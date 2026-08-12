/**
 * SDK-free internal contract for the MCP tool factory.
 *
 * `client.ts` is the only module allowed to import the MCP SDK; everything
 * else (and every exported signature) speaks these types (ADR 0002).
 *
 * @module
 */
import type { JSONSchema } from "@huuma/validate";

/** Icon declaration (spec 2026-07-28: optional `icons` on tools and links). */
export interface McpIcon {
  /** Icon source URL or data URI. */
  src: string;
  /** MIME type of the icon resource. */
  mimeType?: string;
  /** Available sizes (e.g. `["16x16","32x32"]`). */
  sizes?: string[];
  /** Icon theme variant. */
  theme?: "light" | "dark";
}

/** Tool definition as listed by an MCP server. */
export interface McpToolDef {
  /** Original tool name on the server. */
  name: string;
  /** Tool description, if the server provides one. */
  description?: string;
  /** Human-readable display title (spec 2026-07-28). */
  title?: string;
  /** Icon set for UI rendering (spec 2026-07-28). */
  icons?: McpIcon[];
  /** The server's raw JSON Schema for tool input. */
  inputSchema: JSONSchema;
}

/** Content block of an MCP tool result. */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | {
    type: "resource_link";
    uri: string;
    name?: string;
    description?: string;
    mimeType?: string;
    size?: number;
    title?: string;
    icons?: McpIcon[];
  }
  | {
    type: "resource";
    resource: { uri: string; mimeType?: string; text?: string; blob?: string };
  };

/**
 * Result type discriminator for tool call results (spec 2026-07-28).
 *
 * - `"complete"` (default when absent): the result is final and ready to
 *   flatten for the model.
 * - `"input_required"`: the server signals a Model Requesting Tool Result
 *   (MRTR) — it needs additional input from the caller before the result
 *   is usable.  This client has no user-in-the-loop, so MRTR results are
 *   treated as errors.
 */
export type McpResultType = "complete" | "input_required";

/** Result of an MCP tool call. */
export interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
  /** Spec 2026-07-28: result type discriminator (absent = `"complete"`). */
  resultType?: McpResultType;
}

/**
 * Narrow view of a tool result that carries `resultType: "input_required"`.
 *
 * Used only for type-narrowing in error paths — the full {@linkcode McpCallResult}
 * is the runtime shape.
 */
export interface McpInputRequiredResult extends McpCallResult {
  resultType: "input_required";
}

/** Narrow client handle the factory builds tools from. */
export interface McpClient {
  /** List all tools, following pagination cursors to the end. */
  listTools(): Promise<McpToolDef[]>;
  /** Call a tool by its original server-side name. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    timeout?: number,
  ): Promise<McpCallResult>;
  /** Close the connection (terminates a stdio child process). */
  close(): Promise<void>;
}

/** stdio transport: spawn a local server as a child process. */
export interface McpStdioTransportOptions {
  /** Executable to spawn. */
  command: string;
  /** Arguments passed to the executable. */
  args?: string[];
  /** Environment for the child process. */
  env?: Record<string, string>;
  /** Working directory for the child process. */
  cwd?: string;
}

/** Streamable HTTP transport: connect to a hosted server. */
export interface McpHttpTransportOptions {
  /** Server endpoint URL. */
  url: string;
  /** Static headers sent with every request (e.g. authorization). */
  headers?: Record<string, string>;
}

/**
 * Structural escape hatch: a pre-built MCP transport instance.
 *
 * Mirrors the SDK's `Transport` shape without importing it, so an SDK
 * transport (or a custom implementation) can be passed directly when the
 * config shapes don't fit.
 */
export interface McpTransport {
  start(): Promise<void>;
  // deno-lint-ignore no-explicit-any
  send(message: any, options?: any): Promise<void>;
  close(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  // deno-lint-ignore no-explicit-any
  onmessage?: (message: any, extra?: any) => void;
  sessionId?: string;
  setProtocolVersion?: (version: string) => void;
}

/** Transport configuration: shape decides the transport. */
export type McpTransportOptions =
  | McpStdioTransportOptions
  | McpHttpTransportOptions
  | McpTransport;
