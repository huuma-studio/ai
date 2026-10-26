import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile as readTextFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { DEFAULT_READ_FILE_MAX_BYTES, readFile } from "./read_file.ts";

/** Run `fn` with a temp file holding `content`, removed afterwards. */
async function withTempFile(
  content: string | Uint8Array,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const filePath = join(tempDir, "file.txt");
  try {
    await writeFile(filePath, content);
    await fn(filePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Split a read_file result into its text and its trailing note. */
function splitNotice(result: string): { text: string; notice: string } {
  const at = result.lastIndexOf("\n\n…[");
  return at === -1
    ? { text: result, notice: "" }
    : { text: result.slice(0, at), notice: result.slice(at + 2) };
}

/** The error `promise` rejects with; fails the test if it resolves. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail("expected a rejection"),
    (error: unknown) => error,
  );
}

/** The offset a truncation note says to continue at, if any. */
function continueOffset(notice: string): number | undefined {
  const match = notice.match(/offset (\d+) to continue/);
  return match ? Number(match[1]) : undefined;
}

test("readFile - returns a small file unchanged", async () => {
  await withTempFile("hello world", async (path) => {
    expect(await readFile().call({ path })).toStrictEqual("hello world");
  });
});

test("readFile - keeps a byte-order mark like fs.readFile", async () => {
  await withTempFile("﻿hello", async (path) => {
    expect(await readFile().call({ path })).toStrictEqual(await readTextFile(path, "utf8"));
  });
});

test("readFile - caps a large file at 512 KiB and says where to continue", async () => {
  const content = "0123456789abcdef".repeat((3 * 1024 * 1024) / 16);
  await withTempFile(content, async (path) => {
    const result = await readFile().call({ path });
    expect(DEFAULT_READ_FILE_MAX_BYTES).toStrictEqual(512 * 1024);
    expect(result).toStrictEqual(
      `${content.slice(0, DEFAULT_READ_FILE_MAX_BYTES)}\n\n` +
        "…[truncated: showing bytes 0–524287 of 3145728 bytes (3 MiB). " +
        "Call read_file with offset 524288 to continue.]",
    );
  });
});

test("readFile - a raised cap returns the whole file", async () => {
  const content = "x".repeat(3 * 1024 * 1024);
  await withTempFile(content, async (path) => {
    const tool = readFile({ maxBytes: 4 * 1024 * 1024 });
    expect(await tool.call({ path })).toStrictEqual(content);
  });
});

test("readFile - a file exactly at the cap is not truncated", async () => {
  await withTempFile("hello", async (path) => {
    expect(await readFile({ maxBytes: 5 }).call({ path })).toStrictEqual("hello");
  });
});

test("readFile - reads the first, a middle, and the last page", async () => {
  await withTempFile("hello world", async (path) => {
    const tool = readFile({ maxBytes: 4 });
    expect(await tool.call({ path })).toStrictEqual(
      "hell\n\n…[truncated: showing bytes 0–3 of 11 bytes. " +
        "Call read_file with offset 4 to continue.]",
    );
    expect(await tool.call({ path, offset: 4 })).toStrictEqual(
      "o wo\n\n…[truncated: showing bytes 4–7 of 11 bytes. " +
        "Call read_file with offset 8 to continue.]",
    );
    expect(await tool.call({ path, offset: 8 })).toStrictEqual(
      "rld\n\n…[showing bytes 8–10 of 11 bytes; end of file]",
    );
  });
});

test("readFile - limit narrows a read but never widens it past the cap", async () => {
  await withTempFile("hello world", async (path) => {
    const tool = readFile({ maxBytes: 4 });
    expect(await tool.call({ path, offset: 6, limit: 2 })).toStrictEqual(
      "wo\n\n…[truncated: showing bytes 6–7 of 11 bytes. " +
        "Call read_file with offset 8 to continue.]",
    );
    expect(await tool.call({ path, limit: 100 })).toStrictEqual(
      "hell\n\n…[truncated: showing bytes 0–3 of 11 bytes. " +
        "Call read_file with offset 4 to continue.]",
    );
  });
});

test("readFile - a limit covering the whole file returns it unchanged", async () => {
  await withTempFile("hello", async (path) => {
    expect(await readFile().call({ path, limit: 5 })).toStrictEqual("hello");
  });
});

test("readFile - an offset at the end of the file says so", async () => {
  await withTempFile("hello", async (path) => {
    expect(await readFile().call({ path, offset: 5 })).toStrictEqual(
      "\n\n…[end of file: no text after byte 5 of 5 bytes]",
    );
  });
});

test("readFile - an offset inside a character starts at the next one", async () => {
  // "é" is bytes 1–2; offset 2 is inside it.
  await withTempFile("aéb", async (path) => {
    expect(await readFile().call({ path, offset: 2 })).toStrictEqual(
      "b\n\n…[showing bytes 3–3 of 4 bytes; end of file]",
    );
  });
});

test("readFile - a cap inside a character ends the page before it", async () => {
  // "é" is two bytes; a cap of 2 ends between them.
  await withTempFile("aé", async (path) => {
    const tool = readFile({ maxBytes: 2 });
    expect(await tool.call({ path })).toStrictEqual(
      "a\n\n…[truncated: showing bytes 0–0 of 3 bytes. " +
        "Call read_file with offset 1 to continue.]",
    );
    expect(await tool.call({ path, offset: 1 })).toStrictEqual(
      "é\n\n…[showing bytes 1–2 of 3 bytes; end of file]",
    );
  });
});

test("readFile - a byte-order mark counts toward the byte offsets", async () => {
  await withTempFile("\ufeffab", async (path) => {
    const tool = readFile({ maxBytes: 4 });
    expect(await tool.call({ path })).toStrictEqual(
      "\ufeffa\n\n…[truncated: showing bytes 0–3 of 5 bytes. " +
        "Call read_file with offset 4 to continue.]",
    );
  });
});

// Following the notes from the first read to the end must return every
// byte exactly once — across multi-byte characters, escape-heavy text, and
// pages cut by the JSON fit rather than the byte cap.
for (const maxBytes of [1, 7, 64, 1000]) {
  test(`readFile - paging reads the whole file exactly (cap ${maxBytes})`, async () => {
    const content = 'line "one"\n\tzwei ß\n中文 😀\0\x01 end\\\n'.repeat(40);
    await withTempFile(content, async (path) => {
      const tool = readFile({ maxBytes });
      let offset: number | undefined = 0;
      let text = "";
      let reads = 0;
      while (offset !== undefined) {
        expect(++reads < 10_000, "paging did not reach the end").toBe(true);
        const result = await tool.call({ path, offset });
        const page = splitNotice(result);
        text += page.text;
        offset = continueOffset(page.notice);
      }
      expect(text).toStrictEqual(content);
    });
  });
}

test("readFile - rejects an invalid offset or limit", async () => {
  await withTempFile("hello", async (path) => {
    const tool = readFile();
    for (const offset of [-1, 1.5]) {
      const error = await rejection(tool.call({ path, offset }));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `offset must be a non-negative integer, got ${offset}`,
      );
    }
    for (const limit of [0, -1, 1.5]) {
      const error = await rejection(tool.call({ path, limit }));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`limit must be a positive integer, got ${limit}`);
    }
    const error = await rejection(tool.call({ path, offset: 6 }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`offset 6 is past the end of ${path} (5 bytes)`);
  });
});

test("readFile - rejects an invalid maxBytes", () => {
  for (const maxBytes of [0, -1, 1.5]) {
    expect(() => readFile({ maxBytes })).toThrow(TypeError);
    expect(() => readFile({ maxBytes })).toThrow("maxBytes must be a positive integer");
  }
});

test("readFile - the description names the cap and the paging inputs", () => {
  const { description } = readFile();
  expect(description).toContain("at most 512 KiB");
  expect(description).toContain('"offset"');
  expect(description).toContain('"limit"');
});

// The cap exists so a read_file result can never be the reason the next
// request exceeds the Huuma API's 1 MiB message size. JSON escaping inflates
// quotes, backslashes, and newlines to 2 bytes and other control characters
// to 6, so the content is cut to fit the cap once escaped.
for (const [name, unit] of [
  ["source-like text", '  const value = "a \\"quoted\\" string\\n";\n'],
  ["NUL bytes", "\0"],
  ["quotes", '"'],
]) {
  test(`readFile - ${name} stay within the cap once serialized`, async () => {
    const content = unit.repeat(Math.ceil((DEFAULT_READ_FILE_MAX_BYTES + 1) / unit.length));
    await withTempFile(content, async (path) => {
      const result = await readFile().call({ path });
      const { notice } = splitNotice(result);
      expect(notice).toContain("(512 KiB). Call read_file with offset");
      // The quoted, escaped content, the escaped "\n\n" separator, and the
      // quoted, escaped notice, all measured in UTF-8 bytes.
      const bytes = (value: string) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
      expect(
        bytes(result) <= DEFAULT_READ_FILE_MAX_BYTES + 2 + 4 + bytes(notice),
        `serialized result is ${bytes(result)} bytes`,
      ).toBe(true);
    });
  });
}

// A device may never end, and a read waiting on one cannot be interrupted,
// so special files are rejected rather than read.
test.skipIf(process.platform === "win32")("readFile - rejects a device", async () => {
  const error = await rejection(readFile().call({ path: "/dev/zero" }));
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Path is not a regular file: /dev/zero");
});

// Opening a FIFO blocks until a writer appears; it is rejected before it
// is opened, so the call cannot hang.
test.skipIf(process.platform === "win32")(
  "readFile - rejects a FIFO without blocking",
  async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
    const fifo = join(tempDir, "fifo");
    try {
      execFileSync("mkfifo", [fifo]);
      const error = await rejection(readFile().call({ path: fifo }, { timeout: 2_000 }));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`Path is not a regular file: ${fifo}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  },
);

// Permission bits do not apply on Windows.
test.skipIf(process.platform === "win32")("readFile - maps a permission error", async () => {
  await withTempFile("secret", async (path) => {
    await chmod(path, 0o000);
    // Root reads the file regardless of its permission bits.
    const unreadable = await readTextFile(path, "utf8").then(
      () => false,
      () => true,
    );
    if (!unreadable) return;
    const error = await rejection(readFile().call({ path }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(`Permission denied: ${path}`);
  });
});
