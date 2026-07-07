import { assert, assertEquals } from "@std/assert";
import { mcp } from "@/tools/mcp/mcp.ts";

/**
 * Minimal in-process Streamable HTTP MCP server: JSON-RPC requests are
 * answered with plain `application/json` responses (the spec's simplest
 * legal shape), notifications with 202, and the optional GET event
 * stream with 405. Covers `transportFrom`'s `url` branch and the
 * `headers → requestInit` wiring — the auth story for hosted servers.
 */
function serveFixture() {
  const authorization: (string | null)[] = [];

  const server = Deno.serve(
    { port: 0, onListen: () => {} },
    async (request) => {
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      authorization.push(request.headers.get("authorization"));

      const message = await request.json();
      if (message.id === undefined) {
        // Notification (e.g. notifications/initialized).
        return new Response(null, { status: 202 });
      }

      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "http-fixture", version: "0.0.1" },
          };
          break;
        case "tools/list":
          result = {
            tools: [{
              name: "ping",
              description: "Reply with pong.",
              inputSchema: { type: "object", properties: {} },
            }],
          };
          break;
        case "tools/call":
          result = { content: [{ type: "text", text: "pong" }] };
          break;
        default:
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: `unexpected ${message.method}` },
          });
      }
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    },
  );

  return { server, authorization };
}

Deno.test("mcp - streamable HTTP round-trip passes static headers through", async () => {
  const { server, authorization } = serveFixture();
  const connection = await mcp({
    name: "http",
    transport: {
      url: `http://127.0.0.1:${server.addr.port}/mcp`,
      headers: { authorization: "Bearer test-token" },
    },
  });

  try {
    const ping = connection.tools().find((tool) => tool.name === "http_ping");
    assert(ping, "ping missing");
    assertEquals(await ping.call({}), "pong");

    // initialize, initialized notification, tools/list, tools/call — every
    // request must carry the configured header.
    assert(authorization.length >= 4, `only ${authorization.length} requests`);
    assertEquals(
      authorization,
      authorization.map(() => "Bearer test-token"),
    );
  } finally {
    await connection.close();
    await server.shutdown();
  }
});
