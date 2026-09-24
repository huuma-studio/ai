import { assert, assertEquals, assertRejects, assertStrictEquals, assertStringIncludes } from "@std/assert";
// Dev-only SDK import for the pre-built transport; publish excludes tests.
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mcp, type McpTransport } from "@/tools/mcp/mcp.ts";

const FIXTURE = new URL("./testdata/server.ts", import.meta.url).pathname;

// Guards the Deno node-compat path (child process spawn, stdio framing) —
// the SDK's least-tested surface under Deno. Deno's sanitizers fail this
// test if the child process leaks past close().
Deno.test("mcp - stdio round-trip against a child-process server", async () => {
  const fixture = await mcp({
    name: "fixture",
    transport: {
      command: Deno.execPath(),
      args: ["run", "--allow-read", "--allow-env", FIXTURE],
    },
  });

  try {
    const names = fixture.tools().map((tool) => tool.name);
    assert(names.includes("fixture_add"), `add missing in ${names}`);
    assert(names.includes("fixture_echo_json"), `echo_json missing`);
    assert(names.includes("fixture_fail"), `fail missing`);

    const add = fixture.tools().find((tool) => tool.name === "fixture_add");
    assertEquals(await add?.call({ a: 1, b: 2 }), "3");
  } finally {
    await fixture.close();
  }
});

// A process that speaks JSON-RPC but rejects the MCP handshake: the child
// is already running when connect() fails, so connect() must close the
// transport — the sanitizers fail this test if the child leaks.
const NOT_AN_MCP_SERVER = `
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  for await (const chunk of Deno.stdin.readable) {
    for (const line of decoder.decode(chunk).split("\\n")) {
      if (!line.trim()) continue;
      const { id } = JSON.parse(line);
      if (id === undefined) continue;
      await Deno.stdout.write(encoder.encode(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "not an MCP server" },
      }) + "\\n"));
    }
  }
`;

Deno.test("mcp - stdio child is cleaned up when the handshake fails", async () => {
  await assertRejects(() =>
    mcp({
      name: "broken",
      transport: {
        command: Deno.execPath(),
        args: ["eval", NOT_AN_MCP_SERVER],
      },
    })
  );
});

// A child that prints to stderr, then reads stdin forever without ever
// answering `initialize`, holding the handshake open until the caller aborts.
const STALLING_SERVER = `
  await Deno.stderr.write(new TextEncoder().encode("booting slowly\\n"));
  for await (const _ of Deno.stdin.readable) { /* never reply */ }
`;

Deno.test("mcp - aborting the stdio handshake rejects with the reason and cleans up the child", async () => {
  // A pre-built SDK transport (the escape hatch) lets the test watch the
  // same stderr stream the client captures from. mcp() attaches its
  // capture listener synchronously, before this test's listener, and
  // listeners run in registration order — so once the test sees the
  // output, the client has already captured it and the stderr-enrichment
  // path is live when the abort lands.
  const transport = new StdioClientTransport({
    command: Deno.execPath(),
    args: ["eval", STALLING_SERVER],
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

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      transport.stderr?.once("data", () => resolve());
      timer = setTimeout(
        () => reject(new Error("stalling child never wrote to stderr")),
        10_000,
      );
    });
  } catch (error) {
    // Still abort and settle the attempt so no child outlives the failure.
    controller.abort();
    await pending.catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  controller.abort(reason);

  // Exactly the caller's reason — not wrapped with the captured stderr.
  // The sanitizers fail this test if the child outlives the rejection.
  const error = await assertRejects(() => pending);
  assertStrictEquals(error, reason);
});

// Prints a diagnostic, then rejects the MCP handshake like
// NOT_AN_MCP_SERVER.
const FAILING_SERVER = `
  await Deno.stderr.write(new TextEncoder().encode("missing libnss3\\n"));
  ${NOT_AN_MCP_SERVER}
`;

Deno.test("mcp - an abort during cleanup keeps a failed handshake's stderr diagnostics", async () => {
  const controller = new AbortController();
  const transport = new StdioClientTransport({
    command: Deno.execPath(),
    args: ["eval", FAILING_SERVER],
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
  // Make sure the diagnostic is captured before the handshake fails.
  const printed = new Promise((resolve) =>
    transport.stderr?.once("data", resolve)
  );

  const pending = mcp({
    name: "failing",
    transport: transport as McpTransport,
    signal: controller.signal,
  });
  pending.catch(() => {});
  await printed;

  const error = await assertRejects(() => pending, Error);
  assertStringIncludes(error.message, "not an MCP server");
  assertStringIncludes(error.message, "Child stderr: missing libnss3");
});
