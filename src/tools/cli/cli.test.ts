import { assertEquals, assertRejects } from "@std/assert";
import { cli } from "@/tools/cli/cli.ts";

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
