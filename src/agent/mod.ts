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
 * });
 *
 * const messages = await assistant.run("What is the current Deno version?");
 * console.log(messages.at(-1));
 * ```
 *
 * @module
 */
import { callTool, type Tool, Tools } from "@/tools/mod.ts";
import type { BaseModel } from "@/model/mod.ts";
export type { BaseModel, ModelResult } from "@/model/mod.ts";
export type { JSONSchema, Schema, Tool } from "@/tools/mod.ts";
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
} from "@/mod.ts";
import type { Message } from "@/mod.ts";
import { decision, step, workflow } from "@/workflow/mod.ts";

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
}

/** Agent that loops over model responses and tool calls. */
export class Agent<T extends string> {
  #tools = new Tools([]);
  #model: BaseModel<T>;
  #modelId: T;
  #systemPrompt: string;
  /** Create an agent instance. */
  constructor({ model, modelId, tools, systemPrompt }: AgentOptions<T>) {
    this.#model = model;
    this.#modelId = modelId;
    this.#systemPrompt = systemPrompt ?? "";
    tools?.forEach((tool) => this.#tools.add(tool));
  }

  /** Run the agent with a user prompt and return the conversation messages.
   *
   * @param prompt User message to send to the model.
   * @returns The full conversation history including tool results.
   */
  async run(prompt: string): Promise<Message[]> {
    const askAction = async (messages: Message[]) => {
      const result = await this.#model.generate({
        modelId: this.#modelId,
        system: this.#systemPrompt,
        messages,
        tools: this.#tools.all(),
      });
      return [...messages, ...result.messages];
    };
    const askStep = step(askAction);

    const callToolStep = step(callTool(this.#tools));

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

    const loop = workflow({
      name: "Huuma Agent",
      state: [{
        role: "user",
        contents: prompt,
      }],
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
