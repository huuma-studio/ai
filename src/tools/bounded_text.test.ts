import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  formatBytes,
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

Deno.test("readTextBounded - a failing stream rejects with its error", async () => {
  const failure = new Error("disk gone");
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure);
    },
  });
  assertEquals(await assertRejects(() => readTextBounded(stream, 10)), failure);
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
  assertEquals(formatBytes(512), "512 bytes");
  assertEquals(formatBytes(1536), "1.5 KiB");
  assertEquals(formatBytes(2 * 1024 * 1024), "2 MiB");
});
