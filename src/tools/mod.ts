/**
 * Tool primitives and bundled tool factories for agents.
 *
 * @example
 * ```typescript
 * import { tool, cli } from "@huuma/ai/tools";
 * import { string } from "@huuma/validate";
 *
 * const greet = tool({
 *   name: "greet",
 *   description: "Greet someone by name.",
 *   input: object({ name: string() }),
 *   fn: ({ name }) => `Hello, ${name}!`,
 * });
 * ```
 *
 * @example Returning media from a tool
 * ```typescript
 * import { tool, toolOutput } from "@huuma/ai/tools";
 * import { object, string } from "@huuma/validate";
 *
 * const screenshot = tool({
 *   name: "screenshot",
 *   description: "Take a screenshot of a page.",
 *   input: object({ url: string() }),
 *   fn: async ({ url }) => {
 *     const data = await captureAsBase64(url);
 *     return toolOutput("Screenshot captured.", [
 *       { file: { mimeType: "image/png", data } },
 *     ]);
 *   },
 * });
 * ```
 *
 * @module
 */
export {
  callTool,
  Tool,
  tool,
  type ToolCallOptions,
  type ToolContext,
  ToolOutput,
  toolOutput,
  Tools,
  tools,
} from "./tool.ts";
export type { JSONSchema, Schema } from "@huuma/validate";

export {
  cli,
  type CliToolOptions,
  DEFAULT_CLI_MAX_OUTPUT_BYTES,
  DEFAULT_CLI_TIMEOUT,
} from "./cli/cli.ts";

export {
  DEFAULT_GREP_TIMEOUT,
  grep,
  type GrepFileResult,
  type GrepMatch,
  type GrepOptions,
  type GrepResult,
} from "./grep/grep.ts";

export {
  createDirectory,
  DEFAULT_READ_FILE_MAX_BYTES,
  deleteFile,
  editFile,
  files,
  readFile,
  type ReadFileOptions,
  writeFile,
} from "./file/file.ts";

export { image, type ImageToolOptions } from "./image/image.ts";

export {
  DEFAULT_FETCH_WEBSITE_MAX_BYTES,
  DEFAULT_FETCH_WEBSITE_TIMEOUT,
  fetchWebsite,
  type FetchWebsiteOptions,
} from "./browser/browser.ts";

export { DEFAULT_SEARCH_TIMEOUT, search, type SearchToolOptions } from "./search/search.ts";

export { subagent, type SubagentToolOptions } from "./subagent/subagent.ts";

export {
  type SkillFrontmatter,
  type SkillInfo,
  skills,
  type SkillsToolOptions,
} from "./skills/skills.ts";

export {
  mcp,
  McpConnection,
  type McpHttpTransportOptions,
  type McpStdioTransportOptions,
  type McpToolsOptions,
  type McpTransport,
  type McpTransportOptions,
} from "./mcp/mcp.ts";
