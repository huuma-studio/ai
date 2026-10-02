import {
  assert,
  assertEquals,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { agent, type BaseModel, type Message } from "@/agent/mod.ts";
import type { ModelResult, ModelUsage } from "@/agent/mod.ts";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError as OpenAIAPIError,
  APIUserAbortError as OpenAIAPIUserAbortError,
} from "openai";
import { APIError as AnthropicAPIError } from "@anthropic-ai/sdk";
import { MistralError, SDKError } from "@mistralai/mistralai/models/errors";
import { openai, type OpenAIModels } from "../../models/openai/mod.ts";
import {
  backoffDelayMs,
  classifyModelError,
  DEFAULT_RETRIES,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_CAP_DELAY_MS,
  type ModelErrorClass,
  type RetryDeps,
  retryAfterHintMs,
  type WithRetriesOptions,
  withRetries,
} from "@/model/retry.ts";

/** Epoch milliseconds a fake `now` returns, aligned to whole seconds so
 * an HTTP-date hint parses back to an exact delta. */
const NOW = 1_000_000;

const RATE_LIMITED = new Error("Request was rate limited");

function statusError(status: number): Error {
  return Object.assign(new Error("Provider rejected the request"), {
    name: "APIError",
    status,
  });
}

function assertClass(
  error: unknown,
  expected: ModelErrorClass,
  message?: string,
): void {
  assertEquals(classifyModelError(error), expected, message);
}

function assertTransient(error: unknown, message?: string): void {
  assertClass(error, "transient", message);
}

function assertPermanent(error: unknown, message?: string): void {
  assertClass(error, "permanent", message);
}

function mistralMeta(response: Response): {
  response: Response;
  request: Request;
  body: string;
} {
  return {
    response,
    request: new Request("https://api.mistral.ai/v1/chat/completions"),
    body: "",
  };
}

Deno.test("retry - classifies transient HTTP statuses", () => {
  for (const status of [408, 409, 429, 500, 502, 503, 504, 529, 599]) {
    assertTransient(statusError(status), `status ${status}`);
  }
});

Deno.test("retry - classifies other 4xx statuses as permanent", () => {
  for (const status of [400, 401, 403, 404, 411, 421, 422, 498, 499]) {
    assertPermanent(statusError(status), `status ${status}`);
  }
});

Deno.test("retry - falls through non-error statuses to the default", () => {
  // A status outside 4xx/5xx is not an HTTP failure shape; the message
  // heuristics and the unknown-transient default decide.
  assertTransient(statusError(100));
  assertTransient(statusError(200));
  assertTransient(statusError(302));
});

Deno.test("retry - classifies real SDK error shapes", () => {
  // OpenAI SDK: APIError carries a numeric `status`.
  assertTransient(
    new OpenAIAPIError(
      429,
      { message: "Rate limited" },
      "Rate limited",
      undefined,
    ),
  );
  assertPermanent(
    new OpenAIAPIError(401, { message: "Bad key" }, "Bad key", undefined),
  );
  // The SDK's connection failures carry no status at all.
  assertTransient(new APIConnectionTimeoutError({}), "Request timed out.");
  assertTransient(new APIConnectionError({}), "'Connection error.' is unknown");
  assertPermanent(new OpenAIAPIUserAbortError(), "user cancellation");

  // Anthropic SDK: the same APIError shape.
  assertTransient(
    new AnthropicAPIError(
      429,
      { type: "rate_limit_error" },
      "Too many requests",
      undefined,
      "rate_limit_error",
    ),
  );
  assertPermanent(
    new AnthropicAPIError(
      400,
      { type: "invalid_request_error" },
      "invalid request",
      undefined,
      "invalid_request_error",
    ),
  );

  // Mistral SDK: `statusCode` plus the response's own headers.
  assertTransient(
    new SDKError("Too many requests", mistralMeta(new Response(null, { status: 429 }))),
  );
  assertPermanent(
    new SDKError("Bad request", mistralMeta(new Response(null, { status: 400 }))),
  );
  assertPermanent(
    new MistralError("Bad request", mistralMeta(new Response(null, { status: 401 }))),
  );

  // Ollama SDK: `status_code` in snake case.
  assertTransient(
    Object.assign(new Error("Error 429: Too Many Requests"), {
      name: "ResponseError",
      status_code: 429,
    }),
  );
  assertPermanent(
    Object.assign(new Error("Error 404: Not Found"), {
      name: "ResponseError",
      status_code: 404,
    }),
  );

  // Google SDK: `status` on ApiError, message without HTTP words.
  assertTransient(
    Object.assign(new Error("got status: UNAVAILABLE. {…}"), {
      name: "ApiError",
      status: 503,
    }),
  );
  assertPermanent(
    Object.assign(new Error("got status: PERMISSION_DENIED. {…}"), {
      name: "ApiError",
      status: 403,
    }),
  );
});

Deno.test("retry - message heuristics mirror the CLI classification", () => {
  // Transient: timeout / connection reset / fetch failed / overloaded.
  assertTransient(new Error("Request timed out."));
  assertTransient(new TypeError("fetch failed"));
  assertTransient(new Error("Connection reset by peer"));
  assertTransient(new Error("Service overloaded, try again later"));
  assertTransient(new Error("rate limit exceeded for the workspace"));
  assertTransient(new Error("Timed out while streaming the response"));

  // Permanent: auth / invalid-api-key / invalid-request.
  assertPermanent(new Error("unauthorized: no token was supplied"));
  assertPermanent(new TypeError("Authentication failed for the API key"));
  assertPermanent(new Error("invalid_api_key: the key is malformed"));
  assertPermanent(new Error("invalid request: tool choice unknown"));
  assertPermanent(new Error("Invalid-API-Key rejected by the provider"));

  // Unknown errors lean toward retrying.
  assertTransient(new RangeError("model returned no choices"));
  assertTransient(new Error("Provider hiccup"));
  assertTransient({});
});

Deno.test("retry - cancellation and deadlines are never retried", () => {
  assertPermanent(new DOMException("The signal has been aborted", "AbortError"));
  assertPermanent(new DOMException("The model call timed out", "TimeoutError"));
  assertPermanent(Object.assign(new Error("Aborted"), { name: "AbortError" }));
  assertPermanent(new Error("The request was aborted."));
});

Deno.test("retry - reads a Retry-After hint from headers and fields", () => {
  assertEquals(
    retryAfterHintMs({
      status: 429,
      headers: new Headers({ "Retry-After": "2" }),
    }),
    2000,
  );
  assertEquals(
    retryAfterHintMs({ status: 503, headers: { "retry-after": "2.5" } }),
    2500,
  );
  assertEquals(
    retryAfterHintMs({ status: 429, headers: { "Retry-After": "2" } }),
    2000,
  );
  assertEquals(retryAfterHintMs({ retryAfter: 3 }), 3000);
  assertEquals(retryAfterHintMs({ retryAfter: "3" }), 3000);
  assertEquals(retryAfterHintMs({ retryAfterMs: 750 }), 750);
  assertEquals(retryAfterHintMs(RATE_LIMITED), undefined);
  assertEquals(retryAfterHintMs({ headers: { other: "1" } }), undefined);
  assertEquals(retryAfterHintMs({ retryAfter: "soon" }), undefined);
});

Deno.test("retry - reads an HTTP-date retry-after hint relative to now", () => {
  const hint = new Date(NOW + 5_000).toUTCString();
  assertEquals(
    retryAfterHintMs({ headers: { "retry-after": hint } }, () => NOW),
    5000,
  );
  // A past date waits nothing; the loop still honors the backoff minimum.
  assertEquals(
    retryAfterHintMs(
      { headers: { "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" } },
      () => NOW,
    ),
    0,
  );
  // Hints are truncated at the maximum so a broken endpoint cannot
  // stall a run indefinitely.
  assertEquals(retryAfterHintMs({ retryAfter: 3600 }, () => NOW), 60_000);
  assertEquals(retryAfterHintMs({ retryAfter: -5 }, () => NOW), 0);
});

Deno.test("retry - backoff doubles per attempt within the cap and jitter", () => {
  const base = { baseDelayMs: 250, capDelayMs: 5000, random: () => 0 };
  // random() of 0 yields the lower jitter bound: factor 0.5.
  assertEquals(backoffDelayMs({ ...base, attempt: 0 }), 125);
  assertEquals(backoffDelayMs({ ...base, attempt: 1 }), 250);
  assertEquals(backoffDelayMs({ ...base, attempt: 2 }), 500);
  assertEquals(backoffDelayMs({ ...base, attempt: 3 }), 1000);
  assertEquals(backoffDelayMs({ ...base, attempt: 4 }), 2000);
  // 8,000 ms unjittered is above the cap; the cap is used instead.
  assertEquals(backoffDelayMs({ ...base, attempt: 5 }), 2500);
  assertEquals(backoffDelayMs({ ...base, attempt: 20 }), 2500);

  // random() close to 1 yields nearly the full delay.
  const upper = { ...base, random: () => 0.99 };
  assertEquals(backoffDelayMs({ ...upper, attempt: 0 }), 250 * (0.5 + 0.5 * 0.99));
});

Deno.test("retry - the Retry-After hint is a floor under the backoff", () => {
  const base = { baseDelayMs: 250, capDelayMs: 5000, random: () => 0 };
  assertEquals(backoffDelayMs({ ...base, attempt: 0, retryAfterHintMs: 900 }), 900);
  assertEquals(
    backoffDelayMs({ ...base, attempt: 4, retryAfterHintMs: 2000 }),
    2000,
  );
  assertEquals(backoffDelayMs({ ...base, attempt: 0, retryAfterHintMs: 0 }), 125);
});

/** Scripted `generate` outcome: a rejected result or an error. */
type GenerateScript = ModelResult<string> | { error: unknown };

/** A connect outcome for `stream`: a rejected promise or an acquired
 * generator. */
type StreamScript =
  | { error: unknown }
  | { stream: AsyncGenerator<ModelResult> };

/** A step of a scripted stream: a chunk result, or an error thrown at
 * its position — a leading error fails the very first `next()` before
 * any chunk is forwarded. */
type StreamStep = ModelResult | { error: unknown };

/** Builds a stream source for a script: steps run in sequence. */
function streamFromActions(
  steps: StreamStep[],
  onClose?: () => void,
): AsyncGenerator<ModelResult> {
  async function* source(): AsyncGenerator<ModelResult> {
    try {
      for (const step of steps) {
        if ("error" in step) {
          throw step.error;
        }
        yield step;
      }
    } finally {
      onClose?.();
    }
  }
  return source();
}

/** Scripted adapter: each `generate`/`stream` call consumes the next
 * scripted outcome and rejects when none is left. */
class FakeModel implements BaseModel<string> {
  generateCalls: unknown[] = [];
  streamCalls: unknown[] = [];
  readonly #generateScripts: GenerateScript[];
  readonly #streamScripts: StreamScript[];

  constructor(
    { generate = [], stream = [] }: {
      generate?: GenerateScript[];
      stream?: StreamScript[];
    } = {},
  ) {
    this.#generateScripts = [...generate];
    this.#streamScripts = [...stream];
  }

  generate(args: unknown): Promise<ModelResult<string>> {
    this.generateCalls.push(args);
    const script = this.#generateScripts.shift();
    if (script === undefined) {
      return Promise.reject(new Error("Generate script exhausted"));
    }
    if ("error" in script) {
      return Promise.reject(script.error);
    }
    return Promise.resolve(script);
  }

  stream(args: unknown): Promise<AsyncGenerator<ModelResult>> {
    this.streamCalls.push(args);
    const script = this.#streamScripts.shift();
    if (script === undefined) {
      return Promise.reject(new Error("Stream script exhausted"));
    }
    if ("error" in script) {
      // A rejected stream promise — the adapters' connection-failure
      // shape — rather than a failing generator.
      return Promise.reject(script.error);
    }
    return Promise.resolve(script.stream);
  }
}

function modelMessage(text: string): Message {
  return { role: "model", contents: [{ text }], toolCalls: [] };
}

function result(text: string): ModelResult<string> {
  return { modelId: "stub", messages: [modelMessage(text)] };
}

function chunk(text: string): ModelResult {
  return { modelId: "stub", messages: [modelMessage(text)] };
}

/** The usage-only final chunk of a successful stream — no messages, the
 * whole call's usage. */
function usageChunk(usage: ModelUsage): ModelResult {
  return { modelId: "stub", messages: [], usage };
}

/** Deterministic injected deps: factor 0.875 jitter, so attempt 0 sleeps
 * 218.75 ms with the default base of 250. */
function recorder(): { deps: RetryDeps; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    deps: {
      now: () => NOW,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.75,
    },
    sleeps,
  };
}

function rateLimited(): Error {
  return Object.assign(new Error("Too many requests"), { status: 429 });
}

async function collect(stream: AsyncGenerator<ModelResult>): Promise<{
  parts: ModelResult[];
  error?: unknown;
}> {
  const parts: ModelResult[] = [];
  try {
    for await (const part of stream) {
      parts.push(part);
    }
    return { parts };
  } catch (error) {
    return { parts, error };
  }
}

Deno.test("retry - generate retries a transient failure and returns the result", async () => {
  const expected = result("Hello!");
  const args = { prompt: "hi" };
  const model = new FakeModel({
    generate: [{ error: RATE_LIMITED }, expected],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { deps });

  const outcome = await wrapped.generate(args);

  assertStrictEquals(outcome, expected);
  assertEquals(model.generateCalls, [args, args]);
  assertEquals(sleeps, [218.75]);
});

Deno.test("retry - absent options default to two retries", async () => {
  const model = new FakeModel({
    generate: [
      { error: rateLimited() },
      { error: rateLimited() },
      result("Done"),
    ],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { deps });

  await wrapped.generate({});

  assertEquals(DEFAULT_RETRIES, 2);
  assertEquals(DEFAULT_RETRY_BASE_DELAY_MS, 250);
  assertEquals(DEFAULT_RETRY_CAP_DELAY_MS, 5000);
  assertEquals(model.generateCalls.length, 3);
  assertEquals(sleeps, [218.75, 437.5]);
});

Deno.test("retry - exhausted retries rethrow the last error unchanged", async () => {
  const earlier = rateLimited();
  const middle = rateLimited();
  const failure = rateLimited();
  const model = new FakeModel({
    generate: [{ error: earlier }, { error: middle }, { error: failure }],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { retries: 2, deps });

  const error = await wrapped.generate({}).catch((error) => error);

  assertStrictEquals(error, failure);
  assertEquals(model.generateCalls.length, 3);
  assertEquals(sleeps, [218.75, 437.5]);
});

Deno.test("retry - retries zero disables retrying", async () => {
  const failure = rateLimited();
  const model = new FakeModel({ generate: [{ error: failure }] });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { retries: 0, deps });

  const error = await wrapped.generate({}).catch((error) => error);

  assertStrictEquals(error, failure);
  assertEquals(model.generateCalls.length, 1);
  assertEquals(sleeps, []);
});

Deno.test("retry - permanent errors short-circuit with the original error", async () => {
  const failure = statusError(401);
  const model = new FakeModel({ generate: [{ error: failure }] });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { retries: 2, deps });

  const error = await wrapped.generate({}).catch((error) => error);

  assertStrictEquals(error, failure);
  assertEquals(model.generateCalls.length, 1);
  assertEquals(sleeps, []);
});

Deno.test("retry - shouldRetry replaces the classification entirely", async () => {
  // The built-in verdict for a 401 is permanent; the hook decides
  // otherwise, proving it fully replaces the classification.
  const permanentFailure = statusError(401);
  const expected = result("Done");
  const seen: [unknown, number][] = [];
  const model = new FakeModel({
    generate: [{ error: permanentFailure }, expected],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, {
    retries: 3,
    shouldRetry: (error, attempt) => {
      seen.push([error, attempt]);
      return attempt === 0;
    },
    deps,
  });

  const outcome = await wrapped.generate({});

  assertStrictEquals(outcome, expected);
  assertEquals(model.generateCalls.length, 2);
  assertEquals(sleeps, [218.75]);
  // The hook sees the failure with its zero-based attempt index.
  assertEquals(seen, [[permanentFailure, 0]]);
});

Deno.test("retry - shouldRetry returning false keeps transient errors untried", async () => {
  const failure = rateLimited();
  const model = new FakeModel({
    generate: [{ error: failure }, result("Done")],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, {
    retries: 3,
    shouldRetry: () => false,
    deps,
  });

  const error = await wrapped.generate({}).catch((error) => error);

  assertStrictEquals(error, failure);
  assertEquals(model.generateCalls.length, 1);
  assertEquals(sleeps, []);
});

Deno.test("retry - the hook is not consulted past the retry budget", async () => {
  const first = rateLimited();
  const failure = statusError(500);
  const seen: [unknown, number][] = [];
  const model = new FakeModel({
    generate: [{ error: first }, { error: failure }],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, {
    retries: 1,
    shouldRetry: (error, attempt) => {
      seen.push([error, attempt]);
      return true;
    },
    deps,
  });

  const error = await wrapped.generate({}).catch((error) => error);

  assertStrictEquals(error, failure);
  assertEquals(model.generateCalls.length, 2);
  assertEquals(sleeps, [218.75]);
  assertEquals(seen, [[first, 0]]);
});

const NOT_A_FUNCTION = 42;

Deno.test("retry - invalid options throw TypeError", () => {
  for (const retries of [-1, 1.5, Infinity, NaN]) {
    assertThrows(
      () => withRetries(new FakeModel(), { retries }),
      TypeError,
      "Retries must be a non-negative integer",
    );
  }
  for (const delay of [-1, -0.5, NaN, Infinity]) {
    assertThrows(
      () => withRetries(new FakeModel(), { baseDelayMs: delay }),
      TypeError,
      "The retry base delay must be a finite, non-negative number",
    );
    assertThrows(
      () => withRetries(new FakeModel(), { capDelayMs: delay }),
      TypeError,
      "The retry cap delay must be a finite, non-negative number",
    );
  }
  const notHook = NOT_A_FUNCTION as unknown as NonNullable<
    WithRetriesOptions["shouldRetry"]
  >;
  assertThrows(
    () => withRetries(new FakeModel(), { shouldRetry: notHook }),
    TypeError,
    "shouldRetry must be a function",
  );
  const notNow = NOT_A_FUNCTION as unknown as RetryDeps["now"];
  const notSleep = NOT_A_FUNCTION as unknown as RetryDeps["sleep"];
  const notRandom = NOT_A_FUNCTION as unknown as RetryDeps["random"];
  assertThrows(
    () => withRetries(new FakeModel(), { deps: { now: notNow } }),
    TypeError,
    "deps.now must be a function",
  );
  assertThrows(
    () => withRetries(new FakeModel(), { deps: { sleep: notSleep } }),
    TypeError,
    "deps.sleep must be a function",
  );
  assertThrows(
    () => withRetries(new FakeModel(), { deps: { random: notRandom } }),
    TypeError,
    "deps.random must be a function",
  );
});

Deno.test("retry - an error's Retry-After hint is honored as the minimum", async () => {
  const hint = { status: 429, headers: new Headers({ "Retry-After": "2" }) };
  const model = new FakeModel({
    generate: [{ error: hint }, result("Done")],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { baseDelayMs: 100, deps });

  await wrapped.generate({});

  assertEquals(sleeps, [2000]);
});

Deno.test("retry - an agent runs unchanged against a wrapped model", async () => {
  const model = new FakeModel({
    generate: [{ error: rateLimited() }, result("Hello!")],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { deps });

  const assistant = agent({
    model: wrapped,
    modelId: "stub",
    systemPrompt: "Be helpful.",
  });
  const messages = await assistant.run("Hi");

  assertEquals(messages, [
    { role: "user", contents: "Hi" },
    modelMessage("Hello!"),
  ]);
  assertEquals(model.generateCalls.length, 2);
  assertEquals(sleeps, [218.75]);
});

Deno.test("retry - the decorator preserves the wrapped model's typing", () => {
  // Compile-time: the wrapped model keeps its model-id typing.
  const model: BaseModel<OpenAIModels> = openai({ apiKey: "sk-test" });
  const wrapped: BaseModel<OpenAIModels> = withRetries(model, { retries: 0 });
  assert(wrapped);
  assert(model);
});

Deno.test("retry - a usage-only chunk is forwarded unchanged", async () => {
  const usage = usageChunk({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
  const model = new FakeModel({
    stream: [{ stream: streamFromActions([chunk("a"), usage]) }],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { deps });

  const stream = await wrapped.stream({});
  const { parts, error } = await collect(stream);

  assertEquals(error, undefined);
  assertEquals(parts, [chunk("a"), usage]);
  assertEquals(model.streamCalls.length, 1);
  assertEquals(sleeps, []);
});

Deno.test("retry - a stream connection failure is retried with backoff", async () => {
  const args = { prompt: "hi" };
  const usage = usageChunk({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
  const model = new FakeModel({
    stream: [
      { error: rateLimited() },
      { stream: streamFromActions([chunk("a"), usage]) },
    ],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { deps });

  const stream = await wrapped.stream(args);
  const { parts, error } = await collect(stream);

  assertEquals(error, undefined);
  // The retried stream's chunks — including the usage-only final chunk —
  // are yielded exactly once.
  assertEquals(parts, [chunk("a"), usage]);
  assertEquals(model.streamCalls, [args, args]);
  assertEquals(sleeps, [218.75]);
});

Deno.test("retry - a pre-first-chunk failure replays without partial output", async () => {
  const args = { prompt: "hi" };
  const model = new FakeModel({
    stream: [
      { stream: streamFromActions([{ error: rateLimited() }]) },
      { stream: streamFromActions([chunk("a"), chunk("b")]) },
    ],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { deps });

  const stream = await wrapped.stream(args);
  const { parts, error } = await collect(stream);

  assertEquals(error, undefined);
  // Nothing from the failed source reached the consumer; the replay is
  // the only output.
  assertEquals(parts, [chunk("a"), chunk("b")]);
  assertEquals(model.streamCalls, [args, args]);
  assertEquals(sleeps, [218.75]);
});

Deno.test("retry - a failure after the first chunk propagates untouched", async () => {
  const args = { prompt: "hi" };
  const failure = rateLimited();
  const model = new FakeModel({
    stream: [
      {
        stream: streamFromActions([chunk("a"), { error: failure }]),
      },
      { stream: streamFromActions([chunk("b")]) },
    ],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { deps });

  const stream = await wrapped.stream(args);
  const { parts, error } = await collect(stream);

  assertStrictEquals(error, failure);
  assertEquals(parts, [chunk("a")]);
  assertEquals(model.streamCalls, [args]);
  assertEquals(sleeps, []);
});

Deno.test("retry - budget is shared between connection and stream failures", async () => {
  const args = { prompt: "hi" };
  const model = new FakeModel({
    stream: [
      { error: rateLimited() },
      { stream: streamFromActions([{ error: rateLimited() }]) },
      { stream: streamFromActions([chunk("final")]) },
    ],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { retries: 2, deps });

  const stream = await wrapped.stream(args);
  const { parts, error } = await collect(stream);

  assertEquals(error, undefined);
  assertEquals(parts, [chunk("final")]);
  assertEquals(model.streamCalls, [args, args, args]);
  assertEquals(sleeps, [218.75, 437.5]);
});

Deno.test("retry - pre-first-chunk replays stay within the budget", async () => {
  const args = { prompt: "hi" };
  const second = rateLimited();
  const model = new FakeModel({
    stream: [
      { stream: streamFromActions([{ error: rateLimited() }]) },
      { stream: streamFromActions([{ error: second }]) },
      { stream: streamFromActions([chunk("never reached")]) },
    ],
  });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { retries: 1, deps });

  const stream = await wrapped.stream(args);
  const { parts, error } = await collect(stream);

  assertStrictEquals(error, second);
  assertEquals(parts, []);
  assertEquals(model.streamCalls, [args, args]);
  assertEquals(sleeps, [218.75]);
});

Deno.test("retry - a connection failure with no retries rejects the promise", async () => {
  const failure = rateLimited();
  const model = new FakeModel({ stream: [{ error: failure }] });
  const { deps, sleeps } = recorder();
  const wrapped = withRetries(model, { retries: 0, deps });

  const error = await wrapped.stream({}).catch((error) => error);

  assertStrictEquals(error, failure);
  assertEquals(model.streamCalls.length, 1);
  assertEquals(sleeps, []);
});

Deno.test("retry - a stream abandoned after a chunk closes its source", async () => {
  let closed = false;
  const model = new FakeModel({
    stream: [
      {
        stream: streamFromActions(
          [chunk("a"), chunk("b")],
          () => {
            closed = true;
          },
        ),
      },
    ],
  });
  const { deps } = recorder();
  const wrapped = withRetries(model, { deps });

  const stream = await wrapped.stream({});
  const first = await stream.next();
  assertEquals(first.value, chunk("a"));
  await stream.return(undefined);

  assertEquals(closed, true);
  assertEquals(model.streamCalls.length, 1);
});

Deno.test("retry - a stream returned before its first step is not started", async () => {
  // A generator returned before its first step matches the adapters' own
  // semantics: return() completes an unstarted generator without running
  // its body, so neither the source nor the wrapper is asked to close —
  // the caller's deadline, when set, still ends the wrapped request.
  let closed = false;
  const model = new FakeModel({
    stream: [{ stream: streamFromActions([chunk("a")], () => closed = true) }],
  });
  const { deps } = recorder();
  const wrapped = withRetries(model, { deps });

  const stream = await wrapped.stream({});
  await stream.return(undefined);

  assertEquals(closed, false);
  assertEquals(model.streamCalls.length, 1);
});