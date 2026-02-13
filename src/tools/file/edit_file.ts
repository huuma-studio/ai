import {
  literal,
  type LiteralSchema,
  number,
  type NumberSchema,
  object,
  type ObjectSchema,
  string,
  type StringSchema,
  union,
  type UnionSchema,
} from "@huuma/validate";
import { type Tool, tool } from "../mod.ts";
import { EOL } from "@std/fs";

/**
 * Input schema for the edit_file tool.
 * Supports three operations:
 * - search_replace: Find a unique text snippet and replace it
 * - insert: Insert content at a specific line number
 * - delete_lines: Delete a range of lines
 */
export function editFile(): Tool<
  UnionSchema<
    [
      ObjectSchema<{
        path: StringSchema;
        operation: LiteralSchema<"search_replace">;
        search: StringSchema;
        replace: StringSchema;
      }>,
      ObjectSchema<{
        path: StringSchema;
        operation: LiteralSchema<"insert_lines">;
        content: StringSchema;
        line: NumberSchema;
      }>,
      ObjectSchema<{
        path: StringSchema<string>;
        operation: LiteralSchema<"delete_lines">;
        content: StringSchema;
        lineStart: NumberSchema;
        lineEnd: NumberSchema<number | undefined>;
      }>,
    ]
  >,
  {
    success: boolean;
    path: string;
    operation: "search_replace";
    message: string;
  } | {
    success: boolean;
    path: string;
    operation: "insert_lines";
    message: string;
  } | {
    success: boolean;
    path: string;
    operation: "delete_lines";
    message: string;
  }
> {
  return tool({
    name: "edit_file",
    description:
      'Edit a file with targeted operations. Supports: 1) search_replace - "search" a unique text snippet and "replace" it (exact match required), 2) insert - insert content at a specific line number, 3) delete_lines - delete a range of lines. Use this for small targeted edits instead of rewriting entire files.',
    input: union([
      object({
        path: string(),
        operation: literal("search_replace"),
        search: string(),
        replace: string(),
      }),
      object({
        path: string(),
        operation: literal("insert_lines"),
        content: string(),
        line: number(),
      }),
      object({
        path: string(),
        operation: literal("delete_lines"),
        content: string(),
        lineStart: number(),
        lineEnd: number().optional(),
      }),
    ]),
    fn: async (
      props,
    ) => {
      try {
        // Read the current file content
        let fileContent = await Deno.readTextFile(props.path);
        const lines = fileContent.split(EOL);

        switch (props.operation) {
          case "search_replace": {
            // Count occurrences to ensure uniqueness
            const occurrences = countOccurrences(fileContent, props.search);

            if (occurrences === 0) {
              throw new Error(
                `Text not found in file: "${
                  truncate(props.search, 50)
                }". Make sure the search text matches exactly including whitespace.`,
              );
            }

            if (occurrences > 1) {
              throw new Error(
                `Found ${occurrences} occurrences of the search text. The search text must be unique to avoid unintended replacements. Please include more context to make it unique.`,
              );
            }

            // Perform the replacement
            fileContent = fileContent.replace(props.search, props.replace);
            await Deno.writeTextFile(props.path, fileContent);

            return {
              success: true,
              path: props.path,
              operation: props.operation,
              message: `Successfully replaced text in ${props.path}`,
            };
          }

          case "insert_lines": {
            if (props.line < 1) {
              throw new Error("line must be 1 or greater");
            }
            if (props.line > lines.length + 1) {
              throw new Error(
                `line ${props.line} is beyond end of file (file has ${lines.length} lines). Use line ${
                  lines.length + 1
                } to append at end.`,
              );
            }

            // Insert content at the specified line (1-indexed)
            // line=1 means insert at beginning, line=lines.length+1 means append at end
            const insertIndex = props.line - 1;

            // Handle multi-line content
            const contentLines = props.content.endsWith(EOL)
              ? props.content.slice(0, -1).split(EOL)
              : props.content.split(EOL);

            lines.splice(insertIndex, 0, ...contentLines);

            await Deno.writeTextFile(props.path, lines.join(EOL));

            return {
              success: true,
              path: props.path,
              operation: props.operation,
              message:
                `Successfully inserted content at line ${props.line} in ${props.path}`,
            };
          }

          case "delete_lines": {
            const start = props.lineStart;
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
