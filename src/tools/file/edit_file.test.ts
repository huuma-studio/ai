import { assertEquals, assertRejects } from "@std/assert";
import { editFile } from "./edit_file.ts";

Deno.test("editFile - search_replace operation", async (t) => {
  const tool = editFile();
  const testDir = await Deno.makeTempDir();

  await t.step("replaces unique text successfully", async () => {
    const testFile = `${testDir}/test1.txt`;
    await Deno.writeTextFile(testFile, "Hello, World!");

    const result = await tool.call({
      path: testFile,
      operation: "search_replace",
      search: "World",
      replace: "Deno",
    });

    assertEquals(result.success, true);
    assertEquals(result.operation, "search_replace");

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "Hello, Deno!");
  });

  await t.step("fails when text not found", async () => {
    const testFile = `${testDir}/test2.txt`;
    await Deno.writeTextFile(testFile, "Hello, World!");

    await assertRejects(
      async () => {
        await tool.call({
          path: testFile,
          operation: "search_replace",
          search: "NotFound",
          replace: "Deno",
        });
      },
      Error,
      "Text not found in file",
    );
  });

  await t.step("fails when multiple occurrences found", async () => {
    const testFile = `${testDir}/test3.txt`;
    await Deno.writeTextFile(testFile, "Hello Hello Hello");

    await assertRejects(
      async () => {
        await tool.call({
          path: testFile,
          operation: "search_replace",
          search: "Hello",
          replace: "Hi",
        });
      },
      Error,
      "Found 3 occurrences",
    );
  });

  await t.step("can replace multi-line text", async () => {
    const testFile = `${testDir}/test4.txt`;
    await Deno.writeTextFile(testFile, "function old() {\n  return 1;\n}");

    const result = await tool.call({
      path: testFile,
      operation: "search_replace",
      search: "function old() {\n  return 1;\n}",
      replace: "function new() {\n  return 2;\n}",
    });

    assertEquals(result.success, true);

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "function new() {\n  return 2;\n}");
  });

  await Deno.remove(testDir, { recursive: true });
});

Deno.test("editFile - insert operation", async (t) => {
  const tool = editFile();
  const testDir = await Deno.makeTempDir();

  await t.step("inserts at beginning of file", async () => {
    const testFile = `${testDir}/test1.txt`;
    await Deno.writeTextFile(testFile, "line 2\nline 3");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "line 1\n",
      line: 1,
    });

    assertEquals(result.success, true);

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "line 1\nline 2\nline 3");
  });

  await t.step("inserts in middle of file", async () => {
    const testFile = `${testDir}/test2.txt`;
    await Deno.writeTextFile(testFile, "line 1\nline 3");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "line 2\n",
      line: 2,
    });

    assertEquals(result.success, true);

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "line 1\nline 2\nline 3");
  });

  await t.step("inserts at end of file", async () => {
    const testFile = `${testDir}/test3.txt`;
    await Deno.writeTextFile(testFile, "line 1\nline 2");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "line 3",
      line: 3,
    });

    assertEquals(result.success, true);

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "line 1\nline 2\nline 3");
  });

  await t.step("inserts multi-line content", async () => {
    const testFile = `${testDir}/test4.txt`;
    await Deno.writeTextFile(testFile, "start\nend");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "middle1\nmiddle2\n",
      line: 2,
    });

    assertEquals(result.success, true);

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "start\nmiddle1\nmiddle2\nend");
  });

  await t.step("appends multi-line content at lines.length+1", async () => {
    const testFile = `${testDir}/test6.txt`;
    await Deno.writeTextFile(testFile, "line 1\nline 2");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "line 3\nline 4\n",
      line: 3,
    });

    assertEquals(result.success, true);

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "line 1\nline 2\nline 3\nline 4");
  });

  await t.step("fails when line is beyond end of file", async () => {
    const testFile = `${testDir}/test5.txt`;
    await Deno.writeTextFile(testFile, "line 1\nline 2");

    await assertRejects(
      async () => {
        await tool.call({
          path: testFile,
          operation: "insert_lines",
          content: "line 4",
          line: 5,
        });
      },
      Error,
      "is beyond end of file",
    );
  });

  await Deno.remove(testDir, { recursive: true });
});

Deno.test("editFile - delete_lines operation", async (t) => {
  const tool = editFile();
  const testDir = await Deno.makeTempDir();

  await t.step("deletes single line", async () => {
    const testFile = `${testDir}/test1.txt`;
    await Deno.writeTextFile(testFile, "line 1\nline 2\nline 3");

    const result = await tool.call({
      path: testFile,
      operation: "delete_lines",
      content: "", // content is required by schema but not used
      lineStart: 2,
    });

    assertEquals(result.success, true);

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "line 1\nline 3");
  });

  await t.step(
    "deletes multiple lines using lineStart and lineEnd",
    async () => {
      const testFile = `${testDir}/test2.txt`;
      await Deno.writeTextFile(testFile, "line 1\nline 2\nline 3\nline 4");

      const result = await tool.call({
        path: testFile,
        operation: "delete_lines",
        content: "", // content is required by schema but not used
        lineStart: 2,
        lineEnd: 3,
      });

      assertEquals(result.success, true);

      const content = await Deno.readTextFile(testFile);
      assertEquals(content, "line 1\nline 4");
    },
  );

  await t.step("deletes first line", async () => {
    const testFile = `${testDir}/test3.txt`;
    await Deno.writeTextFile(testFile, "line 1\nline 2\nline 3");

    const result = await tool.call({
      path: testFile,
      operation: "delete_lines",
      content: "", // content is required by schema but not used
      lineStart: 1,
    });

    assertEquals(result.success, true);

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "line 2\nline 3");
  });

  await t.step("deletes last line", async () => {
    const testFile = `${testDir}/test4.txt`;
    await Deno.writeTextFile(testFile, "line 1\nline 2\nline 3");

    const result = await tool.call({
      path: testFile,
      operation: "delete_lines",
      content: "", // content is required by schema but not used
      lineStart: 3,
    });

    assertEquals(result.success, true);

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "line 1\nline 2");
  });

  await t.step("fails when lineEnd < lineStart", async () => {
    const testFile = `${testDir}/test5.txt`;
    await Deno.writeTextFile(testFile, "line 1\nline 2");

    await assertRejects(
      async () => {
        await tool.call({
          path: testFile,
          operation: "delete_lines",
          content: "", // content is required by schema but not used
          lineStart: 2,
          lineEnd: 1,
        });
      },
      Error,
      "lineEnd must be greater than or equal to lineStart",
    );
  });

  await Deno.remove(testDir, { recursive: true });
});

Deno.test("editFile - error handling", async (t) => {
  const tool = editFile();

  await t.step("fails for non-existent file", async () => {
    await assertRejects(
      async () => {
        await tool.call({
          path: "/non/existent/file.txt",
          operation: "search_replace",
          search: "old",
          replace: "new",
        });
      },
      Error,
      "File not found",
    );
  });

  await t.step("fails for invalid operation", async () => {
    const testDir = await Deno.makeTempDir();
    const testFile = `${testDir}/test.txt`;
    await Deno.writeTextFile(testFile, "content");

    await assertRejects(
      async () => {
        await tool.call({
          path: testFile,
          operation: "invalid_op",
          // deno-lint-ignore no-explicit-any
        } as any);
      },
      Error,
      "operation",
    );

    await Deno.remove(testDir, { recursive: true });
  });

  await t.step(
    "fails when required parameters missing for search_replace",
    async () => {
      const testDir = await Deno.makeTempDir();
      const testFile = `${testDir}/test.txt`;
      await Deno.writeTextFile(testFile, "content");

      await assertRejects(
        async () => {
          await tool.call({
            path: testFile,
            operation: "search_replace",
            search: "content",
            // replace is intentionally omitted for testing
            // deno-lint-ignore no-explicit-any
          } as any);
        },
        Error,
        "replace",
      );

      await Deno.remove(testDir, { recursive: true });
    },
  );
});

Deno.test("editFile - same-batch same-file edits apply sequentially", async (t) => {
  const tool = editFile();
  const testDir = await Deno.makeTempDir();

  await t.step("two search_replace calls in one batch both land", async () => {
    const testFile = `${testDir}/batch1.txt`;
    await Deno.writeTextFile(testFile, "alpha\nbeta\nTAIL-MARKER-OK");

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

    assertEquals(results.every((result) => result.success), true);

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "ALPHA\nBETA\nTAIL-MARKER-OK");
  });

  await t.step("swapping the batch order still applies both edits", async () => {
    const testFile = `${testDir}/batch2.txt`;
    await Deno.writeTextFile(testFile, "alpha\nbeta\nTAIL-MARKER-OK");

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

    const content = await Deno.readTextFile(testFile);
    assertEquals(content, "ALPHA\nBETA\nTAIL-MARKER-OK");
  });

  await t.step(
    "mixed search_replace and insert_lines in one batch both land",
    async () => {
      const testFile = `${testDir}/batch3.txt`;
      await Deno.writeTextFile(testFile, "alpha\nbeta");

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

      const content = await Deno.readTextFile(testFile);
      assertEquals(content, "ALPHA\ninserted\nbeta");
    },
  );

  await t.step(
    "conflicting same-file edits fail loudly instead of silently losing one",
    async () => {
      const testFile = `${testDir}/batch4.txt`;
      await Deno.writeTextFile(testFile, "value = 1\nTAIL-MARKER-OK");

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
      assertEquals(applied, 1);

      const content = await Deno.readTextFile(testFile);
      assertEquals(
        content === "value = 2\nTAIL-MARKER-OK" ||
          content === "value = 3\nTAIL-MARKER-OK",
        true,
      );
    },
  );

  await t.step(
    "separate editFile instances still serialize on the same file",
    async () => {
      const testFile = `${testDir}/batch5.txt`;
      await Deno.writeTextFile(testFile, "one\ntwo\nTAIL-MARKER-OK");

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

      const content = await Deno.readTextFile(testFile);
      assertEquals(content, "ONE\nTWO\nTAIL-MARKER-OK");
    },
  );

  await Deno.remove(testDir, { recursive: true });
});

Deno.test("editFile - insert_lines handles very large content", async (t) => {
  const tool = editFile();
  const testDir = await Deno.makeTempDir();

  const assertLargeInsert = async (lineCount: number) => {
    const testFile = `${testDir}/large-${lineCount}.txt`;
    await Deno.writeTextFile(testFile, "head\nTAIL-MARKER-OK");

    const content = Array.from(
      { length: lineCount },
      (_, i) => `pad ${i}`,
    ).join("\n") + "\n";

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content,
      line: 2,
    });

    assertEquals(result.success, true);

    const updated = await Deno.readTextFile(testFile);
    const updatedLines = updated.split("\n");
    assertEquals(updatedLines.length, lineCount + 2);
    assertEquals(updatedLines[0], "head");
    assertEquals(updatedLines[1], "pad 0");
    assertEquals(updatedLines[lineCount], `pad ${lineCount - 1}`);
    assertEquals(updatedLines[lineCount + 1], "TAIL-MARKER-OK");
  };

  await t.step("inserts 10 000 lines", async () => await assertLargeInsert(10_000));
  await t.step("inserts 100 000 lines", async () =>
    await assertLargeInsert(100_000));

  await Deno.remove(testDir, { recursive: true });
});

Deno.test("editFile - CRLF files are handled per line and keep their endings", async (t) => {
  const tool = editFile();
  const testDir = await Deno.makeTempDir();

  await t.step("insert_lines preserves CRLF endings", async () => {
    const testFile = `${testDir}/crlf-insert.txt`;
    await Deno.writeTextFile(testFile, "line 1\r\nline 2\r\n");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "inserted\r\n",
      line: 2,
    });

    assertEquals(result.success, true);
    assertEquals(
      await Deno.readTextFile(testFile),
      "line 1\r\ninserted\r\nline 2\r\n",
    );
  });

  await t.step(
    "insert_lines normalizes LF-only content to the file's CRLF",
    async () => {
      const testFile = `${testDir}/crlf-insert-lf.txt`;
      await Deno.writeTextFile(testFile, "line 1\r\nline 2\r\n");

      const result = await tool.call({
        path: testFile,
        operation: "insert_lines",
        content: "inserted\n",
        line: 2,
      });

      assertEquals(result.success, true);
      assertEquals(
        await Deno.readTextFile(testFile),
        "line 1\r\ninserted\r\nline 2\r\n",
      );
    },
  );

  await t.step(
    "insert_lines normalizes a mixed file to its dominant ending",
    async () => {
      const testFile = `${testDir}/crlf-mixed.txt`;
      await Deno.writeTextFile(testFile, "line 1\r\nline 2\nline 3\r\n");

      const result = await tool.call({
        path: testFile,
        operation: "insert_lines",
        content: "inserted\n",
        line: 2,
      });

      assertEquals(result.success, true);
      assertEquals(
        await Deno.readTextFile(testFile),
        "line 1\r\ninserted\r\nline 2\r\nline 3\r\n",
      );
    },
  );

  await t.step("delete_lines preserves CRLF endings", async () => {
    const testFile = `${testDir}/crlf-delete.txt`;
    await Deno.writeTextFile(testFile, "line 1\r\nline 2\r\nline 3\r\n");

    const result = await tool.call({
      path: testFile,
      operation: "delete_lines",
      lineStart: 2,
    });

    assertEquals(result.success, true);
    assertEquals(
      await Deno.readTextFile(testFile),
      "line 1\r\nline 3\r\n",
    );
  });

  await t.step("search_replace leaves untouched line endings alone", async () => {
    const testFile = `${testDir}/crlf-replace.txt`;
    await Deno.writeTextFile(testFile, "line 1\r\nalpha\r\nline 3\r\n");

    const result = await tool.call({
      path: testFile,
      operation: "search_replace",
      search: "alpha",
      replace: "beta",
    });

    assertEquals(result.success, true);
    assertEquals(
      await Deno.readTextFile(testFile),
      "line 1\r\nbeta\r\nline 3\r\n",
    );
  });

  await t.step("an LF file stays LF", async () => {
    const testFile = `${testDir}/lf-insert.txt`;
    await Deno.writeTextFile(testFile, "line 1\nline 2\n");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "inserted\r\n",
      line: 2,
    });

    assertEquals(result.success, true);
    assertEquals(
      await Deno.readTextFile(testFile),
      "line 1\ninserted\nline 2\n",
    );
  });

  await Deno.remove(testDir, { recursive: true });
});

Deno.test("editFile - edits keep content outside the edited region intact", async (t) => {
  const tool = editFile();
  const testDir = await Deno.makeTempDir();

  await t.step("search_replace keeps head and tail intact", async () => {
    const testFile = `${testDir}/intact-replace.txt`;
    await Deno.writeTextFile(testFile, "HEAD-MARKER\nbody-a\nbody-b\nTAIL-MARKER-OK");

    const result = await tool.call({
      path: testFile,
      operation: "search_replace",
      search: "body-a",
      replace: "BODY-A",
    });

    assertEquals(result.success, true);
    assertEquals(
      await Deno.readTextFile(testFile),
      "HEAD-MARKER\nBODY-A\nbody-b\nTAIL-MARKER-OK",
    );
  });

  await t.step("insert_lines keeps head and tail intact", async () => {
    const testFile = `${testDir}/intact-insert.txt`;
    await Deno.writeTextFile(testFile, "HEAD-MARKER\nbody-a\nbody-b\nTAIL-MARKER-OK");

    const result = await tool.call({
      path: testFile,
      operation: "insert_lines",
      content: "new-1\nnew-2\n",
      line: 3,
    });

    assertEquals(result.success, true);
    assertEquals(
      await Deno.readTextFile(testFile),
      "HEAD-MARKER\nbody-a\nnew-1\nnew-2\nbody-b\nTAIL-MARKER-OK",
    );
  });

  await t.step("delete_lines keeps head and tail intact", async () => {
    const testFile = `${testDir}/intact-delete.txt`;
    await Deno.writeTextFile(testFile, "HEAD-MARKER\nbody-a\nbody-b\nTAIL-MARKER-OK");

    const result = await tool.call({
      path: testFile,
      operation: "delete_lines",
      lineStart: 2,
      lineEnd: 3,
    });

    assertEquals(result.success, true);
    assertEquals(
      await Deno.readTextFile(testFile),
      "HEAD-MARKER\nTAIL-MARKER-OK",
    );
  });

  await Deno.remove(testDir, { recursive: true });
});

Deno.test("editFile - search_replace works on multi-megabyte files", async () => {
  const tool = editFile();
  const testDir = await Deno.makeTempDir();
  const testFile = `${testDir}/big.txt`;
  const filler = "a".repeat(3 * 1024 * 1024);
  await Deno.writeTextFile(testFile, `start ${filler} NEEDLE end`);

  const result = await tool.call({
    path: testFile,
    operation: "search_replace",
    search: "NEEDLE",
    replace: "REPLACED",
  });

  assertEquals(result.success, true);

  const content = await Deno.readTextFile(testFile);
  assertEquals(content, `start ${filler} REPLACED end`);
  await Deno.remove(testDir, { recursive: true });
});