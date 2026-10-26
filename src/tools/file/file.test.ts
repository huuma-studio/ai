import {
  mkdir,
  mkdtemp,
  readFile as readTextFile,
  rm,
  stat,
  writeFile as writeTextFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { createDirectory, deleteFile, readFile, writeFile } from "./file.ts";

test("createDirectory - creates a new directory", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const newDir = join(tempDir, "new-dir");
  const tool = createDirectory();

  try {
    const result = await tool.call({ path: newDir });
    expect(result).toStrictEqual({ success: true, path: newDir });
    const info = await stat(newDir);
    expect(info.isDirectory()).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("createDirectory - creates nested directories", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const newDir = join(tempDir, "a", "b", "c");
  const tool = createDirectory();

  try {
    const result = await tool.call({ path: newDir });
    expect(result).toStrictEqual({ success: true, path: newDir });
    const info = await stat(newDir);
    expect(info.isDirectory()).toBe(true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("createDirectory - handles existing directory (no error)", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const tool = createDirectory();

  try {
    const result = await tool.call({ path: tempDir });
    expect(result).toStrictEqual({ success: true, path: tempDir });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeFile - writes a new file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const filePath = join(tempDir, "test.txt");
  const content = "Hello, World!";
  const tool = writeFile();

  try {
    const result = await tool.call({ path: filePath, content });
    expect(result).toStrictEqual({ success: true, path: filePath });
    const fileContent = await readTextFile(filePath, "utf8");
    expect(fileContent).toBe(content);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeFile - overwrites existing file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const filePath = join(tempDir, "test.txt");
  const tool = writeFile();

  try {
    await writeTextFile(filePath, "Initial content");
    const newContent = "Updated content";
    const result = await tool.call({ path: filePath, content: newContent });
    expect(result).toStrictEqual({ success: true, path: filePath });
    const fileContent = await readTextFile(filePath, "utf8");
    expect(fileContent).toBe(newContent);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("writeFile - creates parent directories implicitly", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const filePath = join(tempDir, "nested", "dir", "test.txt");
  const content = "Deep content";
  const tool = writeFile();

  try {
    const result = await tool.call({ path: filePath, content });
    expect(result).toStrictEqual({ success: true, path: filePath });
    const fileContent = await readTextFile(filePath, "utf8");
    expect(fileContent).toBe(content);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readFile - reads existing file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const filePath = join(tempDir, "read_test.txt");
  const content = "Content to read";
  const tool = readFile();

  try {
    await writeTextFile(filePath, content);
    const result = await tool.call({ path: filePath });
    expect(result).toBe(content);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readFile - throws error if file not found", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const filePath = join(tempDir, "non_existent.txt");
  const tool = readFile();

  try {
    await expect(tool.call({ path: filePath })).rejects.toThrow(`File not found: ${filePath}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readFile - throws error if path is a directory", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const dirPath = join(tempDir, "some_dir");
  const tool = readFile();

  try {
    await mkdir(dirPath);
    await expect(tool.call({ path: dirPath })).rejects.toThrow(
      `Path is a directory, not a file: ${dirPath}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("removeFile - removes a file", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const filePath = join(tempDir, "test.txt");
  const tool = deleteFile();

  try {
    await writeTextFile(filePath, "content");
    const result = await tool.call({ path: filePath });
    expect(result).toStrictEqual({ success: true, path: filePath });
    await expect(readTextFile(filePath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore if already removed (though it shouldn't be for tempDir itself unless recursive remove inside removed it?)
    }
  }
});

test("removeFile - removes a directory recursively", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const dirPath = join(tempDir, "subdir");
  const filePath = join(dirPath, "test.txt");
  const tool = deleteFile();

  try {
    await mkdir(dirPath);
    await writeTextFile(filePath, "content");
    const result = await tool.call({ path: dirPath });
    expect(result).toStrictEqual({ success: true, path: dirPath });
    await expect(stat(dirPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

test("removeFile - throws error if not found", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const filePath = join(tempDir, "non_existent.txt");
  const tool = deleteFile();

  try {
    await expect(tool.call({ path: filePath })).rejects.toThrow(
      `File or directory not found: ${filePath}`,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
