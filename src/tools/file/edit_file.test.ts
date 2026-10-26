import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { editFile } from "./edit_file.ts";

describe("editFile - search_replace operation", () => {
  const tool = editFile();
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("replaces unique text successfully", async () => {
    const testFile = `${testDir}/test1.txt`;
    await writeFile(testFile, "Hello, World!");

    const result = await tool.call({
      path: testFile,
      operation: "search_replace",
      search: "World",
      replace: "Deno",
    });

    expect(result.success).toBe(true);
    expect(result.operation).toBe("search_replace");

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("Hello, Deno!");
  });

  test("fails when text not found", async () => {
    const testFile = `${testDir}/test2.txt`;
    await writeFile(testFile, "Hello, World!");

    await expect(
      tool.call({
        path: testFile,
        operation: "search_replace",
        search: "NotFound",
        replace: "Deno",
      }),
    ).rejects.toThrow("Text not found in file");
  });

  test("fails when multiple occurrences found", async () => {
    const testFile = `${testDir}/test3.txt`;
    await writeFile(testFile, "Hello Hello Hello");

    await expect(
      tool.call({
        path: testFile,
        operation: "search_replace",
        search: "Hello",
        replace: "Hi",
      }),
    ).rejects.toThrow("Found 3 occurrences");
  });

  test("can replace multi-line text", async () => {
    const testFile = `${testDir}/test4.txt`;
    await writeFile(testFile, "function old() {\n  return 1;\n}");

    const result = await tool.call({
      path: testFile,
      operation: "search_replace",
      search: "function old() {\n  return 1;\n}",
      replace: "function new() {\n  return 2;\n}",
    });

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("function new() {\n  return 2;\n}");
  });
});

describe("editFile - insert operation", () => {
  const tool = editFile();
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("inserts at beginning of file", async () => {
    const testFile = `${testDir}/test1.txt`;
    await writeFile(testFile, "line 2\nline 3");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "line 1\n",
      line: 1,
    });

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("line 1\nline 2\nline 3");
  });

  test("inserts in middle of file", async () => {
    const testFile = `${testDir}/test2.txt`;
    await writeFile(testFile, "line 1\nline 3");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "line 2\n",
      line: 2,
    });

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("line 1\nline 2\nline 3");
  });

  test("inserts at end of file", async () => {
    const testFile = `${testDir}/test3.txt`;
    await writeFile(testFile, "line 1\nline 2");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "line 3",
      line: 3,
    });

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("line 1\nline 2\nline 3");
  });

  test("inserts multi-line content", async () => {
    const testFile = `${testDir}/test4.txt`;
    await writeFile(testFile, "start\nend");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "middle1\nmiddle2\n",
      line: 2,
    });

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("start\nmiddle1\nmiddle2\nend");
  });

  test("appends multi-line content at lines.length+1", async () => {
    const testFile = `${testDir}/test6.txt`;
    await writeFile(testFile, "line 1\nline 2");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "line 3\nline 4\n",
      line: 3,
    });

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("line 1\nline 2\nline 3\nline 4");
  });

  test("fails when line is beyond end of file", async () => {
    const testFile = `${testDir}/test5.txt`;
    await writeFile(testFile, "line 1\nline 2");

    await expect(
      tool.call({
        path: testFile,
        operation: "insert_lines",
        content: "line 4",
        line: 5,
      }),
    ).rejects.toThrow("is beyond end of file");
  });
});

describe("editFile - delete_lines operation", () => {
  const tool = editFile();
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("deletes single line", async () => {
    const testFile = `${testDir}/test1.txt`;
    await writeFile(testFile, "line 1\nline 2\nline 3");

    const result = await tool.call({
      path: testFile,
      operation: "delete_lines",
      content: "", // content is required by schema but not used
      lineStart: 2,
    });

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("line 1\nline 3");
  });

  test("deletes multiple lines using lineStart and lineEnd", async () => {
    const testFile = `${testDir}/test2.txt`;
    await writeFile(testFile, "line 1\nline 2\nline 3\nline 4");

    const result = await tool.call({
      path: testFile,
      operation: "delete_lines",
      content: "", // content is required by schema but not used
      lineStart: 2,
      lineEnd: 3,
    });

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("line 1\nline 4");
  });

  test("deletes first line", async () => {
    const testFile = `${testDir}/test3.txt`;
    await writeFile(testFile, "line 1\nline 2\nline 3");

    const result = await tool.call({
      path: testFile,
      operation: "delete_lines",
      content: "", // content is required by schema but not used
      lineStart: 1,
    });

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("line 2\nline 3");
  });

  test("deletes last line", async () => {
    const testFile = `${testDir}/test4.txt`;
    await writeFile(testFile, "line 1\nline 2\nline 3");

    const result = await tool.call({
      path: testFile,
      operation: "delete_lines",
      content: "", // content is required by schema but not used
      lineStart: 3,
    });

    expect(result.success).toBe(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("line 1\nline 2");
  });

  test("fails when lineEnd < lineStart", async () => {
    const testFile = `${testDir}/test5.txt`;
    await writeFile(testFile, "line 1\nline 2");

    await expect(
      tool.call({
        path: testFile,
        operation: "delete_lines",
        content: "", // content is required by schema but not used
        lineStart: 2,
        lineEnd: 1,
      }),
    ).rejects.toThrow("lineEnd must be greater than or equal to lineStart");
  });
});

describe("editFile - error handling", () => {
  const tool = editFile();

  test("fails for non-existent file", async () => {
    await expect(
      tool.call({
        path: "/non/existent/file.txt",
        operation: "search_replace",
        search: "old",
        replace: "new",
      }),
    ).rejects.toThrow("File not found");
  });

  test("fails for invalid operation", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
    const testFile = `${testDir}/test.txt`;
    await writeFile(testFile, "content");

    await expect(
      tool.call({
        path: testFile,
        operation: "invalid_op",
      } as any),
    ).rejects.toThrow("operation");

    await rm(testDir, { recursive: true, force: true });
  });

  test("fails when required parameters missing for search_replace", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
    const testFile = `${testDir}/test.txt`;
    await writeFile(testFile, "content");

    await expect(
      tool.call({
        path: testFile,
        operation: "search_replace",
        search: "content",
        // replace is intentionally omitted for testing
      } as any),
    ).rejects.toThrow("replace");

    await rm(testDir, { recursive: true, force: true });
  });
});

describe("editFile - same-batch same-file edits apply sequentially", () => {
  const tool = editFile();
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("two search_replace calls in one batch both land", async () => {
    const testFile = `${testDir}/batch1.txt`;
    await writeFile(testFile, "alpha\nbeta\nTAIL-MARKER-OK");

    const results = await Promise.all([
      tool.call({
        path: testFile,
        operation: "search_replace",
        search: "alpha",
        replace: "ALPHA",
      }),
      tool.call({
        path: testFile,
        operation: "search_replace",
        search: "beta",
        replace: "BETA",
      }),
    ]);

    expect(results.every((result) => result.success)).toStrictEqual(true);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("ALPHA\nBETA\nTAIL-MARKER-OK");
  });

  test("swapping the batch order still applies both edits", async () => {
    const testFile = `${testDir}/batch2.txt`;
    await writeFile(testFile, "alpha\nbeta\nTAIL-MARKER-OK");

    await Promise.all([
      tool.call({
        path: testFile,
        operation: "search_replace",
        search: "beta",
        replace: "BETA",
      }),
      tool.call({
        path: testFile,
        operation: "search_replace",
        search: "alpha",
        replace: "ALPHA",
      }),
    ]);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("ALPHA\nBETA\nTAIL-MARKER-OK");
  });

  test("mixed search_replace and insert_lines in one batch both land", async () => {
    const testFile = `${testDir}/batch3.txt`;
    await writeFile(testFile, "alpha\nbeta");

    await Promise.all([
      tool.call({
        path: testFile,
        operation: "search_replace",
        search: "alpha",
        replace: "ALPHA",
      }),
      tool.call({
        path: testFile,
        operation: "insert_lines",
        content: "inserted\n",
        line: 2,
      }),
    ]);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("ALPHA\ninserted\nbeta");
  });

  test("conflicting same-file edits fail loudly instead of silently losing one", async () => {
    const testFile = `${testDir}/batch4.txt`;
    await writeFile(testFile, "value = 1\nTAIL-MARKER-OK");

    const outcomes = await Promise.allSettled([
      tool.call({
        path: testFile,
        operation: "search_replace",
        search: "value = 1",
        replace: "value = 2",
      }),
      tool.call({
        path: testFile,
        operation: "search_replace",
        search: "value = 1",
        replace: "value = 3",
      }),
    ]);

    // Both calls target the same text; serialized application means exactly
    // one edit wins and the loser reports an error instead of both calls
    // reporting success while one edit is dropped.
    const applied = outcomes.filter((o) => o.status === "fulfilled").length;
    expect(applied).toStrictEqual(1);

    const content = await readFile(testFile, "utf8");
    expect(
      content === "value = 2\nTAIL-MARKER-OK" || content === "value = 3\nTAIL-MARKER-OK",
    ).toStrictEqual(true);
  });

  test("separate editFile instances still serialize on the same file", async () => {
    const testFile = `${testDir}/batch5.txt`;
    await writeFile(testFile, "one\ntwo\nTAIL-MARKER-OK");

    await Promise.all([
      editFile().call({
        path: testFile,
        operation: "search_replace",
        search: "one",
        replace: "ONE",
      }),
      editFile().call({
        path: testFile,
        operation: "search_replace",
        search: "two",
        replace: "TWO",
      }),
    ]);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("ONE\nTWO\nTAIL-MARKER-OK");
  });

  test("edits through hard-linked names of one file still serialize", async () => {
    const testFile = `${testDir}/hard-link-target.txt`;
    await writeFile(testFile, "alpha\nbeta\nTAIL-MARKER-OK");
    const aliasFile = `${testDir}/hard-link-alias.txt`;
    await link(testFile, aliasFile);

    // One edit per alias of the same underlying file, issued concurrently:
    // both must land instead of racing on separate (per-path) locks.
    await Promise.all([
      tool.call({
        path: testFile,
        operation: "search_replace",
        search: "alpha",
        replace: "ALPHA",
      }),
      tool.call({
        path: aliasFile,
        operation: "search_replace",
        search: "beta",
        replace: "BETA",
      }),
    ]);

    const content = await readFile(testFile, "utf8");
    expect(content).toStrictEqual("ALPHA\nBETA\nTAIL-MARKER-OK");
    expect(await readFile(aliasFile, "utf8")).toStrictEqual(content);
  });
});

describe("editFile - insert_lines handles very large content", () => {
  const tool = editFile();
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const assertLargeInsert = async (lineCount: number) => {
    const testFile = `${testDir}/large-${lineCount}.txt`;
    await writeFile(testFile, "head\nTAIL-MARKER-OK");

    const content = Array.from({ length: lineCount }, (_, i) => `pad ${i}`).join("\n") + "\n";

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content,
      line: 2,
    });

    expect(result.success).toBe(true);

    const updated = await readFile(testFile, "utf8");
    const updatedLines = updated.split("\n");
    expect(updatedLines.length).toStrictEqual(lineCount + 2);
    expect(updatedLines[0]).toStrictEqual("head");
    expect(updatedLines[1]).toStrictEqual("pad 0");
    expect(updatedLines[lineCount]).toStrictEqual(`pad ${lineCount - 1}`);
    expect(updatedLines[lineCount + 1]).toStrictEqual("TAIL-MARKER-OK");
  };

  test("inserts 10 000 lines", async () => await assertLargeInsert(10_000));
  test("inserts 100 000 lines", async () => await assertLargeInsert(100_000));
});

describe("editFile - CRLF files are handled per line and keep their endings", () => {
  const tool = editFile();
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("insert_lines preserves CRLF endings", async () => {
    const testFile = `${testDir}/crlf-insert.txt`;
    await writeFile(testFile, "line 1\r\nline 2\r\n");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "inserted\r\n",
      line: 2,
    });

    expect(result.success).toBe(true);
    expect(await readFile(testFile, "utf8")).toStrictEqual("line 1\r\ninserted\r\nline 2\r\n");
  });

  test("insert_lines normalizes LF-only content to the file's CRLF", async () => {
    const testFile = `${testDir}/crlf-insert-lf.txt`;
    await writeFile(testFile, "line 1\r\nline 2\r\n");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "inserted\n",
      line: 2,
    });

    expect(result.success).toBe(true);
    expect(await readFile(testFile, "utf8")).toStrictEqual("line 1\r\ninserted\r\nline 2\r\n");
  });

  test("insert_lines normalizes a mixed file to its dominant ending", async () => {
    const testFile = `${testDir}/crlf-mixed.txt`;
    await writeFile(testFile, "line 1\r\nline 2\nline 3\r\n");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "inserted\n",
      line: 2,
    });

    expect(result.success).toBe(true);
    expect(await readFile(testFile, "utf8")).toStrictEqual(
      "line 1\r\ninserted\r\nline 2\r\nline 3\r\n",
    );
  });

  test("delete_lines preserves CRLF endings", async () => {
    const testFile = `${testDir}/crlf-delete.txt`;
    await writeFile(testFile, "line 1\r\nline 2\r\nline 3\r\n");

    const result = await tool.call({
      path: testFile,
      operation: "delete_lines",
      lineStart: 2,
    });

    expect(result.success).toBe(true);
    expect(await readFile(testFile, "utf8")).toStrictEqual("line 1\r\nline 3\r\n");
  });

  test("search_replace leaves untouched line endings alone", async () => {
    const testFile = `${testDir}/crlf-replace.txt`;
    await writeFile(testFile, "line 1\r\nalpha\r\nline 3\r\n");

    const result = await tool.call({
      path: testFile,
      operation: "search_replace",
      search: "alpha",
      replace: "beta",
    });

    expect(result.success).toBe(true);
    expect(await readFile(testFile, "utf8")).toStrictEqual("line 1\r\nbeta\r\nline 3\r\n");
  });

  test("an LF file stays LF", async () => {
    const testFile = `${testDir}/lf-insert.txt`;
    await writeFile(testFile, "line 1\nline 2\n");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "inserted\r\n",
      line: 2,
    });

    expect(result.success).toBe(true);
    expect(await readFile(testFile, "utf8")).toStrictEqual("line 1\ninserted\nline 2\n");
  });
});

describe("editFile - edits keep content outside the edited region intact", () => {
  const tool = editFile();
  let testDir: string;

  beforeAll(async () => {
    testDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("search_replace keeps head and tail intact", async () => {
    const testFile = `${testDir}/intact-replace.txt`;
    await writeFile(testFile, "HEAD-MARKER\nbody-a\nbody-b\nTAIL-MARKER-OK");

    const result = await tool.call({
      path: testFile,
      operation: "search_replace",
      search: "body-a",
      replace: "BODY-A",
    });

    expect(result.success).toBe(true);
    expect(await readFile(testFile, "utf8")).toStrictEqual(
      "HEAD-MARKER\nBODY-A\nbody-b\nTAIL-MARKER-OK",
    );
  });

  test("insert_lines keeps head and tail intact", async () => {
    const testFile = `${testDir}/intact-insert.txt`;
    await writeFile(testFile, "HEAD-MARKER\nbody-a\nbody-b\nTAIL-MARKER-OK");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "new-1\nnew-2\n",
      line: 3,
    });

    expect(result.success).toBe(true);
    expect(await readFile(testFile, "utf8")).toStrictEqual(
      "HEAD-MARKER\nbody-a\nnew-1\nnew-2\nbody-b\nTAIL-MARKER-OK",
    );
  });

  test("delete_lines keeps head and tail intact", async () => {
    const testFile = `${testDir}/intact-delete.txt`;
    await writeFile(testFile, "HEAD-MARKER\nbody-a\nbody-b\nTAIL-MARKER-OK");

    const result = await tool.call({
      path: testFile,
      operation: "delete_lines",
      lineStart: 2,
      lineEnd: 3,
    });

    expect(result.success).toBe(true);
    expect(await readFile(testFile, "utf8")).toStrictEqual("HEAD-MARKER\nTAIL-MARKER-OK");
  });
});

test("editFile - search_replace works on multi-megabyte files", async () => {
  const tool = editFile();
  const testDir = await mkdtemp(join(tmpdir(), "huuma-ai-"));
  const testFile = `${testDir}/big.txt`;
  const filler = "a".repeat(3 * 1024 * 1024);
  await writeFile(testFile, `start ${filler} NEEDLE end`);

  const result = await tool.call({
    path: testFile,
    operation: "search_replace",
    search: "NEEDLE",
    replace: "REPLACED",
  });

  expect(result.success).toBe(true);

  const content = await readFile(testFile, "utf8");
  expect(content).toStrictEqual(`start ${filler} REPLACED end`);
});
