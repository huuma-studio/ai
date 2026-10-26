import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { pipeline, Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { expect, test } from "vite-plus/test";
import { NodeHtmlMarkdown } from "node-html-markdown";
import {
  DEFAULT_FETCH_WEBSITE_MAX_BYTES,
  DEFAULT_FETCH_WEBSITE_TIMEOUT,
  fetchWebsite,
} from "./browser.ts";

/** Responses whose body is sent as a stream, without a Content-Length. */
const streamedResponses = new WeakSet<Response>();

/** A response sending `body` as it streams, chunked and without a
 * Content-Length; the client closing the connection cancels `body`. */
function streamed(body: ReadableStream<Uint8Array>): Response {
  const response = new Response(body);
  streamedResponses.add(response);
  return response;
}

/** Serve `handler` on a free port for the duration of `fn`.
 *
 * A response's body is sent whole with a Content-Length, as `Deno.serve`
 * sends a body of known size, unless it was created by {@linkcode streamed}. */
async function withServer(
  handler: () => Response | Promise<Response>,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const server = createServer(async (_request, res) => {
    const response = await handler();
    const headers = Object.fromEntries(response.headers);
    if (!streamedResponses.has(response) || response.body === null) {
      const body = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, {
        ...headers,
        "content-length": body.byteLength,
      });
      res.end(body);
      return;
    }
    res.writeHead(response.status, headers);
    // A connection closed early ends the pipeline, which cancels the body.
    pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), res, () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/** The error `promise` rejects with; fails the test if it resolves. */
function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => expect.fail("expected a rejection"),
    (error: unknown) => error,
  );
}

/** Waits for `promise`, failing with `message` after a deadline so a
 * regression fails the test instead of stalling the run. */
async function within(promise: Promise<unknown>, message: string, ms = 2_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** A body that streams `chunk` forever and reports when the client
 * cancels it — the server-side view of the connection closing. */
function endlessBody(chunk: string) {
  const bytes = new TextEncoder().encode(chunk);
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      resolveCancelled();
    },
  });
  return { body, cancelled };
}

test("fetchWebsite - fetches content", async () => {
  await withServer(
    () => new Response("Hello from test server"),
    async (url) => {
      expect(await fetchWebsite().call({ url })).toStrictEqual("Hello from test server");
    },
  );
});

test("fetchWebsite - handles 404", async () => {
  await withServer(
    () => new Response("Not Found", { status: 404 }),
    async (url) => {
      const error = await rejection(fetchWebsite().call({ url }));
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("404");
    },
  );
});

test("fetchWebsite - small pages convert exactly as before", async () => {
  const html =
    '<html><body><h1>Title</h1><p>Some <b>bold</b> text and a <a href="https://example.com">link</a>.</p><ul><li>one</li><li>zwei — drei</li></ul></body></html>';
  await withServer(
    () => new Response(html, { headers: { "content-type": "text/html" } }),
    async (url) => {
      expect(await fetchWebsite().call({ url })).toStrictEqual(NodeHtmlMarkdown.translate(html));
    },
  );
});

test("fetchWebsite - description promises Markdown and states the limits", () => {
  const description = fetchWebsite().description;
  expect(description).toContain("Markdown");
  expect(description).toContain("2 MiB");
  expect(description).toContain("30s");
  expect(!description.includes("raw HTML")).toBe(true);

  expect(fetchWebsite({ timeout: 5_000, maxBytes: 512 * 1024 }).description).toContain(
    "512 KiB are truncated, and the request times out after 5s",
  );
});

test("fetchWebsite - applies a default deadline that the factory can override", () => {
  expect(fetchWebsite().timeout).toStrictEqual(DEFAULT_FETCH_WEBSITE_TIMEOUT);
  expect(fetchWebsite({ timeout: 1_000 }).timeout).toStrictEqual(1_000);
});

test("fetchWebsite - rejects an invalid maxBytes", () => {
  for (const maxBytes of [0, -1, 1.5, NaN]) {
    expect(() => fetchWebsite({ maxBytes })).toThrow(TypeError);
    expect(() => fetchWebsite({ maxBytes })).toThrow("maxBytes must be a positive integer");
  }
});

test("fetchWebsite - a body above maxBytes is cut at the cap with a notice", async () => {
  const text = "a".repeat(5_000);
  await withServer(
    () => new Response(text),
    async (url) => {
      const result = await fetchWebsite({ maxBytes: 1_000 }).call({ url });
      expect(result).toStrictEqual(
        `${NodeHtmlMarkdown.translate("a".repeat(1_000))}\n\n` +
          "…[truncated: showing the first 1000 bytes of 4.9 KiB]",
      );
    },
  );
});

test("fetchWebsite - a body of exactly maxBytes is not truncated", async () => {
  await withServer(
    () => new Response("b".repeat(1_000)),
    async (url) => {
      const result = await fetchWebsite({ maxBytes: 1_000 }).call({ url });
      expect(result).toStrictEqual("b".repeat(1_000));
    },
  );
});

test("fetchWebsite - a multi-byte character split by the cap is dropped", async () => {
  // "ü" is two bytes in UTF-8; a 3-byte cap splits the second one.
  await withServer(
    () => new Response("üü"),
    async (url) => {
      const result = await fetchWebsite({ maxBytes: 3 }).call({ url });
      expect(result.startsWith("ü\n\n…[truncated"), result).toBe(true);
    },
  );
});

test("fetchWebsite - an endless body resolves at the cap and the download is cancelled", async () => {
  const { body, cancelled } = endlessBody("<p>more</p>".repeat(100));
  await withServer(
    () => streamed(body),
    async (url) => {
      const result = await fetchWebsite({ maxBytes: 64 * 1024 }).call({ url });
      expect(result).toContain("…[truncated: showing the first 64 KiB]");
      await within(cancelled, "the download was not cancelled at the cap");
    },
  );
});

test("fetchWebsite - aborting mid-download cancels the request and rejects with the reason", async () => {
  // A slow page: one small chunk every 10ms, so the tool is mid-download
  // when the caller aborts. The server notices the closed connection on
  // its next write and cancels the body.
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const chunk = new TextEncoder().encode("<p>more</p>");
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.enqueue(chunk);
      resolveStarted();
    },
    cancel() {
      resolveCancelled();
    },
  });

  await withServer(
    () => streamed(body),
    async (url) => {
      const controller = new AbortController();
      const reason = new Error("stop");
      const pending = fetchWebsite().call({ url }, { signal: controller.signal });
      await started;
      controller.abort(reason);

      const error = await rejection(pending);
      expect(error).toBe(reason);
      await within(cancelled, "the request was not cancelled on abort");
    },
  );
});

test("fetchWebsite - default maxBytes is 2 MiB", () => {
  expect(DEFAULT_FETCH_WEBSITE_MAX_BYTES).toStrictEqual(2 * 1024 * 1024);
});

test("fetchWebsite - a body that stalls exactly at the cap still resolves with a notice", async () => {
  // Exactly maxBytes, then the connection stays open with nothing more —
  // no Content-Length, so the tool cannot know whether the body continues.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("c".repeat(1_000)));
    },
  });
  await withServer(
    () => streamed(body),
    async (url) => {
      const result = fetchWebsite({ maxBytes: 1_000 }).call({ url });
      await within(result, "the read waited past the cap");
      expect(await result).toStrictEqual(
        "c".repeat(1_000) + "\n\n…[truncated: showing the first 1000 bytes]",
      );
    },
  );
});

test("fetchWebsite - the deadline stops a slow download", async () => {
  let resolveCancelled!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const chunk = new TextEncoder().encode("<p>slow</p>");
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.enqueue(chunk);
    },
    cancel() {
      resolveCancelled();
    },
  });

  await withServer(
    () => streamed(body),
    async (url) => {
      const error = await rejection(fetchWebsite({ timeout: 100 }).call({ url }));
      expect((error as DOMException).name).toStrictEqual("TimeoutError");
      await within(cancelled, "the download kept running past the deadline");
    },
  );
});

test("fetchWebsite - a body of exactly maxBytes without Content-Length is not truncated", async () => {
  // A streamed body is sent chunked, so the tool learns the size only
  // when the stream ends right after the last byte.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("d".repeat(1_000)));
      controller.close();
    },
  });
  await withServer(
    () => streamed(body),
    async (url) => {
      const result = await fetchWebsite({ maxBytes: 1_000 }).call({ url });
      expect(result).toStrictEqual("d".repeat(1_000));
    },
  );
});
