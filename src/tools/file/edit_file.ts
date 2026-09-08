import { number, object, string } from "@huuma/validate";
import { type Tool, tool } from "../mod.ts";

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

/**
 * Per-file locks for read-modify-write edits.
 *
 * Batched tool calls run concurrently (callTool settles every call in a batch
 * via Promise.allSettled), so two same-file edits previously raced on
 * unsynchronized read/modify/write cycles: one edit was silently lost, and
 * interleaved open/truncate/write ordering could even leave stale bytes
 * appended after a shorter later write. Locking on the file's identity
 * (device + inode) makes every operation resolve against the current on-disk
 * content and keeps path aliases — symlinks and hard links to the same file —
 * on one lock. Where file identity is unavailable (missing file, or a
 * filesystem without inode info) the key falls back to the real path, then to
 * the given path; such edits fail with "File not found" anyway. The lock
 * serializes within this process only; writers in other processes are not
 * synchronized.
 */
const fileLocks = new Map<string, Promise<unknown>>();

/** Resolve a lock key that identifies the underlying file, not the path. */
async function lockKeyFor(path: string): Promise<string> {
  try {
    const info = await Deno.stat(path);
    if (info.dev !== null && info.ino !== null && info.ino !== 0) {
      return `file:${info.dev}:${info.ino}`;
    }
  } catch {
    // Missing file: the edit fails below with a clear error regardless.
  }
  try {
    return `path:${await Deno.realPath(path)}`;
  } catch {
    return `path:${path}`;
  }
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = await lockKeyFor(path);
  const previous = fileLocks.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tracked = run.catch(() => {}).finally(() => {
    if (fileLocks.get(key) === tracked) fileLocks.delete(key);
  });
  fileLocks.set(key, tracked);
  return run;
}

/** Create a tool that performs targeted file edits (search/replace, insert, delete).
 *
 * Same-file edits are serialized per path, so several operations issued
 * against one file in a single batch all land instead of racing.
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
    fn: (
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
      return withFileLock(props.path, async () => {
        try {
          // Read the current file content while holding the path lock so the
          // operation always resolves against up-to-date on-disk state.
          const fileContent = await Deno.readTextFile(props.path);

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

              // Perform the replacement with raw string operations; the line
              // handling below is only needed for insert/delete, so no line
              // array is allocated here.
              await Deno.writeTextFile(
                props.path,
                fileContent.replace(search, replace),
              );

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

              const { lines, eol } = splitLines(fileContent);

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

              // Strip a single trailing line break so content lines line up
              // with read_file numbering; tolerate CRLF and LF content.
              const contentLines = content.replace(/\r?\n$/, "").split(/\r?\n/);

              // Assemble via slices instead of spreading into splice(): the
              // spread form hits V8's ~65k argument limit on large inserts.
              const updated = [
                ...lines.slice(0, insertIndex),
                ...contentLines,
                ...lines.slice(insertIndex),
              ];

              await Deno.writeTextFile(props.path, updated.join(eol));

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

              const { lines, eol } = splitLines(fileContent);

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

              await Deno.writeTextFile(props.path, lines.join(eol));

              return {
                success: true,
                path: props.path,
                operation: props.operation,
                message:
                  `Successfully deleted ${deleteCount} line(s) (${start}-${end}) from ${props.path}`,
              };
            }

            default:
              // Unreachable: the operation is validated before the lock is
              // taken, but the explicit throw keeps this callback's return
              // type from including undefined.
              throw new Error(
                `Unknown operation "${props.operation}". Must be one of: search_replace, insert_lines, delete_lines.`,
              );
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
      });
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
 * Split file content into lines tolerating both LF and CRLF endings, and
 * report the file's dominant line ending so writes preserve it. Splitting on
 * the platform EOL constant mangled files using the "other" ending: on Linux
 * a CRLF file parsed with stray carriage returns in every line, and on
 * Windows an LF file parsed as one giant line.
 */
function splitLines(fileContent: string): { lines: string[]; eol: string } {
  const crlf = countOccurrences(fileContent, "\r\n");
  const loneLf = countOccurrences(fileContent, "\n") - crlf;
  return {
    lines: fileContent.split(/\r?\n/),
    eol: crlf > loneLf ? "\r\n" : "\n",
  };
}

/**
 * Truncate a string to a maximum length, adding ellipsis if needed.
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}