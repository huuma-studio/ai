import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vite-plus/test";
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
 * Note: the runtime exposes no open-resource table, so the leak
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
function pollUntil(condition: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
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
  test(`${name} - forwards the cancellation signal to fetch`, async () => {
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
        expect(received, "the provider did not pass the caller's signal to fetch").toBe(
          controller.signal,
        );
      },
    );
  });

  test(`${name} - aborting the signal cancels the in-flight request`, async () => {
    let handled = false;
    let clientGone = false;

    // Hangs until the client disconnects; the timer is a fallback so a
    // provider that ignores the signal still cannot wedge the test.
    const server = createServer((_request, response) => {
      handled = true;
      const fallback = setTimeout(() => {
        response.writeHead(500).end("late");
      }, 3_000);
      response.on("close", () => {
        clearTimeout(fallback);
        if (!response.writableFinished) clientGone = true;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;

    // Redirect provider traffic to the local server; init (including the
    // provider-supplied signal) passes through untouched.
    const original = globalThis.fetch;
    globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
      original(`http://127.0.0.1:${port}/`, init);

    try {
      const provider = make();
      const controller = new AbortController();
      const pending = provider.search("test", { signal: controller.signal });

      await pollUntil(() => handled, "the request never reached the test server");
      controller.abort();

      const error = await pending.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DOMException);
      await pollUntil(() => clientGone, "the test server never observed the connection close");
    } finally {
      globalThis.fetch = original;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test(`${name} - cancels the response body before throwing on a non-OK status`, async () => {
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
        const error = await provider.search("test").then(
          () => expect.fail("expected the search to reject"),
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("Search failed: 502");
        expect(cancelled, "the provider threw without cancelling the error response body").toBe(
          true,
        );
      },
    );
  });
}
