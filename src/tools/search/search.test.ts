import { expect, test } from "vite-plus/test";
import { DEFAULT_SEARCH_TIMEOUT, search } from "./search.ts";

test("search - has a 30 second default timeout", () => {
  const tool = search({ engine: "brave", apiKey: "test-key" });
  expect(tool.timeout).toBe(DEFAULT_SEARCH_TIMEOUT);
  expect(DEFAULT_SEARCH_TIMEOUT).toBe(30_000);
});

test("search - timeout is overridable at the factory", () => {
  const tool = search({ engine: "brave", apiKey: "test-key", timeout: 5_000 });
  expect(tool.timeout).toBe(5_000);
});

test("search - forwards the caller's signal to the provider fetch", async () => {
  let captured: AbortSignal | null | undefined;

  const original = globalThis.fetch;
  globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = init?.signal;
    // In flight until the combined tool signal aborts.
    return new Promise<Response>(() => {});
  };

  try {
    const tool = search({ engine: "brave", apiKey: "test-key" });
    const controller = new AbortController();
    const pending = tool.call({ query: "test" }, { signal: controller.signal });

    for (let i = 0; i < 200 && captured === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (captured == null) {
      return expect.fail("the provider fetch was never called");
    }

    controller.abort();
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect(captured.aborted, "the aborted caller signal never reached the provider fetch").toBe(
      true,
    );
  } finally {
    globalThis.fetch = original;
  }
});
