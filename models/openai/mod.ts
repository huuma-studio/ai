/**
 * OpenAI chat-completions model adapter for the Huuma AI model interface.
 *
 * @example
 * ```typescript
 * import { openai } from "jsr:@huuma/ai/models/openai";
 *
 * const model = openai({ apiKey: Deno.env.get("OPENAI_API_KEY") });
 * const result = await model.generate({
 *   modelId: "gpt-4o-mini",
 *   messages: [{ role: "user", contents: "Hello!" }],
 * });
 * ```
 *
 * @module
 */
import type { BaseModel, ModelResult, ModelUsage } from "@/model/mod.ts";
import { dataUrlFrom, fileSourceFrom, toolFilesLabel } from "@/model/mod.ts";
import type {
  FileContent,
  Message,
  ModelMessage,
  TextContent,
  ToolCallContent,
} from "@/mod.ts";
import OpenAI, { type ClientOptions } from "openai";
import type { Tool } from "@/tools/mod.ts";
import type { JSONSchema } from "@huuma/validate";

/** Vendor extension used by reasoning-capable OpenAI-compatible providers. */
interface ReasoningExtension {
  reasoning_content?: string | null;
}

/**
 * OpenAI chat model identifiers.
 *
 * The official SDK type is used for known models, while the open string branch
 * keeps the wrapper usable with newly released and OpenAI-compatible models.
 */
// deno-lint-ignore ban-types
export type OpenAIModels = OpenAI.ChatModel | (string & {});

/**
 * Additional OpenAI chat completion request options.
 *
 * `messages`, `model`, `stream`, and `tools` are managed by the adapter. `n`
 * is omitted because the adapter only maps the first choice; allowing it would
 * silently drop the additional completions.
 */
export type OpenAIRequestOptions = Omit<
  OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  "messages" | "model" | "stream" | "tools" | "n"
>;

/**
 * Options passed to {@link OpenAIModel.generate} and
 * {@link OpenAIModel.stream}.
 */
export interface OpenAIGenerateOptions {
  /** The model identifier to use. */
  modelId: OpenAIModels;

  /** Conversation history. */
  messages: Message[];

  /** Optional system prompt prepended to the message list. */
  system?: string;

  /** Tools available to the model. */
  // deno-lint-ignore no-explicit-any
  tools?: Tool<any>[];

  /** Additional OpenAI chat completion options. */
  options?: OpenAIRequestOptions;
}

/**
 * Wrapper around the official OpenAI SDK providing a unified
 * {@link BaseModel} interface.
 */
export class OpenAIModel implements BaseModel<OpenAIModels> {
  #client: OpenAI;

  /**
   * Create a new OpenAI model adapter.
   *
   * @param options Optional OpenAI client configuration.
   */
  constructor(options: ClientOptions = {}) {
    this.#client = new OpenAI(options);
  }

  /**
   * Sends a single non-streaming chat completion request.
   *
   * @param options Generation options including model ID, messages, and optional tools.
   * @returns A normalized {@link ModelResult}.
   */
  async generate(
    { modelId, messages, tools, system, options }: OpenAIGenerateOptions,
  ): Promise<ModelResult<OpenAIModels>> {
    const response = await this.#client.chat.completions.create({
      ...options,
      model: modelId,
      messages: openAIMessagesFrom(messages, system),
      tools: tools?.length ? openAIToolsFrom(tools) : undefined,
      stream: false,
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No choices returned from OpenAI");
    }

    return {
      modelId,
      messages: [modelMessageFrom(choice.message)],
      usage: usageFrom(response.usage),
    };
  }

  /**
   * Sends a streaming chat completion request.
   *
   * The request opts into `stream_options.include_usage`, so the stream ends
   * with a usage-only {@link ModelResult} (empty `messages`) carrying the
   * token usage of the whole call.
   *
   * @param options Generation options including model ID, messages, and optional tools.
   * @returns An async generator yielding normalized {@link ModelResult} chunks.
   */
  async stream(
    { modelId, messages, tools, system, options }: OpenAIGenerateOptions,
  ): Promise<AsyncGenerator<ModelResult<OpenAIModels>>> {
    const stream = await this.#client.chat.completions.create({
      ...options,
      model: modelId,
      messages: openAIMessagesFrom(messages, system),
      tools: tools?.length ? openAIToolsFrom(tools) : undefined,
      stream: true,
      stream_options: { include_usage: true },
    });

    return streamCompletions(stream, modelId);
  }
}

/**
 * Converts Huuma {@link Message}s into the format expected by the
 * OpenAI chat completions API.
 *
 * Note: `thinking` on model messages is intentionally **not**
 * round-tripped because OpenAI's API does not accept `reasoning_content`
 * (or similar) in assistant request messages.
 */
export function openAIMessagesFrom(
  messages: Message[],
  system?: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const message of messages) {
    if (message.role === "system") {
      result.push({
        role: "system",
        content: textFrom(message.contents),
      });
    } else if (message.role === "user") {
      result.push({
        role: "user",
        content: userContentFrom(message.contents),
      });
    } else if (message.role === "model") {
      const textParts = message.contents.filter((c) =>
        "text" in c
      ) as TextContent[];
      const content = textParts.length > 0
        ? textParts.map((c) => c.text).join("")
        : null;
      const toolCalls = modelToolCallsFrom(message).map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.props),
        },
      }));

      // Skip fully empty assistant messages. OpenAI rejects a message
      // with neither `content` nor `tool_calls`.
      if (content === null && toolCalls.length === 0) {
        continue;
      }

      const assistantMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam =
        {
          role: "assistant",
        };
      if (content !== null) {
        assistantMessage.content = content;
      }
      if (toolCalls.length > 0) {
        assistantMessage.tool_calls = toolCalls;
      }
      result.push(assistantMessage);
    } else if (message.role === "tool") {
      // Chat completions tool messages are text-only, so files ride one
      // synthetic user message after the tool messages — wire-only, never
      // part of shared history (ADR 0004).
      const fileParts: OpenAI.Chat.ChatCompletionContentPart[] = [];
      for (const content of message.contents) {
        if ("toolResult" in content) {
          const { id, name, result: toolResult, files } = content.toolResult;
          result.push({
            role: "tool",
            tool_call_id: id,
            content: toolOutputString(toolResult),
          });
          if (files?.length) {
            fileParts.push(
              { type: "text", text: toolFilesLabel(name, id) },
              ...files.map((file) => filePartFrom(file.file)),
            );
          }
        }
      }
      if (fileParts.length > 0) {
        result.push({ role: "user", content: fileParts });
      }
    }
  }
  return result;
}

function modelMessageFrom(
  message: OpenAI.Chat.ChatCompletionMessage,
): ModelMessage {
  const result: ModelMessage = {
    role: "model",
    contents: [],
    toolCalls: [],
  };

  if (message.content) {
    result.contents.push({ text: message.content });
  }

  // Refusals carry the explanation text while `content` stays null; map
  // them to text content so callers never receive a silently empty message.
  if (message.refusal) {
    result.contents.push({ text: message.refusal });
  }

  const reasoningContent = (message as ReasoningExtension).reasoning_content;
  if (reasoningContent) {
    result.thinking = reasoningContent;
  }

  if (message.tool_calls) {
    for (const toolCall of message.tool_calls) {
      if (toolCall.type !== "function") {
        continue;
      }

      const mappedToolCall: ToolCallContent["toolCall"] = {
        id: toolCall.id,
        name: toolCall.function.name,
        props: parseToolArguments(toolCall.function.arguments),
      };
      result.toolCalls.push(mappedToolCall);
      result.contents.push({ toolCall: mappedToolCall });
    }
  }

  return result;
}

interface PendingToolCall {
  id: string;
  name: string;
  argumentsJSON: string;
}

// Tool calls are buffered and emitted once their arguments JSON is
// complete, instead of re-parsing partial JSON on every delta. A pending
// call is complete when a fragment for a higher index arrives, when the
// choice reports a finish reason, or when the stream ends.
async function* streamCompletions(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  modelId: OpenAIModels,
): AsyncGenerator<ModelResult<OpenAIModels>> {
  const pendingToolCalls: Record<number, PendingToolCall> = {};
  let usage: ModelUsage | undefined;

  for await (const chunk of stream) {
    // With `stream_options.include_usage` the usage arrives on a final
    // chunk that carries no choices.
    if (chunk.usage) {
      usage = usageFrom(chunk.usage);
    }

    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }

    const message = modelMessageFromDelta(choice.delta);
    if (isPopulatedModelMessage(message)) {
      yield { modelId, messages: [message] };
    }

    for (const toolCallDelta of choice.delta.tool_calls ?? []) {
      if (toolCallDelta.type && toolCallDelta.type !== "function") {
        continue;
      }

      const index = toolCallDelta.index;
      yield* flushPendingToolCalls(pendingToolCalls, modelId, index);

      pendingToolCalls[index] ??= { id: "", name: "", argumentsJSON: "" };
      const pending = pendingToolCalls[index];

      if (toolCallDelta.id) {
        pending.id = toolCallDelta.id;
      }
      if (toolCallDelta.function?.name) {
        pending.name = toolCallDelta.function.name;
      }
      if (toolCallDelta.function?.arguments) {
        pending.argumentsJSON += toolCallDelta.function.arguments;
      }
    }

    if (choice.finish_reason) {
      yield* flushPendingToolCalls(pendingToolCalls, modelId);
    }
  }

  yield* flushPendingToolCalls(pendingToolCalls, modelId);

  if (usage) {
    yield { modelId, messages: [], usage };
  }
}

/** Maps OpenAI completion usage to the normalized {@link ModelUsage}. */
function usageFrom(
  usage: OpenAI.CompletionUsage | null | undefined,
): ModelUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const result: ModelUsage = {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
  };

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  if (cachedTokens !== undefined) {
    result.cacheReadInputTokens = cachedTokens;
  }

  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoningTokens !== undefined) {
    result.thinkingTokens = reasoningTokens;
  }

  return result;
}

function* flushPendingToolCalls(
  pendingToolCalls: Record<number, PendingToolCall>,
  modelId: OpenAIModels,
  beforeIndex = Infinity,
): Generator<ModelResult<OpenAIModels>> {
  const indexes = Object.keys(pendingToolCalls)
    .map(Number)
    .filter((index) => index < beforeIndex)
    .sort((a, b) => a - b);

  for (const index of indexes) {
    const pending = pendingToolCalls[index];
    delete pendingToolCalls[index];

    const toolCall: ToolCallContent["toolCall"] = {
      id: pending.id,
      name: pending.name,
      props: parseToolArguments(pending.argumentsJSON),
    };
    yield {
      modelId,
      messages: [{
        role: "model",
        contents: [{ toolCall }],
        toolCalls: [toolCall],
      }],
    };
  }
}

function modelMessageFromDelta(
  delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta,
): ModelMessage {
  const message: ModelMessage = {
    role: "model",
    contents: [],
    toolCalls: [],
  };

  if (delta.content) {
    message.contents.push({ text: delta.content });
  }

  if (delta.refusal) {
    message.contents.push({ text: delta.refusal });
  }

  const reasoningContent = (delta as ReasoningExtension).reasoning_content;
  if (reasoningContent) {
    message.thinking = reasoningContent;
  }

  return message;
}

function isPopulatedModelMessage(message: ModelMessage): boolean {
  return message.contents.length > 0 || message.thinking !== undefined ||
    message.toolCalls.length > 0;
}

function modelToolCallsFrom(
  message: ModelMessage,
): ToolCallContent["toolCall"][] {
  if (message.toolCalls.length > 0) {
    return message.toolCalls;
  }

  return message.contents
    .filter((content): content is ToolCallContent => "toolCall" in content)
    .map((content) => content.toolCall);
}

function parseToolArguments(argumentsJSON: string): JSONSchema {
  try {
    return argumentsJSON ? JSON.parse(argumentsJSON) : {};
  } catch {
    return {};
  }
}

function textFrom(contents: string | TextContent[]): string {
  return typeof contents === "string"
    ? contents
    : contents.map((content) => content.text).join("");
}

/**
 * Converts user message contents into OpenAI user content.
 *
 * Text-only messages keep today's plain-string wire shape; messages
 * carrying file parts become a content part array.
 */
function userContentFrom(
  contents: string | (TextContent | FileContent)[],
): string | OpenAI.Chat.ChatCompletionContentPart[] {
  if (typeof contents === "string") {
    return contents;
  }

  if (contents.every((content): content is TextContent => "text" in content)) {
    return textFrom(contents);
  }

  return contents.map((content) =>
    "file" in content
      ? filePartFrom(content.file)
      : { type: "text" as const, text: content.text }
  );
}

/** Audio formats accepted by OpenAI chat completions, keyed by mimeType. */
const OPENAI_AUDIO_FORMATS = {
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
} as const;

/**
 * Converts a file content part into an OpenAI content part.
 *
 * Images map to `image_url` (URLs pass through, base64 becomes a data
 * URL), wav/mp3 audio data maps to `input_audio`, and PDF data maps to a
 * `file` part (chat completions requires a data URL and a filename at
 * wire level). Audio and PDFs by URL throw — the API has no URL input
 * for them and adapters never fetch. Any other media type throws.
 */
function filePartFrom(
  file: FileContent["file"],
): OpenAI.Chat.ChatCompletionContentPart {
  const source = fileSourceFrom(file);

  if (file.mimeType.startsWith("image/")) {
    return {
      type: "image_url",
      image_url: {
        url: source.kind === "url" ? source.url : dataUrlFrom(file),
      },
    };
  }

  const audioFormat =
    OPENAI_AUDIO_FORMATS[file.mimeType as keyof typeof OPENAI_AUDIO_FORMATS];
  if (audioFormat) {
    if (source.kind === "url") {
      throw new RangeError(
        `OpenAI adapter does not support audio by URL ("${file.mimeType}")`,
      );
    }
    return {
      type: "input_audio",
      input_audio: { data: source.data, format: audioFormat },
    };
  }

  if (file.mimeType === "application/pdf") {
    if (source.kind === "url") {
      throw new RangeError(
        "OpenAI adapter does not support PDFs by URL",
      );
    }
    return {
      type: "file",
      file: {
        filename: file.name ?? "file.pdf",
        file_data: dataUrlFrom(file),
      },
    };
  }

  throw new RangeError(
    `OpenAI adapter does not support file content of type "${file.mimeType}"`,
  );
}

/**
 * Serializes a tool execution result into the single string OpenAI's
 * `role: "tool"` message requires. Errors take precedence over output,
 * and non-string payloads are JSON-encoded.
 */
function toolOutputString(
  result: { output?: unknown; error?: unknown },
): string {
  const value = result.error ?? result.output;
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;

  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Converts Huuma {@link Tool}s into OpenAI function-tool definitions.
 */
export function openAIToolsFrom(
  // deno-lint-ignore no-explicit-any
  tools: Tool<any>[],
): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input.jsonSchema() as Record<string, unknown>,
    },
  }));
}

/**
 * Factory function that creates an {@link OpenAIModel}.
 *
 * @param options Optional OpenAI client options, including `apiKey`.
 * @returns A configured {@link OpenAIModel} instance.
 *
 * @example
 * ```typescript
 * const model = openai({ apiKey: Deno.env.get("OPENAI_API_KEY") });
 * ```
 */
export function openai(options?: ClientOptions): OpenAIModel {
  return new OpenAIModel(options);
}
