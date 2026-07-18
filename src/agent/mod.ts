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
import { decision, step, workflow } from "@/workflow/mod.ts";

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
    }: AgentOptions<T>,
  ) {
    this.#model = model;
    this.#modelId = modelId;
    this.#systemPrompt = systemPrompt ?? "";
    this.#onMessage = onMessage;
    this.#onMessageError = onMessageError;
    this.#finishTurn = finishTurn ?? false;
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
   * @param options Per-run options such as an {@link OnMessage} callback.
   * @returns The full conversation history including tool results.
   */
  async run(
    prompt: string | (TextContent | FileContent)[],
    history: Message[] = [],
    options?: RunOptions,
  ): Promise<Message[]> {
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

    const executeToolCalls = this.#executeToolCalls.bind(this);
    const callToolStep = step(async (messages: Message[]) => {
      const updated = await executeToolCalls(messages);
      await emit(...updated.slice(messages.length));
      return updated;
    });

    const stop = step((messages: Message[]) => messages);

    const toolCallCheck = decision<Message[]>({
      condition: (state) => {
        const message = [...state].pop();
        return message?.role === "model" && !!message.toolCalls?.length;
      },
      then: callToolStep,
      else: stop,
    });
    askStep.next(toolCallCheck);

    // After tool execution, terminate when the produced tool message
    // contains a successful `finish_turn` result; otherwise loop back to
    // the model. Sibling tool failures do not cancel a valid finish_turn.
    const finishCheck = decision<Message[]>({
      condition: (state) => endsWithSuccessfulFinishTurn([...state].pop()),
      then: stop,
      else: askStep,
    });
    callToolStep.next(finishCheck);

    const userMessage: Message = { role: "user", contents: prompt };
    await emit(userMessage);

    const loop = workflow({
      name: "Huuma Agent",
      state: [...history, userMessage],
      start: askStep,
    });

    return await loop.start();
  }

  /** Execute the tool calls in the last model message, appending a single
   * native tool message with one result per call.
   *
   * When `finishTurn` is enabled and a model message contains more than
   * one `finish_turn` call, every `finish_turn` in that batch receives a
   * deterministic error result instructing the model to issue exactly
   * one, and the batch is non-terminal. Other tool calls in the same
   * message use the existing execution semantics. */
  async #executeToolCalls(messages: Message[]): Promise<Message[]> {
    const lastMessage = messages.at(-1);
    if (!lastMessage || lastMessage.role !== "model") return messages;
    const toolCalls = lastMessage.toolCalls;
    if (!toolCalls?.length) return messages;

    const finishTurnCount = toolCalls.filter((tc) =>
      tc.name === FINISH_TURN_TOOL
    ).length;
    if (!this.#finishTurn || finishTurnCount <= 1) {
      return await callTool(this.#tools)(messages);
    }

    const duplicateError =
      "Issue exactly one finish_turn call per turn; multiple finish_turn calls in a single response are not allowed.";
    const settled = await Promise.allSettled(
      toolCalls.map(async (toolCall) => {
        if (toolCall.name === FINISH_TURN_TOOL) {
          throw new Error(duplicateError);
        }
        const tool = this.#tools.get(toolCall.name);
        const output = await tool.call(toolCall.props);
        const wrapped = output instanceof ToolOutput;
        return {
          toolResult: {
            id: toolCall.id,
            name: toolCall.name,
            result: { output: wrapped ? output.output : output },
            ...(wrapped ? { files: output.files } : {}),
          },
        } satisfies ToolResultContent;
      }),
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
