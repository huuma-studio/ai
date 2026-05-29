import type { BaseModel, ModelResult } from "@/model/mod.ts";
import type {
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

export type OpenAIRequestOptions = Omit<
  OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  "messages" | "model" | "stream" | "tools"
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

  constructor(options: ClientOptions = {}) {
    this.#client = new OpenAI(options);
  }

  /**
   * Sends a single non-streaming chat completion request.
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
    };
  }

  /**
   * Sends a streaming chat completion request.
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
    });

    const accumulatedToolCalls: Record<
      number,
      { id?: string; name?: string; arguments: string }
    > = {};

    return (async function* () {
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (!choice) {
          continue;
        }

        const message = modelMessageFromDelta(
          choice.delta,
          accumulatedToolCalls,
        );
        if (isPopulatedModelMessage(message)) {
          yield {
            modelId,
            messages: [message],
          };
        }
      }
    })();
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
        content: textFrom(message.contents),
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
      for (const content of message.contents) {
        if ("toolResult" in content) {
          result.push({
            role: "tool",
            tool_call_id: content.toolResult.id,
            content: toolOutputString(content.toolResult.result),
          });
        }
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

function modelMessageFromDelta(
  delta: OpenAI.Chat.ChatCompletionChunk.Choice.Delta,
  accumulatedToolCalls: Record<
    number,
    { id?: string; name?: string; arguments: string }
  >,
): ModelMessage {
  const message: ModelMessage = {
    role: "model",
    contents: [],
    toolCalls: [],
  };

  if (delta.content) {
    message.contents.push({ text: delta.content });
  }

  const reasoningContent = (delta as ReasoningExtension).reasoning_content;
  if (reasoningContent) {
    message.thinking = reasoningContent;
  }

  if (delta.tool_calls) {
    for (const toolCallDelta of delta.tool_calls) {
      if (toolCallDelta.type && toolCallDelta.type !== "function") {
        continue;
      }

      const index = toolCallDelta.index;
      accumulatedToolCalls[index] ??= { arguments: "" };
      const accumulatedToolCall = accumulatedToolCalls[index];

      if (toolCallDelta.id) {
        accumulatedToolCall.id = toolCallDelta.id;
      }
      if (toolCallDelta.function?.name) {
        accumulatedToolCall.name = toolCallDelta.function.name;
      }
      if (toolCallDelta.function?.arguments) {
        accumulatedToolCall.arguments += toolCallDelta.function.arguments;
      }

      const mappedToolCall: ToolCallContent["toolCall"] = {
        id: accumulatedToolCall.id ?? "",
        name: accumulatedToolCall.name ?? "",
        props: parseToolArguments(accumulatedToolCall.arguments),
      };

      message.toolCalls.push(mappedToolCall);
      message.contents.push({ toolCall: mappedToolCall });
    }
  }

  return message;
}

function isPopulatedModelMessage(message: ModelMessage): boolean {
  return message.contents.length > 0 || message.thinking !== undefined ||
    message.toolCalls.length > 0;
}

function modelToolCallsFrom(message: ModelMessage): ToolCallContent["toolCall"][] {
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
 * @example
 * ```typescript
 * const model = openai({ apiKey: Deno.env.get("OPENAI_API_KEY") });
 * ```
 */
export function openai(options?: ClientOptions): OpenAIModel {
  return new OpenAIModel(options);
}
