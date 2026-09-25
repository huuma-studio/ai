import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  fitJsonString,
  formatBytes,
  readLines,
  readTextBounded,
  validateMaxBytes,
  withTruncationNotice,
} from "@/tools/bounded_text.ts";

const encoder = new TextEncoder();

/** A stream of the given chunks that records whether it was cancelled, and
 * optionally stays open after them instead of ending. */
function chunked(chunks: string[] | Uint8Array[], { stall = false } = {}) {
  const state = { cancelled: false };
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index++];
        controller.enqueue(
          typeof chunk === "string" ? encoder.encode(chunk) : chunk,
        );
      } else if (!stall) {
        controller.close();
      } else {
        return new Promise(() => {});
      }
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no result in ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

Deno.test("validateMaxBytes - accepts positive integers only", () => {
  validateMaxBytes(1);
  for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
    assertThrows(
      () => validateMaxBytes(invalid),
      TypeError,
      "maxBytes must be a positive integer",
    );
  }
});

Deno.test("readTextBounded - returns a stream under the cap whole", async () => {
  const { stream } = chunked(["hello ", "world"]);
  assertEquals(await readTextBounded(stream, 100), {
    text: "hello world",
    truncated: false,
  });
});

Deno.test("readTextBounded - cuts the chunk crossing the cap and cancels the rest", async () => {
  const { stream, state } = chunked(["abcd", "efgh", "ijkl"]);
  assertEquals(await readTextBounded(stream, 6), {
    text: "abcdef",
    truncated: true,
  });
  assert(state.cancelled, "the stream was not cancelled at the cap");
});

Deno.test("readTextBounded - drops a character split by the cap", async () => {
  // "é" is two bytes; a cap of 2 ends between them.
  const { stream } = chunked(["aé"]);
  assertEquals(await readTextBounded(stream, 2), {
    text: "a",
    truncated: true,
  });
});

Deno.test("readTextBounded - decodes a character split across chunks", async () => {
  const bytes = encoder.encode("é");
  const { stream } = chunked([bytes.subarray(0, 1), bytes.subarray(1)]);
  assertEquals(await readTextBounded(stream, 100), {
    text: "é",
    truncated: false,
  });
});

Deno.test("readTextBounded - drops a byte-order mark unless told to keep it", async () => {
  assertEquals(await readTextBounded(chunked(["\ufeffhi"]).stream, 100), {
    text: "hi",
    truncated: false,
  });
  assertEquals(
    await readTextBounded(chunked(["\ufeffhi"]).stream, 100, {
      ignoreBOM: true,
    }),
    { text: "\ufeffhi", truncated: false },
  );
});

Deno.test("readTextBounded - a stream ending exactly at the cap is complete", async () => {
  const { stream } = chunked(["abc", "def"]);
  assertEquals(await readTextBounded(stream, 6), {
    text: "abcdef",
    truncated: false,
  });
});

Deno.test("readTextBounded - a stream continuing exactly at the cap is truncated", async () => {
  const { stream, state } = chunked(["abc", "def", "g"], { stall: true });
  assertEquals(await readTextBounded(stream, 6), {
    text: "abcdef",
    truncated: true,
  });
  assert(state.cancelled, "the stream was not cancelled at the cap");
});

Deno.test("readTextBounded - a stream stalling at the cap is truncated after the grace", async () => {
  const { stream, state } = chunked(["abcdef"], { stall: true });
  assertEquals(
    await within(readTextBounded(stream, 6, { endOfStreamGrace: 20 })),
    { text: "abcdef", truncated: true },
  );
  assert(state.cancelled, "the stalled stream was not cancelled");
});

Deno.test("readTextBounded - an abort stops reading and cancels the stream", async () => {
  const controller = new AbortController();
  const reason = new DOMException("stop", "AbortError");
  let pulls = 0;
  const state = { cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(streamController) {
      if (++pulls === 2) controller.abort(reason);
      streamController.enqueue(encoder.encode("x"));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const error = await assertRejects(() =>
    readTextBounded(stream, 1_000, { signal: controller.signal })
  );
  assertEquals(error, reason);
  assert(state.cancelled, "the stream was not cancelled on abort");
});

Deno.test("readTextBounded - an abort ends a read waiting on a stalled stream", async () => {
  const controller = new AbortController();
  const reason = new DOMException("stop", "AbortError");
  const { stream, state } = chunked(["abc"], { stall: true });
  const reading = readTextBounded(stream, 1_000, {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(reason), 10);
  const error = await within(assertRejects(() => reading));
  assertEquals(error, reason);
  assert(state.cancelled, "the stalled stream was not cancelled on abort");
});

Deno.test("readTextBounded - an abort during the end-of-stream grace wins", async () => {
  const controller = new AbortController();
  const reason = new DOMException("stop", "AbortError");
  const { stream, state } = chunked(["abcdef"], { stall: true });
  const reading = readTextBounded(stream, 6, {
    signal: controller.signal,
    endOfStreamGrace: 1_000,
  });
  setTimeout(() => controller.abort(reason), 10);
  const error = await within(assertRejects(() => reading), 500);
  assertEquals(error, reason);
  assert(state.cancelled, "the stalled stream was not cancelled on abort");
});

Deno.test("readTextBounded - a failing stream rejects with its error", async () => {
  const failure = new Error("disk gone");
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure);
    },
  });
  assertEquals(await assertRejects(() => readTextBounded(stream, 10)), failure);
});

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const all: string[] = [];
  for await (const line of lines) all.push(line);
  return all;
}

Deno.test("readLines - splits lines across chunks", async () => {
  const { stream } = chunked(["one\ntw", "o\n\nthr", "ee"]);
  assertEquals(await collect(readLines(stream, 100)), [
    "one",
    "two",
    "",
    "three",
  ]);
});

Deno.test("readLines - decodes a character split across chunks", async () => {
  const bytes = encoder.encode("é\n");
  const { stream } = chunked([bytes.subarray(0, 1), bytes.subarray(1)]);
  assertEquals(await collect(readLines(stream, 100)), ["é"]);
});

Deno.test("readLines - keeps only the start of a long line", async () => {
  const { stream } = chunked(["abcdef", "ghij\nshort\n", "x".repeat(50)]);
  assertEquals(await collect(readLines(stream, 4)), ["abcd", "shor", "xxxx"]);
});

Deno.test("readLines - holds only the cap of an endless line", async () => {
  // 64 MiB of one line, delivered in 64 KiB chunks.
  const chunk = encoder.encode("x".repeat(64 * 1024));
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < 1024) controller.enqueue(chunk);
      else controller.close();
    },
  });
  assertEquals(await collect(readLines(stream, 10)), ["x".repeat(10)]);
});

Deno.test("readLines - stopping early cancels the stream", async () => {
  const { stream, state } = chunked(["a\nb\nc\n"], { stall: true });
  for await (const line of readLines(stream, 100)) {
    if (line === "b") break;
  }
  assert(state.cancelled, "the stream was not cancelled");
});

/** UTF-8 size of `text` as a JSON string, without the quotes. */
function jsonBytes(text: string): number {
  return encoder.encode(JSON.stringify(text)).byteLength - 2;
}

Deno.test("fitJsonString - keeps text that fits unchanged", () => {
  assertEquals(fitJsonString("hello", 5), { text: "hello", trimmed: false });
});

Deno.test("fitJsonString - counts escaped characters at their escaped size", () => {
  // A quote and a newline escape to 2 bytes, NUL to 6 (\u0000).
  assertEquals(fitJsonString('a"b', 3), { text: 'a"', trimmed: true });
  assertEquals(fitJsonString('a"b', 2), { text: "a", trimmed: true });
  assertEquals(fitJsonString("a\nb", 4), { text: "a\nb", trimmed: false });
  assertEquals(fitJsonString("\0\0", 11), { text: "\0", trimmed: true });
});

Deno.test("fitJsonString - never splits a surrogate pair", () => {
  // "😀" is one surrogate pair: 4 UTF-8 bytes.
  assertEquals(fitJsonString("a😀", 4), { text: "a", trimmed: true });
  assertEquals(fitJsonString("a😀", 5), { text: "a😀", trimmed: false });
});

Deno.test("fitJsonString - agrees with JSON.stringify on mixed text", () => {
  const samples = [
    'const s = "q\\"uote\\\\";\n\t',
    "\0\x01\x1f\b\f\r plain",
    "é ü ß 中文 😀 \u2028",
    "lone \ud800 and \udc00 surrogates",
  ];
  for (const sample of samples) {
    const text = sample.repeat(20);
    const full = jsonBytes(text);
    assertEquals(fitJsonString(text, full), { text, trimmed: false });
    for (const budget of [1, 7, 50, full - 1]) {
      const fitted = fitJsonString(text, budget);
      assert(fitted.trimmed);
      assert(jsonBytes(fitted.text) <= budget, `over budget at ${budget}`);
      // The cut is as late as the budget allows: one more character (or
      // surrogate pair) would exceed it.
      const rest = text.slice(fitted.text.length);
      const nextChar = String.fromCodePoint(rest.codePointAt(0)!);
      const nextUnits = /^[\ud800-\udbff][\udc00-\udfff]/.test(rest) ? 2 : 1;
      assert(
        jsonBytes(text.slice(0, fitted.text.length + nextUnits)) > budget,
        `cut early at ${budget} before ${JSON.stringify(nextChar)}`,
      );
    }
  }
});

Deno.test("withTruncationNotice - names the cap and a larger total", () => {
  assertEquals(
    withTruncationNotice("text", 512 * 1024, 3 * 1024 * 1024),
    "text\n\n…[truncated: showing the first 512 KiB of 3 MiB]",
  );
});

Deno.test("withTruncationNotice - omits an unknown or smaller total", () => {
  const expected = "text\n\n…[truncated: showing the first 1 KiB]";
  assertEquals(withTruncationNotice("text", 1024), expected);
  assertEquals(withTruncationNotice("text", 1024, 0), expected);
});

Deno.test("formatBytes - picks a readable unit", () => {
  assertEquals(formatBytes(1), "1 byte");
  assertEquals(formatBytes(512), "512 bytes");
  assertEquals(formatBytes(1536), "1.5 KiB");
  assertEquals(formatBytes(2 * 1024 * 1024), "2 MiB");
});
