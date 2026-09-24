import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { NodeHtmlMarkdown } from "node-html-markdown";
import {
  DEFAULT_FETCH_WEBSITE_MAX_BYTES,
  DEFAULT_FETCH_WEBSITE_TIMEOUT,
  fetchWebsite,
} from "./browser.ts";

/** Serve `handler` on a free port for the duration of `fn`. */
async function withServer(
  handler: (request: Request) => Response | Promise<Response>,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: controller.signal, onListen: () => {} },
    handler,
  );
  try {
    await fn(`http://localhost:${server.addr.port}`);
  } finally {
    controller.abort();
    await server.finished;
  }
}

/** Waits for `promise`, failing with `message` after a deadline so a
 * regression fails the test instead of stalling the run. */
async function within(
  promise: Promise<unknown>,
  message: string,
  ms = 2_000,
): Promise<void> {
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

Deno.test("fetchWebsite - fetches content", async () => {
  await withServer(() => new Response("Hello from test server"), async (url) => {
    assertEquals(await fetchWebsite().call({ url }), "Hello from test server");
  });
});

Deno.test("fetchWebsite - handles 404", async () => {
  await withServer(
    () => new Response("Not Found", { status: 404 }),
    async (url) => {
      await assertRejects(() => fetchWebsite().call({ url }), Error, "404");
    },
  );
});

Deno.test("fetchWebsite - small pages convert exactly as before", async () => {
  const html =
    "<html><body><h1>Title</h1><p>Some <b>bold</b> text and a <a href=\"https://example.com\">link</a>.</p><ul><li>one</li><li>zwei — drei</li></ul></body></html>";
  await withServer(
    () => new Response(html, { headers: { "content-type": "text/html" } }),
    async (url) => {
      assertEquals(
        await fetchWebsite().call({ url }),
        NodeHtmlMarkdown.translate(html),
      );
    },
  );
});

Deno.test("fetchWebsite - description promises Markdown and states the limits", () => {
  const description = fetchWebsite().description;
  assertStringIncludes(description, "Markdown");
  assertStringIncludes(description, "2 MiB");
  assertStringIncludes(description, "30s");
  assert(!description.includes("raw HTML"));

  assertStringIncludes(
    fetchWebsite({ timeout: 5_000, maxBytes: 512 * 1024 }).description,
    "512 KiB are truncated, and the request times out after 5s",
  );
});

Deno.test("fetchWebsite - applies a default deadline that the factory can override", () => {
  assertEquals(fetchWebsite().timeout, DEFAULT_FETCH_WEBSITE_TIMEOUT);
  assertEquals(fetchWebsite({ timeout: 1_000 }).timeout, 1_000);
});

Deno.test("fetchWebsite - rejects an invalid maxBytes", () => {
  for (const maxBytes of [0, -1, 1.5, NaN]) {
    assertThrows(
      () => fetchWebsite({ maxBytes }),
      TypeError,
      "maxBytes must be a positive integer",
    );
  }
});

Deno.test("fetchWebsite - a body above maxBytes is cut at the cap with a notice", async () => {
  const text = "a".repeat(5_000);
  await withServer(() => new Response(text), async (url) => {
    const result = await fetchWebsite({ maxBytes: 1_000 }).call({ url });
    assertEquals(
      result,
      `${NodeHtmlMarkdown.translate("a".repeat(1_000))}\n\n` +
        "…[truncated: showing the first 1000 bytes of 4.9 KiB]",
    );
  });
});

Deno.test("fetchWebsite - a body of exactly maxBytes is not truncated", async () => {
  await withServer(() => new Response("b".repeat(1_000)), async (url) => {
    const result = await fetchWebsite({ maxBytes: 1_000 }).call({ url });
    assertEquals(result, "b".repeat(1_000));
  });
});

Deno.test("fetchWebsite - a multi-byte character split by the cap is dropped", async () => {
  // "ü" is two bytes in UTF-8; a 3-byte cap splits the second one.
  await withServer(() => new Response("üü"), async (url) => {
    const result = await fetchWebsite({ maxBytes: 3 }).call({ url });
    assert(result.startsWith("ü\n\n…[truncated"), result);
  });
});

Deno.test("fetchWebsite - an endless body resolves at the cap and the download is cancelled", async () => {
  const { body, cancelled } = endlessBody("<p>more</p>".repeat(100));
  await withServer(() => new Response(body), async (url) => {
    const result = await fetchWebsite({ maxBytes: 64 * 1024 }).call({ url });
    assertStringIncludes(result, "…[truncated: showing the first 64 KiB]");
    await within(cancelled, "the download was not cancelled at the cap");
  });
});

Deno.test("fetchWebsite - aborting mid-download cancels the request and rejects with the reason", async () => {
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

  await withServer(() => new Response(body), async (url) => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const pending = fetchWebsite().call({ url }, { signal: controller.signal });
    await started;
    controller.abort(reason);

    const error = await assertRejects(() => pending);
    assertStrictEquals(error, reason);
    await within(cancelled, "the request was not cancelled on abort");
  });
});

Deno.test("fetchWebsite - default maxBytes is 2 MiB", () => {
  assertEquals(DEFAULT_FETCH_WEBSITE_MAX_BYTES, 2 * 1024 * 1024);
});
