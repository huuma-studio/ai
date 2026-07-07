/**
 * Internal seam around the official MCP SDK.
 *
 * Every `@modelcontextprotocol/sdk` import lives in this file behind the
 * narrow types in `types.ts`, so the v1 → v2 SDK swap after the 2026-07-28
 * spec revision touches only this module (ADR 0002).
 *
 * @module
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONSchema } from "@huuma/validate";
import type {
  McpCallResult,
  McpClient,
  McpToolDef,
  McpTransportOptions,
} from "@/tools/mcp/types.ts";
import denoJson from "../../../deno.json" with { type: "json" };

/** Connect to an MCP server and return the narrow client handle. */
export async function connect(
  options: McpTransportOptions,
): Promise<McpClient> {
  // Sent to every server in the initialize handshake; sourced from
  // deno.json so version bumps can't leave it behind.
  const client = new Client({ name: denoJson.name, version: denoJson.version });
  try {
    await client.connect(transportFrom(options));
  } catch (error) {
    // A stdio transport may have already spawned the child process when the
    // MCP handshake fails; close so it doesn't outlive the rejected connect.
    // SDK v1 fires an unawaited close() itself on init failure, but that is
    // an implementation detail this seam must not depend on (ADR 0002).
    await client.close().catch(() => {});
    throw error;
  }

  return {
    async listTools() {
      const tools: McpToolDef[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const { name, description, inputSchema } of page.tools) {
          tools.push({
            name,
            description,
            inputSchema: inputSchema as JSONSchema,
          });
        }
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args, timeout) {
      const result = await client.callTool(
        { name, arguments: args },
        undefined,
        timeout === undefined ? undefined : { timeout },
      );
      return result as McpCallResult;
    },
    close: () => client.close(),
  };
}

function transportFrom(options: McpTransportOptions): Transport {
  if ("command" in options) {
    const { command, args, env, cwd } = options;
    return new StdioClientTransport({ command, args, env, cwd });
  }

  if ("url" in options) {
    return new StreamableHTTPClientTransport(
      new URL(options.url),
      options.headers
        ? { requestInit: { headers: options.headers } }
        : undefined,
    );
  }

  // Structural escape hatch: a pre-built transport (e.g. an SDK transport
  // instance). McpTransport mirrors the SDK's Transport shape.
  return options as Transport;
}
