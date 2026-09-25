import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  createDirectory,
  DEFAULT_READ_FILE_MAX_BYTES,
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

/** Run `fn` with a temp file holding `content`, removed afterwards. */
async function withTempFile(
  content: string,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const filePath = join(tempDir, "file.txt");
  try {
    await Deno.writeTextFile(filePath, content);
    await fn(filePath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("readFile - caps a large file at 512 KiB and names its full size", async () => {
  const content = "0123456789abcdef".repeat(3 * 1024 * 1024 / 16);
  await withTempFile(content, async (path) => {
    const result = await readFile().call({ path });
    assertEquals(DEFAULT_READ_FILE_MAX_BYTES, 512 * 1024);
    assertEquals(
      result,
      `${content.slice(0, DEFAULT_READ_FILE_MAX_BYTES)}\n\n` +
        "…[truncated: showing the first 512 KiB of 3 MiB]",
    );
  });
});

Deno.test("readFile - a raised cap returns the whole file", async () => {
  const content = "x".repeat(3 * 1024 * 1024);
  await withTempFile(content, async (path) => {
    const tool = readFile({ maxBytes: 4 * 1024 * 1024 });
    assertEquals(await tool.call({ path }), content);
  });
});

Deno.test("readFile - a custom cap truncates at that size", async () => {
  await withTempFile("hello world", async (path) => {
    const tool = readFile({ maxBytes: 5 });
    assertEquals(
      await tool.call({ path }),
      "hello\n\n…[truncated: showing the first 5 bytes of 11 bytes]",
    );
  });
});

Deno.test("readFile - a file exactly at the cap is not truncated", async () => {
  await withTempFile("hello", async (path) => {
    assertEquals(await readFile({ maxBytes: 5 }).call({ path }), "hello");
  });
});

Deno.test("readFile - drops a character split by the cap", async () => {
  // "é" is two bytes; a cap of 2 ends between them.
  await withTempFile("aé", async (path) => {
    assertEquals(
      await readFile({ maxBytes: 2 }).call({ path }),
      "a\n\n…[truncated: showing the first 2 bytes of 3 bytes]",
    );
  });
});

Deno.test("readFile - rejects an invalid maxBytes", () => {
  for (const maxBytes of [0, -1, 1.5]) {
    assertThrows(
      () => readFile({ maxBytes }),
      TypeError,
      "maxBytes must be a positive integer",
    );
  }
});

Deno.test("readFile - the description names the cap", () => {
  assertStringIncludes(readFile().description, "larger than 512 KiB");
});

// The cap exists so a read_file result can never be the reason the next
// request exceeds the Huuma API's 1 MiB message size. JSON escaping inflates
// quotes, backslashes, and newlines, so source-like text is used here.
Deno.test("readFile - a capped result serializes well below 1 MiB", async () => {
  const line = '  const value = "a \\"quoted\\" string\\n";\n';
  const content = line.repeat(Math.ceil(3 * 1024 * 1024 / line.length));
  await withTempFile(content, async (path) => {
    const result = await readFile().call({ path });
    const serialized = new TextEncoder().encode(JSON.stringify(result));
    assert(
      serialized.byteLength < 768 * 1024,
      `serialized result is ${serialized.byteLength} bytes`,
    );
  });
});

// An endless source ends at the cap instead of buffering until memory
// runs out; its size is unknown, so the notice names only the cap.
Deno.test({
  name: "readFile - an endless file is read only up to the cap",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const result = await readFile({ maxBytes: 1024 }).call({
      path: "/dev/zero",
    });
    assertEquals(
      result,
      `${"\0".repeat(1024)}\n\n…[truncated: showing the first 1 KiB]`,
    );
  },
});

Deno.test({
  name: "readFile - maps a permission error",
  // Permission bits do not apply on Windows.
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempFile("secret", async (path) => {
      await Deno.chmod(path, 0o000);
      // Root reads the file regardless of its permission bits.
      const unreadable = await Deno.readTextFile(path).then(
        () => false,
        () => true,
      );
      if (!unreadable) return;
      await assertRejects(
        () => readFile().call({ path }),
        Error,
        `Permission denied: ${path}. Make sure to run with --allow-read.`,
      );
    });
  },
});
