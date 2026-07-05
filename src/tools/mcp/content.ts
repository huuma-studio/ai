import type { McpCallResult, McpContentBlock } from "@/tools/mcp/types.ts";

/**
 * Flatten an MCP tool result to the string adapters expect.
 *
 * `isError: true` throws so `callTool`'s existing settled-promise path
 * formats it as `{ result: { error } }` (ADR 0001: errors propagate).
 * Otherwise `structuredContent` wins as JSON (servers commonly duplicate
 * it as a text block), else blocks flatten: text verbatim, everything
 * else as a placeholder until message contents support binary parts.
 */
export function flattenResult(result: McpCallResult): string {
  if (result.isError) {
    const text = (result.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    throw new Error(text || "MCP tool call failed");
  }

  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }

  return (result.content ?? []).map(blockText).join("\n");
}

function blockText(block: McpContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return `[image ${block.mimeType}]`;
    case "audio":
      return `[audio ${block.mimeType}]`;
    case "resource_link":
      return `[resource ${block.uri}]`;
    case "resource":
      return `[resource ${block.resource.uri}]`;
    default:
      return `[${(block as { type: string }).type}]`;
  }
}
