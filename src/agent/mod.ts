import { callTool, type Tool, Tools } from "@/tools/mod.ts";
import type { BaseModel } from "@/model/mod.ts";
import type { Message } from "@/mod.ts";
import { decision, step, workflow } from "@/workflow/mod.ts";

interface AgentOptions<T extends string> {
  model: BaseModel<T>;
  modelId: T;
  // deno-lint-ignore no-explicit-any
  tools?: Tool<any>[];
  systemPrompt: string;
}

class Agent<T extends string> {
  #tools = new Tools([]);
  #model: BaseModel<T>;
  #modelId: T;
  #systemPrompt: string;
  constructor({ model, modelId, tools, systemPrompt }: AgentOptions<T>) {
    this.#model = model;
    this.#modelId = modelId;
    this.#systemPrompt = systemPrompt ?? "";
    tools?.forEach((tool) => this.#tools.add(tool));
  }

  async run(prompt: string) {
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

export function agent<T extends string>(options: AgentOptions<T>) {
  return new Agent<T>({ ...options });
}
