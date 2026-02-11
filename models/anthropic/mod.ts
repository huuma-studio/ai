import Anthropic from "@anthropic-ai/sdk";
import type { BaseModel, ModelResult } from "@/model/mod.ts";
import type {
  Message,
  ModelMessage,
  TextContent,
  ToolCallContent,
} from "@/mod.ts";
import type { Tool } from "@/tools/mod.ts";

/**
 * Anthropic models available.
 *
 * Includes aliases (latest) and specific versions.
 * @see https://docs.anthropic.com/en/docs/about-claude/models
 */
export type AnthropicModels =
  // Claude Opus 4.6 (Latest 2026)
  | "claude-opus-4-6-latest"
  | "claude-opus-4-6"
  // Claude Sonnet 4.5
  | "claude-sonnet-4-5-latest"
  | "claude-sonnet-4-5"
  | "claude-sonnet-4-5-20250929"
  // Claude Haiku 4.5
  | "claude-haiku-4-5-latest"
  | "claude-haiku-4-5"
  | "claude-haiku-4-5-20251001"
  // Claude 3.7 Sonnet
  | "claude-3-7-sonnet-latest"
  | "claude-3-7-sonnet-20250219"
  // Claude 3.5 Sonnet
  | "claude-3-5-sonnet-latest"
  | "claude-3-5-sonnet-20241022"
  | "claude-3-5-sonnet-20240620"
  // Claude 3.5 Haiku
  | "claude-3-5-haiku-latest"
  | "claude-3-5-haiku-20241022"
  // Claude 3 Opus
  | "claude-3-opus-latest"
  | "claude-3-opus-20240229"
  // Claude 3 Sonnet
  | "claude-3-sonnet-20240229"
  // Claude 3 Haiku
  | "claude-3-haiku-20240307";

/**
 * Options for configuring the Anthropic client.
 */
export interface AnthropicOptions {
  /**
   * The API key for Anthropic.
   * If not provided, it will look for ANTHROPIC_API_KEY environment variable.
   */
  apiKey?: string;

  /**
   * Base URL for the API (optional).
   */
  baseURL?: string;
}

/**
 * Options for generating content with Anthropic.
 */
export interface AnthropicGenerateOptions {
  /**
   * The model to use.
   */
  modelId: AnthropicModels;

  /**
   * The messages to send to the model.
   */
  messages: Message[];

  /**
   * System prompt (optional).
   */
  system?: string;

  /**
   * Tools available to the model (optional).
   */
  // deno-lint-ignore no-explicit-any
  tools?: Tool<any>[];
}

/**
 * Converts internal tool format to Anthropic's tool definitions.
 *
 * @param tools - Array of internal Tool objects.
 * @returns Array of Anthropic Tool objects.
 */
// deno-lint-ignore no-explicit-any
export function anthropicToolsFrom(tools: Tool<any>[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input.jsonSchema() as Anthropic.Tool.InputSchema,
  }));
}

/**
 * Converts internal Message format to Anthropic's MessageParam[].
 *
 * Handles role mapping:
 * - user -> user
 * - model -> assistant
 * - tool -> user (with tool_result content)
 *
 * Skips system messages (as they should be passed separately).
 *
 * @param messages - Array of internal Message objects.
 * @returns Array of Anthropic MessageParam objects.
 */
export function anthropicMessagesFrom(
  messages: Message[],
): Anthropic.MessageParam[] {
  const anthropicMessages: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      if (typeof message.contents === "string") {
        anthropicMessages.push({ role: "user", content: message.contents });
      } else {
        const content = message.contents.map((c) => ({
          type: "text" as const,
          text: c.text,
        }));
        anthropicMessages.push({ role: "user", content });
      }
    } else if (message.role === "model") {
      const content: Array<
        Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam
      > = [];

      for (const c of message.contents) {
        if ("text" in c) {
          content.push({ type: "text", text: c.text });
        } else if ("toolCall" in c) {
          content.push({
            type: "tool_use",
            id: c.toolCall.id,
            name: c.toolCall.name,
            input: c.toolCall.props,
          });
        }
      }

      anthropicMessages.push({ role: "assistant", content });
    } else if (message.role === "tool") {
      const content: Anthropic.ToolResultBlockParam[] = [];

      for (const c of message.contents) {
        if ("toolResult" in c) {
          const { id, result } = c.toolResult;
          if (result.error) {
            content.push({
              type: "tool_result",
              tool_use_id: id,
              content: String(result.error),
              is_error: true,
            });
          } else {
            const outputStr = typeof result.output === "string"
              ? result.output
              : JSON.stringify(result.output);

            content.push({
              type: "tool_result",
              tool_use_id: id,
              content: outputStr,
            });
          }
        }
      }

      if (content.length > 0) {
        anthropicMessages.push({ role: "user", content });
      }
    }
  }

  return anthropicMessages;
}

/**
 * Converts Anthropic's API response to internal ModelResult.
 *
 * @param response - The message response from Anthropic.
 * @returns The internal ModelResult.
 */
export function modelResultFrom(
  response: Anthropic.Message,
): ModelResult<AnthropicModels> {
  const contents: (TextContent | ToolCallContent)[] = [];
  const toolCalls: ToolCallContent["toolCall"][] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      contents.push({ text: block.text });
    } else if (block.type === "tool_use") {
      const toolCall = {
        id: block.id,
        name: block.name,
        // deno-lint-ignore no-explicit-any
        props: block.input as any,
      };

      contents.push({ toolCall });
      toolCalls.push(toolCall);
    }
  }

  const message: ModelMessage = {
    role: "model",
    contents,
    toolCalls,
  };

  return {
    modelId: response.model as AnthropicModels,
    messages: [message],
  };
}

/**
 * Implementation of BaseModel for Anthropic.
 */
export class AnthropicModel implements BaseModel<AnthropicModels> {
  #client: Anthropic;

  constructor(options: AnthropicOptions) {
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
  }

  async generate(
    args: AnthropicGenerateOptions,
  ): Promise<ModelResult<AnthropicModels>> {
    const options = args;
    const messages = anthropicMessagesFrom(options.messages);
    const tools = options.tools ? anthropicToolsFrom(options.tools) : undefined;

    const response = await this.#client.messages.create({
      model: options.modelId,
      messages,
      system: options.system,
      tools,
      max_tokens: 4096,
    });

    return modelResultFrom(response);
  }

  async stream(
    args: unknown,
  ): Promise<AsyncGenerator<ModelResult<AnthropicModels>>> {
    const options = args as AnthropicGenerateOptions;
    const messages = anthropicMessagesFrom(options.messages);
    const tools = options.tools ? anthropicToolsFrom(options.tools) : undefined;

    const stream = await this.#client.messages.create({
      model: options.modelId,
      messages,
      system: options.system,
      tools,
      max_tokens: 4096,
      stream: true,
    });

    return this.#streamIterator(stream, options.modelId);
  }

  async *#streamIterator(
    stream: AsyncIterable<Anthropic.MessageStreamEvent>,
    modelId: AnthropicModels,
  ): AsyncGenerator<ModelResult<AnthropicModels>> {
    // Track content blocks to build up the message
    const contentBlocks: (TextContent | ToolCallContent)[] = [];
    const toolArgsBuffers: Map<number, string> = new Map();

    for await (const event of stream) {
      if (event.type === "content_block_start") {
        if (event.content_block.type === "text") {
          contentBlocks[event.index] = { text: event.content_block.text };
        } else if (event.content_block.type === "tool_use") {
          contentBlocks[event.index] = {
            toolCall: {
              id: event.content_block.id,
              name: event.content_block.name,
              props: {},
            },
          };
          toolArgsBuffers.set(event.index, "");
        }
      } else if (event.type === "content_block_delta") {
        const block = contentBlocks[event.index];
        if (!block) continue;

        if (event.delta.type === "text_delta" && "text" in block) {
          block.text += event.delta.text;
        } else if (
          event.delta.type === "input_json_delta" && "toolCall" in block
        ) {
          const current = toolArgsBuffers.get(event.index) || "";
          const updated = current + event.delta.partial_json;
          toolArgsBuffers.set(event.index, updated);

          try {
            (block as ToolCallContent).toolCall.props = JSON.parse(updated);
          } catch {
            // Ignore parse error for partial JSON
          }
        }
      }

      const currentMessage: ModelMessage = {
        role: "model",
        contents: [...contentBlocks],
        toolCalls: contentBlocks
          .filter((b) => "toolCall" in b)
          .map((b) => (b as ToolCallContent).toolCall),
      };

      yield {
        modelId,
        messages: [currentMessage],
      };
    }
  }
}

/**
 * Convenience function to create an AnthropicModel.
 *
 * @param options - The configuration options.
 * @returns An instance of AnthropicModel.
 */
export function anthropic(options: AnthropicOptions): AnthropicModel {
  return new AnthropicModel(options);
}
