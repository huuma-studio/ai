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
