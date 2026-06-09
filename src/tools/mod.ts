/**
 * Tool primitives and bundled tool factories for agents.
 *
 * @example
 * ```typescript
 * import { tool, cli } from "jsr:@huuma/ai/tools";
 * import { string } from "jsr:@huuma/validate";
 *
 * const greet = tool({
 *   name: "greet",
 *   description: "Greet someone by name.",
 *   input: object({ name: string() }),
 *   fn: ({ name }) => `Hello, ${name}!`,
 * });
 * ```
 *
 * @module
 */
import { type Schema, ValidationException } from "@huuma/validate";
export type { JSONSchema, Schema } from "@huuma/validate";
import type { Message, ToolResultContent } from "@huuma/ai";

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

/** Executable tool with schema-validated input. */
// deno-lint-ignore no-explicit-any
export class Tool<T extends Schema<any>, R = unknown> {
  #name: string;
  #description: string;
  #input: T;
  #fn: (props: T["infer"]) => (Promise<R>) | R;

  /** Tool name exposed to models. */
  get name(): string {
    return this.#name;
  }

  /** Human-readable tool description. */
  get description(): string {
    return this.#description;
  }

  /** Input schema used to validate calls and generate JSON Schema. */
  get input(): T {
    return this.#input;
  }

  /** Create a tool instance. */
  constructor({ name, description, input, fn }: {
    /** Tool name exposed to models. */
    name: string;
    /** Human-readable tool description. */
    description: string;
    /** Input schema used to validate calls. */
    input: T;
    /** Tool implementation. */
    fn: (props: T["infer"]) => (Promise<R>) | R;
  }) {
    this.#name = name;
    this.#description = description;
    this.#input = input;
    this.#fn = fn;
  }

  /** Validate input properties and execute the tool. */
  async call(props: unknown): Promise<R> {
    const { errors, value } = this.#input.validate(props);

    if (errors?.length) {
      throw new ValidationException(errors);
    }

    return await this.#fn(value);
  }
}

/** Create a schema-validated tool.
 *
 * @param name Tool name exposed to models.
 * @param description Human-readable description of what the tool does.
 * @param input Validation schema for tool arguments.
 * @param fn Implementation function receiving validated props.
 * @returns A configured {@link Tool} instance.
 */
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

/** Collection of tools addressable by name. */
export class Tools {
  // deno-lint-ignore no-explicit-any
  #tools: Map<string, Tool<any>>;
  // deno-lint-ignore no-explicit-any
  constructor(tools: Tool<any>[]) {
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** Add or replace a tool in the collection. */
  // deno-lint-ignore no-explicit-any
  add(tool: Tool<any>) {
    this.#tools.set(tool.name, tool);
  }

  /** Get a tool by name. */
  get(name: string): Tool<Schema<unknown>, unknown> {
    const tool = this.#tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return tool;
  }

  /** Return all tools in the collection. */
  all(): Tool<Schema<Schema<unknown>>, unknown>[] {
    return Array.from(this.#tools.values());
  }
}

/** Create a tool collection.
 *
 * @param tools Initial array of tools to include.
 * @returns A mutable {@link Tools} collection.
 */
export function tools(tools: Tool<Schema<unknown>, unknown>[]): Tools {
  return new Tools(tools);
}

function formatRejection(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string") return reason;
  try {
    const serialized = JSON.stringify(reason);
    if (serialized !== undefined) return serialized;
  } catch {
    // Fall through to String()
  }
  return String(reason);
}

/** Create a callable that executes tool calls found in the last model message.
 *
 * @param tools Collection of available tools.
 * @returns An async function that takes messages and returns updated messages with tool results appended.
 */
export function callTool(
  tools: Tools,
): (messages: Message[]) => Promise<Message[]> {
  return async function executeToolCalls(messages: Message[]) {
    const lastMessage = messages.at(-1);
    if (!lastMessage || lastMessage.role !== "model") {
      return messages;
    }

    const toolCalls = lastMessage.toolCalls;
    if (!toolCalls.length) {
      return messages;
    }

    const settled = await Promise.allSettled(
      toolCalls.map(async (toolCall) => {
        const tool = tools.get(toolCall.name);
        const output = await tool.call(toolCall.props);
        return {
          toolResult: {
            id: toolCall.id,
            name: toolCall.name,
            result: { output },
          },
        } satisfies ToolResultContent;
      }),
    );

    const contents = settled.map((outcome, i): ToolResultContent => {
      if (outcome.status === "fulfilled") {
        return outcome.value;
      }

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
  };
}
