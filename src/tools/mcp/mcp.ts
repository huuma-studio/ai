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
import { Tool } from "@/tools/mod.ts";
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
  #tools: Tool<any, string>[];

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
  tools(): Tool<any, string>[] {
    return [...this.#tools];
  }

  /**
   * Re-list the server's tools.
   *
   * Affects subsequent `tools()` calls only; an already-constructed agent
   * keeps its snapshot (agents freeze their toolset at construction).
   */
  // deno-lint-ignore no-explicit-any
  async refresh(): Promise<Tool<any, string>[]> {
    this.#tools = this.#wrap(await this.#client.listTools());
    return this.tools();
  }

  /** Close the connection. Required for stdio: it terminates the child. */
  close(): Promise<void> {
    return this.#client.close();
  }

  // deno-lint-ignore no-explicit-any
  #wrap(defs: McpToolDef[]): Tool<any, string>[] {
    const allowed = this.#allowedTools;
    return defs
      .filter((def) => !allowed || allowed.includes(def.name))
      .map((def) =>
        new Tool({
          name: modelToolName(this.#name, def.name),
          description: def.description ?? "",
          input: new PassthroughSchema(def.inputSchema),
          // The server is always called with the original tool name; the
          // prefixed name exists only for the model.
          fn: async (props) =>
            flattenResult(
              await this.#client.callTool(def.name, props, this.#timeout),
            ),
        })
      );
  }
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
  const { name, transport, allowedTools, timeout } = options;

  validateServerName(name);

  const client = await connect(transport);
  try {
    const defs = await client.listTools();
    return new McpConnection({ name, client, defs, allowedTools, timeout });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
