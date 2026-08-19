import { array, object, string } from "@huuma/validate";
import { Tool } from "@/tools/mod.ts";

/** Options for configuring the CLI tool. */
export interface CliToolOptions {
  /** Commands the tool is allowed to execute. */
  allowedCommands: string[];
  /** Maximum duration of each command in milliseconds. Defaults to 120s. */
  timeout?: number;
}

/** Default maximum runtime of a CLI command. */
export const DEFAULT_CLI_TIMEOUT = 120_000;

/** Create a tool that executes allow-listed CLI commands.
 *
 * @param options Configuration including the list of permitted commands.
 * @returns A {@link Tool} that runs CLI commands and returns stdout.
 */
export function cli(
  { allowedCommands, timeout = DEFAULT_CLI_TIMEOUT }: CliToolOptions,
  // deno-lint-ignore no-explicit-any
): Tool<any, string> {
  return new Tool({
    name: "cli",
    description: `Execute CLI commands. Allowed commands: ${
      allowedCommands.join(", ")
    }`,
    input: object({
      command: string(),
      args: array(string()),
    }),
    timeout,
    fn: async ({ command, args }, { signal }) => {
      if (!allowedCommands.includes(command)) {
        throw new Error(
          `Command "${command}" is not allowed. Allowed commands: ${
            allowedCommands.join(", ")
          }`,
        );
      }

      const cmd = new Deno.Command(command, {
        args,
        signal,
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
