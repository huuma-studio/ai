import { assertEquals, assertRejects } from "@std/assert";
import { cli, DEFAULT_CLI_TIMEOUT } from "@/tools/cli/cli.ts";

Deno.test("cli - executes allowed command", async () => {
  const cliTool = cli({ allowedCommands: ["echo"] });

  const result = await cliTool.call({ command: "echo", args: ["hello"] });

  assertEquals(result.trim(), "hello");
});

Deno.test("cli - rejects disallowed command", async () => {
  const cliTool = cli({ allowedCommands: ["echo"] });

  await assertRejects(
    () => cliTool.call({ command: "ls", args: [] }),
    Error,
    'Command "ls" is not allowed',
  );
});

Deno.test("cli - throws on non-zero exit code", async () => {
  const cliTool = cli({ allowedCommands: ["false"] });

  await assertRejects(
    () => cliTool.call({ command: "false", args: [] }),
    Error,
  );
});

Deno.test("cli - has a 120 second default timeout", () => {
  const cliTool = cli({ allowedCommands: ["echo"] });
  assertEquals(cliTool.timeout, DEFAULT_CLI_TIMEOUT);
});

Deno.test("cli - kills a command when its timeout expires", async () => {
  const executable = Deno.execPath();
  const cliTool = cli({ allowedCommands: [executable], timeout: 10 });

  await assertRejects(
    () =>
      cliTool.call({
        command: executable,
        args: ["eval", "await new Promise(() => {})"],
      }),
    DOMException,
    "The operation was aborted due to timeout",
  );
});
