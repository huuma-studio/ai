import type { FileContent } from "@/mod.ts";
import { type ToolOutput, toolOutput } from "@/tools/mod.ts";
import type { McpCallResult, McpContentBlock } from "@/tools/mcp/types.ts";

/** Blocks that flatten to text; `image`/`audio` become files instead. */
type NonMediaBlock = Exclude<McpContentBlock, { type: "image" | "audio" }>;

/**
 * Flatten an MCP tool result to what `callTool` expects.
 *
 * `isError: true` throws so `callTool`'s existing settled-promise path
 * formats it as `{ result: { error } }` (ADR 0001: errors propagate).
 * The model-visible output is `structuredContent` as JSON when present
 * (servers commonly duplicate it as a text block), else the remaining
 * blocks joined: text verbatim, resources as placeholders. `image` and
 * `audio` blocks map 1:1 onto {@linkcode FileContent} and the result
 * becomes a {@linkcode ToolOutput}, which `callTool` unwraps onto the
 * tool result's `files` (ADR 0004) — delivery is then the adapters'
 * job, including their fail-loud rules for unsupported media.
 */
export function flattenResult(
  result: McpCallResult,
): string | ToolOutput<string> {
  if (result.isError) {
    const text = (result.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    throw new Error(text || "MCP tool call failed");
  }

  const texts: string[] = [];
  const files: FileContent[] = [];
  for (const block of result.content ?? []) {
    if (block.type === "image" || block.type === "audio") {
      files.push({ file: { mimeType: block.mimeType, data: block.data } });
    } else {
      texts.push(blockText(block));
    }
  }

  const output = result.structuredContent !== undefined
    ? JSON.stringify(result.structuredContent)
    : texts.join("\n");

  return files.length ? toolOutput(output, files) : output;
}

function blockText(block: NonMediaBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "resource_link":
      return `[resource ${block.uri}]`;
    case "resource":
      return `[resource ${block.resource.uri}]`;
    default:
      return `[${(block as { type: string }).type}]`;
  }
}
