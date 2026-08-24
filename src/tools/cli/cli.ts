import {
  array,
  type JSONSchema,
  object,
  type Schema,
  string,
} from "@huuma/validate";
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
}

/** Default maximum runtime of a CLI command. */
export const DEFAULT_CLI_TIMEOUT = 120_000;

/** Create a tool that executes allow-listed CLI commands.
 *
 * @param options Configuration including the list of permitted commands.
 * @returns A {@link Tool} that runs CLI commands and returns stdout.
 */
export function cli(
  {
    allowedCommands,
    timeout = DEFAULT_CLI_TIMEOUT,
    env: configuredEnv,
    allowUnsafeEnvironmentVariables = false,
  }: CliToolOptions,
  // deno-lint-ignore no-explicit-any
): Tool<any, string> {
  return new Tool({
    name: "cli",
    description: `Execute CLI commands non-interactively. ${
      allowUnsafeEnvironmentVariables
        ? "Arbitrary per-call environment variables are enabled and must have string values."
        : "Per-call environment variables are disabled."
    } Allowed commands: ${allowedCommands.join(", ")}`,
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

      const cmd = new Deno.Command(command, {
        args,
        env: { ...callEnv, ...configuredEnv },
        signal,
        stdin: "null",
      });
      const { code, stdout, stderr } = await cmd.output();

      const output = new TextDecoder().decode(stdout);
      const error = new TextDecoder().decode(stderr);

      if (code !== 0) {
        throw new Error(error || `Command exited with code ${code}`);
      }

      return output + (error ? `\n${error}` : "");
    },
  });
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
