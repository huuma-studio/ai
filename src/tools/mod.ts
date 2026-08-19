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
 * @example Returning media from a tool
 * ```typescript
 * import { tool, toolOutput } from "jsr:@huuma/ai/tools";
 * import { object, string } from "jsr:@huuma/validate";
 *
 * const screenshot = tool({
 *   name: "screenshot",
 *   description: "Take a screenshot of a page.",
 *   input: object({ url: string() }),
 *   fn: async ({ url }) => {
 *     const data = await captureAsBase64(url);
 *     return toolOutput("Screenshot captured.", [
 *       { file: { mimeType: "image/png", data } },
 *     ]);
 *   },
 * });
 * ```
 *
 * @module
 */
import { type Schema, ValidationException } from "@huuma/validate";
export type { JSONSchema, Schema } from "@huuma/validate";
import type { FileContent, Message, ToolResultContent } from "@huuma/ai";

/** Runtime controls passed to a tool implementation. */
export interface ToolContext {
  /** Aborted when the caller cancels the call or its timeout expires. */
  signal: AbortSignal;
  /** Maximum duration of the call in milliseconds. */
  timeout?: number;
}

/** Runtime controls supplied when invoking a tool. */
export interface ToolCallOptions {
  /** Optional cancellation signal inherited from the surrounding run. */
  signal?: AbortSignal;
  /** Maximum duration of the call in milliseconds. */
  timeout?: number;
}

export {
  cli,
  type CliToolOptions,
  DEFAULT_CLI_TIMEOUT,
} from "@/tools/cli/cli.ts";

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

export {
  subagent,
  type SubagentToolOptions,
} from "@/tools/subagent/subagent.ts";

export {
  type SkillFrontmatter,
  type SkillInfo,
  skills,
  type SkillsToolOptions,
} from "@/tools/skills/skills.ts";

export {
  mcp,
  McpConnection,
  type McpHttpTransportOptions,
  type McpStdioTransportOptions,
  type McpToolsOptions,
  type McpTransport,
  type McpTransportOptions,
} from "@/tools/mcp/mcp.ts";

/** Executable tool with schema-validated input. */
// deno-lint-ignore no-explicit-any
export class Tool<T extends Schema<any>, R = unknown> {
  #name: string;
  #description: string;
  #input: T;
  #fn: (props: T["infer"], context: ToolContext) => (Promise<R>) | R;
  #timeout?: number;

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

  /** Configured maximum duration of each call in milliseconds. */
  get timeout(): number | undefined {
    return this.#timeout;
  }

  /** Create a tool instance. */
  constructor({ name, description, input, fn, timeout }: {
    /** Tool name exposed to models. */
    name: string;
    /** Human-readable tool description. */
    description: string;
    /** Input schema used to validate calls. */
    input: T;
    /** Tool implementation. */
    fn: (props: T["infer"], context: ToolContext) => (Promise<R>) | R;
    /** Maximum duration of each call in milliseconds. */
    timeout?: number;
  }) {
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
      throw new TypeError("Tool timeout must be a finite, non-negative number");
    }
    this.#name = name;
    this.#description = description;
    this.#input = input;
    this.#fn = fn;
    this.#timeout = timeout;
  }

  /** Validate input properties and execute the tool with cancellation controls. */
  async call(props: unknown, options: ToolCallOptions = {}): Promise<R> {
    const { errors, value } = this.#input.validate(props);

    if (errors?.length) {
      throw new ValidationException(errors);
    }
    validateTimeout(options.timeout);

    const timeout = shortestTimeout(this.#timeout, options.timeout);
    const signals: AbortSignal[] = [];
    if (options.signal) signals.push(options.signal);
    if (timeout !== undefined) signals.push(timeoutSignal(timeout));
    const signal = signals.length > 0
      ? AbortSignal.any(signals)
      : new AbortController().signal;

    const aborted = new Promise<never>((_, reject) => {
      const rejectOnAbort = () => reject(abortReason(signal));
      if (signal.aborted) rejectOnAbort();
      else {
        signal.addEventListener("abort", rejectOnAbort, {
          once: true,
        });
      }
    });

    const execution = Promise.resolve().then(() => {
      if (signal.aborted) throw abortReason(signal);
      return this.#fn(value, { signal, timeout });
    });
    return await Promise.race([execution, aborted]);
  }
}

function shortestTimeout(
  first: number | undefined,
  second: number | undefined,
): number | undefined {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Math.min(first, second);
}

function validateTimeout(timeout: number | undefined): void {
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
    throw new TypeError("Tool timeout must be a finite, non-negative number");
  }
}

function timeoutSignal(timeout: number): AbortSignal {
  if (timeout === 0) {
    return AbortSignal.abort(
      new DOMException("The tool operation timed out", "TimeoutError"),
    );
  }
  return AbortSignal.timeout(timeout);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Tool call aborted", "AbortError");
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
  { name, description, input, fn, timeout }: {
    name: string;
    description: string;
    input: T;
    fn: (props: T["infer"], context: ToolContext) => (Promise<R>) | R;
    /** Maximum duration of each call in milliseconds. */
    timeout?: number;
  },
): Tool<T, R> {
  return new Tool({ name, description, input, fn, timeout });
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

/**
 * Branded wrapper pairing a tool's output with media files.
 *
 * {@linkcode callTool} detects instances via `instanceof` and lifts the
 * files onto the tool result's `files` field — a plain object with
 * `output`/`files` keys is treated as ordinary output, never unwrapped.
 */
export class ToolOutput<T = unknown> {
  /** Model-visible tool output. */
  readonly output: T;
  /** Media attached to the result. */
  readonly files: FileContent[];

  /** Create a wrapped tool output. */
  constructor(output: T, files: FileContent[]) {
    this.output = output;
    this.files = files;
  }
}

/** Attach media files to a tool's output.
 *
 * @param output Model-visible tool output.
 * @param files Media attached to the result.
 * @returns A {@link ToolOutput} that {@linkcode callTool} unwraps into the
 * tool result.
 */
export function toolOutput<T>(output: T, files: FileContent[]): ToolOutput<T> {
  return new ToolOutput(output, files);
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
 * @param options Cancellation signal or timeout shared by calls in the batch.
 * @returns An async function that takes messages and returns updated messages with tool results appended.
 */
export function callTool(
  tools: Tools,
  options: ToolCallOptions = {},
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
        const output = await tool.call(toolCall.props, options);
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
