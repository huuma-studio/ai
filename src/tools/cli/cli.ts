import {
  array,
  type JSONSchema,
  object,
  type Schema,
  string,
} from "@huuma/validate";
import { formatBytes, validateMaxBytes } from "@/tools/bounded_text.ts";
import { Tool } from "@/tools/mod.ts";

/** Options for configuring the CLI tool. */
export interface CliToolOptions {
  /** Commands the tool is allowed to execute. */
  allowedCommands: string[];
  /** Maximum duration of each command in milliseconds. Defaults to 120s. */
  timeout?: number;
  /** Environment variables added to the inherited child-process environment. */
  env?: Record<string, string>;
  /** Allow arbitrary agent-provided environment variables per call.
   *
   * This makes `allowedCommands` unsuitable as a security boundary because
   * loader and runtime variables can execute additional code. Enable only when
   * child processes are protected by an external OS sandbox. Defaults to false.
   */
  allowUnsafeEnvironmentVariables?: boolean;
  /**
   * Maximum number of command-output bytes kept per call, combined across
   * stdout and stderr. Output is read as it arrives; once the cap is reached
   * the rest is discarded while the command runs to its exit — the command
   * is never killed for writing too much, so its exit code stays meaningful —
   * and the kept prefix is returned with a truncation note. Defaults to
   * 512 KiB, half the Huuma API's 1 MiB message limit, leaving room for JSON
   * escaping and the rest of the conversation in the same request.
   */
  maxOutputBytes?: number;
}

/** Default maximum runtime of a CLI command. */
export const DEFAULT_CLI_TIMEOUT = 120_000;

/**
 * Default maximum number of command-output bytes kept per call: 512 KiB,
 * half the Huuma API's 1 MiB message limit, leaving room for JSON escaping,
 * the truncation note, and the rest of the conversation in the same request,
 * so an oversized result cannot fail the next model call.
 */
export const DEFAULT_CLI_MAX_OUTPUT_BYTES = 512 * 1024;

/** Create a tool that executes allow-listed CLI commands.
 *
 * The command's output is read as it arrives and kept only up to
 * `maxOutputBytes`, so a chatty command cannot exhaust memory or produce a
 * tool result too large to send: see {@linkcode CliToolOptions.maxOutputBytes}.
 *
 * @param options Configuration including the list of permitted commands.
 * @returns A {@link Tool} that runs CLI commands and returns their output.
 */
export function cli(
  {
    allowedCommands,
    timeout = DEFAULT_CLI_TIMEOUT,
    env: configuredEnv,
    allowUnsafeEnvironmentVariables = false,
    maxOutputBytes = DEFAULT_CLI_MAX_OUTPUT_BYTES,
  }: CliToolOptions,
  // deno-lint-ignore no-explicit-any
): Tool<any, string> {
  validateMaxBytes(maxOutputBytes);

  return new Tool({
    name: "cli",
    description: `Execute CLI commands non-interactively. ${
      allowUnsafeEnvironmentVariables
        ? "Arbitrary per-call environment variables are enabled and must have string values."
        : "Per-call environment variables are disabled."
    } Allowed commands: ${allowedCommands.join(", ")}. Output over ${
      formatBytes(maxOutputBytes)
    } (stdout and stderr combined) is truncated.`,
    input: object({
      command: string(),
      args: array(string()),
      env: environmentSchema,
    }),
    timeout,
    fn: async ({ command, args, env }, { signal }) => {
      if (!allowedCommands.includes(command)) {
        throw new Error(
          `Command "${command}" is not allowed. Allowed commands: ${
            allowedCommands.join(", ")
          }`,
        );
      }

      const callEnv = env ?? {};
      if (
        Object.keys(callEnv).length > 0 && !allowUnsafeEnvironmentVariables
      ) {
        throw new Error(
          "Per-call environment variables are disabled. Enable CliToolOptions.allowUnsafeEnvironmentVariables only when child processes run in an external OS sandbox.",
        );
      }

      const child = new Deno.Command(command, {
        args,
        env: { ...callEnv, ...configuredEnv },
        signal,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();

      let output: CommandOutput;
      try {
        output = await readCommandOutput(child, maxOutputBytes);
      } catch (error) {
        killQuietly(child);
        await child.status.catch(() => {});
        throw error;
      }
      const { code } = await child.status;
      // An abort killed the child, so its exit code says nothing.
      signal.throwIfAborted();

      if (code !== 0) {
        const error = output.stderr.join("");
        const message = error || `Command exited with code ${code}`;
        throw new Error(
          output.truncated ? message + truncationNote(maxOutputBytes) : message,
        );
      }
      return assembleOutput(output, maxOutputBytes);
    },
  });
}

/** The output kept from a command's pipes: decoded pieces of stdout and
 * stderr in arrival order, and whether the pipes carried more than the cap. */
interface CommandOutput {
  stdout: string[];
  stderr: string[];
  truncated: boolean;
}

/**
 * Read both output pipes of a running command, keeping at most `maxBytes`
 * bytes of combined stdout and stderr as UTF-8 text.
 *
 * The pipes are read concurrently — a command writing to one while the
 * other's buffer is full must not wait on it — under one shared byte
 * budget: once the budget is spent, further bytes are discarded as they
 * arrive while both pipes are drained to their end, so the command is
 * never killed for writing too much and its exit code stays meaningful.
 * Only the kept pieces are held, so memory stays O(maxBytes) however much
 * the command emits.
 *
 * A multi-byte character split by the cut is dropped rather than decoded
 * into a replacement character.
 */
async function readCommandOutput(
  child: Deno.ChildProcess,
  maxBytes: number,
): Promise<CommandOutput> {
  const budget: OutputBudget = { remaining: maxBytes, truncated: false };
  const [stdout, stderr] = await Promise.all([
    readPipe(child.stdout, budget),
    readPipe(child.stderr, budget),
  ]);
  return { stdout, stderr, truncated: budget.truncated };
}

/** Byte budget shared by a command's output pipes: how many more bytes are
 * kept, and whether any arrived past the cap. */
interface OutputBudget {
  remaining: number;
  truncated: boolean;
}

/** Read one pipe, keeping its first bytes under the shared budget and
 * discarding the rest as they arrive. The pipe is always read to its end
 * (or cancelled on failure), and only the kept pieces are returned. */
async function readPipe(
  stream: ReadableStream<Uint8Array>,
  budget: OutputBudget,
): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const pieces: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (budget.remaining === 0) {
        // Drain-discard: past the cap, read on so the command never blocks
        // on a full pipe, holding nothing.
        if (value.byteLength > 0) budget.truncated = true;
        continue;
      }
      const kept = Math.min(value.byteLength, budget.remaining);
      if (kept < value.byteLength) {
        budget.remaining = 0;
        budget.truncated = true;
      } else {
        budget.remaining -= kept;
      }
      const text = decoder.decode(value.subarray(0, kept), { stream: true });
      if (text !== "") pieces.push(text);
    }
    // The stream was read to its end under the cap: finish any character it
    // split. Past the cap the decoder's trailing partial character is the
    // cut, and is dropped instead of decoded into a replacement character.
    if (budget.remaining > 0) {
      const text = decoder.decode();
      if (text !== "") pieces.push(text);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return pieces;
}

/** Assemble the tool result from the kept pieces in one pass: the kept
 * stdout, the kept stderr on a new line when there is any, and the note
 * when the command kept emitting past the cap. */
function assembleOutput(
  { stdout, stderr, truncated }: CommandOutput,
  maxOutputBytes: number,
): string {
  const parts = [...stdout];
  if (stderr.length > 0) parts.push("\n", ...stderr);
  if (truncated) parts.push(truncationNote(maxOutputBytes));
  return parts.join("");
}

/** The note appended when a command kept emitting past the cap. */
function truncationNote(maxOutputBytes: number): string {
  return `\n\n…[output truncated at ${formatBytes(maxOutputBytes)}]`;
}

/** Kill `child` unless it has already exited. */
function killQuietly(child: Deno.ChildProcess): void {
  try {
    child.kill();
  } catch {
    // Already exited.
  }
}

type EnvironmentJsonSchema = JSONSchema & {
  additionalProperties: JSONSchema;
};

const environmentSchema: Schema<
  Record<string, string> | undefined,
  EnvironmentJsonSchema
> = {
  infer: undefined,
  validate(value) {
    try {
      return { value: environmentFrom(value), errors: undefined };
    } catch (error) {
      return {
        value: undefined,
        errors: [{
          message: error instanceof Error ? error.message : "Invalid CLI env",
        }],
      };
    }
  },
  jsonSchema() {
    return { type: "object", additionalProperties: { type: "string" } };
  },
  isRequired() {
    return false;
  },
};

function environmentFrom(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("CLI env must be an object with string values");
  }

  const environment: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new TypeError(
        `CLI environment variable "${name}" must have a string value`,
      );
    }
    environment[name] = entry;
  }
  return environment;
}