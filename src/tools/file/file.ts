import { object } from "@huuma/validate/object";
import { type Tool, tool } from "../mod.ts";
import { string } from "@huuma/validate/string";
import { dirname } from "@std/path/dirname";
import { editFile } from "./edit_file.ts";

export { editFile } from "./edit_file.ts";

/** Result returned by mutating file-system tools. */
export interface FileOperationResult {
  /** Whether the operation succeeded. */
  success: boolean;
  /** Path that was operated on. */
  path: string;
}

/** Create a tool that reads a text file.
 *
 * @returns A {@link Tool} that returns the contents of the requested file path.
 */
// deno-lint-ignore no-explicit-any
export function readFile(): Tool<any, string> {
  return tool({
    name: "read_file",
    description:
      "Read the complete content of a text file from the file system. Use this to inspect code, configuration files, or documentation.",
    input: object({
      path: string(),
    }),
    fn: async ({ path }) => {
      try {
        const content = await Deno.readTextFile(path);
        return content;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          throw new Error(`File not found: ${path}`);
        }
        if (error instanceof Deno.errors.PermissionDenied) {
          throw new Error(
            `Permission denied: ${path}. Make sure to run with --allow-read.`,
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
