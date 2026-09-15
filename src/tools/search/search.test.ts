import { assert, assertEquals, assertRejects } from "@std/assert";
import { DEFAULT_SEARCH_TIMEOUT, search } from "./search.ts";

Deno.test("search - has a 30 second default timeout", () => {
  const tool = search({ engine: "brave", apiKey: "test-key" });
  assertEquals(tool.timeout, DEFAULT_SEARCH_TIMEOUT);
  assertEquals(DEFAULT_SEARCH_TIMEOUT, 30_000);
});

Deno.test("search - timeout is overridable at the factory", () => {
  const tool = search({ engine: "brave", apiKey: "test-key", timeout: 5_000 });
  assertEquals(tool.timeout, 5_000);
});

Deno.test("search - forwards the caller's signal to the provider fetch", async () => {
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
    assert(captured != null, "the provider fetch was never called");

    controller.abort();
    await assertRejects(() => pending, DOMException);
    assertEquals(
      captured.aborted,
      true,
      "the aborted caller signal never reached the provider fetch",
    );
  } finally {
    globalThis.fetch = original;
  }
});