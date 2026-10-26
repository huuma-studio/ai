import { expect, test } from "vite-plus/test";
import { ValidationException } from "@huuma/validate";
import { cli, DEFAULT_CLI_MAX_OUTPUT_BYTES, DEFAULT_CLI_TIMEOUT } from "./cli.ts";

test("cli - executes allowed command", async () => {
  const cliTool = cli({ allowedCommands: ["echo"] });

  const result = await cliTool.call({ command: "echo", args: ["hello"] });

  expect(result.trim()).toBe("hello");
});

test("cli - rejects disallowed command", async () => {
  const cliTool = cli({ allowedCommands: ["echo"] });

  await expect(cliTool.call({ command: "ls", args: [] })).rejects.toThrow(
    'Command "ls" is not allowed',
  );
});

test("cli - throws on non-zero exit code", async () => {
  const cliTool = cli({ allowedCommands: ["false"] });

  await expect(cliTool.call({ command: "false", args: [] })).rejects.toBeInstanceOf(Error);
});

test("cli - closes child-process stdin", async () => {
  const executable = process.execPath;
  const cliTool = cli({ allowedCommands: [executable] });

  const result = await cliTool.call({
    command: executable,
    args: [
      "-e",
      'let n = 0; process.stdin.on("data", (c) => { n += c.length; }); process.stdin.on("end", () => console.log(n));',
    ],
  });

  expect(result.trim()).toBe("0");
});

test("cli - passes configured environment variables", async () => {
  const executable = process.execPath;
  const cliTool = cli({
    allowedCommands: [executable],
    env: { HUUMA_CLI_TEST: "configured" },
  });

  const result = await cliTool.call({
    command: executable,
    args: ["-e", "console.log(process.env.HUUMA_CLI_TEST)"],
  });

  expect(result.trim()).toBe("configured");
});

test("cli - passes explicitly enabled per-call environment variables", async () => {
  const executable = process.execPath;
  const cliTool = cli({
    allowedCommands: [executable],
    allowUnsafeEnvironmentVariables: true,
  });

  const result = await cliTool.call({
    command: executable,
    args: ["-e", "console.log(process.env.HUUMA_CLI_CALL_TEST)"],
    env: { HUUMA_CLI_CALL_TEST: "agent" },
  });

  expect(result.trim()).toBe("agent");
});

test("cli - rejects per-call environment variables by default", async () => {
  const executable = process.execPath;
  const cliTool = cli({ allowedCommands: [executable] });

  await expect(
    cliTool.call({
      command: executable,
      args: ["--version"],
      env: { LD_PRELOAD: "/tmp/payload.so" },
    }),
  ).rejects.toThrow("Per-call environment variables are disabled");
});

test("cli - rejects non-string environment values", async () => {
  const executable = process.execPath;
  const cliTool = cli({ allowedCommands: [executable] });

  await expect(
    cliTool.call({
      command: executable,
      args: ["--version"],
      env: { HUUMA_CLI_CALL_TEST: 1 },
    }),
  ).rejects.toBeInstanceOf(ValidationException);
});

test("cli - describes per-call environment as a string record", () => {
  const cliTool = cli({ allowedCommands: ["gh"] });

  expect(cliTool.input.jsonSchema().properties?.env).toStrictEqual({
    type: "object",
    additionalProperties: { type: "string" },
  });
});

test("cli - configured environment overrides per-call values", async () => {
  const executable = process.execPath;
  const cliTool = cli({
    allowedCommands: [executable],
    env: { HUUMA_CLI_TEST: "configured" },
    allowUnsafeEnvironmentVariables: true,
  });

  const result = await cliTool.call({
    command: executable,
    args: ["-e", "console.log(process.env.HUUMA_CLI_TEST)"],
    env: { HUUMA_CLI_TEST: "agent" },
  });

  expect(result.trim()).toBe("configured");
});

test("cli - has a 120 second default timeout", () => {
  const cliTool = cli({ allowedCommands: ["echo"] });
  expect(cliTool.timeout).toBe(DEFAULT_CLI_TIMEOUT);
});

test("cli - kills a command when its timeout expires", async () => {
  const executable = process.execPath;
  const cliTool = cli({ allowedCommands: [executable], timeout: 10 });

  // An interval keeps the child alive until the timeout kills it.
  const error = await cliTool
    .call({
      command: executable,
      args: ["-e", "setInterval(() => {}, 1000)"],
    })
    .catch((e: unknown) => e);

  expect(error).toBeInstanceOf(DOMException);
  expect((error as DOMException).message).toBe("The operation was aborted due to timeout");
});

test("cli - returns stdout and stderr byte-identical", async () => {
  const executable = process.execPath;
  const cliTool = cli({ allowedCommands: [executable] });

  const result = await cliTool.call({
    command: executable,
    args: ["-e", 'console.log("out"); console.error("err");'],
  });

  expect(result).toBe("out\n\nerr\n");
});

test("cli - truncates oversized output and keeps the exit code", async () => {
  const executable = process.execPath;
  const cap = 64 * 1024;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    // Twice the cap and more than a pipe buffer holds: the call resolving
    // proves the rest was drained, not abandoned, and the exit stayed 0.
    args: ["-e", "process.stdout.write(Buffer.alloc(2 * 64 * 1024, 97))"],
  });

  expect(result).toBe(`${"a".repeat(cap)}\n\n…[output truncated at 64 KiB]`);
});

test("cli - returns output that fills the cap exactly without a note", async () => {
  const executable = process.execPath;
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    args: ["-e", "process.stdout.write(Buffer.alloc(1000, 97))"],
  });

  expect(result).toBe("a".repeat(cap));
});

test("cli - finishes a trailing partial character of untruncated output", async () => {
  const executable = process.execPath;
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    // Exactly the cap, ending mid-character: nothing was discarded, so the
    // tail is replaced like a plain decode would and nothing is truncated.
    // The incomplete sequence takes three bytes, so its replacement
    // character still fits the cap once escaped.
    args: [
      "-e",
      [
        "const bytes = Buffer.alloc(1000, 97)",
        "bytes[997] = 0xf0",
        "bytes[998] = 0x9f",
        "bytes[999] = 0x92",
        "process.stdout.write(bytes)",
      ].join("; "),
    ],
  });

  expect(result).toBe(`${"a".repeat(997)}�`);
});

test("cli - drops a character split by the cut", async () => {
  const executable = process.execPath;
  const cap = 999;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    // The same output with one byte less of cap: the cut falls inside the
    // character, and its kept prefix ends without a replacement character.
    args: [
      "-e",
      [
        "const bytes = Buffer.alloc(1000, 97)",
        "bytes[999] = 0xc3",
        "process.stdout.write(bytes)",
      ].join("; "),
    ],
  });

  expect(result).toBe(`${"a".repeat(cap)}\n\n…[output truncated at 999 bytes]`);
});

test("cli - bounds the result to the cap across stdout and stderr", async () => {
  const executable = process.execPath;
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    // Each pipe keeps up to the cap, and the assembled result is cut to
    // the cap once escaped — dropping stderr's tail here.
    args: [
      "-e",
      [
        "process.stdout.write(Buffer.alloc(1500, 97))",
        "setTimeout(() => process.stderr.write(Buffer.alloc(1500, 98)), 100)",
      ].join("; "),
    ],
  });

  expect(result).toBe(`${"a".repeat(cap)}\n\n…[output truncated at 1000 bytes]`);
});

test("cli - keeps the result at the cap for output that escapes large", async () => {
  const executable = process.execPath;
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const result = await cliTool.call({
    command: executable,
    // NUL bytes escape to 6 bytes each in the model request: 1500 of them
    // must be cut to what escapes within the cap, not kept whole.
    args: ["-e", "process.stdout.write(Buffer.alloc(1500))"],
  });

  expect(result).toBe(`${"\0".repeat(166)}\n\n…[output truncated at 1000 bytes]`);
});

// The children below set process.exitCode rather than calling
// process.exit(), which could cut off output still being written to a pipe.

test("cli - keeps a failing command's stderr diagnostic beside flooded stdout", async () => {
  const executable = process.execPath;
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const failure = await cliTool
    .call({
      command: executable,
      // stdout spends its pipe's cap long before the diagnostic is written,
      // so the failure's reason must survive the stdout flood.
      args: [
        "-e",
        [
          "process.stdout.write(Buffer.alloc(1500, 97))",
          'setTimeout(() => { process.stderr.write("boom"); process.exitCode = 3; }, 100)',
        ].join("; "),
      ],
    })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(`boom\n\n…[output truncated at 1000 bytes]`);
});

test("cli - reports a truncated stderr prefix when a command fails", async () => {
  const executable = process.execPath;
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const failure = await cliTool
    .call({
      command: executable,
      args: ["-e", "process.stderr.write(Buffer.alloc(1500, 101)); process.exitCode = 3"],
    })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(
    `${"e".repeat(cap)}\n\n…[output truncated at 1000 bytes]`,
  );
});

test("cli - notes truncation on failure even when stderr is empty", async () => {
  const executable = process.execPath;
  const cap = 1000;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  const failure = await cliTool
    .call({
      command: executable,
      args: ["-e", "process.stdout.write(Buffer.alloc(1500, 97)); process.exitCode = 3"],
    })
    .catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(
    `Command exited with code 3\n\n…[output truncated at 1000 bytes]`,
  );
});

test("cli - truncates at the default cap", async () => {
  const executable = process.execPath;
  const cliTool = cli({ allowedCommands: [executable] });

  const result = await cliTool.call({
    command: executable,
    args: ["-e", "process.stdout.write(Buffer.alloc(512 * 1024 + 1, 97))"],
  });

  expect(result).toBe(
    `${"a".repeat(DEFAULT_CLI_MAX_OUTPUT_BYTES)}\n\n…[output truncated at 512 KiB]`,
  );
});

test("cli - keeps memory bounded when a command emits far past the cap", async () => {
  const forceGc = (globalThis as { gc?: () => void }).gc;
  if (!forceGc) {
    throw new Error(
      "forced GC is unavailable; run the suite with `--expose-gc` " +
        "(set for the test workers by vite.config.ts test.execArgv)",
    );
  }
  const executable = process.execPath;
  const cap = 64 * 1024;
  const cliTool = cli({ allowedCommands: [executable], maxOutputBytes: cap });

  forceGc();
  await new Promise((resolve) => setTimeout(resolve, 0));
  forceGc();
  const before = process.memoryUsage().heapUsed;

  const result = await cliTool.call({
    command: executable,
    args: ["-e", "process.stdout.write(Buffer.alloc(50 * 1024 * 1024, 97))"],
  });

  forceGc();
  await new Promise((resolve) => setTimeout(resolve, 0));
  forceGc();
  const after = process.memoryUsage().heapUsed;

  expect(result).toBe(`${"a".repeat(cap)}\n\n…[output truncated at 64 KiB]`);
  // The child emitted 50 MiB and the tool kept 64 KiB of it. The bound is
  // loose so runtime heap drift cannot fail a healthy run, while holding
  // even one full copy of the output would blow past it.
  const growth = after - before;
  expect(
    growth < 8 * 1024 * 1024,
    `emitting 50 MiB grew the heap by ${(growth / 1024).toFixed(0)} KiB: ` +
      `command output is being buffered, not streamed`,
  ).toBe(true);
});

test("cli - describes the output cap", () => {
  const cliTool = cli({ allowedCommands: ["echo"], maxOutputBytes: 2048 });

  expect(cliTool.description).toContain(
    "Output over 2 KiB (stdout and stderr combined) is truncated.",
  );
});

test("cli - rejects an invalid maxOutputBytes", () => {
  let error: unknown;
  try {
    cli({ allowedCommands: ["echo"], maxOutputBytes: 0 });
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(TypeError);
  expect((error as TypeError).message).toContain("maxBytes must be a positive integer");
});
