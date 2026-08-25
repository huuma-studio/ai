/**
 * Internal seam around the official MCP SDK.
 *
 * Every `@modelcontextprotocol/sdk` import lives in this file behind the
 * narrow types in `types.ts`, so the v1 → v2 SDK swap after the 2026-07-28
 * spec revision touches only this module (ADR 0002).
 *
 * The 2026-07-28 revision introduces a stateless protocol model where the
 * initialize handshake is optional.  SDK 1.30.0 still performs it inside
 * `connect()`, but this module no longer *depends* on handshake state for
 * its logic — the version probe is best-effort and tool calls are
 * per-request.  When a future SDK version drops the handshake entirely
 * this code will keep working unchanged.
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
  McpIcon,
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
  const transport = transportFrom(options);

  // Collect stderr from stdio transports so connection failures can surface
  // the child process's actual error output (e.g. "npx: not found",
  // "Missing system library libnss3") instead of the opaque SDK message
  // "MCP error -32000: Connection closed". Capture is capped at a fixed byte
  // limit so a child spamming stderr during a slow or failed handshake cannot
  // cause unbounded memory growth or an arbitrarily large error message. The
  // listener is removed once the handshake succeeds so a long-lived child's
  // recurring stderr does not accumulate either.
  const STDERR_CAPTURE_LIMIT = 4096;
  const stderrChunks: string[] = [];
  let stderrCollectedBytes = 0;
  let stderrTruncated = false;
  const stderrListener = (chunk: Uint8Array) => {
    if (stderrCollectedBytes >= STDERR_CAPTURE_LIMIT) {
      stderrTruncated = true;
      return;
    }
    stderrChunks.push(new TextDecoder().decode(chunk));
    stderrCollectedBytes += chunk.byteLength;
  };
  if (transport instanceof StdioClientTransport && transport.stderr) {
    transport.stderr.on("data", stderrListener);
  }

  try {
    await client.connect(transport);
  } catch (error) {
    // A stdio transport may have already spawned the child process when the
    // MCP handshake fails; close so it doesn't outlive the rejected connect.
    // SDK v1 fires an unawaited close() itself on init failure, but that is
    // an implementation detail this seam must not depend on (ADR 0002).
    await client.close().catch(() => {});

    // Enhance the error with captured stderr to aid diagnosis. The child's
    // stderr often contains the real reason the process exited before the
    // MCP handshake (missing binary, missing library, network error, etc.).
    let stderrText = stderrChunks.join("").trim();
    if (stderrTruncated) {
      stderrText += `\n[stderr truncated at ${STDERR_CAPTURE_LIMIT} bytes]`;
    }
    if (stderrText) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\nChild stderr: ${stderrText}`, {
        cause: error,
      });
    }
    throw error;
  }

  // Handshake succeeded — stop collecting stderr so a long-lived child's
  // recurring diagnostics don't accumulate unboundedly in memory.
  if (transport instanceof StdioClientTransport && transport.stderr) {
    transport.stderr.removeListener("data", stderrListener);
  }
  stderrChunks.length = 0;

  // Best-effort version probe (spec 2026-07-28: server/discover).
  // The SDK exposes the negotiated version via getServerVersion() after
  // the initialize handshake.  We log but never fail on its absence —
  // a server that doesn't report a version is still usable.
  const serverVersion = client.getServerVersion();
  if (serverVersion) {
    // Stored for diagnostics; not currently surfaced but available for
    // future feature-gating based on protocol version.
    void serverVersion;
  }

  return {
    async listTools() {
      const tools: McpToolDef[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const tool of page.tools) {
          const { name, description, inputSchema, title, icons } = tool;
          tools.push({
            name,
            description,
            title,
            icons: icons as McpIcon[] | undefined,
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
      const callResult = result as McpCallResult;

      // Spec 2026-07-28: resultType "input_required" signals a Model
      // Requesting Tool Result (MRTR) — the server needs additional input
      // from a user-in-the-loop before the result is usable.  This client
      // has no interactive loop, so MRTR results are surfaced as errors
      // rather than silently returning incomplete data.
      if (callResult.resultType === "input_required") {
        const text = (callResult.content ?? [])
          .filter(
            (block): block is Extract<
              { type: "text"; text: string },
              { type: "text" }
            > => block.type === "text",
          )
          .map((block) => block.text)
          .join("\n");
        throw new Error(
          text ||
            `MCP tool "${name}" returned resultType "input_required" — ` +
              `additional input is needed but no interactive loop is available`,
        );
      }

      return callResult;
    },
    close: () => client.close(),
  };
}

function transportFrom(options: McpTransportOptions): Transport {
  if ("command" in options) {
    const { command, args, env, cwd } = options;
    // stderr: "pipe" creates a PassThrough stream accessible via
    // transport.stderr, so connect() can capture and surface the child's
    // error output when the MCP handshake fails. Without this, stderr
    // defaults to "inherit" and the actual error is silently lost.
    return new StdioClientTransport({ command, args, env, cwd, stderr: "pipe" });
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