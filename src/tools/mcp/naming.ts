/** Provider-side constraint on model-visible tool names. */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const NAME_MAX = 64;
// Truncation leaves room for "_" plus a 4-hex hash: 59 + 1 + 4 = 64.
const TRUNCATE_AT = 59;

/** Validate a server namespace. Throws unless it matches `[A-Za-z0-9_-]+`. */
export function validateServerName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new RangeError(
      `mcp server name "${name}" must match [A-Za-z0-9_-]+`,
    );
  }
}

/**
 * Model-visible tool name: `${server}_${tool}`, capped at 64 chars.
 *
 * Characters outside `[A-Za-z0-9_-]` are sanitized to `_` (MCP allows
 * `.`, providers don't). Over-long names are truncated with a
 * deterministic hash suffix of the full unsanitized name, so two long
 * names sharing a truncation-length prefix stay distinct. The original
 * tool name is still used on the wire; this name exists only for the
 * model (ADR 0002).
 */
export function modelToolName(server: string, tool: string): string {
  const sanitized = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `${server}_${sanitized}`;

  if (full.length <= NAME_MAX) {
    return full;
  }

  return `${full.slice(0, TRUNCATE_AT)}_${djb2Hex4(`${server}_${tool}`)}`;
}

/** djb2 hash reduced to 4 hex chars — deterministic, dependency-free. */
function djb2Hex4(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return ((hash >>> 0) & 0xffff).toString(16).padStart(4, "0");
}
