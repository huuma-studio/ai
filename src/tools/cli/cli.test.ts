import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { ValidationException } from "@huuma/validate";
import {
  cli,
  DEFAULT_CLI_MAX_OUTPUT_BYTES,
  DEFAULT_CLI_TIMEOUT,
} from "@/tools/cli/cli.ts";

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

Deno.test("cli - passes explicitly enabled per-call environment variables", async () => {
  const executable = Deno.execPath();
  const cliTool = cli({
    allowedCommands: [executable],
    allowUnsafeEnvironmentVariables: true,
  });

  const result = await cliTool.call({
    command: executable,
    args: ["eval", 'console.log(Deno.env.get("HUUMA_CLI_CALL_TEST"))'],
    env: { HUUMA_CLI_CALL_TEST: "agent" },
  });

  assertEquals(result.trim(), "agent");
});

Deno.test("cli - rejects per-call environment variables by default", async () => {
  const executable = Deno.execPath();
  const cliTool = cli({ allowedCommands: [executable] });

  await assertRejects(
    () =>
      cliTool.call({
        command: executable,
        args: ["--version"],
        env: { LD_PRELOAD: "/tmp/payload.so" },
      }),
    Error,
    "Per-call environment variables are disabled",
  );
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
    allowUnsafeEnvironmentVariables: true,
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

Deno.test("cli - returns stdout and stderr byte-identical", async () => {
  const executable = Deno.execPath();
  const cliTool = cli({ allowedCommands: [executable] });

  const result = await cliTool.call({
    command: executable,
    args: ["eval", 'console.log("out"); console.error("err");'],
  });

  assertEquals(result, "out\n\nerr\n");
});

Deno.test("cli - truncates oversized output and keeps the exit code", async () => {
  const executable = Deno.execPath();
  const cap = 64 * 1024;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    // Twice the cap and more than a pipe buffer holds: the call resolving
    // proves the rest was drained, not abandoned, and the exit stayed 0.
    args: [
      "eval",
      "await Deno.stdout.write(new Uint8Array(2 * 64 * 1024).fill(97))",
    ],
  });

  assertEquals(result, `${"a".repeat(cap)}\n\n…[output truncated at 64 KiB]`);
});

Deno.test("cli - returns output that fills the cap exactly without a note", async () => {
  const executable = Deno.execPath();
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    args: ["eval", "await Deno.stdout.write(new Uint8Array(1000).fill(97))"],
  });

  assertEquals(result, "a".repeat(cap));
});

Deno.test("cli - finishes a trailing partial character of untruncated output", async () => {
  const executable = Deno.execPath();
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    // Exactly the cap, ending mid-character: nothing was discarded, so the
    // tail is replaced like a plain decode would and nothing is truncated.
    // The incomplete sequence takes three bytes, so its replacement
    // character still fits the cap once escaped.
    args: ["eval", [
      "const bytes = new Uint8Array(1000)",
      "bytes.fill(97)",
      "bytes[997] = 0xf0",
      "bytes[998] = 0x9f",
      "bytes[999] = 0x92",
      "await Deno.stdout.write(bytes)",
    ].join("; ")],
  });

  assertEquals(result, `${"a".repeat(997)}\uFFFD`);
});

Deno.test("cli - drops a character split by the cut", async () => {
  const executable = Deno.execPath();
  const cap = 999;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    // The same output with one byte less of cap: the cut falls inside the
    // character, and its kept prefix ends without a replacement character.
    args: ["eval", [
      "const bytes = new Uint8Array(1000)",
      "bytes.fill(97)",
      "bytes[999] = 0xc3",
      "await Deno.stdout.write(bytes)",
    ].join("; ")],
  });

  assertEquals(result, `${"a".repeat(cap)}\n\n…[output truncated at 999 bytes]`);
});

Deno.test("cli - bounds the result to the cap across stdout and stderr", async () => {
  const executable = Deno.execPath();
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    // Each pipe keeps up to the cap, and the assembled result is cut to
    // the cap once escaped — dropping stderr's tail here.
    args: ["eval", [
      "await Deno.stdout.write(new Uint8Array(1500).fill(97))",
      "await new Promise((resolve) => setTimeout(resolve, 100))",
      "await Deno.stderr.write(new Uint8Array(1500).fill(98))",
    ].join("; ")],
  });

  assertEquals(result, `${"a".repeat(cap)}\n\n…[output truncated at 1000 bytes]`);
});

Deno.test("cli - keeps the result at the cap for output that escapes large", async () => {
  const executable = Deno.execPath();
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    // NUL bytes escape to 6 bytes each in the model request: 1500 of them
    // must be cut to what escapes within the cap, not kept whole.
    args: ["eval", "await Deno.stdout.write(new Uint8Array(1500))"],
  });

  assertEquals(
    result,
    `${"\0".repeat(166)}\n\n…[output truncated at 1000 bytes]`,
  );
});

Deno.test("cli - keeps a failing command's stderr diagnostic beside flooded stdout", async () => {
  const executable = Deno.execPath();
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const failure = await cliTool.call({
    command: executable,
    // stdout spends its pipe's cap long before the diagnostic is written,
    // so the failure's reason must survive the stdout flood.
    args: ["eval", [
      "await Deno.stdout.write(new Uint8Array(1500).fill(97))",
      "await new Promise((resolve) => setTimeout(resolve, 100))",
      'await Deno.stderr.write(new TextEncoder().encode("boom"))',
      "Deno.exit(3)",
    ].join("; ")],
  }).catch((error: unknown) => error);

  assertInstanceOf(failure, Error);
  assertEquals(failure.message, `boom\n\n…[output truncated at 1000 bytes]`);
});

Deno.test("cli - reports a truncated stderr prefix when a command fails", async () => {
  const executable = Deno.execPath();
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const failure = await cliTool.call({
    command: executable,
    args: [
      "eval",
      "await Deno.stderr.write(new Uint8Array(1500).fill(101)); Deno.exit(3)",
    ],
  }).catch((error: unknown) => error);

  assertInstanceOf(failure, Error);
  assertEquals(
    failure.message,
    `${"e".repeat(cap)}\n\n…[output truncated at 1000 bytes]`,
  );
});

Deno.test("cli - notes truncation on failure even when stderr is empty", async () => {
  const executable = Deno.execPath();
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const failure = await cliTool.call({
    command: executable,
    args: [
      "eval",
      "await Deno.stdout.write(new Uint8Array(1500).fill(97)); Deno.exit(3)",
    ],
  }).catch((error: unknown) => error);

  assertInstanceOf(failure, Error);
  assertEquals(
    failure.message,
    `Command exited with code 3\n\n…[output truncated at 1000 bytes]`,
  );
});

Deno.test("cli - truncates at the default cap", async () => {
  const executable = Deno.execPath();
  const cliTool = cli({ allowedCommands: [executable] });

  const result = await cliTool.call({
    command: executable,
    args: [
      "eval",
      "await Deno.stdout.write(new Uint8Array(512 * 1024 + 1).fill(97))",
    ],
  });

  assertEquals(
    result,
    `${
      "a".repeat(DEFAULT_CLI_MAX_OUTPUT_BYTES)
    }\n\n…[output truncated at 512 KiB]`,
  );
});

Deno.test("cli - keeps memory bounded when a command emits far past the cap", async () => {
  const forceGc = (globalThis as { gc?: () => void }).gc;
  if (!forceGc) {
    throw new Error(
      "forced GC is unavailable; run the suite with " +
        "`--v8-flags=--expose-gc` (the `deno task test` default)",
    );
  }
  const executable = Deno.execPath();
  const cap = 64 * 1024;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  forceGc();
  await new Promise((resolve) => setTimeout(resolve, 0));
  forceGc();
  const before = Deno.memoryUsage().heapUsed;

  const result = await cliTool.call({
    command: executable,
    args: [
      "eval",
      "await Deno.stdout.write(new Uint8Array(50 * 1024 * 1024).fill(97))",
    ],
  });

  forceGc();
  await new Promise((resolve) => setTimeout(resolve, 0));
  forceGc();
  const after = Deno.memoryUsage().heapUsed;

  assertEquals(result, `${"a".repeat(cap)}\n\n…[output truncated at 64 KiB]`);
  // The child emitted 50 MiB and the tool kept 64 KiB of it. The bound is
  // loose so runtime heap drift cannot fail a healthy run, while holding
  // even one full copy of the output would blow past it.
  const growth = after - before;
  assert(
    growth < 8 * 1024 * 1024,
    `emitting 50 MiB grew the heap by ${(growth / 1024).toFixed(0)} KiB: ` +
      `command output is being buffered, not streamed`,
  );
});

Deno.test("cli - describes the output cap", () => {
  const cliTool = cli({ allowedCommands: ["echo"], maxOutputBytes: 2048 });

  assert(
    cliTool.description.includes(
      "Output over 2 KiB (stdout and stderr combined) is truncated.",
    ),
  );
});

Deno.test("cli - rejects an invalid maxOutputBytes", () => {
  assertThrows(
    () => cli({ allowedCommands: ["echo"], maxOutputBytes: 0 }),
    TypeError,
    "maxBytes must be a positive integer",
  );
});
