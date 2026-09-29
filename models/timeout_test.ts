import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
import type { BaseModel, Message } from "@/model/mod.ts";
import { anthropic, google, mistral, ollama, openai, zai } from "./mod.ts";

/**
 * A deadline must reject a model call that never responds within bounds
 * and cancel it at the transport — the same contract signal_test.ts
 * requires for caller signals. Each case stubs `fetch` with a request
 * that only ever settles by aborting, exactly like a real fetch on a
 * stalled connection, and asserts the deadline fires and the abort
 * reaches the transport.
 */
const adapters: [string, () => BaseModel<string>, string][] = [
  ["openai", () => openai({ apiKey: "test", maxRetries: 0 }), "gpt-5.5"],
  ["zai", () => zai({ apiKey: "test" }), "glm-5.3"],
  [
    "anthropic",
    () => anthropic({ apiKey: "test", maxRetries: 0 }),
    "claude-opus-4-7",
  ],
  ["mistral", () => mistral({ apiKey: "test" }), "mistral-large-latest"],
  ["google", () => google({ apiKey: "test" }), "gemini-3-pro-preview"],
  ["ollama", () => ollama({ host: "http://localhost:11434" }), "llama3"],
];

const messages: Message[] = [{ role: "user", contents: "Hi" }];

/** Replaces `fetch` with a request that hangs until its signal aborts,
 * resolving `fetched` with the transport-level signal once called. */
function stubHangingFetch(): {
  fetched: Promise<AbortSignal>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  let resolveFetched!: (signal: AbortSignal) => void;
  const fetched = new Promise<AbortSignal>((resolve) => {
    resolveFetched = resolve;
  });
  globalThis.fetch = (input, init) => {
    const signal = init?.signal ??
      (input instanceof Request ? input.signal : undefined);
    if (!signal) {
      return Promise.reject(new Error("request carries no signal"));
    }
    resolveFetched(signal);
    return new Promise<Response>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  };
  return { fetched, restore: () => globalThis.fetch = original };
}

/** Replaces `fetch` with a streaming response whose headers arrive at
 * once but whose body stalls until the signal aborts — then errors with
 * the abort reason, as a real fetch body does. `stream()` resolves, so
 * the deadline lands mid-iteration. */
function stubStalledStreamFetch(contentType: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const signal = init?.signal ??
      (input instanceof Request ? input.signal : undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => controller.error(signal.reason),
          { once: true },
        );
      },
    });
    return Promise.resolve(
      new Response(body, { headers: { "content-type": contentType } }),
    );
  };
  return () => globalThis.fetch = original;
}

/** Rejects if `promise` has not settled within `ms` — a deadline that
 * never fires leaves the stubbed request hanging forever, so the test
 * must fail rather than stall. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the deadline did not reach the transport`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const streamContentTypes: Record<string, string> = {
  ollama: "application/x-ndjson",
};

for (const [name, create, modelId] of adapters) {
  for (const method of ["generate", "stream"] as const) {
    Deno.test(`${name} - ${method} rejects in bounded time when its deadline expires`, async () => {
      const { fetched, restore } = stubHangingFetch();
      try {
        const pending = create()[method]({ modelId, messages, timeout: 50 });
        pending.catch(() => {});
        const transportSignal = await within(fetched, 2_000);

        await within(assertRejects(() => pending), 2_000);
        assertEquals(transportSignal.aborted, true);
      } finally {
        restore();
      }
    });
  }
}

for (const [name, create, modelId] of adapters) {
  Deno.test(`${name} - a stream deadline ends a body that stalls mid-iteration`, async () => {
    const restore = stubStalledStreamFetch(
      streamContentTypes[name] ?? "text/event-stream",
    );
    try {
      const stream = await within(
        create().stream({ modelId, messages, timeout: 50 }),
        2_000,
      );

      const next = stream.next();
      await within(assertRejects(() => next), 2_000);
    } finally {
      restore();
    }
  });
}

// --- deadline reasons reaching the consumer ---

/**
 * The SDK-translated error types vary by provider, so the general cases
 * above assert only the bounded rejection and the transport abort. The
 * Ollama transport is abort-faithful (the adapter owns its fetch), so its
 * tests additionally pin that the deadline's reason reaches the caller.
 */
Deno.test("ollama - the deadline rejects generate with its TimeoutError reason", async () => {
  const { fetched, restore } = stubHangingFetch();
  try {
    const pending = ollama().generate({
      modelId: "llama3",
      messages,
      timeout: 50,
    });
    pending.catch(() => {});
    const transportSignal = await within(fetched, 2_000);

    const error = await within(assertRejects(() => pending), 2_000);
    assertInstanceOf(error, DOMException);
    assertEquals(error.name, "TimeoutError");
    assertEquals(error.message, "The operation was aborted due to timeout");
    assertEquals(transportSignal.aborted, true);
  } finally {
    restore();
  }
});

Deno.test("ollama - the deadline ends a stalled stream with its TimeoutError reason", async () => {
  const restore = stubStalledStreamFetch("application/x-ndjson");
  try {
    const stream = await within(
      ollama().stream({ modelId: "llama3", messages, timeout: 50 }),
      2_000,
    );

    const error = await within(
      assertRejects(() => stream.next()),
      2_000,
    );
    assertInstanceOf(error, DOMException);
    assertEquals(error.name, "TimeoutError");
    assertEquals(error.message, "The operation was aborted due to timeout");
  } finally {
    restore();
  }
});

Deno.test("ollama - a timeout of 0 rejects with the instant-timeout reason", async () => {
  const { restore } = stubHangingFetch();
  try {
    const error = await within(
      assertRejects(() =>
        ollama().generate({ modelId: "llama3", messages, timeout: 0 })
      ),
      2_000,
    );
    assertInstanceOf(error, DOMException);
    assertEquals(error.name, "TimeoutError");
    assertEquals(error.message, "The model call timed out");
  } finally {
    restore();
  }
});

Deno.test("ollama - invalid timeouts reject with TypeError", async () => {
  const model = ollama();
  await assertRejects(
    () => model.generate({ modelId: "llama3", messages, timeout: -1 }),
    TypeError,
    "Model timeout must be a finite, non-negative number",
  );
  await assertRejects(
    () => model.stream({ modelId: "llama3", messages, timeout: NaN }),
    TypeError,
    "Model timeout must be a finite, non-negative number",
  );
});

Deno.test("ollama - a deadline longer than the response leaves a responding call untouched", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          model: "llama3",
          message: { role: "assistant", content: "Hello" },
          done: true,
          prompt_eval_count: 3,
          eval_count: 5,
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      ),
    );
  try {
    const result = await within(
      ollama().generate({ modelId: "llama3", messages, timeout: 10_000 }),
      2_000,
    );
    assertEquals(result.modelId, "llama3");
    assertEquals(result.usage?.totalTokens, 8);
  } finally {
    globalThis.fetch = original;
  }
});
