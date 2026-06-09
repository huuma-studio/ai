import { number, object, string } from "@huuma/validate";
import { type Tool, tool } from "../mod.ts";
import { EOL } from "@std/fs";

/**
 * Input schema for the edit_file tool.
 * Supports three operations:
 * - search_replace: Find a unique text snippet and replace it
 * - insert_lines: Insert content at a specific line number
 * - delete_lines: Delete a range of lines
 *
 * The schema is intentionally a single flat object (rather than a union of
 * objects) because some model providers (e.g. Ollama) require tool parameters
 * to be a top-level object with `properties`. Per-operation field requirements
 * are validated at runtime in the function body.
 */
/** Result returned by the edit_file tool. */
export interface EditFileResult {
  /** Whether the edit succeeded. */
  success: boolean;
  /** Path that was edited. */
  path: string;
  /** Edit operation that was applied. */
  operation: "search_replace" | "insert_lines" | "delete_lines";
  /** Human-readable edit summary. */
  message: string;
}

/** Create a tool that performs targeted file edits (search/replace, insert, delete).
 *
 * @returns A {@link Tool} that edits files in place and returns an {@link EditFileResult}.
 */
// deno-lint-ignore no-explicit-any
export function editFile(): Tool<any, EditFileResult> {
  return tool({
    name: "edit_file",
    description:
      'Edit a file with targeted operations. The "operation" field selects the operation; required fields per operation are: ' +
      '1) search_replace - requires "search" (unique text snippet, exact match) and "replace". ' +
      '2) insert_lines - requires "content" and "line" (1-indexed; use lines.length+1 to append). ' +
      '3) delete_lines - requires "lineStart" and optional "lineEnd" (defaults to lineStart). ' +
      "Use this for small targeted edits instead of rewriting entire files.",
    input: object({
      path: string(),
      operation: string(),
      search: string().optional(),
      replace: string().optional(),
      content: string().optional(),
      line: number().optional(),
      lineStart: number().optional(),
      lineEnd: number().optional(),
    }),
    fn: async (
      props,
    ) => {
      if (
        props.operation !== "search_replace" &&
        props.operation !== "insert_lines" &&
        props.operation !== "delete_lines"
      ) {
        throw new Error(
          `Unknown operation "${props.operation}". Must be one of: search_replace, insert_lines, delete_lines.`,
        );
      }
      try {
        // Read the current file content
        let fileContent = await Deno.readTextFile(props.path);
        const lines = fileContent.split(EOL);

        switch (props.operation) {
          case "search_replace": {
            const search = props.search;
            const replace = props.replace;
            if (search === undefined || replace === undefined) {
              throw new Error(
                'search_replace requires both "search" and "replace" fields.',
              );
            }

            // Count occurrences to ensure uniqueness
            const occurrences = countOccurrences(fileContent, search);

            if (occurrences === 0) {
              throw new Error(
                `Text not found in file: "${
                  truncate(search, 50)
                }". Make sure the search text matches exactly including whitespace.`,
              );
            }

            if (occurrences > 1) {
              throw new Error(
                `Found ${occurrences} occurrences of the search text. The search text must be unique to avoid unintended replacements. Please include more context to make it unique.`,
              );
            }

            // Perform the replacement
            fileContent = fileContent.replace(search, replace);
            await Deno.writeTextFile(props.path, fileContent);

            return {
              success: true,
              path: props.path,
              operation: props.operation,
              message: `Successfully replaced text in ${props.path}`,
            };
          }

          case "insert_lines": {
            const content = props.content;
            const line = props.line;
            if (content === undefined || line === undefined) {
              throw new Error(
                'insert_lines requires both "content" and "line" fields.',
              );
            }

            if (line < 1) {
              throw new Error("line must be 1 or greater");
            }
            if (line > lines.length + 1) {
              throw new Error(
                `line ${line} is beyond end of file (file has ${lines.length} lines). Use line ${
                  lines.length + 1
                } to append at end.`,
              );
            }

            // Insert content at the specified line (1-indexed)
            // line=1 means insert at beginning, line=lines.length+1 means append at end
            const insertIndex = line - 1;

            // Handle multi-line content
            const contentLines = content.endsWith(EOL)
              ? content.slice(0, -1).split(EOL)
              : content.split(EOL);

            lines.splice(insertIndex, 0, ...contentLines);

            await Deno.writeTextFile(props.path, lines.join(EOL));

            return {
              success: true,
              path: props.path,
              operation: props.operation,
              message:
                `Successfully inserted content at line ${line} in ${props.path}`,
            };
          }

          case "delete_lines": {
            const start = props.lineStart;
            if (start === undefined) {
              throw new Error('delete_lines requires "lineStart" field.');
            }
            const end = props.lineEnd ?? start;

            if (start < 1) {
              throw new Error("line numbers must be 1 or greater");
            }
            if (end < start) {
              throw new Error(
                "lineEnd must be greater than or equal to lineStart",
              );
            }
            if (start > lines.length) {
              throw new Error(
                `start line ${start} is beyond end of file (file has ${lines.length} lines)`,
              );
            }
            if (end > lines.length) {
              throw new Error(
                `end line ${end} is beyond end of file (file has ${lines.length} lines)`,
              );
            }

            // Delete lines (1-indexed, inclusive range)
            const deleteStart = start - 1;
            const deleteCount = end - start + 1;
            lines.splice(deleteStart, deleteCount);

            await Deno.writeTextFile(props.path, lines.join(EOL));

            return {
              success: true,
              path: props.path,
              operation: props.operation,
              message:
                `Successfully deleted ${deleteCount} line(s) (${start}-${end}) from ${props.path}`,
            };
          }
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new Error(`File not found: ${props.path}`);
        }
        if (error instanceof Deno.errors.PermissionDenied) {
          throw new Error(
            `Permission denied: ${props.path}. Make sure to run with --allow-read and --allow-write.`,
          );
        }
        if (error instanceof Deno.errors.IsADirectory) {
          throw new Error(`Path is a directory, not a file: ${props.path}`);
        }
        throw error;
      }
    },
  });
}

/**
 * Count non-overlapping occurrences of a substring in a string.
 */
function countOccurrences(text: string, search: string): number {
  if (search.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = text.indexOf(search, pos)) !== -1) {
    count++;
    pos += search.length;
  }
  return count;
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}
