import { object, type ObjectSchema } from "@huuma/validate/object";
import { type Tool, tool } from "../mod.ts";
import { string, type StringSchema } from "@huuma/validate/string";
import { dirname } from "@std/path/dirname";

export function readFile(): Tool<
  ObjectSchema<{
    path: StringSchema<string>;
  }>
> {
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

export function writeFile(): Tool<
  ObjectSchema<{
    path: StringSchema<string>;
    content: StringSchema<string>;
  }>,
  {
    success: boolean;
    path: string;
  }
> {
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

export function createDirectory(): Tool<
  ObjectSchema<{
    path: StringSchema<string>;
  }>,
  {
    success: boolean;
    path: string;
  }
> {
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

export function deleteFile(): Tool<
  ObjectSchema<{
    path: StringSchema<string>;
  }>,
  {
    success: boolean;
    path: string;
  }
> {
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

export function files(): (
  | Tool<
    ObjectSchema<{
      path: StringSchema<string>;
    }>,
    unknown
  >
  | Tool<
    ObjectSchema<{
      path: StringSchema<string>;
      content: StringSchema<string>;
    }>,
    {
      success: boolean;
      path: string;
    }
  >
)[] {
  return [
    readFile(),
    writeFile(),
    createDirectory(),
    deleteFile(),
  ];
}
