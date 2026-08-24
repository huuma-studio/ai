import { assertEquals, assertRejects } from "@std/assert";
import { ValidationException } from "@huuma/validate";
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

Deno.test("cli - closes child-process stdin", async () => {
  const executable = Deno.execPath();
  const cliTool = cli({ allowedCommands: [executable] });

  const result = await cliTool.call({
    command: executable,
    args: [
      "eval",
      "console.log((await new Response(Deno.stdin.readable).text()).length)",
    ],
  });

  assertEquals(result.trim(), "0");
});

Deno.test("cli - passes configured environment variables", async () => {
  const executable = Deno.execPath();
  const cliTool = cli({
    allowedCommands: [executable],
    env: { HUUMA_CLI_TEST: "configured" },
  });

  const result = await cliTool.call({
    command: executable,
    args: ["eval", 'console.log(Deno.env.get("HUUMA_CLI_TEST"))'],
  });

  assertEquals(result.trim(), "configured");
});

Deno.test("cli - passes per-call environment variables", async () => {
  const executable = Deno.execPath();
  const cliTool = cli({ allowedCommands: [executable] });

  const result = await cliTool.call({
    command: executable,
    args: ["eval", 'console.log(Deno.env.get("HUUMA_CLI_CALL_TEST"))'],
    env: { HUUMA_CLI_CALL_TEST: "agent" },
  });

  assertEquals(result.trim(), "agent");
});

Deno.test("cli - rejects non-string environment values", async () => {
  const executable = Deno.execPath();
  const cliTool = cli({ allowedCommands: [executable] });

  await assertRejects(
    () =>
      cliTool.call({
        command: executable,
        args: ["--version"],
        env: { HUUMA_CLI_CALL_TEST: 1 },
      }),
    ValidationException,
  );
});

Deno.test("cli - describes per-call environment as a string record", () => {
  const cliTool = cli({ allowedCommands: ["gh"] });

  assertEquals(cliTool.input.jsonSchema().properties?.env, {
    type: "object",
    additionalProperties: { type: "string" },
  });
});

Deno.test("cli - configured environment overrides per-call values", async () => {
  const executable = Deno.execPath();
  const cliTool = cli({
    allowedCommands: [executable],
    env: { HUUMA_CLI_TEST: "configured" },
  });

  const result = await cliTool.call({
    command: executable,
    args: ["eval", 'console.log(Deno.env.get("HUUMA_CLI_TEST"))'],
    env: { HUUMA_CLI_TEST: "agent" },
  });

  assertEquals(result.trim(), "configured");
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
