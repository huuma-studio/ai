/**
 * Library-level model-call retry for provider adapters.
 *
 * Wraps any {@linkcode BaseModel} with `withRetries` to retry transient
 * provider failures — HTTP 408/409/429 and 5xx statuses, connection and
 * timeout messages, and anything unrecognized — with bounded exponential
 * backoff, without touching the adapters themselves. Streams retry only
 * until the first chunk is forwarded, after which failures propagate to
 * the consumer unchanged.
 *
 * @example
 * ```typescript
 * import { agent } from "jsr:@huuma/ai/agent";
 * import { withRetries } from "jsr:@huuma/ai/model";
 * import { openai } from "jsr:@huuma/ai/models/openai";
 *
 * const assistant = agent({
 *   model: withRetries(openai({
 *     apiKey: Deno.env.get("OPENAI_API_KEY"),
 *     maxRetries: 0, // do not stack the SDK's retries on the decorator's
 *   })),
 *   modelId: "gpt-5.5",
 *   systemPrompt: "You are a helpful assistant.",
 * });
 * ```
 *
 * @module
 */
import type { BaseModel, ModelResult } from "./mod.ts";

/** Whether an error's retry policy allows retrying a model call. */
export type ModelErrorClass = "transient" | "permanent";

/** Default additional attempts after the initial model call. */
export const DEFAULT_RETRIES = 2;

/** Default base delay of the exponential backoff, in milliseconds. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 250;

/** Default delay the exponential backoff may grow to, in milliseconds. */
export const DEFAULT_RETRY_CAP_DELAY_MS = 5000;

/** Upper bound of an honored `Retry-After` hint, in milliseconds — a
 * provider hint longer than this is truncated so a broken endpoint
 * cannot stall a run indefinitely. */
export const MAX_RETRY_AFTER_MS = 60_000;

/** Fields adapter and SDK errors may carry an HTTP status in: the OpenAI
 * and Anthropic SDKs use `status`, the Mistral SDK `statusCode`, the
 * Ollama SDK `status_code`, and raw `Response` rejections carry `status`.
 */
const STATUS_KEYS = ["status", "statusCode", "status_code"] as const;

/** Message fragments signaling a transient provider failure. Falls back
 * to text because providers also surface plain `Error`s without a
 * status. */
const TRANSIENT_MESSAGE_FRAGMENTS = [
  "timed out",
  "timeout",
  "connection reset",
  "fetch failed",
  "overload",
  "rate limit",
] as const;

/** Message fragments signaling a permanent failure: auth and
 * invalid-request texts, mirroring the CLI's classification table
 * (spec #55). Abort texts are matched separately, before these. */
const PERMANENT_MESSAGE_FRAGMENTS = [
  "unauthorized",
  "authentication",
  "invalid api key",
  "invalid request",
] as const;

/**
 * Classifies a model-call error for the retry loop.
 *
 * A duck-typed HTTP `status`/`statusCode`/`status_code` decides first:
 * 408, 409, 429, and ≥500 are transient; other 4xx are permanent. Next,
 * runtime-level cancellation never retries — an error named `AbortError`
 * or `TimeoutError` (the library's model-deadline convention), or a
 * message reporting an abort. Message heuristics follow: timeout,
 * connection-reset, fetch-failed, overload, and rate-limit texts are
 * transient; auth and invalid-request texts are permanent. No match at
 * all classifies as **transient** — attempts are bounded, so a wasted
 * retry is cheaper than an avoidable failure.
 *
 * @param error The rejection reason of a `generate`/`stream` call.
 * @returns Whether the error may be retried.
 */
export function classifyModelError(error: unknown): ModelErrorClass {
  const status = statusFrom(error);
  if (status !== undefined) {
    if (status === 408 || status === 409 || status === 429) {
      return "transient";
    }
    if (status >= 400) {
      return status < 500 ? "permanent" : "transient";
    }
  }

  // Cancellation dominates every other signal: an aborted request, or
  // the deadline of a model call (a `TimeoutError`, the library's
  // deadline convention), must not be re-issued behind the caller's
  // back. The retry budget would soften the rejection into a delay.
  const name = nameFrom(error);
  if (name === "AbortError" || name === "TimeoutError") {
    return "permanent";
  }

  const message = normalizeMessage(error);
  if (message !== undefined) {
    if (message.includes("abort")) return "permanent";
    if (matches(message, TRANSIENT_MESSAGE_FRAGMENTS)) return "transient";
    if (matches(message, PERMANENT_MESSAGE_FRAGMENTS)) return "permanent";
  }

  return "transient";
}

function statusFrom(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const source = error as Record<string, unknown>;
  for (const key of STATUS_KEYS) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function nameFrom(error: unknown): string | undefined {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" ? name : undefined;
}

function normalizeMessage(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== "string") {
    return undefined;
  }
  // SDKs spell fragments with hyphens and underscores: invalid-api-key,
  // invalid_request_error. Normalizing makes one word list cover them.
  return message.toLowerCase().replace(/[-_]/g, " ");
}

function matches(
  message: string,
  fragments: readonly string[],
): boolean {
  return fragments.some((fragment) => message.includes(fragment));
}

/** Injectable timing and randomness for the retry loop, mirroring the
 * tool factories' `Deps` style: every default is the platform's
 * implementation, and tests inject deterministic ones. */
export interface RetryDeps {
  /** Clock in epoch milliseconds, read for `Retry-After` HTTP-date hints. */
  now(): number;
  /** Suspends the caller until `ms` milliseconds have passed. */
  sleep(ms: number): Promise<void>;
  /** Random number in `[0, 1)` used to jitter a delay. */
  random(): number;
}

/** Options of {@linkcode withRetries}. */
export interface WithRetriesOptions {
  /**
   * Additional attempts after the initial model call. `0` disables
   * retrying; the last error propagates unchanged. Retries only cover
   * the model call — tool execution happens outside it, so no
   * conversation replay is involved (unlike the CLI's whole-`run()`
   * retry). Defaults to {@linkcode DEFAULT_RETRIES} (2).
   */
  retries?: number;
  /**
   * Base delay of the exponential backoff in milliseconds — the delay
   * after the first failure, doubling per further attempt up to
   * `capDelayMs`. Defaults to
   * {@linkcode DEFAULT_RETRY_BASE_DELAY_MS} (250).
   */
  baseDelayMs?: number;
  /**
   * Ceiling the exponential backoff may reach before jitter, in
   * milliseconds. Defaults to {@linkcode DEFAULT_RETRY_CAP_DELAY_MS}
   * (5,000).
   */
  capDelayMs?: number;
  /**
   * Decides whether an error may be retried, replacing the built-in
   * {@linkcode classifyModelError} entirely. `attempt` is the
   * zero-based index of the attempt that just failed; the hook is only
   * consulted while the retry budget remains.
   */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Injectable timing and randomness — see {@linkcode RetryDeps}. */
  deps?: Partial<RetryDeps>;
}

/** Inputs of {@linkcode backoffDelayMs}. */
export interface BackoffOptions {
  /** Zero-based index of the attempt that just failed. */
  attempt: number;
  /** Base delay in milliseconds. */
  baseDelayMs: number;
  /** Ceiling the delay may reach before jitter, in milliseconds. */
  capDelayMs: number;
  /** Random number in `[0, 1)` used to jitter the delay. */
  random: () => number;
  /** Minimum delay honored for the attempt, from a `Retry-After` hint. */
  retryAfterHintMs?: number;
}

/**
 * The delay before the retry following `attempt`: the exponential
 * backoff `min(capDelayMs, baseDelayMs × 2^attempt)` multiplied by a
 * jitter factor in `[0.5, 1.0)`, never below the attempt's
 * `Retry-After` hint.
 *
 * @param options The attempt and backoff parameters.
 */
export function backoffDelayMs(
  { attempt, baseDelayMs, capDelayMs, random, retryAfterHintMs: hint }:
    BackoffOptions,
): number {
  const exponential = Math.min(capDelayMs, baseDelayMs * 2 ** attempt);
  return Math.max(exponential * (0.5 + 0.5 * random()), hint ?? 0);
}

/**
 * Reads a model error's best-effort `Retry-After` hint.
 *
 * Recognizes a direct field (`retryAfterMs` in milliseconds, or
 * `retryAfter` in seconds), an SDK error's `headers` — a `Headers`
 * instance or a plain record — and numeric values, seconds-count
 * strings, and HTTP-date strings. Values are clamped to the
 * `[0, 60,000]` millisecond interval so a broken endpoint cannot stall
 * a run indefinitely.
 *
 * @param error The rejection reason of a `generate`/`stream` call.
 * @param now Clock for HTTP-date hints, in epoch milliseconds.
 * @returns The honored hint in milliseconds, or `undefined` when absent.
 */
export function retryAfterHintMs(
  error: unknown,
  now: () => number = Date.now,
): number | undefined {
  // A direct `retryAfterMs` field is already in milliseconds.
  const milliseconds = (error as { retryAfterMs?: unknown } | null)
    ?.retryAfterMs;
  if (typeof milliseconds === "number" && Number.isFinite(milliseconds)) {
    return clampHint(Math.max(0, milliseconds));
  }
  const hint = directHint(error) ?? headerHint(error);
  if (hint === undefined) {
    return undefined;
  }
  return clampHint(parseRetryAfter(hint, now));
}

function clampHint(hint: number | undefined): number | undefined {
  if (hint === undefined) {
    return undefined;
  }
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, hint));
}

function parseRetryAfter(
  value: string | number,
  now: () => number,
): number | undefined {
  if (typeof value === "number") {
    return value * 1000;
  }
  const text = value.trim();
  // Numeric values are seconds, per the HTTP header's convention.
  if (/^\d+(\.\d+)?$/.test(text)) {
    return Number(text) * 1000;
  }
  const milliseconds = Date.parse(text);
  return Number.isNaN(milliseconds)
    ? undefined
    : Math.max(0, milliseconds - now());
}

function directHint(error: unknown): string | number | undefined {
  const value = (error as { retryAfter?: unknown } | null)?.retryAfter;
  if (typeof value === "number" || typeof value === "string") {
    return value;
  }
  return undefined;
}

function headerHint(error: unknown): string | number | undefined {
  const headers = (error as { headers?: unknown } | null)?.headers;
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  // Headers-like values (`Headers` instances and any `get`-shaped
  // object) are read through the method — case-insensitive per spec —
  // anything else is treated as a plain record.
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    try {
      const value = (headers as { get(key: string): unknown }).get(
        "retry-after",
      );
      if (typeof value === "string" || typeof value === "number") {
        return value;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
  for (const [key, value] of Object.entries(headers)) {
    if (
      key.toLowerCase() === "retry-after" &&
      (typeof value === "string" || typeof value === "number")
    ) {
      return value;
    }
  }
  return undefined;
}

/** Model adapter wrapped by {@linkcode withRetries}: delegates
 * `generate`/`stream` through the bounded retry loop with exponential
 * backoff. Streams replay only until the first chunk is forwarded. */
export class RetryModel<T extends string = string> implements BaseModel<T> {
  readonly #model: BaseModel<T>;
  readonly #retries: number;
  readonly #baseDelayMs: number;
  readonly #capDelayMs: number;
  readonly #shouldRetry: (error: unknown, attempt: number) => boolean;
  readonly #deps: RetryDeps;

  constructor(model: BaseModel<T>, options: WithRetriesOptions = {}) {
    this.#model = model;

    const retries = options.retries ?? DEFAULT_RETRIES;
    if (!Number.isInteger(retries) || retries < 0) {
      throw new TypeError("Retries must be a non-negative integer");
    }
    this.#retries = retries;

    const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
      throw new TypeError(
        "The retry base delay must be a finite, non-negative number",
      );
    }
    this.#baseDelayMs = baseDelayMs;

    const capDelayMs = options.capDelayMs ?? DEFAULT_RETRY_CAP_DELAY_MS;
    if (!Number.isFinite(capDelayMs) || capDelayMs < 0) {
      throw new TypeError(
        "The retry cap delay must be a finite, non-negative number",
      );
    }
    this.#capDelayMs = capDelayMs;

    if (options.shouldRetry !== undefined && typeof options.shouldRetry !== "function") {
      throw new TypeError("shouldRetry must be a function");
    }
    this.#shouldRetry = options.shouldRetry ?? defaultShouldRetry;

    this.#deps = retryDepsFrom(options.deps ?? {});
  }

  /** Generate a complete model response, retrying transient failures. */
  async generate(args: unknown): Promise<ModelResult<T>> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.#model.generate(args);
      } catch (error) {
        if (!this.#mayRetry(error, attempt)) {
          throw error;
        }
        await this.#sleepBeforeRetry(attempt, error);
        attempt += 1;
      }
    }
  }

  /** Stream incremental model responses.
   *
   * The connection is retried with backoff while the returned promise
   * is pending — a failing provider request rejects with the original
   * error only once the retry budget is exhausted. Once the consumer
   * iterates, the wrapped stream replays on a failure before the first
   * forwarded chunk; after that, failures propagate untouched.
   */
  async stream(args: unknown): Promise<AsyncGenerator<ModelResult>> {
    const { stream, attempt } = await this.#connect(args, 0);
    return this.#forward(args, stream, attempt);
  }

  /** Whether the error may be retried: the retry budget must remain and
   * the configured hook (built-in classification by default) must
   * accept the failure. */
  #mayRetry(error: unknown, attempt: number): boolean {
    if (attempt >= this.#retries) {
      return false;
    }
    return this.#shouldRetry(error, attempt);
  }

  async #sleepBeforeRetry(attempt: number, error: unknown): Promise<void> {
    await this.#deps.sleep(backoffDelayMs({
      attempt,
      baseDelayMs: this.#baseDelayMs,
      capDelayMs: this.#capDelayMs,
      random: this.#deps.random,
      retryAfterHintMs: retryAfterHintMs(error, this.#deps.now),
    }));
  }

  /** Acquires the provider stream, retrying connection failures — the
   * `stream()` promise rejections of every adapter — with the shared
   * attempt budget. */
  async #connect(
    args: unknown,
    attempt: number,
  ): Promise<{
    stream: AsyncGenerator<ModelResult>;
    attempt: number;
  }> {
    for (;;) {
      try {
        return { stream: await this.#model.stream(args), attempt };
      } catch (error) {
        if (!this.#mayRetry(error, attempt)) {
          throw error;
        }
        await this.#sleepBeforeRetry(attempt, error);
        attempt += 1;
      }
    }
  }

  /** Iterates an acquired stream and replays it — re-invoking
   * `model.stream` with the shared attempt budget — on a failure before
   * the first chunk is forwarded. Once any chunk has reached the
   * consumer, failures propagate untouched: re-issuing the stream would
   * duplicate already-delivered output. */
  async *#forward(
    args: unknown,
    first: AsyncGenerator<ModelResult>,
    attemptsUsed: number,
  ): AsyncGenerator<ModelResult> {
    let stream = first;
    let attempt = attemptsUsed;
    let forwarded = false;

    while (true) {
      let failure: unknown;
      try {
        for (;;) {
          const next = await stream.next();
          if (next.done) {
            return;
          }
          forwarded = true;
          yield next.value;
        }
      } catch (error) {
        failure = error;
      } finally {
        // Every exit but clean completion closes the source: finished
        // generators are already done (return() is a no-op), a failed
        // or abandoned one otherwise keeps its request and deadline
        // alive — the same ending the adapters' deadline guard enforces.
        await closeQuietly(stream);
      }

      if (forwarded || !this.#mayRetry(failure, attempt)) {
        throw failure;
      }
      await this.#sleepBeforeRetry(attempt, failure);
      attempt += 1;
      ({ stream, attempt } = await this.#connect(args, attempt));
    }
  }
}

/** The built-in retry hook: an error retries when classified transient. */
function defaultShouldRetry(error: unknown, _attempt: number): boolean {
  return classifyModelError(error) === "transient";
}

function retryDepsFrom(deps: Partial<RetryDeps>): RetryDeps {
  const entries = [
    ["now", deps.now],
    ["sleep", deps.sleep],
    ["random", deps.random],
  ] as const;
  for (const [name, dependency] of entries) {
    if (dependency !== undefined && typeof dependency !== "function") {
      throw new TypeError(`deps.${name} must be a function`);
    }
  }
  return {
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? defaultSleep,
    random: deps.random ?? Math.random,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeQuietly(stream: AsyncGenerator): Promise<void> {
  try {
    await stream.return(undefined);
  } catch {
    // Closing must not mask the error or result being delivered.
  }
}

/**
 * Wraps a model adapter and retries its transient provider failures
 * with bounded exponential backoff — HTTP 408/409/429 and 5xx statuses,
 * connection and timeout messages, and unrecognized errors — so one
 * blip does not fail an `Agent.run`. The decorators' options default to
 * two additional attempts, starting at 250 ms and capped at 5,000 ms;
 * `shouldRetry` replaces the built-in classification entirely.
 *
 * The decorator is generic over the wrapped model's model-id type, so
 * the result stays assignable anywhere the adapter was accepted —
 * including `Agent`'s `model` option, unchanged.
 *
 * Streams retry only until the first chunk is forwarded: a failing
 * connection rejects the `stream()` promise (retried), a failure before
 * the first forwarded chunk replays the stream, and a failure after it
 * — or inside delivered output — propagates unchanged, since re-issuing
 * would duplicate already-delivered output.
 *
 * Wrapped SDK clients retry on their own, so attempts do not multiply:
 * pass `maxRetries: 0` to the OpenAI and Anthropic adapters' client
 * options and `retryConfig: { strategy: "none" }` to Mistral. Ollama,
 * Google, and the Z.AI adapter expose no retry knobs — this decorator
 * is what gives them retries at all. Retried model calls re-bill their
 * tokens when the provider processed the failed attempt before
 * failing — inherent to any retry layer, and mitigated here by
 * retrying only transient classifications.
 *
 * @param model The adapter to decorate.
 * @param options The retry behavior; see {@linkcode WithRetriesOptions}.
 * @returns A model delegating to `model` with bounded retries —
 * assignable anywhere the wrapped model was.
 *
 * @example
 * ```typescript
 * import { withRetries } from "jsr:@huuma/ai/model";
 * import { openai } from "jsr:@huuma/ai/models/openai";
 *
 * const model = withRetries(
 *   openai({ apiKey: Deno.env.get("OPENAI_API_KEY"), maxRetries: 0 }),
 *   { retries: 2, baseDelayMs: 250, capDelayMs: 5_000 },
 * );
 * const result = await model.generate({
 *   modelId: "gpt-5.5",
 *   messages: [{ role: "user", contents: "Hello!" }],
 * });
 * ```
 */
export function withRetries<T extends string = string>(
  model: BaseModel<T>,
  options: WithRetriesOptions = {},
): BaseModel<T> {
  return new RetryModel<T>(model, options);
}