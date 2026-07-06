/**
 * Agent orchestration built on top of models, workflows, and tools.
 *
 * @example
 * ```typescript
 * import { agent } from "jsr:@huuma/ai/agent";
 * import { openai } from "jsr:@huuma/ai/models/openai";
 * import { cli } from "jsr:@huuma/ai/tools";
 *
 * const assistant = agent({
 *   model: openai({ apiKey: Deno.env.get("OPENAI_API_KEY") }),
 *   modelId: "gpt-4o-mini",
 *   systemPrompt: "You are a helpful assistant.",
 *   tools: [cli({ allowedCommands: ["deno"] })],
 *   // Optionally observe each emitted message as the run progresses,
 *   // along with the run's accumulated token usage.
 *   onMessage: (message, usage) => console.log(message, usage?.totalTokens),
 * });
 *
 * const messages = await assistant.run("What is the current Deno version?");
 * console.log(messages.at(-1));
 *
 * // Continue the conversation by passing the previous messages as history.
 * const followUp = await assistant.run("And the previous version?", messages);
 * ```
 *
 * @module
 */
import { callTool, type Tool, Tools } from "@/tools/mod.ts";
import { type BaseModel, type ModelUsage, sumModelUsage } from "@/model/mod.ts";
export type { BaseModel, ModelResult, ModelUsage } from "@/model/mod.ts";
export { sumModelUsage } from "@/model/mod.ts";
export type { JSONSchema, Schema, Tool } from "@/tools/mod.ts";
export type {
  FileContent,
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
} from "@/mod.ts";
import type { FileContent, Message, TextContent } from "@/mod.ts";
import { decision, step, workflow } from "@/workflow/mod.ts";

/** Callback invoked for each message emitted during an agent run.
 *
 * The callback is awaited before the run continues, so within a single
 * run messages are delivered sequentially and in order. Concurrent
 * {@link Agent.run} calls on the same agent share the agent-level
 * callback, and their messages interleave without attribution; pass a
 * per-run callback via {@link RunOptions} to tell runs apart. Errors
 * thrown by the callback are caught and logged as a warning; they do
 * not abort the run.
 *
 * The second argument is a snapshot of the run's token usage: the
 * {@link ModelUsage} of all model calls of the run summed so far, not
 * the usage of an individual message. It is `undefined` until the first
 * model call reports usage, and the value passed with the last emitted
 * message covers the whole run.
 */
export type OnMessage = (
  message: Message,
  usage?: ModelUsage,
) => void | Promise<void>;

/** Options for a single agent run. */
export interface RunOptions {
  /** Called for each message emitted during this run. Overrides the
   * agent-level {@link AgentOptions.onMessage} callback. */
  onMessage?: OnMessage;
}

/** Options used to create an agent. */
export interface AgentOptions<T extends string> {
  /** Model adapter used to generate responses. */
  model: BaseModel<T>;
  /** Model identifier passed to the adapter. */
  modelId: T;
  /** Tools available to the agent. */
  // deno-lint-ignore no-explicit-any
  tools?: Tool<any>[];
  /** System prompt sent with each model request. */
  systemPrompt: string;
  /** Called for each message emitted during a run: the user prompt,
   * every model message, and every tool result. Messages passed in as
   * history are not emitted. Shared by all runs of this agent — for
   * concurrent runs, prefer the per-run {@link RunOptions.onMessage}. */
  onMessage?: OnMessage;
}

/** Agent that loops over model responses and tool calls. */
export class Agent<T extends string> {
  #tools = new Tools([]);
  #model: BaseModel<T>;
  #modelId: T;
  #systemPrompt: string;
  #onMessage?: OnMessage;
  /** Create an agent instance. */
  constructor(
    { model, modelId, tools, systemPrompt, onMessage }: AgentOptions<T>,
  ) {
    this.#model = model;
    this.#modelId = modelId;
    this.#systemPrompt = systemPrompt ?? "";
    this.#onMessage = onMessage;
    tools?.forEach((tool) => this.#tools.add(tool));
  }

  /** Run the agent with a user prompt and return the conversation messages.
   *
   * @param prompt User message to send to the model, either as plain text
   * or as text and file parts. Media support depends on the model adapter
   * and provider; unsupported mimeType/source combinations throw at
   * request time.
   * @param history Prior conversation messages to continue from.
   * @param options Per-run options such as an {@link OnMessage} callback.
   * @returns The full conversation history including tool results.
   */
  async run(
    prompt: string | (TextContent | FileContent)[],
    history: Message[] = [],
    options?: RunOptions,
  ): Promise<Message[]> {
    const onMessage = options?.onMessage ?? this.#onMessage;
    let runUsage: ModelUsage | undefined;
    const emit = async (...messages: Message[]) => {
      for (const message of messages) {
        try {
          // A copy keeps the accumulated usage safe from consumer mutation.
          await onMessage?.(message, runUsage ? { ...runUsage } : undefined);
        } catch (error) {
          console.warn("[Huuma Agent] onMessage callback failed:", error);
        }
      }
    };

    const askAction = async (messages: Message[]) => {
      const result = await this.#model.generate({
        modelId: this.#modelId,
        system: this.#systemPrompt,
        messages,
        tools: this.#tools.all(),
      });
      runUsage = sumModelUsage(runUsage, result.usage);
      await emit(...result.messages);
      return [...messages, ...result.messages];
    };
    const askStep = step(askAction);

    const executeToolCalls = callTool(this.#tools);
    const callToolStep = step(async (messages: Message[]) => {
      const updated = await executeToolCalls(messages);
      await emit(...updated.slice(messages.length));
      return updated;
    });

    callToolStep.next(askStep);

    const toolCallCheck = decision<Message[]>({
      condition: (state) => {
        const message = [...state].pop();
        return message?.role === "model" && !!message.toolCalls?.length;
      },
      then: callToolStep,
      else: step((messages) => {
        return messages;
      }),
    });
    askStep.next(toolCallCheck);

    const userMessage: Message = { role: "user", contents: prompt };
    await emit(userMessage);

    const loop = workflow({
      name: "Huuma Agent",
      state: [...history, userMessage],
      start: askStep,
    });

    return await loop.start();
  }
}

/** Create an agent.
 *
 * @param options Configuration for the agent including model, modelId, and system prompt.
 * @returns A new {@link Agent} instance ready to run.
 */
export function agent<T extends string>(options: AgentOptions<T>): Agent<T> {
  return new Agent<T>({ ...options });
}
