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
}

/** Default maximum runtime of a CLI command. */
export const DEFAULT_CLI_TIMEOUT = 120_000;

/** Create a tool that executes allow-listed CLI commands.
 *
 * @param options Configuration including the list of permitted commands.
 * @returns A {@link Tool} that runs CLI commands and returns stdout.
 */
export function cli(
  { allowedCommands, timeout = DEFAULT_CLI_TIMEOUT, env: configuredEnv }:
    CliToolOptions,
  // deno-lint-ignore no-explicit-any
): Tool<any, string> {
  return new Tool({
    name: "cli",
    description:
      `Execute CLI commands non-interactively. Optionally provide environment variables as an env object with string values; PATH cannot be set per call. Allowed commands: ${
        allowedCommands.join(", ")
      }`,
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
      const pathVariable = Object.keys(callEnv).find((name) =>
        name.toLowerCase() === "path"
      );
      if (pathVariable) {
        throw new Error(
          `Environment variable "${pathVariable}" cannot be set per call because it controls executable resolution. Configure it through CliToolOptions.env instead.`,
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
