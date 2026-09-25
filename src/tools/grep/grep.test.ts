import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DEFAULT_GREP_TIMEOUT, grep } from "@/tools/grep/grep.ts";

/** Run `fn` in a temp directory holding `files` (relative path → content). */
async function withTree(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(dir, name);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

function lines(count: number, text: (index: number) => string): string {
  return Array.from({ length: count }, (_, index) => text(index)).join("\n") +
    "\n";
}

Deno.test("grep - groups directory matches by file with line numbers", async () => {
  await withTree({
    "a.ts": "const needle = 1;\nother\n  Needle again  \n",
    "b.md": "no match\n",
    "sub/c.ts": "needle\n",
  }, async (dir) => {
    const result = await grep().call({ pattern: "needle", path: dir });
    const byFile = Object.fromEntries(
      result.results.map((r) => [r.file, r.matches]),
    );
    assertEquals(result.path, dir);
    assertEquals(byFile, {
      [join(dir, "a.ts")]: [
        { line: 1, content: "const needle = 1;" },
        { line: 3, content: "Needle again" },
      ],
      [join(dir, "sub/c.ts")]: [{ line: 1, content: "needle" }],
    });
    assertEquals(result.truncated, undefined);
    assertEquals(result.message, undefined);
  });
});

Deno.test("grep - caseSensitive, glob, and excluded directories", async () => {
  await withTree({
    "a.ts": "Needle\nneedle\n",
    "a.md": "needle\n",
    "node_modules/x.ts": "needle\n",
    ".git/y.ts": "needle\n",
  }, async (dir) => {
    const result = await grep().call({
      pattern: "needle",
      path: dir,
      glob: "*.ts",
      caseSensitive: true,
    });
    assertEquals(result.results, [
      { file: join(dir, "a.ts"), matches: [{ line: 2, content: "needle" }] },
    ]);
  });
});

Deno.test("grep - caps matches per file at 10", async () => {
  await withTree({
    "many.txt": lines(25, (i) => `match ${i}`),
  }, async (dir) => {
    const result = await grep().call({ pattern: "match", path: dir });
    assertEquals(result.results.length, 1);
    assertEquals(
      result.results[0].matches.map((m) => m.line),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assertEquals(result.truncated, undefined);
  });
});

Deno.test("grep - caps directory matches at 100 in total", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) {
    files[`f${String(i).padStart(2, "0")}.txt`] = lines(5, (j) => `match ${j}`);
  }
  await withTree(files, async (dir) => {
    const result = await grep().call({ pattern: "match", path: dir });
    const total = result.results.reduce((n, r) => n + r.matches.length, 0);
    assertEquals(total, 100);
    assertEquals(result.truncated, true);
    assertEquals(
      result.message,
      "Results truncated to 100 matches. Use a more specific pattern or path to narrow results.",
    );
  });
});

Deno.test("grep - searches a single file", async () => {
  await withTree({ "one.txt": "alpha\nbeta\nalphabet\n" }, async (dir) => {
    const path = join(dir, "one.txt");
    const result = await grep().call({ pattern: "alpha", path });
    assertEquals(result, {
      path,
      results: [{
        file: path,
        matches: [
          { line: 1, content: "alpha" },
          { line: 3, content: "alphabet" },
        ],
      }],
    });
  });
});

Deno.test("grep - caps single-file matches at 100", async () => {
  await withTree(
    { "big.txt": lines(150, (i) => `match ${i}`) },
    async (dir) => {
      const path = join(dir, "big.txt");
      const result = await grep().call({ pattern: "match", path });
      const matches = result.results[0].matches;
      assertEquals(matches.length, 100);
      assertEquals(matches.at(-1), { line: 100, content: "match 99" });
      assertEquals(result.truncated, true);
    },
  );
});

Deno.test("grep - truncates long lines to 200 characters", async () => {
  await withTree({ "long.txt": "x".repeat(500) + "\n" }, async (dir) => {
    const path = join(dir, "long.txt");
    const result = await grep().call({ pattern: "x", path });
    assertEquals(result.results[0].matches, [
      { line: 1, content: "x".repeat(200) + "…" },
    ]);
  });
});

Deno.test("grep - reports no matches", async () => {
  await withTree({ "a.txt": "nothing here\n" }, async (dir) => {
    assertEquals(await grep().call({ pattern: "needle", path: dir }), {
      path: dir,
      results: [],
      message: "No matches found",
    });
  });
});

Deno.test("grep - throws when grep fails", async () => {
  await withTree({}, async (dir) => {
    await assertRejects(
      () => grep().call({ pattern: "x", path: join(dir, "missing") }),
      Error,
      "grep exited with code 2",
    );
  });
});

Deno.test("grep - a pattern starting with a dash is not an option", async () => {
  await withTree({ "a.txt": "use -v here\n" }, async (dir) => {
    const path = join(dir, "a.txt");
    const result = await grep().call({ pattern: "-v", path });
    assertEquals(result.results[0].matches, [
      { line: 1, content: "use -v here" },
    ]);
  });
});

Deno.test("grep - skips binary files", async () => {
  await withTree({ "bin.dat": "needle\0binary\n" }, async (dir) => {
    const result = await grep().call({ pattern: "needle", path: dir });
    assert(result.results.length === 0, JSON.stringify(result));
  });
});

Deno.test("grep - stops a search that finds far more than the cap", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 500; i++) {
    files[`f${i}.txt`] = lines(10, (j) => `match ${j}`);
  }
  await withTree(files, async (dir) => {
    const result = await grep().call({ pattern: "match", path: dir });
    const total = result.results.reduce((n, r) => n + r.matches.length, 0);
    assertEquals(total, 100);
    assertEquals(result.truncated, true);
    assertEquals(result.totalMatches, undefined);
  });
});

Deno.test("grep - a single file with far more matches than the cap", async () => {
  await withTree(
    { "huge.txt": lines(200_000, (i) => `match ${i}`) },
    async (dir) => {
      const path = join(dir, "huge.txt");
      const result = await grep().call({ pattern: "match", path });
      assertEquals(result.results[0].matches.length, 100);
      assertEquals(result.truncated, true);
      assertEquals(
        result.message,
        "Results truncated to the first 100 matches. Use a more specific pattern to narrow results.",
      );
    },
  );
});

Deno.test("grep - a huge matching line is cut without being held whole", async () => {
  await withTree(
    { "min.js": "  " + "x".repeat(8 * 1024 * 1024) + "\n" },
    async (dir) => {
      const result = await grep().call({ pattern: "x", path: dir });
      assertEquals(result.results[0].matches, [
        { line: 1, content: "x".repeat(200) + "…" },
      ]);
    },
  );
});

Deno.test("grep - has a default timeout", () => {
  assertEquals(DEFAULT_GREP_TIMEOUT, 30_000);
  assertEquals(grep().timeout, 30_000);
  assertEquals(grep({ timeout: 5 }).timeout, 5);
});

/** Run `fn` with a FIFO that nobody writes to: grep blocks reading it. */
async function withStalledFifo(
  fn: (fifo: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const fifo = join(dir, "fifo");
  try {
    const { success } = await new Deno.Command("mkfifo", { args: [fifo] })
      .output();
    assert(success, "mkfifo failed");
    await fn(fifo);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Whether a process — the grep under test — still has `fifo` open for
 * reading. Opening a FIFO's write end completes only once a reader is there,
 * so it completes at once if grep is still waiting on it; otherwise the test
 * opens a reader itself to release the pending open.
 */
async function hasReader(fifo: string): Promise<boolean> {
  // The call rejects as soon as it is aborted, while the kill signal is
  // still on its way to grep: give it a moment to take effect.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const writer = Deno.open(fifo, { write: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const opened = await Promise.race([
    writer.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 200);
    }),
  ]);
  clearTimeout(timer);
  if (!opened) (await Deno.open(fifo, { read: true })).close();
  (await writer).close();
  return opened;
}

// grep blocks on the FIFO until the call ends it; afterwards nothing may
// still be reading it.
Deno.test({
  name: "grep - an abort stops a running search",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withStalledFifo(async (fifo) => {
      const controller = new AbortController();
      const reason = new DOMException("stop", "AbortError");
      const call = grep().call({ pattern: "x", path: fifo }, {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(reason), 50);
      assertEquals(await assertRejects(() => call), reason);
      assert(!(await hasReader(fifo)), "grep is still running");
    });
  },
});

Deno.test({
  name: "grep - the timeout stops a running search",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withStalledFifo(async (fifo) => {
      const error = await assertRejects(() =>
        grep({ timeout: 50 }).call({ pattern: "x", path: fifo })
      );
      assert(
        error instanceof DOMException && error.name === "TimeoutError",
        `expected a TimeoutError, got ${error}`,
      );
      assert(!(await hasReader(fifo)), "grep is still running");
    });
  },
});
