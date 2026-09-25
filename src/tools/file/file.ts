import { object } from "@huuma/validate/object";
import { type Tool, tool } from "../mod.ts";
import { string } from "@huuma/validate/string";
import { dirname } from "@std/path/dirname";
import { editFile } from "./edit_file.ts";
import {
  type BoundedText,
  formatBytes,
  readTextBounded,
  validateMaxBytes,
  withTruncationNotice,
} from "../bounded_text.ts";
import { mapReadError } from "../read_errors.ts";

export { editFile } from "./edit_file.ts";

/** Result returned by mutating file-system tools. */
export interface FileOperationResult {
  /** Whether the operation succeeded. */
  success: boolean;
  /** Path that was operated on. */
  path: string;
}

/** Options for configuring the read-file tool. */
export interface ReadFileOptions {
  /**
   * Maximum number of bytes of a file returned per read. Larger files are
   * cut off at this size and marked as truncated. Defaults to 512 KiB.
   */
  maxBytes?: number;
}

/**
 * Default maximum number of bytes returned per read: 512 KiB, half the
 * Huuma API's 1 MiB message limit, leaving room for JSON escaping, the
 * truncation note, and the rest of the conversation in the same request.
 */
export const DEFAULT_READ_FILE_MAX_BYTES = 512 * 1024;

/** Create a tool that reads a text file.
 *
 * At most `maxBytes` of the file are read — the result then ends with a
 * truncation notice naming the file's full size — so a huge file cannot
 * exhaust memory or produce a tool result too large to send to the model.
 *
 * @param options Optional size cap.
 * @returns A {@link Tool} that returns the contents of the requested file path.
 */
// deno-lint-ignore no-explicit-any
export function readFile(options?: ReadFileOptions): Tool<any, string> {
  const maxBytes = options?.maxBytes ?? DEFAULT_READ_FILE_MAX_BYTES;
  validateMaxBytes(maxBytes);

  return tool({
    name: "read_file",
    description:
      `Read the content of a text file from the file system. Use this to inspect code, configuration files, or documentation. Files larger than ${
        formatBytes(maxBytes)
      } are truncated; search larger files instead of reading them whole.`,
    input: object({
      path: string(),
    }),
    fn: async ({ path }, { signal }) => {
      const { text, truncated, size } = await readTextFileBounded(
        path,
        maxBytes,
        signal,
      );
      return truncated ? withTruncationNotice(text, maxBytes, size) : text;
    },
  });
}

/** Read at most `maxBytes` of the file at `path` as text, along with the
 * file's full size for the truncation notice. */
async function readTextFileBounded(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BoundedText & { size: number }> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (error) {
    throw mapReadError(error, path);
  }
  let size: number;
  try {
    size = (await file.stat()).size;
  } catch (error) {
    file.close();
    throw mapReadError(error, path);
  }
  try {
    // The stream owns the handle from here: it closes the file when it is
    // read to the end, cancelled at the cap, or fails.
    const bounded = await readTextBounded(file.readable, maxBytes, { signal });
    return { ...bounded, size };
  } catch (error) {
    throw mapReadError(error, path);
  }
}

/** Create a tool that writes text to a file.
 *
 * @returns A {@link Tool} that overwrites the given file path with the supplied content.
 */
// deno-lint-ignore no-explicit-any
export function writeFile(): Tool<any, FileOperationResult> {
  return tool({
    name: "write_file",
    description:
      "Write content to a file at the given path. Overwrites existing files. Creates parent directories if they don't exist.",
    input: object({
      path: string(),
      content: string(),
    }),
    fn: async ({ path, content }) => {
      try {
        // Ensure the directory exists before writing
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.writeTextFile(path, content);
        return { success: true, path };
      } catch (error) {
        if (error instanceof Deno.errors.PermissionDenied) {
          throw new Error(
            `Permission denied: ${path}. Make sure to run with --allow-write.`,
          );
        }
        if (error instanceof Deno.errors.IsADirectory) {
          throw new Error(`Path is a directory, not a file: ${path}`);
        }
        throw error;
      }
    },
  });
}

/** Create a tool that creates a directory recursively.
 *
 * @returns A {@link Tool} that creates directories (and parents) on demand.
 */
// deno-lint-ignore no-explicit-any
export function createDirectory(): Tool<any, FileOperationResult> {
  return tool({
    name: "create_directory",
    description:
      "Create a directory at the given path. Creates parent directories if they don't exist.",
    input: object({
      path: string(),
    }),
    fn: async ({ path }) => {
      try {
        await Deno.mkdir(path, { recursive: true });
        return { success: true, path };
      } catch (error) {
        if (error instanceof Deno.errors.PermissionDenied) {
          throw new Error(
            `Permission denied: ${path}. Make sure to run with --allow-write.`,
          );
        }
        if (error instanceof Deno.errors.AlreadyExists) {
          throw new Error(
            `Path already exists and is not a directory: ${path}`,
          );
        }
        throw error;
      }
    },
  });
}

/** Create a tool that deletes a file or directory recursively.
 *
 * @returns A {@link Tool} that removes files or directories.
 */
// deno-lint-ignore no-explicit-any
export function deleteFile(): Tool<any, FileOperationResult> {
  return tool({
    name: "delete_file",
    description:
      "Delete a file or directory at the given path. Deletes directories recursively.",
    input: object({
      path: string(),
    }),
    fn: async ({ path }) => {
      try {
        await Deno.remove(path, { recursive: true });
        return { success: true, path };
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new Error(`File or directory not found: ${path}`);
        }
        if (error instanceof Deno.errors.PermissionDenied) {
          throw new Error(
            `Permission denied: ${path}. Make sure to run with --allow-write.`,
          );
        }
        throw error;
      }
    },
  });
}

/** Create all bundled file-system tools.
 *
 * @returns An array containing read, write, create-directory, delete, and edit-file tools.
 */
// deno-lint-ignore no-explicit-any
export function files(): Tool<any, unknown>[] {
  return [
    readFile(),
    writeFile(),
    createDirectory(),
    deleteFile(),
    editFile(),
  ];
}
