import { assertEquals, assertRejects } from "@std/assert";
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
