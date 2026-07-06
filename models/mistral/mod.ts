/**
 * Mistral model adapter for the Huuma AI model interface.
 *
 * @example
 * ```typescript
 * import { mistral } from "jsr:@huuma/ai/models/mistral";
 *
 * const model = mistral({ apiKey: Deno.env.get("MISTRAL_API_KEY") });
 * const result = await model.generate({
 *   modelId: "mistral-large-latest",
 *   messages: [{ role: "user", contents: "Hello!" }],
 * });
 * ```
 *
 * @module
 */
import { Mistral } from "@mistralai/mistralai";
import type { SDKOptions } from "@mistralai/mistralai";
import type {
  AssistantMessage,
  ChatCompletionRequest,
  ChatCompletionStreamRequest,
  CompletionChunk,
  CompletionEvent,
  ContentChunk,
  DeltaMessage,
  SystemMessage as MistralSystemMessage,
  Tool as MistralTool,
  ToolMessage as MistralToolMessage,
  UsageInfo,
  UserMessage as MistralUserMessage,
} from "@mistralai/mistralai/models/components";
import type { BaseModel, ModelResult, ModelUsage } from "@/model/mod.ts";
import { dataUrlFrom, fileSourceFrom, toolFilesLabel } from "@/model/mod.ts";
import type {
  FileContent,
  Message,
  ModelMessage,
  TextContent,
  ToolCallContent,
  ToolResultContent,
} from "@/mod.ts";
// Tool instances are accepted structurally via ToolLike.
import type { JSONSchema, Schema } from "@huuma/validate";

type Mistral_Large_Latest = "mistral-large-latest";
type Mistral_Medium_Latest = "mistral-medium-latest";
type Mistral_Small_Latest = "mistral-small-latest";
type Mistral_Tiny_Latest = "mistral-tiny-latest";
type Pixtral_Large_Latest = "pixtral-large-latest";
type Pixtral_12B_Latest = "pixtral-12b-latest";
type Ministral_3B_Latest = "ministral-3b-latest";
type Ministral_8B_Latest = "ministral-8b-latest";
type Open_Mistral_Nemo = "open-mistral-nemo";
type Codestral_Latest = "codestral-latest";
type Open_Codestral_Mamba = "open-codestral-mamba";
type Devstral_Latest = "devstral-latest";

/**
 * Mistral chat model identifiers.
 *
 * Known aliases are listed for autocompletion, while the open string branch
 * keeps the wrapper usable with newly released models.
 */
export type MistralModels =
  | Mistral_Large_Latest
  | Mistral_Medium_Latest
  | Mistral_Small_Latest
  | Mistral_Tiny_Latest
  | Pixtral_Large_Latest
  | Pixtral_12B_Latest
  | Ministral_3B_Latest
  | Ministral_8B_Latest
  | Open_Mistral_Nemo
  | Codestral_Latest
  | Open_Codestral_Mamba
  | Devstral_Latest
  // deno-lint-ignore ban-types
  | (string & {});

/**
 * Additional Mistral chat completion request options.
 *
 * `messages`, `model`, `stream`, and `tools` are managed by the adapter. `n`
 * is omitted because the adapter only maps the first choice; allowing it would
 * silently drop the additional completions.
 */
export type MistralRequestOptions = Omit<
  ChatCompletionRequest,
  "messages" | "model" | "stream" | "tools" | "n"
>;

/**
 * Options passed to {@link MistralModel.generate} and
 * {@link MistralModel.stream}.
 */
export interface MistralGenerateOptions {
  /** The model identifier to use. */
  modelId: MistralModels;

  /** Conversation history. */
  messages: Message[];

  /** Optional system prompt prepended to the message list. */
  system?: string;

  /** Tools available to the model. */
  tools?: ToolLike[];

  /** Additional Mistral chat completion options. */
  options?: MistralRequestOptions;
}

/** Minimal tool shape accepted by the adapter. */
type ToolLike = {
  name: string;
  description: string;
  input: Schema<unknown>;
};

/**
 * Wrapper around the official Mistral SDK providing a unified
 * {@link BaseModel} interface.
 */
export class MistralModel implements BaseModel<MistralModels> {
  #client: Mistral;

  /**
   * Create a new Mistral model adapter.
   *
   * @param options Optional Mistral client configuration.
   */
  constructor(options: SDKOptions = {}) {
    this.#client = new Mistral(options);
  }

  /**
   * Sends a single non-streaming chat completion request.
   *
   * @param options Generation options including model ID, messages, and optional tools.
   * @returns A normalized {@link ModelResult}.
   */
  async generate(
    { modelId, messages, tools, system, options }: MistralGenerateOptions,
  ): Promise<ModelResult<MistralModels>> {
    const response = await this.#client.chat.complete({
      ...options,
      model: modelId,
      messages: mistralMessagesFrom(messages, system),
      tools: tools?.length ? mistralToolsFrom(tools) : undefined,
      stream: false,
    } as ChatCompletionRequest);

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No choices returned from Mistral");
    }

    return {
      modelId,
      messages: [modelMessageFrom(choice.message)],
      usage: mistralUsageFrom(response.usage),
    };
  }

  /**
   * Sends a streaming chat completion request.
   *
   * The stream yields incremental {@link ModelResult} chunks with text deltas
   * and completed tool calls. If the provider reports usage on a final chunk,
   * a usage-only result is emitted at the end.
   *
   * @param options Generation options including model ID, messages, and optional tools.
   * @returns An async generator yielding normalized {@link ModelResult} chunks.
   */
  async stream(
    { modelId, messages, tools, system, options }: MistralGenerateOptions,
  ): Promise<AsyncGenerator<ModelResult<MistralModels>>> {
    const stream = await this.#client.chat.stream({
      ...options,
      model: modelId,
      messages: mistralMessagesFrom(messages, system),
      tools: tools?.length ? mistralToolsFrom(tools) : undefined,
      stream: true,
    } as ChatCompletionStreamRequest);

    return streamCompletions(stream, modelId);
  }
}

/**
 * Converts Huuma {@link Message}s into the format expected by the
 * Mistral chat completions API.
 *
 * A top-level `system` prompt is sent as the first `role: "system"` message.
 * Existing system messages in the history keep their role.
 */
export function mistralMessagesFrom(
  messages: Message[],
  system?: string,
): ChatCompletionRequest["messages"] {
  const result: ChatCompletionRequest["messages"] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  // Tool result files awaiting delivery via a synthetic user message
  // (ADR 0004). Mistral chat templates enforce role alternation, so the
  // chunks fold into a directly-following user message when one exists
  // and only otherwise become their own message.
  let pendingFileChunks: ContentChunk[] = [];

  for (const message of messages) {
    if (pendingFileChunks.length > 0 && message.role !== "user") {
      result.push({ role: "user", content: pendingFileChunks });
      pendingFileChunks = [];
    }

    if (message.role === "system") {
      result.push({
        role: "system",
        content: textFrom(message.contents),
      } as MistralSystemMessage);
    } else if (message.role === "user") {
      const content = userContentFrom(message.contents);
      if (pendingFileChunks.length > 0) {
        result.push({
          role: "user",
          content: [
            ...pendingFileChunks,
            ...(typeof content === "string"
              ? [{ type: "text" as const, text: content }]
              : content),
          ],
        });
        pendingFileChunks = [];
      } else {
        result.push({ role: "user", content } as MistralUserMessage);
      }
    } else if (message.role === "model") {
      const textParts = message.contents.filter((c): c is TextContent =>
        "text" in c
      );
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

      // Skip fully empty assistant messages. Mistral rejects a message
      // with neither `content` nor `tool_calls`.
      if (content === null && toolCalls.length === 0) {
        continue;
      }

      const assistantMessage: AssistantMessage = {
        role: "assistant",
      };
      if (content !== null) {
        assistantMessage.content = content;
      }
      if (toolCalls.length > 0) {
        assistantMessage.toolCalls = toolCalls;
      }
      result.push(assistantMessage as AssistantMessage & { role: "assistant" });
    } else if (message.role === "tool") {
      // `ToolMessage.content` is typed to accept chunks, but model support
      // is unverified — typed-but-ignored content would be silent data
      // loss, so files ride a synthetic user message after the tool
      // messages instead, wire-only (ADR 0004).
      for (const content of message.contents) {
        if ("toolResult" in content) {
          const { id, name, result: toolResult, files } = content.toolResult;
          result.push({
            role: "tool",
            content: toolOutputString(toolResult),
            toolCallId: id,
            name,
          } as MistralToolMessage);
          if (files?.length) {
            pendingFileChunks.push(
              { type: "text", text: toolFilesLabel(name, id) },
              ...files.map((file) => fileChunkFrom(file.file)),
            );
          }
        }
      }
    }
  }

  if (pendingFileChunks.length > 0) {
    result.push({ role: "user", content: pendingFileChunks });
  }

  return result;
}

/**
 * Converts Huuma {@link Tool}s into Mistral function-tool definitions.
 */
export function mistralToolsFrom(
  tools: ToolLike[],
): MistralTool[] {
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
 * Maps Mistral {@link UsageInfo} to the normalized {@link ModelUsage}.
 */
export function mistralUsageFrom(
  usage: UsageInfo | null | undefined,
): ModelUsage | undefined {
  if (!usage) {
    return undefined;
  }

  const result: ModelUsage = {};

  if (usage.promptTokens !== undefined) {
    result.inputTokens = usage.promptTokens;
  }
  if (usage.completionTokens !== undefined) {
    result.outputTokens = usage.completionTokens;
  }
  if (usage.totalTokens !== undefined) {
    result.totalTokens = usage.totalTokens;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Factory function that creates a {@link MistralModel}.
 *
 * @param options Optional Mistral client options, including `apiKey`.
 * @returns A configured {@link MistralModel} instance.
 *
 * @example
 * ```typescript
 * const model = mistral({ apiKey: Deno.env.get("MISTRAL_API_KEY") });
 * ```
 */
export function mistral(options: SDKOptions = {}): MistralModel {
  return new MistralModel(options);
}

function modelMessageFrom(
  message: AssistantMessage | undefined,
): ModelMessage {
  const result: ModelMessage = {
    role: "model",
    contents: [],
    toolCalls: [],
  };

  if (!message) {
    return result;
  }

  if (typeof message.content === "string" && message.content) {
    result.contents.push({ text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const chunk of message.content) {
      if (typeof chunk === "object" && chunk !== null && "text" in chunk) {
        result.contents.push({ text: (chunk as TextChunk).text });
      }
    }
  }

  if (message.toolCalls) {
    for (const toolCall of message.toolCalls) {
      if (toolCall.type !== undefined && toolCall.type !== "function") {
        continue;
      }

      const mappedToolCall: ToolCallContent["toolCall"] = {
        id: toolCall.id ?? "",
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

async function* streamCompletions(
  stream: ReadableStream<CompletionEvent>,
  modelId: MistralModels,
): AsyncGenerator<ModelResult<MistralModels>> {
  const pendingToolCalls: Record<number, PendingToolCall> = {};
  const seenToolCallIndexes = new Set<number>();
  let maxSeenToolCallIndex = -1;
  let usage: ModelUsage | undefined;

  for await (const event of stream) {
    const chunk: CompletionChunk = event.data;

    if (chunk.usage) {
      usage = mistralUsageFrom(chunk.usage);
    }

    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }

    const message = modelMessageFromDelta(choice.delta);
    if (isPopulatedModelMessage(message)) {
      yield { modelId, messages: [message] };
    }

    const toolCallDeltas = choice.delta.toolCalls ?? [];
    const currentIndexes = toolCallDeltas.map((tc) => tc.index ?? 0);

    // Update pending calls first so we do not lose deltas that complete a
    // previous call in the same chunk that also starts a new one.
    for (const toolCallDelta of toolCallDeltas) {
      if (
        toolCallDelta.type !== undefined && toolCallDelta.type !== "function"
      ) {
        continue;
      }

      const index = toolCallDelta.index ?? 0;
      seenToolCallIndexes.add(index);
      pendingToolCalls[index] ??= { id: "", name: "", argumentsJSON: "" };
      const pending = pendingToolCalls[index];

      // The Mistral SDK defaults missing tool-call ids to the string "null"
      // in stream deltas; preserve the first real id we receive.
      if (toolCallDelta.id && pending.id === "") {
        pending.id = toolCallDelta.id;
      }
      if (toolCallDelta.function?.name) {
        pending.name = toolCallDelta.function.name;
      }
      if (typeof toolCallDelta.function?.arguments === "string") {
        pending.argumentsJSON += toolCallDelta.function.arguments;
      }
    }

    // A newly seen index higher than the previous maximum means earlier
    // pending tool calls are complete.
    const newHigherIndex = currentIndexes.find((idx) =>
      idx > maxSeenToolCallIndex
    );
    if (newHigherIndex !== undefined) {
      yield* flushPendingToolCalls(pendingToolCalls, modelId, newHigherIndex);
      maxSeenToolCallIndex = newHigherIndex;
    }

    maxSeenToolCallIndex = Math.max(maxSeenToolCallIndex, ...currentIndexes);

    if (choice.finishReason) {
      yield* flushPendingToolCalls(pendingToolCalls, modelId);
    }
  }

  yield* flushPendingToolCalls(pendingToolCalls, modelId);

  if (usage) {
    yield { modelId, messages: [], usage };
  }
}

function* flushPendingToolCalls(
  pendingToolCalls: Record<number, PendingToolCall>,
  modelId: MistralModels,
  beforeIndex = Infinity,
): Generator<ModelResult<MistralModels>> {
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

function modelMessageFromDelta(delta: DeltaMessage): ModelMessage {
  const message: ModelMessage = {
    role: "model",
    contents: [],
    toolCalls: [],
  };

  if (typeof delta.content === "string" && delta.content) {
    message.contents.push({ text: delta.content });
  } else if (Array.isArray(delta.content)) {
    for (const chunk of delta.content) {
      if (typeof chunk === "object" && chunk !== null && "text" in chunk) {
        message.contents.push({ text: (chunk as TextChunk).text });
      }
    }
  }

  return message;
}

function isPopulatedModelMessage(message: ModelMessage): boolean {
  return message.contents.length > 0 || message.toolCalls.length > 0 ||
    message.thinking !== undefined;
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

function parseToolArguments(argumentsValue: unknown): JSONSchema {
  if (typeof argumentsValue === "string") {
    try {
      return argumentsValue ? JSON.parse(argumentsValue) : {};
    } catch {
      return {};
    }
  }
  if (typeof argumentsValue === "object" && argumentsValue !== null) {
    return argumentsValue as JSONSchema;
  }
  return {};
}

function textFrom(contents: string | TextContent[]): string {
  return typeof contents === "string"
    ? contents
    : contents.map((content) => content.text).join("");
}

/**
 * Converts user message contents into Mistral user content.
 *
 * Text-only messages keep today's plain-string wire shape; messages
 * carrying file parts become a content chunk array.
 */
function userContentFrom(
  contents: string | (TextContent | FileContent)[],
): string | ContentChunk[] {
  if (typeof contents === "string") {
    return contents;
  }

  if (contents.every((content): content is TextContent => "text" in content)) {
    return textFrom(contents);
  }

  return contents.map((content) =>
    "file" in content
      ? fileChunkFrom(content.file)
      : { type: "text" as const, text: content.text }
  );
}

/**
 * Converts a file content part into a Mistral content chunk.
 *
 * Images map to `image_url` chunks (URLs pass through, base64 becomes a
 * data URL), PDF URLs map to `document_url` chunks, and audio maps to
 * `input_audio` chunks (base64 or URL in the same string field). Base64
 * PDFs throw — `document_url` is URL-only and the Files-API signed-URL
 * flow is out of scope. Any other media type throws.
 */
function fileChunkFrom(file: FileContent["file"]): ContentChunk {
  const source = fileSourceFrom(file);

  if (file.mimeType.startsWith("image/")) {
    return {
      type: "image_url",
      imageUrl: source.kind === "url" ? source.url : dataUrlFrom(file),
    };
  }

  if (file.mimeType === "application/pdf") {
    if (source.kind === "data") {
      throw new RangeError(
        "Mistral adapter does not support base64 PDFs; pass a URL instead",
      );
    }
    return { type: "document_url", documentUrl: source.url };
  }

  if (file.mimeType.startsWith("audio/")) {
    return {
      type: "input_audio",
      inputAudio: source.kind === "data" ? source.data : source.url,
    };
  }

  throw new RangeError(
    `Mistral adapter does not support file content of type "${file.mimeType}"`,
  );
}

/**
 * Serializes a tool execution result into the single string Mistral's
 * `role: "tool"` message requires. Errors take precedence over output,
 * and non-string payloads are JSON-encoded.
 */
function toolOutputString(
  result: ToolResultContent["toolResult"]["result"],
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

interface TextChunk {
  type?: string;
  text: string;
}
