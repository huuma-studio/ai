import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  createDirectory,
  deleteFile,
  readFile,
  writeFile,
} from "@/tools/file/file.ts";

Deno.test("createDirectory - creates a new directory", async () => {
  const tempDir = await Deno.makeTempDir();
  const newDir = join(tempDir, "new-dir");
  const tool = createDirectory();

  try {
    const result = await tool.call({ path: newDir });
    assertEquals(result, { success: true, path: newDir });
    const stat = await Deno.stat(newDir);
    assertEquals(stat.isDirectory, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("createDirectory - creates nested directories", async () => {
  const tempDir = await Deno.makeTempDir();
  const newDir = join(tempDir, "a", "b", "c");
  const tool = createDirectory();

  try {
    const result = await tool.call({ path: newDir });
    assertEquals(result, { success: true, path: newDir });
    const stat = await Deno.stat(newDir);
    assertEquals(stat.isDirectory, true);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("createDirectory - handles existing directory (no error)", async () => {
  const tempDir = await Deno.makeTempDir();
  const tool = createDirectory();

  try {
    const result = await tool.call({ path: tempDir });
    assertEquals(result, { success: true, path: tempDir });
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("writeFile - writes a new file", async () => {
  const tempDir = await Deno.makeTempDir();
  const filePath = join(tempDir, "test.txt");
  const content = "Hello, World!";
  const tool = writeFile();

  try {
    const result = await tool.call({ path: filePath, content });
    assertEquals(result, { success: true, path: filePath });
    const fileContent = await Deno.readTextFile(filePath);
    assertEquals(fileContent, content);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("writeFile - overwrites existing file", async () => {
  const tempDir = await Deno.makeTempDir();
  const filePath = join(tempDir, "test.txt");
  const tool = writeFile();

  try {
    await Deno.writeTextFile(filePath, "Initial content");
    const newContent = "Updated content";
    const result = await tool.call({ path: filePath, content: newContent });
    assertEquals(result, { success: true, path: filePath });
    const fileContent = await Deno.readTextFile(filePath);
    assertEquals(fileContent, newContent);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("writeFile - creates parent directories implicitly", async () => {
  const tempDir = await Deno.makeTempDir();
  const filePath = join(tempDir, "nested", "dir", "test.txt");
  const content = "Deep content";
  const tool = writeFile();

  try {
    const result = await tool.call({ path: filePath, content });
    assertEquals(result, { success: true, path: filePath });
    const fileContent = await Deno.readTextFile(filePath);
    assertEquals(fileContent, content);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readFile - reads existing file", async () => {
  const tempDir = await Deno.makeTempDir();
  const filePath = join(tempDir, "read_test.txt");
  const content = "Content to read";
  const tool = readFile();

  try {
    await Deno.writeTextFile(filePath, content);
    const result = await tool.call({ path: filePath });
    assertEquals(result, content);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readFile - throws error if file not found", async () => {
  const tempDir = await Deno.makeTempDir();
  const filePath = join(tempDir, "non_existent.txt");
  const tool = readFile();

  try {
    await assertRejects(
      async () => await tool.call({ path: filePath }),
      Error,
      `File not found: ${filePath}`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("readFile - throws error if path is a directory", async () => {
  const tempDir = await Deno.makeTempDir();
  const dirPath = join(tempDir, "some_dir");
  const tool = readFile();

  try {
    await Deno.mkdir(dirPath);
    await assertRejects(
      async () => await tool.call({ path: dirPath }),
      Error,
      `Path is a directory, not a file: ${dirPath}`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("removeFile - removes a file", async () => {
  const tempDir = await Deno.makeTempDir();
  const filePath = join(tempDir, "test.txt");
  const tool = deleteFile();

  try {
    await Deno.writeTextFile(filePath, "content");
    const result = await tool.call({ path: filePath });
    assertEquals(result, { success: true, path: filePath });
    await assertRejects(
      async () => await Deno.readTextFile(filePath),
      Deno.errors.NotFound,
    );
  } finally {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // ignore if already removed (though it shouldn't be for tempDir itself unless recursive remove inside removed it?)
    }
  }
});

Deno.test("removeFile - removes a directory recursively", async () => {
  const tempDir = await Deno.makeTempDir();
  const dirPath = join(tempDir, "subdir");
  const filePath = join(dirPath, "test.txt");
  const tool = deleteFile();

  try {
    await Deno.mkdir(dirPath);
    await Deno.writeTextFile(filePath, "content");
    const result = await tool.call({ path: dirPath });
    assertEquals(result, { success: true, path: dirPath });
    await assertRejects(
      async () => await Deno.stat(dirPath),
      Deno.errors.NotFound,
    );
  } finally {
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // ignore
    }
  }
});

Deno.test("removeFile - throws error if not found", async () => {
  const tempDir = await Deno.makeTempDir();
  const filePath = join(tempDir, "non_existent.txt");
  const tool = deleteFile();

  try {
    await assertRejects(
      async () => await tool.call({ path: filePath }),
      Error,
      `File or directory not found: ${filePath}`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
