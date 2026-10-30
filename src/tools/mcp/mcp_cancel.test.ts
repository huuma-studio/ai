import { expect, test } from "vite-plus/test";
// Dev-only SDK imports for the in-process server; publish excludes tests.
import { InMemoryTransport, Server } from "@modelcontextprotocol/server";
import { mcp, type McpTransport } from "./mcp.ts";
import { callTool, tools } from "../mod.ts";
import type { JSONSchema, Message, ToolMessage } from "../../agent/mod.ts";

const EMPTY_SCHEMA = { type: "object" as const, properties: {} };

/**
 * In-process server whose `hang` tool — and, once `hangListing` is set,
 * its tools/list — never answers on its own: each request stays pending
 * until the client cancels it. The SDK aborts a handler's `extra.signal`
 * when `notifications/cancelled` arrives, so `cancelled` proves the
 * cancellation reached the server rather than the client merely giving up.
 */
async function cancellableServer() {
  const state = {
    hangListing: false,
    listRequests: 0,
    /** Requests (tool calls and hanging listings) awaiting cancellation. */
    started: 0,
    cancelled: 0,
  };
  let notifyStarted = () => {};
  const server = new Server(
    { name: "huuma-cancel-fixture", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  const untilCancelled = (signal: AbortSignal) =>
    new Promise<never>(() => {
      signal.addEventListener("abort", () => state.cancelled++, {
        once: true,
      });
    });
  server.setRequestHandler(
    "tools/list",
    (_request: unknown, ctx: { mcpReq: { signal: AbortSignal } }) => {
      state.listRequests++;
      if (!state.hangListing) {
        return { tools: [{ name: "hang", inputSchema: EMPTY_SCHEMA }] };
      }
      state.started++;
      notifyStarted();
      return untilCancelled(ctx.mcpReq.signal);
    },
  );
  server.setRequestHandler(
    "tools/call",
    (_request: unknown, ctx: { mcpReq: { signal: AbortSignal } }) => {
      state.started++;
      notifyStarted();
      return untilCancelled(ctx.mcpReq.signal);
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  /** Resolves once `count` pending requests have reached the server, and
   * rejects after a deadline — a request that never arrives must fail the
   * test rather than stall the run. */
  const started = (count: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`only ${state.started} of ${count} requests reached the server`)),
        2_000,
      );
      const check = () => {
        if (state.started < count) return;
        clearTimeout(timer);
        resolve();
      };
      notifyStarted = check;
      check();
    });

  return { transport: clientTransport as McpTransport, state, started };
}

/** Polls until the server has observed `count` cancellations. */
async function cancellations(state: { cancelled: number }, count: number): Promise<void> {
  for (let i = 0; i < 200 && state.cancelled < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(state.cancelled).toBe(count);
}

test("mcp - aborting a tool call cancels it on the server and rejects with the reason", async () => {
  const { transport, state, started } = await cancellableServer();
  const connection = await mcp({ name: "srv", transport });
  try {
    const [hang] = connection.tools();
    const controller = new AbortController();
    const reason = new Error("stop");

    const pending = hang.call({}, { signal: controller.signal });
    await started(1);
    controller.abort(reason);

    const error = await pending.catch((e: unknown) => e);
    expect(error).toBe(reason);
    await cancellations(state, 1);
  } finally {
    await connection.close();
  }
});

test("mcp - a per-call timeout cancels the request on the server", async () => {
  const { transport, state } = await cancellableServer();
  // A long configured timeout: the shorter per-call timeout must win.
  const connection = await mcp({ name: "srv", transport, timeout: 60_000 });
  try {
    const [hang] = connection.tools();

    const error = await hang.call({}, { timeout: 50 }).catch((e: unknown) => e);
    expect((error as DOMException).name).toBe("TimeoutError");
    await cancellations(state, 1);
  } finally {
    await connection.close();
  }
});

test("mcp - aborting a batch fails and cancels every in-flight MCP call", async () => {
  const { transport, state, started } = await cancellableServer();
  const connection = await mcp({ name: "srv", transport });
  try {
    const controller = new AbortController();
    const calls = ["a", "b"].map((id) => ({
      id,
      name: "srv_hang",
      props: {} as unknown as JSONSchema,
    }));
    const messages: Message[] = [
      {
        role: "model",
        contents: calls.map((toolCall) => ({ toolCall })),
        toolCalls: calls,
      },
    ];

    const pending = callTool(tools(connection.tools()), {
      signal: controller.signal,
    })(messages);
    await started(2);
    controller.abort(new Error("stop"));

    const result = (await pending).at(-1) as ToolMessage;
    expect(
      result.contents.map((content) =>
        "toolResult" in content ? content.toolResult.result.error : undefined,
      ),
    ).toStrictEqual(["stop", "stop"]);
    await cancellations(state, 2);
  } finally {
    await connection.close();
  }
});

test("mcp - refresh with an aborted signal rejects, stops paging, and keeps the tools", async () => {
  const { transport, state, started } = await cancellableServer();
  const connection = await mcp({ name: "srv", transport });
  try {
    state.hangListing = true;
    const controller = new AbortController();
    const reason = new Error("stop");

    const pending = connection.refresh({ signal: controller.signal });
    await started(1);
    controller.abort(reason);

    const error = await pending.catch((e: unknown) => e);
    expect(error).toBe(reason);
    await cancellations(state, 1);
    // One eager listing plus the single cancelled refresh page.
    expect(state.listRequests).toBe(2);
    expect(connection.tools().map((tool) => tool.name)).toStrictEqual(["srv_hang"]);
  } finally {
    await connection.close();
  }
});

test("mcp - an aborted signal stops mcp() before connecting", async () => {
  const { transport, state } = await cancellableServer();
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);

  const error = await mcp({ name: "srv", transport, signal: controller.signal }).catch(
    (e: unknown) => e,
  );
  expect(error).toBe(reason);
  expect(state.listRequests).toBe(0);
});

test("mcp - aborting during the initial listing rejects mcp() with the reason", async () => {
  const { transport, state, started } = await cancellableServer();
  state.hangListing = true;
  const controller = new AbortController();
  const reason = new Error("stop");

  const pending = mcp({ name: "srv", transport, signal: controller.signal });
  await started(1);
  controller.abort(reason);

  const error = await pending.catch((e: unknown) => e);
  expect(error).toBe(reason);
  await cancellations(state, 1);
});
