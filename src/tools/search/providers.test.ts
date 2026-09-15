import { assertEquals, assertRejects } from "@std/assert";
import { BraveSearchProvider } from "./brave.ts";
import { OllamaSearchProvider } from "./ollama.ts";
import { PerplexitySearchProvider } from "./perplexity.ts";
import type { SearchProvider } from "./types.ts";

/**
 * Shared cancellation contract for all search providers: the caller's
 * AbortSignal must reach `fetch` (an aborted run cancels the in-flight
 * request) and non-OK responses must have their bodies cancelled before
 * throwing (an unconsumed body pins the connection until finalized).
 *
 * Note: this runtime no longer exposes Deno.resources(), so the leak
 * assertion uses a tracked body stream whose cancel callback fires only
 * when the provider explicitly cancels the response body.
 */
const providers: [string, () => SearchProvider][] = [
  ["BraveSearchProvider", () => new BraveSearchProvider("test-key")],
  ["PerplexitySearchProvider", () => new PerplexitySearchProvider("test-key")],
  ["OllamaSearchProvider", () => new OllamaSearchProvider("test-key")],
];

function okResponse(): Response {
  return new Response(JSON.stringify({ results: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Swap in a fetch stub and restore the original on cleanup. */
async function withFetchStub(
  stub: typeof globalThis.fetch,
  run: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

/** Resolve once the condition holds; reject with `message` after `timeoutMs`. */
function pollUntil(
  condition: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(message));
      setTimeout(tick, 20);
    };
    tick();
  });
}

for (const [name, make] of providers) {
  Deno.test(`${name} - forwards the cancellation signal to fetch`, async () => {
    let received: AbortSignal | null | undefined;

    await withFetchStub(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        received = init?.signal;
        return Promise.resolve(okResponse());
      },
      async () => {
        const provider = make();
        const controller = new AbortController();
        await provider.search("test", { signal: controller.signal });
        assertEquals(
          received,
          controller.signal,
          "the provider did not pass the caller's signal to fetch",
        );
      },
    );
  });

  Deno.test(`${name} - aborting the signal cancels the in-flight request`, async () => {
    let handled = false;
    let clientGone = false;

    // Hangs until the client disconnects; the timer is a fallback so a
    // provider that ignores the signal still cannot wedge the test.
    const server = Deno.serve({ port: 0, onListen: () => {} }, (request) => {
      handled = true;
      return new Promise<Response>((resolve) => {
        const fallback = setTimeout(
          () => resolve(new Response("late", { status: 500 })),
          3_000,
        );
        request.signal.addEventListener("abort", () => {
          clearTimeout(fallback);
          clientGone = true;
          resolve(new Response("gone", { status: 499 }));
        });
      });
    });
    const port = server.addr.port;

    // Redirect provider traffic to the local server; init (including the
    // provider-supplied signal) passes through untouched.
    const original = globalThis.fetch;
    globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
      original(`http://127.0.0.1:${port}/`, init);

    try {
      const provider = make();
      const controller = new AbortController();
      const pending = provider.search("test", { signal: controller.signal });

      await pollUntil(
        () => handled,
        "the request never reached the test server",
      );
      controller.abort();

      await assertRejects(() => pending, DOMException);
      await pollUntil(
        () => clientGone,
        "the test server never observed the connection close",
      );
    } finally {
      globalThis.fetch = original;
      await server.shutdown();
    }
  });

  Deno.test(`${name} - cancels the response body before throwing on a non-OK status`, async () => {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("error body"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, {
      status: 502,
      statusText: "Bad Gateway",
    });

    await withFetchStub(
      () => Promise.resolve(response),
      async () => {
        const provider = make();
        await assertRejects(
          () => provider.search("test"),
          Error,
          "Search failed: 502",
        );
        assertEquals(
          cancelled,
          true,
          "the provider threw without cancelling the error response body",
        );
      },
    );
  });
}