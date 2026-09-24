/**
 * MCP server tools as a tool factory.
 *
 * Connects to a Model Context Protocol server (stdio or Streamable HTTP),
 * lists its tools, and wraps each one as an ordinary {@link Tool} so agents
 * can use them without any adapter changes (ADR 0002).
 *
 * Permissions: stdio transports need `--allow-run --allow-read --allow-env`
 * (a child process is spawned); HTTP transports need `--allow-net`.
 *
 * @example
 * ```typescript
 * import { agent } from "jsr:@huuma/ai/agent";
 * import { anthropic } from "jsr:@huuma/ai/models/anthropic";
 * import { mcp } from "jsr:@huuma/ai/tools";
 *
 * const deepwiki = await mcp({
 *   name: "deepwiki",
 *   transport: { url: "https://mcp.deepwiki.com/mcp" },
 * });
 *
 * const assistant = agent({
 *   model: anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") }),
 *   modelId: "claude-fable-5",
 *   systemPrompt: "You answer questions about open source repositories.",
 *   tools: [...deepwiki.tools()],
 * });
 *
 * const messages = await assistant.run("What is huuma-studio/ai about?");
 * await deepwiki.close(); // caller-owned lifecycle
 * ```
 *
 * @module
 */
import { Tool, type ToolOutput } from "@/tools/mod.ts";
import { connect } from "@/tools/mcp/client.ts";
import { flattenResult } from "@/tools/mcp/content.ts";
import { modelToolName, validateServerName } from "@/tools/mcp/naming.ts";
import { PassthroughSchema } from "@/tools/mcp/schema.ts";
import type { McpClient, McpToolDef } from "@/tools/mcp/types.ts";
import type { McpTransportOptions } from "@/tools/mcp/types.ts";

export type {
  McpHttpTransportOptions,
  McpStdioTransportOptions,
  McpTransport,
  McpTransportOptions,
} from "@/tools/mcp/types.ts";

/** Options for connecting to an MCP server via {@link mcp}. */
export interface McpToolsOptions {
  /**
   * Namespace for this server. Model-visible tool names are prefixed as
   * `${name}_${toolName}`. Must match `[A-Za-z0-9_-]+`.
   */
  name: string;
  /** Transport configuration (`command` → stdio, `url` → Streamable HTTP). */
  transport: McpTransportOptions;
  /** Only expose these tools, matched by original (unprefixed) name. */
  allowedTools?: string[];
  /** Per tool call timeout in milliseconds (SDK default: 60s). */
  timeout?: number;
  /**
   * Cancels connecting and the initial tool listing. Only covers
   * {@link mcp} itself: tool calls are cancelled through their own
   * `ToolContext` signal, and {@link McpConnection.refresh} takes its own.
   */
  signal?: AbortSignal;
}

/**
 * Handle to a connected MCP server.
 *
 * One handle per server; multi-server setups compose handles:
 * `[...a.tools(), ...b.tools()]`. `close()` is the caller's obligation —
 * stdio transports own a child process.
 */
export class McpConnection {
  #name: string;
  #client: McpClient;
  #allowedTools?: string[];
  #timeout?: number;
  // deno-lint-ignore no-explicit-any
  #tools: Tool<any, string | ToolOutput<string>>[];

  /** @internal Use {@link mcp} to create instances. */
  constructor(options: {
    name: string;
    client: McpClient;
    defs: McpToolDef[];
    allowedTools?: string[];
    timeout?: number;
  }) {
    this.#name = options.name;
    this.#client = options.client;
    this.#allowedTools = options.allowedTools;
    this.#timeout = options.timeout;
    this.#tools = this.#wrap(options.defs);
  }

  /** The tools listed at connect time (or at the last `refresh()`). */
  // deno-lint-ignore no-explicit-any
  tools(): Tool<any, string | ToolOutput<string>>[] {
    return [...this.#tools];
  }

  /**
   * Re-list the server's tools.
   *
   * Affects subsequent `tools()` calls only; an already-constructed agent
   * keeps its snapshot (agents freeze their toolset at construction).
   *
   * @param options.signal Cancels the listing: the in-flight page request
   * is cancelled, no further pages are fetched, and `refresh()` rejects
   * with the signal's reason, keeping the previous tools.
   */
  async refresh(
    options: { signal?: AbortSignal } = {},
    // deno-lint-ignore no-explicit-any
  ): Promise<Tool<any, string | ToolOutput<string>>[]> {
    this.#tools = this.#wrap(await this.#client.listTools(options));
    return this.tools();
  }

  /** Close the connection. Required for stdio: it terminates the child. */
  close(): Promise<void> {
    return this.#client.close();
  }

  // deno-lint-ignore no-explicit-any
  #wrap(defs: McpToolDef[]): Tool<any, string | ToolOutput<string>>[] {
    const allowed = this.#allowedTools;
    // Sanitization can collide below the length cap ("repo.search" and
    // "repo_search" both become "srv_repo_search"); the tool map would
    // silently keep the last one, so fail loud instead (ADR 0002).
    const seen = new Map<string, string>();
    return defs
      .filter((def) => !allowed || allowed.includes(def.name))
      .map((def) => {
        const name = modelToolName(this.#name, def.name);
        const clash = seen.get(name);
        if (clash !== undefined) {
          throw new Error(
            `mcp server "${this.#name}": tools "${clash}" and ` +
              `"${def.name}" both map to model tool name "${name}" — ` +
              `exclude one via allowedTools`,
          );
        }
        seen.set(name, def.name);
        // Spec 2026-07-28: surface the tool's human-readable title in the
        // model-visible description, prepended to the existing description.
        const description = def.title
          ? def.description
            ? `${def.title} — ${def.description}`
            : def.title
          : (def.description ?? "");
        return new Tool({
          name,
          description,
          input: new PassthroughSchema(def.inputSchema),
          // The server is always called with the original tool name; the
          // prefixed name exists only for the model. The call's signal —
          // caller cancellation plus its timeout — is forwarded so the
          // server is told to stop, not just abandoned; the SDK deadline
          // is the shorter of the configured and the per-call timeout.
          fn: async (props, { signal, timeout }) =>
            flattenResult(
              await this.#client.callTool(
                def.name,
                props,
                shortestTimeout(this.#timeout, timeout),
                signal,
              ),
            ),
        });
      });
  }
}

function shortestTimeout(
  configured: number | undefined,
  perCall: number | undefined,
): number | undefined {
  if (configured === undefined) return perCall;
  if (perCall === undefined) return configured;
  return Math.min(configured, perCall);
}

/** Connect to an MCP server and expose its tools as huuma {@link Tool}s.
 *
 * Connects and lists eagerly: `Agent` snapshots tools at construction, so
 * the tools must exist before `agent()` is called. Connection failures
 * throw here, where the caller can handle them per server.
 *
 * @param options Server namespace, transport, and optional tool filter/timeout.
 * @returns A connected {@link McpConnection} handle.
 */
export async function mcp(options: McpToolsOptions): Promise<McpConnection> {
  const { name, transport, allowedTools, timeout, signal } = options;

  validateServerName(name);
  signal?.throwIfAborted();

  const client = await connect(transport, name, signal);
  try {
    const defs = await client.listTools({ signal });
    return new McpConnection({ name, client, defs, allowedTools, timeout });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
