/**
 * Z.AI (GLM) model adapter for the Huuma AI model interface.
 *
 * Targets the **GLM Coding Plan** subscription endpoint, which is fully
 * OpenAI Chat Completions-compatible. The adapter wraps the OpenAI SDK with
 * a pre-configured base URL and adds type-safe model IDs plus Z.AI-specific
 * request options.
 *
 * @example
 * ```typescript
 * import { zai } from "jsr:@huuma/ai/models/zai";
 *
 * const model = zai({ apiKey: Deno.env.get("ZAI_CODING_API_KEY") });
 * const result = await model.generate({
 *   modelId: "glm-5.3",
 *   messages: [{ role: "user", contents: "Write a REST API in Go." }],
 * });
 * ```
 *
 * @module
 */
import type { BaseModel, ModelResult } from "@/model/mod.ts";
import type { Message } from "@/mod.ts";
import OpenAI from "openai";
import type { Tool } from "@/tools/mod.ts";
import {
  modelMessageFrom,
  openAIMessagesFrom,
  openAIToolsFrom,
  streamCompletions,
  usageFrom,
  type OpenAIRequestOptions,
} from "../openai/mod.ts";

/** Default base URL for the Z.AI Coding Plan endpoint. */
const DEFAULT_BASE_URL = "https://api.z.ai/api/coding/paas/v4/";

/**
 * Z.AI (GLM) chat model identifiers.
 *
 * Known Coding Plan models are listed for autocompletion, while the open
 * string branch keeps the wrapper usable with newly released models.
 * Requests for GLM-5.2/GLM-5.1 auto-route to GLM-5.3.
 */
export type ZAIModels =
  | "glm-5.3"
  | "glm-5-turbo"
  | "glm-4.7"
  // deno-lint-ignore ban-types
  | (string & {});

/** Configuration for the Z.AI thinking / Preserved Thinking feature. */
export interface ZAIThinkingOptions {
  /** Enable or disable thinking. */
  type: "enabled" | "disabled";
  /** When false, prior thinking is retained for cache hit-rate continuity. */
  clear_thinking?: boolean;
}

/**
 * Additional Z.AI chat completion request options.
 *
 * Extends {@link OpenAIRequestOptions} with Z.AI-specific parameters that the
 * OpenAI SDK passes through to the API as extra body fields.
 */
export type ZAIRequestOptions = OpenAIRequestOptions & {
  /** Controls Preserved Thinking (enabled by default on the Coding Plan). */
  thinking?: ZAIThinkingOptions;
  /** Reasoning effort level. */
  reasoning_effort?: "low" | "medium" | "high" | "max";
  /** Whether to use sampling (temperature/top_p) instead of greedy decoding. */
  do_sample?: boolean;
  /** Whether to stream tool-call arguments incrementally. */
  tool_stream?: boolean;
};

/**
 * Options for configuring the Z.AI adapter.
 */
export interface ZAIOptions {
  /** Coding Plan API key. Falls back to `ZAI_CODING_API_KEY` env var. */
  apiKey?: string;
  /** Override the default Coding Plan base URL. */
  baseURL?: string;
}

/**
 * Options passed to {@link ZAIModel.generate} and {@link ZAIModel.stream}.
 */
export interface ZAIGenerateOptions {
  /** The model identifier to use. */
  modelId: ZAIModels;

  /** Conversation history. */
  messages: Message[];

  /** Optional system prompt prepended to the message list. */
  system?: string;

  /** Tools available to the model. */
  // deno-lint-ignore no-explicit-any
  tools?: Tool<any>[];

  /** Additional Z.AI chat completion options. */
  options?: ZAIRequestOptions;
}

/**
 * Wrapper around the OpenAI SDK providing a unified {@link BaseModel}
 * interface for the Z.AI Coding Plan endpoint.
 */
export class ZAIModel implements BaseModel<ZAIModels> {
  #client: OpenAI;

  /**
   * Create a new Z.AI model adapter.
   *
   * @param options Configuration including API key and optional base URL override.
   */
  constructor(options: ZAIOptions = {}) {
    this.#client = new OpenAI({
      apiKey: options.apiKey ?? Deno.env.get("ZAI_CODING_API_KEY"),
      baseURL: options.baseURL ?? DEFAULT_BASE_URL,
    });
  }

  /**
   * Sends a single non-streaming chat completion request.
   *
   * @param options Generation options including model ID, messages, and optional tools.
   * @returns A normalized {@link ModelResult}.
   */
  async generate(
    { modelId, messages, tools, system, options }: ZAIGenerateOptions,
  ): Promise<ModelResult<ZAIModels>> {
    const response = await this.#client.chat.completions.create({
      ...options,
      model: modelId,
      messages: zaiMessagesFrom(messages, system),
      tools: tools?.length ? openAIToolsFrom(tools) : undefined,
      stream: false,
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No choices returned from Z.AI");
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
    { modelId, messages, tools, system, options }: ZAIGenerateOptions,
  ): Promise<AsyncGenerator<ModelResult<ZAIModels>>> {
    const stream = await this.#client.chat.completions.create({
      ...options,
      model: modelId,
      messages: zaiMessagesFrom(messages, system),
      tools: tools?.length ? openAIToolsFrom(tools) : undefined,
      stream: true,
      stream_options: { include_usage: true },
    } as OpenAI.Chat.ChatCompletionCreateParamsStreaming);

    return streamCompletions(stream, modelId);
  }
}

/**
 * Converts Huuma {@link Message}s into the format expected by the Z.AI
 * chat completions API.
 *
 * Delegates to {@link openAIMessagesFrom} with `preserveThinking` enabled.
 * Z.AI's Coding Plan endpoint accepts and expects `reasoning_content` in
 * assistant messages for Preserved Thinking (enabled by default); sending
 * incomplete or missing thinking blocks degrades model performance and
 * cache hit rates.
 *
 * Assistant messages without a `thinking` field are left untouched — no
 * null or empty `reasoning_content` is sent. Thinking-only messages (no
 * text content or tool calls) are included rather than skipped so the
 * reasoning state carries across tool-call iterations.
 */
export function zaiMessagesFrom(
  messages: Message[],
  system?: string,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return openAIMessagesFrom(messages, system, { preserveThinking: true });
}

/**
 * Factory function that creates a {@link ZAIModel}.
 *
 * @param options Optional configuration including API key and base URL.
 * @returns A configured {@link ZAIModel} instance.
 *
 * @example
 * ```typescript
 * const model = zai({ apiKey: Deno.env.get("ZAI_CODING_API_KEY") });
 * ```
 */
export function zai(options?: ZAIOptions): ZAIModel {
  return new ZAIModel(options);
}