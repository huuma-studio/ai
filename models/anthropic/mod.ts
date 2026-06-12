/**
 * Anthropic Claude model adapter for the Huuma AI model interface.
 *
 * @example
 * ```typescript
 * import { anthropic } from "jsr:@huuma/ai/models/anthropic";
 *
 * const model = anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });
 * const result = await model.generate({
 *   modelId: "claude-opus-4-8",
 *   messages: [{ role: "user", contents: "Hello!" }],
 * });
 * ```
 *
 * @module
 */
import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type { BaseModel, ModelResult, ModelUsage } from "@/model/mod.ts";
import type {
  Message,
  ModelMessage,
  TextContent,
  ToolCallContent,
} from "@/mod.ts";
import type { Tool } from "@/tools/mod.ts";
import type { JSONSchema } from "@huuma/validate";

type Claude_Fable_5 = "claude-fable-5";
type Claude_Opus_4_8 = "claude-opus-4-8";
type Claude_Opus_4_7 = "claude-opus-4-7";
type Claude_Opus_4_6 = "claude-opus-4-6";
type Claude_Sonnet_4_6 = "claude-sonnet-4-6";
type Claude_Haiku_4_5 = "claude-haiku-4-5";

/**
 * Anthropic Claude model identifiers.
 *
 * Known aliases are listed for autocompletion, while the open string branch
 * keeps the wrapper usable with newly released models.
 */
export type ClaudeModels =
  | Claude_Fable_5
  | Claude_Opus_4_8
  | Claude_Opus_4_7
  | Claude_Opus_4_6
  | Claude_Sonnet_4_6
  | Claude_Haiku_4_5
  | string
    // deno-lint-ignore ban-types
    & {};

// Defaults follow Anthropic's guidance: non-streaming requests above ~16K
// output tokens risk SDK HTTP timeouts, while streaming requests can give
// the model more room.
const DEFAULT_GENERATE_MAX_TOKENS = 16000;
const DEFAULT_STREAM_MAX_TOKENS = 64000;

/**
 * Options passed to {@link AnthropicModel.generate} and
 * {@link AnthropicModel.stream}.
 */
export interface AnthropicGenerateOptions {
  /** The model identifier to use. */
  modelId: ClaudeModels;

  /** Conversation history. */
  messages: Message[];

  /** Optional system prompt sent as Anthropic's top-level `system` field. */
  system?: string;

  /** Tools available to the model. */
  // deno-lint-ignore no-explicit-any
  tools?: Tool<any>[];

  /** Additional Anthropic message options. */
  options?: {
    /**
     * Maximum output tokens. Defaults to 16000 for `generate` and 64000 for
     * `stream`.
     */
    maxTokens?: number;
    /** Thinking configuration, e.g. `{ type: "adaptive" }`. */
    thinking?: Anthropic.ThinkingConfigParam;
  };
}

/**
 * Per-block thinking metadata stored in `thinkingMeta.blocks`.
 *
 * Anthropic signs each thinking block individually, so replaying a response
 * that contained several blocks (interleaved thinking between tool calls)
 * requires keeping every block's text paired with its own signature and in
 * its original order relative to redacted blocks.
 */
export type AnthropicThinkingBlockMeta =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/**
 * Wrapper around the official Anthropic SDK providing a unified
 * {@link BaseModel} interface.
 */
export class AnthropicModel implements BaseModel<ClaudeModels> {
  #client: Anthropic;

  /**
   * Create a new Anthropic model adapter.
   *
   * @param options Optional Anthropic client configuration.
   */
  constructor(options: ClientOptions = {}) {
    this.#client = new Anthropic(options);
  }

  /**
   * Sends a single non-streaming message request.
   *
   * @param options Generation options including model ID, messages, and optional tools.
   * @returns A normalized {@link ModelResult}.
   */
  async generate(
    { modelId, messages, tools, system, options }: AnthropicGenerateOptions,
  ): Promise<ModelResult<ClaudeModels>> {
    const response = await this.#client.messages.create({
      model: modelId,
      max_tokens: options?.maxTokens ?? DEFAULT_GENERATE_MAX_TOKENS,
      thinking: options?.thinking,
      system,
      tools: tools?.length ? anthropicToolsFrom(tools) : undefined,
      messages: anthropicMessagesFrom(messages),
      stream: false,
    });

    return modelResultFrom(
      modelId,
      modelMessagesFrom(response),
      anthropicUsageFrom(response.usage),
    );
  }

  /**
   * Sends a streaming message request.
   *
   * Each chunk carries a partial message: text and thinking deltas for
   * display, plus complete tool calls and signed thinking blocks once their
   * content block finishes. Use {@link mergeAnthropicModelMessages} to fold
   * the chunks into a single message that can be replayed as history.
   *
   * The stream ends with a usage-only {@link ModelResult} (empty `messages`)
   * carrying the token usage of the whole call, accumulated from Anthropic's
   * `message_start` and `message_delta` events.
   *
   * @param options Generation options including model ID, messages, and optional tools.
   * @returns An async generator yielding normalized {@link ModelResult} chunks.
   */
  async stream(
    { modelId, messages, tools, system, options }: AnthropicGenerateOptions,
  ): Promise<AsyncGenerator<ModelResult<ClaudeModels>>> {
    const stream = await this.#client.messages.create({
      model: modelId,
      max_tokens: options?.maxTokens ?? DEFAULT_STREAM_MAX_TOKENS,
      thinking: options?.thinking,
      system,
      tools: tools?.length ? anthropicToolsFrom(tools) : undefined,
      messages: anthropicMessagesFrom(messages),
      stream: true,
    });

    return streamMessages(stream, modelId);
  }
}

/** Create an Anthropic Claude model adapter.
 *
 * @param options Anthropic API key and other client options.
 * @returns An {@link AnthropicModel} instance.
 */
export function anthropic(options: ClientOptions = {}): AnthropicModel {
  return new AnthropicModel(options);
}

function modelResultFrom<T extends ClaudeModels>(
  modelId: T,
  messages: ModelMessage[],
  usage?: ModelUsage,
): ModelResult<T> {
  return usage ? { modelId, messages, usage } : { modelId, messages };
}

/** Partial usage shape shared by Anthropic's full and delta usage objects. */
interface AnthropicUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Maps Anthropic usage to the normalized {@link ModelUsage}.
 *
 * Anthropic's `input_tokens` excludes cache reads and writes, so the total
 * is derived as the sum of all reported fields. Merging an existing usage
 * (from `message_start`) with delta usage (from `message_delta`) keeps the
 * latest value per field because Anthropic reports cumulative counts.
 */
function anthropicUsageFrom(
  usage: AnthropicUsageLike | null | undefined,
  base?: ModelUsage,
): ModelUsage | undefined {
  if (!usage) {
    return base;
  }

  const result: ModelUsage = { ...base };
  if (typeof usage.input_tokens === "number") {
    result.inputTokens = usage.input_tokens;
  }
  if (typeof usage.output_tokens === "number") {
    result.outputTokens = usage.output_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    result.cacheReadInputTokens = usage.cache_read_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === "number") {
    result.cacheWriteInputTokens = usage.cache_creation_input_tokens;
  }

  if (Object.keys(result).length === 0) {
    return base;
  }

  result.totalTokens = (result.inputTokens ?? 0) +
    (result.outputTokens ?? 0) +
    (result.cacheReadInputTokens ?? 0) +
    (result.cacheWriteInputTokens ?? 0);
  return result;
}

/**
 * Converts shared messages into Anthropic request messages.
 *
 * Anthropic only accepts the roles `"user"` and `"assistant"`: system
 * messages in history are sent as user content (the system prompt itself is
 * a top-level request field), and tool messages become user content carrying
 * `tool_result` blocks. Thinking captured in `thinkingMeta.blocks` is
 * replayed as `thinking` and `redacted_thinking` blocks in their original
 * order so multi-turn tool use keeps every block's signature intact.
 */
export function anthropicMessagesFrom(
  messages: Message[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "user") {
      result.push({ role: "user", content: textFrom(message.contents) });
    } else if (message.role === "model") {
      const content = assistantContentFrom(message);

      // Skip fully empty assistant messages. Anthropic rejects a message
      // with no content blocks.
      if (content.length === 0) {
        continue;
      }

      result.push({ role: "assistant", content });
    } else if (message.role === "tool") {
      const content: Anthropic.ToolResultBlockParam[] = [];
      for (const part of message.contents) {
        if ("toolResult" in part) {
          content.push({
            type: "tool_result",
            tool_use_id: part.toolResult.id,
            content: toolOutputString(part.toolResult.result),
            is_error: part.toolResult.result.error !== undefined,
          });
        }
      }

      // Skip tool messages without results for the same reason: Anthropic
      // rejects a message with an empty content array.
      if (content.length === 0) {
        continue;
      }

      result.push({ role: "user", content });
    }
  }

  return result;
}

function assistantContentFrom(
  message: ModelMessage,
): Anthropic.ContentBlockParam[] {
  // Thinking blocks must precede other content.
  const content: Anthropic.ContentBlockParam[] = thinkingContentFrom(message);

  for (const part of message.contents) {
    if ("text" in part) {
      content.push({ type: "text", text: part.text });
    } else if ("toolCall" in part) {
      const { id, name, props } = part.toolCall;
      content.push({ type: "tool_use", id, name, input: props });
    }
  }

  return content;
}

/**
 * Rebuilds the thinking blocks of an assistant message.
 *
 * Prefers the ordered block list captured by {@link modelMessagesFrom}, which
 * keeps each signature attached to the exact text it signs. Falls back to the
 * single-block `thinking`/`signature` shape produced by stream chunks or
 * hand-written history; a thinking block without a signature is dropped
 * because Anthropic rejects it.
 */
function thinkingContentFrom(
  message: ModelMessage,
): Anthropic.ContentBlockParam[] {
  const content: Anthropic.ContentBlockParam[] = [];

  const blocks = message.thinkingMeta?.blocks;
  if (Array.isArray(blocks)) {
    for (const block of blocks) {
      if (isThinkingBlockMeta(block)) {
        content.push({
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        });
      } else if (isRedactedThinkingBlockMeta(block)) {
        content.push({ type: "redacted_thinking", data: block.data });
      }
    }
    return content;
  }

  const signature = message.thinkingMeta?.signature;
  if (message.thinking && typeof signature === "string") {
    content.push({
      type: "thinking",
      thinking: message.thinking,
      signature,
    });
  }

  const redacted = message.thinkingMeta?.redactedThinking;
  if (Array.isArray(redacted)) {
    for (const data of redacted) {
      if (typeof data === "string") {
        content.push({ type: "redacted_thinking", data });
      }
    }
  }

  return content;
}

function isThinkingBlockMeta(
  block: unknown,
): block is Extract<AnthropicThinkingBlockMeta, { type: "thinking" }> {
  if (typeof block !== "object" || block === null) return false;
  const candidate = block as Record<string, unknown>;
  return candidate.type === "thinking" &&
    typeof candidate.thinking === "string" &&
    typeof candidate.signature === "string";
}

function isRedactedThinkingBlockMeta(
  block: unknown,
): block is Extract<AnthropicThinkingBlockMeta, { type: "redacted_thinking" }> {
  if (typeof block !== "object" || block === null) return false;
  const candidate = block as Record<string, unknown>;
  return candidate.type === "redacted_thinking" &&
    typeof candidate.data === "string";
}

/** Convert an Anthropic response into model messages.
 *
 * Throws when the response carries no usable content for a reason other
 * than a normal stop, so refusals and truncated responses fail loudly
 * instead of resolving empty.
 */
function modelMessagesFrom(
  response: Anthropic.Message,
): ModelMessage[] {
  const message: ModelMessage = {
    role: "model",
    contents: [],
    toolCalls: [],
  };
  const thinkingBlocks: AnthropicThinkingBlockMeta[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      message.contents.push({ text: block.text });
    } else if (block.type === "thinking") {
      if (block.thinking) {
        message.thinking = (message.thinking ?? "") + block.thinking;
      }
      // Each block is kept with its own signature: signatures sign the exact
      // block text, so blocks cannot be merged for replay.
      if (block.signature) {
        thinkingBlocks.push({
          type: "thinking",
          thinking: block.thinking,
          signature: block.signature,
        });
      }
    } else if (block.type === "redacted_thinking") {
      thinkingBlocks.push({ type: "redacted_thinking", data: block.data });
    } else if (block.type === "tool_use") {
      const toolCall: ToolCallContent["toolCall"] = {
        id: block.id,
        name: block.name,
        props: (block.input ?? {}) as JSONSchema,
      };
      message.toolCalls.push(toolCall);
      message.contents.push({ toolCall });
    }
  }

  if (thinkingBlocks.length) {
    message.thinkingMeta = { blocks: thinkingBlocks };
  }

  if (
    message.contents.length === 0 && message.toolCalls.length === 0 &&
    message.thinking === undefined && !message.thinkingMeta
  ) {
    if (response.stop_reason && response.stop_reason !== "end_turn") {
      throw new Error(
        `Claude returned no content (stop reason: ${response.stop_reason})`,
      );
    }
    return [];
  }

  return [message];
}

interface PendingToolCall {
  id: string;
  name: string;
  inputJSON: string;
}

interface PendingThinkingBlock {
  thinking: string;
  signature: string;
}

/** Per-index accumulation of content blocks that span multiple events. */
interface StreamState {
  toolCalls: Record<number, PendingToolCall>;
  thinking: Record<number, PendingThinkingBlock>;
  redacted: Record<number, string>;
}

/** Stream the response as incremental model results.
 *
 * Mirrors the `generate` error behavior: a stream that ends without usable
 * content for a reason other than a normal stop (e.g. a refusal) throws
 * instead of completing empty.
 */
async function* streamMessages(
  stream: AsyncIterable<Anthropic.RawMessageStreamEvent>,
  modelId: ClaudeModels,
) {
  const state: StreamState = { toolCalls: {}, thinking: {}, redacted: {} };
  let yielded = false;
  let stopReason: Anthropic.StopReason | null = null;
  let usage: ModelUsage | undefined;

  for await (const event of stream) {
    if (event.type === "message_start") {
      usage = anthropicUsageFrom(event.message.usage, usage);
      continue;
    }

    if (event.type === "message_delta") {
      stopReason = event.delta.stop_reason;
      usage = anthropicUsageFrom(event.usage, usage);
      continue;
    }

    const message = deltaMessageFrom(event, state);
    if (message) {
      yielded = true;
      yield modelResultFrom(modelId, [message]);
    }
  }

  if (!yielded && stopReason && stopReason !== "end_turn") {
    throw new Error(
      `Claude returned no content (stop reason: ${stopReason})`,
    );
  }

  if (usage) {
    yield modelResultFrom(modelId, [], usage);
  }
}

function deltaMessageFrom(
  event: Anthropic.RawMessageStreamEvent,
  state: StreamState,
): ModelMessage | undefined {
  if (event.type === "content_block_start") {
    const block = event.content_block;
    if (block.type === "tool_use") {
      state.toolCalls[event.index] = {
        id: block.id,
        name: block.name,
        inputJSON: "",
      };
    } else if (block.type === "thinking") {
      state.thinking[event.index] = {
        thinking: block.thinking,
        signature: block.signature,
      };
    } else if (block.type === "redacted_thinking") {
      // Redacted thinking has no deltas; the data arrives complete here.
      state.redacted[event.index] = block.data;
    }
    return undefined;
  }

  if (event.type === "content_block_delta") {
    const { delta } = event;
    if (delta.type === "text_delta") {
      return { role: "model", contents: [{ text: delta.text }], toolCalls: [] };
    }
    if (delta.type === "thinking_delta") {
      const pending = state.thinking[event.index];
      if (pending) {
        pending.thinking += delta.thinking;
      }
      return {
        role: "model",
        contents: [],
        toolCalls: [],
        thinking: delta.thinking,
      };
    }
    if (delta.type === "signature_delta") {
      const pending = state.thinking[event.index];
      if (pending) {
        pending.signature += delta.signature;
      }
      return undefined;
    }
    if (delta.type === "input_json_delta") {
      const pending = state.toolCalls[event.index];
      if (pending) {
        pending.inputJSON += delta.partial_json;
      }
      return undefined;
    }
    return undefined;
  }

  // Multi-event blocks are emitted once they are complete: tool calls so
  // their input JSON parses, thinking blocks so the signature stays paired
  // with the exact text it signs.
  if (event.type === "content_block_stop") {
    return completedBlockFrom(event.index, state);
  }

  return undefined;
}

function completedBlockFrom(
  index: number,
  state: StreamState,
): ModelMessage | undefined {
  const pendingToolCall = state.toolCalls[index];
  if (pendingToolCall) {
    delete state.toolCalls[index];

    const toolCall: ToolCallContent["toolCall"] = {
      id: pendingToolCall.id,
      name: pendingToolCall.name,
      props: parseToolInput(pendingToolCall.name, pendingToolCall.inputJSON),
    };
    return {
      role: "model",
      contents: [{ toolCall }],
      toolCalls: [toolCall],
    };
  }

  // The thinking text was already streamed via thinking deltas; this chunk
  // only carries the replay metadata. Blocks without a signature are dropped
  // because Anthropic rejects them.
  const pendingThinking = state.thinking[index];
  if (pendingThinking) {
    delete state.thinking[index];

    if (!pendingThinking.signature) {
      return undefined;
    }
    const block: AnthropicThinkingBlockMeta = {
      type: "thinking",
      thinking: pendingThinking.thinking,
      signature: pendingThinking.signature,
    };
    return {
      role: "model",
      contents: [],
      toolCalls: [],
      thinkingMeta: { blocks: [block] },
    };
  }

  const redacted = state.redacted[index];
  if (redacted !== undefined) {
    delete state.redacted[index];

    const block: AnthropicThinkingBlockMeta = {
      type: "redacted_thinking",
      data: redacted,
    };
    return {
      role: "model",
      contents: [],
      toolCalls: [],
      thinkingMeta: { blocks: [block] },
    };
  }

  return undefined;
}

/**
 * Merges streamed chunk messages into a single replayable model message.
 *
 * {@link AnthropicModel.stream} yields one partial message per chunk;
 * appending those directly to history would lose thinking signatures. This
 * helper concatenates text, tool calls, thinking text, and
 * `thinkingMeta.blocks` so the result round-trips through
 * {@link anthropicMessagesFrom}. Non-model messages are ignored.
 *
 * @param messages Chunk messages collected from a stream, in order.
 * @returns The merged message, or `undefined` when there is nothing to merge.
 */
export function mergeAnthropicModelMessages(
  messages: Message[],
): ModelMessage | undefined {
  const merged: ModelMessage = { role: "model", contents: [], toolCalls: [] };
  const blocks: AnthropicThinkingBlockMeta[] = [];

  for (const message of messages) {
    if (message.role !== "model") {
      continue;
    }

    for (const part of message.contents) {
      const last = merged.contents.at(-1);
      if ("text" in part && last && "text" in last) {
        last.text += part.text;
      } else if ("text" in part) {
        merged.contents.push({ text: part.text });
      } else {
        merged.contents.push(part);
      }
    }
    merged.toolCalls.push(...message.toolCalls);

    if (message.thinking) {
      merged.thinking = (merged.thinking ?? "") + message.thinking;
    }

    const chunkBlocks = message.thinkingMeta?.blocks;
    if (Array.isArray(chunkBlocks)) {
      for (const block of chunkBlocks) {
        if (isThinkingBlockMeta(block) || isRedactedThinkingBlockMeta(block)) {
          blocks.push(block);
        }
      }
    }
  }

  if (blocks.length) {
    merged.thinkingMeta = { blocks };
  }

  if (
    merged.contents.length === 0 && merged.toolCalls.length === 0 &&
    merged.thinking === undefined && !merged.thinkingMeta
  ) {
    return undefined;
  }

  return merged;
}

/** Parse accumulated tool input JSON.
 *
 * An empty string means the tool was called without arguments. Malformed
 * JSON (e.g. a stream truncated by `max_tokens` mid-tool-call) throws so the
 * tool is never invoked with silently emptied props.
 */
function parseToolInput(name: string, inputJSON: string): JSONSchema {
  if (!inputJSON) {
    return {};
  }

  try {
    return JSON.parse(inputJSON);
  } catch (cause) {
    throw new Error(
      `Claude returned invalid input JSON for tool "${name}"`,
      { cause },
    );
  }
}

function textFrom(contents: string | TextContent[]): string {
  return typeof contents === "string"
    ? contents
    : contents.map((content) => content.text).join("");
}

/**
 * Serializes a tool execution result into the string content Anthropic's
 * `tool_result` block carries. Errors take precedence over output, and
 * non-string payloads are JSON-encoded.
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
 * Converts Huuma {@link Tool}s into Anthropic tool definitions.
 */
export function anthropicToolsFrom(
  // deno-lint-ignore no-explicit-any
  tools: Tool<any>[],
): Anthropic.Tool[] {
  return tools.map(({ name, description, input }) => ({
    name,
    description,
    input_schema: input.jsonSchema() as Anthropic.Tool.InputSchema,
  }));
}
