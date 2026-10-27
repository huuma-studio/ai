import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vite-plus/test";
import { mcp } from "./mcp.ts";

/**
 * Minimal in-process Streamable HTTP MCP server: JSON-RPC requests are
 * answered with plain `application/json` responses (the spec's simplest
 * legal shape), notifications with 202, and the optional GET event
 * stream with 405. Covers `transportFrom`'s `url` branch and the
 * `headers → requestInit` wiring — the auth story for hosted servers.
 */
async function serveFixture() {
  const authorization: (string | null)[] = [];

  const reply = (response: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      response.writeHead(status).end();
    } else {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    }
  };

  const server = createServer(async (request, response) => {
    if (request.method !== "POST") {
      return reply(response, 405);
    }
    authorization.push(request.headers.authorization ?? null);

    let raw = "";
    for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw);
    if (message.id === undefined) {
      // Notification (e.g. notifications/initialized).
      return reply(response, 202);
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
          tools: [
            {
              name: "ping",
              description: "Reply with pong.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
        break;
      case "tools/call":
        result = { content: [{ type: "text", text: "pong" }] };
        break;
      default:
        return reply(response, 200, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `unexpected ${message.method}` },
        });
    }
    reply(response, 200, { jsonrpc: "2.0", id: message.id, result });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return { server, port, authorization };
}

test("mcp - streamable HTTP round-trip passes static headers through", async () => {
  const { server, port, authorization } = await serveFixture();
  const connection = await mcp({
    name: "http",
    transport: {
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { authorization: "Bearer test-token" },
    },
  });

  try {
    const ping = connection.tools().find((tool) => tool.name === "http_ping");
    expect(ping, "ping missing").toBeDefined();
    expect(await ping!.call({})).toBe("pong");

    // initialize, initialized notification, tools/list, tools/call — every
    // request must carry the configured header.
    expect(authorization.length, `only ${authorization.length} requests`).toBeGreaterThanOrEqual(4);
    expect(authorization).toStrictEqual(authorization.map(() => "Bearer test-token"));
  } finally {
    await connection.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
