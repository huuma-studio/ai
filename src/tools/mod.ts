import { type Schema, ValidationException } from "@huuma/validate";
import type { Message, ModelMessage, ToolResultContent } from "@huuma/ai";

export { cli, type CliToolOptions } from "@/tools/cli/cli.ts";

export {
  grep,
  type GrepFileResult,
  type GrepMatch,
} from "@/tools/grep/grep.ts";

export {
  createDirectory,
  deleteFile,
  editFile,
  files,
  readFile,
  writeFile,
} from "@/tools/file/file.ts";

export { fetchWebsite } from "@/tools/browser/browser.ts";

export { search } from "@/tools/search/search.ts";

// deno-lint-ignore no-explicit-any
export class Tool<T extends Schema<any>, R = unknown> {
  #name: string;
  #description: string;
  #input: T;
  #fn: (props: T["infer"]) => (Promise<R>) | R;

  get name(): string {
    return this.#name;
  }

  get description(): string {
    return this.#description;
  }

  get input(): T {
    return this.#input;
  }

  constructor({ name, description, input, fn }: {
    name: string;
    description: string;
    input: T;
    fn: (props: T["infer"]) => (Promise<R>) | R;
  }) {
    this.#name = name;
    this.#description = description;
    this.#input = input;
    this.#fn = fn;
  }

  async call(props: unknown): Promise<R> {
    const { errors, value } = this.#input.validate(props);

    if (errors?.length) {
      throw new ValidationException(errors);
    }

    return await this.#fn(value);
  }
}

// deno-lint-ignore no-explicit-any
export function tool<T extends Schema<any>, R = unknown>(
  { name, description, input, fn }: {
    name: string;
    description: string;
    input: T;
    fn: (props: T["infer"]) => (Promise<R>) | R;
  },
): Tool<T, R> {
  return new Tool({ name, description, input, fn });
}

export class Tools {
  // deno-lint-ignore no-explicit-any
  #tools: Map<string, Tool<any>>;
  // deno-lint-ignore no-explicit-any
  constructor(tools: Tool<any>[]) {
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  // deno-lint-ignore no-explicit-any
  add(tool: Tool<any>) {
    this.#tools.set(tool.name, tool);
  }

  get(name: string): Tool<Schema<unknown>, unknown> {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return tool;
  }

  all(): Tool<Schema<Schema<unknown>>, unknown>[] {
    return Array.from(this.#tools.values());
  }
}

export function tools(tools: Tool<Schema<unknown>, unknown>[]): Tools {
  return new Tools(tools);
}

export function callTool(
  tools: Tools,
): (messages: Message[]) => Promise<Message[]> {
  return async (messages: Message[]) => {
    const message = [...messages].pop();
    const results: ToolResultContent[] = [];
    for (const toolCall of (<ModelMessage> message).toolCalls) {
      console.log("TOOL_CALL:", toolCall.name, toolCall);
      let result: unknown;

      try {
        const tool = tools.get(toolCall.name);
        result = await tool.call(toolCall.props);
      } catch (error) {
        console.error(`Error calling tool ${toolCall.name}:`, error);
        if (error instanceof Error) {
          result = { error: error.message };
        } else {
          result = { error: JSON.stringify(error) };
        }
      }

      results.push({
        toolResult: {
          id: toolCall.id,
          name: toolCall.name,
          result: { output: result },
        },
      });
    }
    return [...messages, {
      role: "tool",
      contents: results,
    }];
  };
}
