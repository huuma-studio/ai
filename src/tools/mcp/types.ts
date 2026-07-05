/**
 * SDK-free internal contract for the MCP tool factory.
 *
 * `client.ts` is the only module allowed to import the MCP SDK; everything
 * else (and every exported signature) speaks these types (ADR 0002).
 *
 * @module
 */
import type { JSONSchema } from "@huuma/validate";

/** Tool definition as listed by an MCP server. */
export interface McpToolDef {
  /** Original tool name on the server. */
  name: string;
  /** Tool description, if the server provides one. */
  description?: string;
  /** The server's raw JSON Schema for tool input. */
  inputSchema: JSONSchema;
}

/** Content block of an MCP tool result. */
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | {
    type: "resource";
    resource: { uri: string; mimeType?: string; text?: string; blob?: string };
  };

/** Result of an MCP tool call. */
export interface McpCallResult {
  content?: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
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
