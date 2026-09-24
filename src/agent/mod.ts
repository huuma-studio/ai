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
 *
 * // Runs make at most 100 model calls by default (`maxModelCalls`), and a
 * // signal stops a run early — run() then rejects with the abort reason.
 * const controller = new AbortController();
 * await assistant.run("Upgrade the dependencies.", [], {
 *   signal: controller.signal,
 *   maxModelCalls: 20,
 * });
 * ```
 *
 * @module
 */
import { mapSettled, validateMaxConcurrency } from "@/tools/concurrency.ts";
import {
  callTool,
  tool,
  type Tool,
  ToolOutput,
  Tools,
} from "@/tools/mod.ts";
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
import type {
  FileContent,
  Message,
  TextContent,
  ToolResultContent,
} from "@/mod.ts";
import { enums, object, string } from "@huuma/validate";

/** Reserved name of the opt-in control tool that ends a run with a
 * structured `question` or `completion` outcome. */
export const FINISH_TURN_TOOL = "finish_turn";

/** Outcome reported by a successful `finish_turn` call. */
export type FinishTurnOutcome = "question" | "completion";

/** Validated payload echoed by a successful `finish_turn` result. */
export interface FinishTurnOutput {
  outcome: FinishTurnOutcome;
  message: string;
}

const finishTurnTool = tool({
  name: FINISH_TURN_TOOL,
  description:
    "End the current run with a structured outcome. Call this exactly once per turn when you are blocked on user input (outcome: \"question\") or when the requested work is complete (outcome: \"completion\"). The message field carries the natural-language question or completion summary intended for the user.",
  input: object({
    outcome: enums(["question", "completion"]),
    message: string(),
  }),
  fn: ({ outcome, message }: { outcome: FinishTurnOutcome; message: string }): FinishTurnOutput => {
    if (message.trim().length === 0) {
      throw new Error(
        "finish_turn message must contain at least one non-whitespace character",
      );
    }
    return { outcome, message };
  },
});

/** Returns `true` when a tool-result content part is a successful
 * `finish_turn` result (no error, structured output present). */
function isSuccessfulFinishTurn(content: ToolResultContent): boolean {
  if (content.toolResult.name !== FINISH_TURN_TOOL) return false;
  const result = content.toolResult.result;
  return result.error === undefined && result.output !== undefined;
}

/** Returns `true` when the last message is a tool message containing at
 * least one successful `finish_turn` result. */
function endsWithSuccessfulFinishTurn(message: Message | undefined): boolean {
  if (!message || message.role !== "tool") return false;
  return message.contents.some(
    (content) =>
      "toolResult" in content && isSuccessfulFinishTurn(content),
  );
}

/** Format a thrown/rejected value into a tool-result error string,
 * matching {@linkcode callTool}'s behavior so duplicate-`finish_turn`
 * errors render identically to ordinary tool failures. */
function formatRejection(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    const serialized = JSON.stringify(reason);
    if (serialized !== undefined) return serialized;
  } catch {
    // Fall through to String().
  }
  return String(reason);
}

/** Default upper bound on model calls per run, applied when neither
 * {@link AgentOptions.maxModelCalls} nor {@link RunOptions.maxModelCalls}
 * is set. */
export const DEFAULT_MAX_MODEL_CALLS = 100;

/** Validate a `maxModelCalls` option. `undefined` means "not configured";
 * `Infinity` disables the cap; anything else must be a positive integer. */
function validateMaxModelCalls(maxModelCalls: number | undefined): void {
  if (
    maxModelCalls !== undefined && maxModelCalls !== Infinity &&
    (!Number.isInteger(maxModelCalls) || maxModelCalls < 1)
  ) {
    throw new TypeError(
      "maxModelCalls must be a positive integer or Infinity",
    );
  }
}

/** Reason a run rejects with once its signal aborts, following the
 * `AbortError` convention of {@linkcode Tool.call}. */
function runAbortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Agent run aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw runAbortReason(signal);
}

/** Settle with `promise`, or reject with the abort reason as soon as
 * `signal` aborts — whichever happens first. Adapters that cannot cancel
 * their transport would otherwise hold the run until the provider
 * responds. The listener is removed once `promise` settles, so a
 * long-lived signal does not accumulate one listener per model call. */
function raceAbort<R>(promise: Promise<R>, signal?: AbortSignal): Promise<R> {
  if (!signal) return promise;
  return new Promise<R>((resolve, reject) => {
    const onAbort = () => reject(runAbortReason(signal));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort)
    );
  });
}

/** Name of the most recent tool the model called, used to make a
 * `maxModelCalls` error point at the likely loop. */
function lastToolCallName(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "model" && message.toolCalls?.length) {
      return message.toolCalls.at(-1)?.name;
    }
  }
  return undefined;
}

/** Callback invoked for each message emitted during an agent run.
 *
 * The callback is awaited before the run continues, so within a single
 * run messages are delivered sequentially and in order. Concurrent
 * {@link Agent.run} calls on the same agent share the agent-level
 * callback, and their messages interleave without attribution; pass a
 * per-run callback via {@link RunOptions} to tell runs apart.
 *
 * The second argument is a snapshot of the run's token usage: the
 * {@link ModelUsage} of all model calls of the run summed so far, not
 * the usage of an individual message. It is `undefined` until the first
 * model call reports usage, and the value passed with the last emitted
 * message covers the whole run.
 *
 * The handling of a rejected callback is governed by
 * {@link AgentOptions.onMessageError} / {@link RunOptions.onMessageError}.
 */
export type OnMessage = (
  message: Message,
  usage?: ModelUsage,
) => void | Promise<void>;

/** Policy for handling {@link OnMessage} callback rejections during a run.
 *
 * - `"warn"` (default): the rejection is logged as a warning and the run
 *   continues.
 * - `"throw"`: the rejection is propagated from {@link Agent.run}
 *   immediately. No further model or tool operation runs after the failed
 *   delivery boundary.
 */
export type OnMessageError = "warn" | "throw";

/** Options for a single agent run. */
export interface RunOptions {
  /** Called for each message emitted during this run. Overrides the
   * agent-level {@link AgentOptions.onMessage} callback. */
  onMessage?: OnMessage;
  /** Policy for handling rejections from this run's {@link onMessage}
   * callback. Overrides the agent-level
   * {@link AgentOptions.onMessageError}. Defaults to `"warn"` when
   * unset at both levels. */
  onMessageError?: OnMessageError;
  /** Maximum number of tool calls from a single model message that may
   * overlap in execution during this run. Overrides the agent-level
   * {@link AgentOptions.maxConcurrency} for this run. */
  maxConcurrency?: number;
  /** Maximum number of model calls this run may make. When the
   * agent-level {@link AgentOptions.maxModelCalls} is also set, the
   * smaller of the two applies. */
  maxModelCalls?: number;
  /** Cancels the run. Once aborted, {@link Agent.run} rejects with the
   * signal's reason and starts no further model call or tool execution.
   * The signal is forwarded to the model adapter and to every tool call,
   * so in-flight work can stop as well where it supports cancellation. */
  signal?: AbortSignal;
}

/** Options used to create an agent. */
export interface AgentOptions<T extends string> {
  /** Model adapter used to generate responses. */
  model: BaseModel<T>;
  /** Model identifier passed to the adapter. */
  modelId: T;
  /** Tools available to the agent. A tool named `finish_turn` is
   * reserved by the runtime and rejected at construction; enable the
   * built-in control tool with {@link finishTurn} instead. */
  // deno-lint-ignore no-explicit-any
  tools?: Tool<any>[];
  /** System prompt sent with each model request. */
  systemPrompt: string;
  /** Called for each message emitted during a run: the user prompt,
   * every model message, and every tool result. Messages passed in as
   * history are not emitted. Shared by all runs of this agent — for
   * concurrent runs, prefer the per-run {@link RunOptions.onMessage}. */
  onMessage?: OnMessage;
  /** Policy for handling rejections from the agent-level
   * {@link onMessage} callback. Per-run {@link RunOptions.onMessageError}
   * overrides this. Defaults to `"warn"`. */
  onMessageError?: OnMessageError;
  /** Opt in to the built-in `finish_turn` control tool. When `true`, the
   * runtime registers a tool named `finish_turn` that lets the model end
   * a run with a structured `question` or `completion` outcome. Fixed
   * for the lifetime of the Agent; there is no per-run override.
   * Defaults to `false`. */
  finishTurn?: boolean;
  /**
   * Maximum number of tool calls from a single model message that may
   * overlap in execution. Models control their own batch size, so
   * without a cap one message can fan out into dozens of simultaneous
   * processes, fetches, and buffers — a memory and event-loop spike
   * under the model's control that degrades every run sharing the
   * process. Capping a batch trades throughput for that protection:
   * queued calls wait for a free slot instead of competing. Defaults to
   * unlimited (the behavior of every prior release); per-run
   * {@link RunOptions.maxConcurrency} overrides this value.
   */
  maxConcurrency?: number;
  /**
   * Maximum number of model calls a single run may make. A model that
   * keeps requesting tools would otherwise loop — and bill — without
   * bound. Exceeding the cap rejects {@link Agent.run} before the next
   * model call. Defaults to {@link DEFAULT_MAX_MODEL_CALLS}; pass
   * `Infinity` to disable the cap. Per-run
   * {@link RunOptions.maxModelCalls} can only lower it.
   */
  maxModelCalls?: number;
}

/** Agent that loops over model responses and tool calls. */
export class Agent<T extends string> {
  #tools = new Tools([]);
  #model: BaseModel<T>;
  #modelId: T;
  #systemPrompt: string;
  #onMessage?: OnMessage;
  #onMessageError?: OnMessageError;
  #finishTurn: boolean;
  #maxConcurrency?: number;
  #maxModelCalls?: number;
  /** Create an agent instance. */
  constructor(
    {
      model,
      modelId,
      tools,
      systemPrompt,
      onMessage,
      onMessageError,
      finishTurn,
      maxConcurrency,
      maxModelCalls,
    }: AgentOptions<T>,
  ) {
    this.#model = model;
    this.#modelId = modelId;
    this.#systemPrompt = systemPrompt ?? "";
    this.#onMessage = onMessage;
    this.#onMessageError = onMessageError;
    this.#finishTurn = finishTurn ?? false;
    validateMaxConcurrency(maxConcurrency);
    this.#maxConcurrency = maxConcurrency;
    validateMaxModelCalls(maxModelCalls);
    this.#maxModelCalls = maxModelCalls;
    tools?.forEach((tool) => {
      if (tool.name === FINISH_TURN_TOOL) {
        throw new Error(
          `Tool name "${FINISH_TURN_TOOL}" is reserved by the agent runtime. Rename your tool or enable the built-in via the \`finishTurn\` option.`,
        );
      }
      this.#tools.add(tool);
    });
    if (this.#finishTurn) this.#tools.add(finishTurnTool);
  }

  /** Run the agent with a user prompt and return the conversation messages.
   *
   * @param prompt User message to send to the model, either as plain text
   * or as text and file parts. Media support depends on the model adapter
   * and provider; unsupported mimeType/source combinations throw at
   * request time.
   * @param history Prior conversation messages to continue from.
   * @param options Per-run options such as an {@link OnMessage} callback
   * or a cancellation signal.
   * @returns The full conversation history including tool results.
   * @throws The signal's abort reason when {@link RunOptions.signal}
   * aborts, or an `Error` when the run exceeds its `maxModelCalls` cap.
   */
  async run(
    prompt: string | (TextContent | FileContent)[],
    history: Message[] = [],
    options?: RunOptions,
  ): Promise<Message[]> {
    const maxConcurrency = options?.maxConcurrency ??
      this.#maxConcurrency;
    validateMaxConcurrency(maxConcurrency);
    validateMaxModelCalls(options?.maxModelCalls);
    const configuredCaps = [this.#maxModelCalls, options?.maxModelCalls]
      .filter((cap): cap is number => cap !== undefined);
    const maxModelCalls = configuredCaps.length > 0
      ? Math.min(...configuredCaps)
      : DEFAULT_MAX_MODEL_CALLS;
    const signal = options?.signal;
    throwIfAborted(signal);
    const onMessage = options?.onMessage ?? this.#onMessage;
    const onMessageError = options?.onMessageError ??
      this.#onMessageError ?? "warn";
    let runUsage: ModelUsage | undefined;
    const emit = async (...messages: Message[]) => {
      for (const message of messages) {
        if (!onMessage) continue;
        try {
          // A copy keeps the accumulated usage safe from consumer mutation.
          await onMessage(message, runUsage ? { ...runUsage } : undefined);
        } catch (error) {
          if (onMessageError === "throw") throw error;
          console.warn("[Huuma Agent] onMessage callback failed:", error);
        }
      }
    };

    const userMessage: Message = { role: "user", contents: prompt };
    await emit(userMessage);

    // One tools snapshot per run: the collection is frozen at
    // construction, so every model request can share a single array.
    const tools = this.#tools.all();

    // Iterative loop instead of a cyclic Step chain. A recursive chain
    // suspends one frame set per round until the whole run resolves —
    // possibly pinning each round's message array as well, depending
    // on the engine's frame liveness — so a long run can retain O(n^2)
    // memory in conversation length. The loop keeps only the current
    // array alive; each append still produces a fresh array so every
    // model request sees an immutable snapshot.
    let messages: Message[] = [...history, userMessage];
    let modelCalls = 0;
    while (true) {
      throwIfAborted(signal);
      if (modelCalls >= maxModelCalls) {
        const lastTool = lastToolCallName(messages);
        throw new Error(
          `Agent run exceeded maxModelCalls (${maxModelCalls}) without finishing` +
            (lastTool ? `; last tool called: "${lastTool}"` : ""),
        );
      }
      modelCalls += 1;
      const result = await raceAbort(
        this.#model.generate({
          modelId: this.#modelId,
          system: this.#systemPrompt,
          messages,
          tools,
          signal,
        }),
        signal,
      );
      runUsage = sumModelUsage(runUsage, result.usage);
      await emit(...result.messages);
      messages = [...messages, ...result.messages];

      const last = messages.at(-1);
      if (last?.role !== "model" || !last.toolCalls?.length) break;

      throwIfAborted(signal);
      const updated = await this.#executeToolCalls(
        messages,
        maxConcurrency,
        signal,
      );
      await emit(...updated.slice(messages.length));
      messages = updated;

      // Terminate when the produced tool message contains a successful
      // `finish_turn` result; otherwise loop back to the model. Sibling
      // tool failures do not cancel a valid finish_turn.
      if (endsWithSuccessfulFinishTurn(messages.at(-1))) break;
    }

    // An abort during the final onMessage delivery must still reject:
    // run() settles successfully only if the signal never fired.
    throwIfAborted(signal);
    return messages;
  }

  /** Execute the tool calls in the last model message, appending a single
   * native tool message with one result per call.
   *
   * When `finishTurn` is enabled and a model message contains more than
   * one `finish_turn` call, every `finish_turn` in that batch receives a
   * deterministic error result instructing the model to issue exactly
   * one, and the batch is non-terminal. Other tool calls in the same
   * message use the existing execution semantics.
   *
   * `maxConcurrency` bounds how many calls of the batch may overlap,
   * uniformly across both the delegated `callTool` path and the
   * duplicate-`finish_turn` path, and `signal` reaches every call on
   * both paths. */
  async #executeToolCalls(
    messages: Message[],
    maxConcurrency?: number,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    const lastMessage = messages.at(-1);
    if (!lastMessage || lastMessage.role !== "model") return messages;
    const toolCalls = lastMessage.toolCalls;
    if (!toolCalls?.length) return messages;

    const finishTurnCount = toolCalls.filter((tc) =>
      tc.name === FINISH_TURN_TOOL
    ).length;
    if (!this.#finishTurn || finishTurnCount <= 1) {
      return await callTool(this.#tools, { maxConcurrency, signal })(messages);
    }

    const duplicateError =
      "Issue exactly one finish_turn call per turn; multiple finish_turn calls in a single response are not allowed.";
    const settled = await mapSettled(
      toolCalls,
      async (toolCall) => {
        if (toolCall.name === FINISH_TURN_TOOL) {
          throw new Error(duplicateError);
        }
        const tool = this.#tools.get(toolCall.name);
        const output = await tool.call(toolCall.props, { signal });
        const wrapped = output instanceof ToolOutput;
        return {
          toolResult: {
            id: toolCall.id,
            name: toolCall.name,
            result: { output: wrapped ? output.output : output },
            ...(wrapped ? { files: output.files } : {}),
          },
        } satisfies ToolResultContent;
      },
      maxConcurrency,
    );

    const contents = settled.map((outcome, i): ToolResultContent => {
      if (outcome.status === "fulfilled") return outcome.value;
      const toolCall = toolCalls[i];
      return {
        toolResult: {
          id: toolCall.id,
          name: toolCall.name,
          result: { error: formatRejection(outcome.reason) },
        },
      };
    });

    return [...messages, { role: "tool", contents }];
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
