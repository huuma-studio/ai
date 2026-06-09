/**
 * Common model interfaces implemented by provider adapters.
 *
 * @example
 * ```typescript
 * import type { BaseModel } from "jsr:@huuma/ai/model";
 *
 * const result = await model.generate({
 *   modelId: "gpt-4o-mini",
 *   messages: [{ role: "user", contents: "Hello!" }],
 * });
 * ```
 *
 * @module
 */
import type { Message } from "../mod.ts";
export type {
  Message,
  MessageRole,
  MessageWithRole,
  ModelMessage,
  SystemMessage,
  TextContent,
  ToolCallContent,
  ToolMessage,
  ToolResultContent,
  UserMessage,
} from "../mod.ts";
/** Common interface implemented by all model adapters. */
export interface BaseModel<T extends string = string> {
  /** Generate a complete model response.
   *
   * @param options Implementation-specific generate options (e.g. {@link OpenAIGenerateOptions}).
   */
  generate(args: unknown): Promise<ModelResult<T>>;
  /** Stream incremental model responses.
   *
   * @param options Implementation-specific stream options (e.g. {@link OpenAIGenerateOptions}).
   */
  stream(args: unknown): Promise<AsyncGenerator<ModelResult>>;
}

/** Normalized result returned by model adapters. */
export interface ModelResult<T extends string = string> {
  /** Identifier of the model that produced the result. */
  modelId: T;
  /** Messages produced by the model. */
  messages: Message[];
}
