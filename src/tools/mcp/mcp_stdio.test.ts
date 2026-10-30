import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vite-plus/test";
// Dev-only SDK import for the pre-built transport; publish excludes tests.
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { mcp, type McpTransport } from "./mcp.ts";

const FIXTURE = fileURLToPath(new URL("./testdata/server.ts", import.meta.url));

// Every child here writes its PID to the file named by its last argument,
// so each test can check that the child exited: close(), a failed
// handshake and a cancelled one must all terminate it.
const WRITE_PID = `require("node:fs").writeFileSync(process.argv.at(-1), String(process.pid));`;

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A path for a child's PID file, in a temp dir removed after the test. */
async function pidFilePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "huuma-ai-mcp-"));
  tempDirs.push(dir);
  return join(dir, "pid");
}

/** Waits up to 5 s for the process whose PID is in `pidFile` to exit. */
async function expectExited(pidFile: string): Promise<void> {
  const pid = Number(await readFile(pidFile, "utf8"));
  expect(pid, "child wrote no PID").toBeGreaterThan(0);
  const deadline = Date.now() + 5_000;
  while (isRunning(pid)) {
    if (Date.now() > deadline) {
      process.kill(pid, "SIGKILL");
      expect.fail(`child ${pid} still running 5 s after cleanup`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Guards the child-process path (spawn, stdio framing) end to end. Node
// strips the fixture's TypeScript types natively, so it runs without a
// loader. close() must terminate the child.
test("mcp - stdio round-trip against a child-process server", async () => {
  const pidFile = await pidFilePath();
  const fixture = await mcp({
    name: "fixture",
    transport: {
      command: process.execPath,
      args: [FIXTURE, pidFile],
    },
  });

  try {
    const names = fixture.tools().map((tool) => tool.name);
    expect(names, `add missing in ${names.join(", ")}`).toContain("fixture_add");
    expect(names, `echo_json missing`).toContain("fixture_echo_json");
    expect(names, `fail missing`).toContain("fixture_fail");

    const add = fixture.tools().find((tool) => tool.name === "fixture_add");
    expect(await add?.call({ a: 1, b: 2 })).toBe("3");
  } finally {
    await fixture.close();
  }
  await expectExited(pidFile);
});

// A process that speaks JSON-RPC but rejects the MCP handshake: the child
// is already running when connect() fails, so connect() must close the
// transport rather than leak the child.
const NOT_AN_MCP_SERVER = `
  ${WRITE_PID}
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const { id } = JSON.parse(line);
      if (id === undefined) continue;
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "not an MCP server" },
      }) + "\\n");
    }
  });
`;

test("mcp - stdio child is cleaned up when the handshake fails", async () => {
  const pidFile = await pidFilePath();
  await expect(
    mcp({
      name: "broken",
      transport: {
        command: process.execPath,
        args: ["--eval", NOT_AN_MCP_SERVER, pidFile],
      },
    }),
  ).rejects.toThrow();
  await expectExited(pidFile);
});

/**
 * Resolves once the child behind `transport` writes to stderr. If it has
 * not done so within the deadline, aborts and settles the connection
 * attempt — so no child outlives the test — and rejects with how that
 * attempt ended, so a broken fixture fails with its real error instead of
 * stalling the run.
 */
async function firstStderrOutput(
  transport: StdioClientTransport,
  pending: Promise<unknown>,
  controller: AbortController,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      transport.stderr?.once("data", () => resolve());
      timer = setTimeout(() => reject(new Error("child never wrote to stderr")), 10_000);
    });
  } catch (error) {
    controller.abort();
    const outcome = await pending.then(
      () => "connected",
      (reason) => `failed: ${reason}`,
    );
    throw new Error(`${(error as Error).message} (connection ${outcome})`);
  } finally {
    clearTimeout(timer);
  }
}

// A child that prints to stderr, then keeps stdin open forever without ever
// answering `initialize`, holding the handshake open until the caller aborts.
const STALLING_SERVER = `
  ${WRITE_PID}
  process.stderr.write("booting slowly\\n");
  process.stdin.resume(); // never reply
`;

test("mcp - aborting the stdio handshake rejects with the reason and cleans up the child", async () => {
  // A pre-built SDK transport (the escape hatch) lets the test watch the
  // same stderr stream the client captures from. mcp() attaches its
  // capture listener synchronously, before this test's listener, and
  // listeners run in registration order — so once the test sees the
  // output, the client has already captured it and the stderr-enrichment
  // path is live when the abort lands.
  const pidFile = await pidFilePath();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--eval", STALLING_SERVER, pidFile],
    stderr: "pipe",
  });
  const controller = new AbortController();
  const reason = new Error("stop");

  const pending = mcp({
    name: "stalling",
    transport: transport as McpTransport,
    signal: controller.signal,
  });
  pending.catch(() => {});

  await firstStderrOutput(transport, pending, controller);
  controller.abort(reason);

  // Exactly the caller's reason — not wrapped with the captured stderr.
  // connect() closes the transport before rejecting, so the child does not
  // outlive the rejection.
  const error = await pending.catch((e: unknown) => e);
  expect(error).toBe(reason);
  await expectExited(pidFile);
});

// Prints a diagnostic, then rejects the MCP handshake like
// NOT_AN_MCP_SERVER.
const FAILING_SERVER = `
  process.stderr.write("missing libnss3\\n");
  ${NOT_AN_MCP_SERVER}
`;

test("mcp - an abort during cleanup keeps a failed handshake's stderr diagnostics", async () => {
  const controller = new AbortController();
  const pidFile = await pidFilePath();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--eval", FAILING_SERVER, pidFile],
    stderr: "pipe",
  });
  // The handshake fails on its own; the abort must land while connect()
  // is cleaning up after that failure. Closing starts as the handshake
  // fails, and each close first waits for a timer — timers fire only after
  // every pending microtask, so by then the rejection has reached
  // connect(), been classified, and connect() is awaiting its own close.
  // Patched on the instance so the client still sees a stdio transport
  // and captures its stderr.
  const close = transport.close.bind(transport);
  transport.close = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("late abort"));
    return await close();
  };
  const pending = mcp({
    name: "failing",
    transport: transport as McpTransport,
    signal: controller.signal,
  });
  pending.catch(() => {});
  // Make sure the diagnostic was captured, bounded like the test above.
  await firstStderrOutput(transport, pending, controller);

  const error = await pending.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  const { message } = error as Error;
  expect(message).toContain("not an MCP server");
  expect(message).toContain("Child stderr: missing libnss3");
  await expectExited(pidFile);
});
