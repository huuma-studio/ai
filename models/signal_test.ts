import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import type { BaseModel, Message } from "@/model/mod.ts";
import {
  anthropic,
  google,
  mistral,
  ollama,
  openai,
  zai,
} from "./mod.ts";

/**
 * Every adapter must hand the caller's signal to the transport, so that
 * aborting a run cancels the in-flight provider request instead of
 * abandoning it. Each case stubs `fetch` with a request that only ever
 * settles by aborting — exactly like a real fetch on a stalled
 * connection — and asserts the abort reaches it.
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
 * the abort lands mid-iteration. */
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

/** Rejects if `promise` has not settled within `ms` — an adapter that
 * drops the signal leaves the stubbed request hanging forever, so the
 * test must fail rather than stall. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the abort did not reach the transport`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

for (const [name, create, modelId] of adapters) {
  for (const method of ["generate", "stream"] as const) {
    Deno.test(`${name} - ${method} forwards the signal to the transport`, async () => {
      const { fetched, restore } = stubHangingFetch();
      try {
        const model = create();
        const controller = new AbortController();

        const pending = model[method]({
          modelId,
          messages,
          signal: controller.signal,
        });
        pending.catch(() => {});
        const transportSignal = await within(fetched, 2_000);
        controller.abort(new Error("stop"));

        await within(assertRejects(() => pending), 2_000);
        assertEquals(transportSignal.aborted, true);
      } finally {
        restore();
      }
    });
  }
}

const streamContentTypes: Record<string, string> = {
  ollama: "application/x-ndjson",
};

for (const [name, create, modelId] of adapters) {
  Deno.test(`${name} - aborting a stream mid-iteration ends it with an error`, async () => {
    const restore = stubStalledStreamFetch(
      streamContentTypes[name] ?? "text/event-stream",
    );
    try {
      const controller = new AbortController();
      const stream = await within(
        create().stream({ modelId, messages, signal: controller.signal }),
        2_000,
      );

      const next = stream.next();
      next.catch(() => {});
      controller.abort(new Error("stop"));

      await within(assertRejects(() => next), 2_000);
    } finally {
      restore();
    }
  });
}

Deno.test("openai - no buffered tool call is delivered after an abort", async () => {
  // One chunk completes two tool calls, which the adapter yields back to
  // back without reading the transport again; the body then stalls.
  const chunk = {
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-5.5",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [
          { index: 0, id: "a", type: "function", function: { name: "first", arguments: "{}" } },
          { index: 1, id: "b", type: "function", function: { name: "second", arguments: "{}" } },
        ],
      },
      finish_reason: "tool_calls",
    }],
  };
  const original = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`),
        );
        signal?.addEventListener(
          "abort",
          () => controller.error(signal.reason),
          { once: true },
        );
      },
    });
    return Promise.resolve(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
  };
  try {
    const controller = new AbortController();
    const reason = new Error("stop");
    const stream = await openai({ apiKey: "test", maxRetries: 0 }).stream({
      modelId: "gpt-5.5",
      messages,
      signal: controller.signal,
    });

    const first = await within(stream.next(), 2_000);
    assertEquals(first.value?.messages[0].role, "model");
    controller.abort(reason);

    const error = await within(assertRejects(() => stream.next()), 2_000);
    assertStrictEquals(error, reason);
  } finally {
    globalThis.fetch = original;
  }
});
