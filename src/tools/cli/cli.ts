import {
  array,
  type ArraySchema,
  object,
  type ObjectSchema,
  string,
  type StringSchema,
} from "@huuma/validate";
import { Tool } from "@/tools/mod.ts";

export interface CliToolOptions {
  allowedCommands: string[];
}

export function cli({ allowedCommands }: CliToolOptions): Tool<
  ObjectSchema<{
    command: StringSchema<string>;
    args: ArraySchema<StringSchema<string>>;
  }>,
  string
> {
  return new Tool({
    name: "cli",
    description: `Execute CLI commands. Allowed commands: ${
      allowedCommands.join(", ")
    }`,
    input: object({
      command: string(),
      args: array(string()),
    }),
    fn: async ({ command, args }) => {
      if (!allowedCommands.includes(command)) {
        throw new Error(
          `Command "${command}" is not allowed. Allowed commands: ${
            allowedCommands.join(", ")
          }`,
        );
      }

      const cmd = new Deno.Command(command, { args });
      const { code, stdout, stderr } = await cmd.output();

      const output = new TextDecoder().decode(stdout);
      const error = new TextDecoder().decode(stderr);

      if (code !== 0) {
        console.log(code, error, output);
        throw new Error(error || `Command exited with code ${code}`);
      }

      return output + (error ? `\n${error}` : "");
    },
  });
}
