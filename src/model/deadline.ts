/**
 * Deadline support for the model adapters' requests.
 *
 * Adapts the abort conventions of `Tool.call` to model calls: a caller's
 * `signal` and an optional `timeout` combine into one `AbortSignal` the
 * transport must observe, the deadline aborts with a `TimeoutError`
 * DOMException, and a call that settles first disarms the deadline so no
 * pending timer is left behind.
 *
 * @module
 */

import { abortable } from "@/model/abortable.ts";

/** Message of the `TimeoutError` a model call rejects with once its
 * deadline expires. */
export const MODEL_TIMEOUT_MESSAGE = "The model call timed out";

/** Deadline inputs shared by every model adapter's generate options. */
export interface DeadlineOptions {
  /** Aborted when the caller cancels the call. */
  signal?: AbortSignal;
  /** Maximum total duration of the call in milliseconds — for streams,
   * including the full body. */
  timeout?: number;
}

/** A combined cancellation signal for one model call. */
export interface Deadline {
  /**
   * Caller cancellation and the deadline combined with `AbortSignal.any` —
   * whichever fires first aborts it, and its reason is that first one.
   * The caller's own signal when no timeout is given, and `undefined`
   * when neither is given, so the request runs exactly as before
   * deadlines existed.
   */
  signal: AbortSignal | undefined;

  /**
   * Disarms the deadline. A model call that finishes, fails, or — for
   * streams — ends iteration before the deadline must not leak a live
   * timer until the deadline elapses; a no-op without a timeout.
   */
  clear(): void;

  /**
   * The error a failed call should reject with: the signal's reason once
   * it has aborted, `error` otherwise. Provider SDKs translate an abort
   * into their own error types (e.g. `APIUserAbortError`), which would
   * hide whether the deadline or the caller ended the call.
   */
  errorFrom(error: unknown): unknown;

  /**
   * Re-yields `stream` under the deadline: iteration throws the signal's
   * reason once it aborts — also when the SDK raises its own error
   * mid-read — and the deadline is disarmed when iteration completes,
   * fails, or is closed with `return()`.
   */
  guard<T>(stream: AsyncIterable<T>): AsyncGenerator<T>;
}

/**
 * Combines a caller's `signal` and an optional `timeout` into one signal.
 *
 * Invalid timeouts throw `TypeError` like `Tool.call` does; `timeout`
 * `0` aborts immediately with `TimeoutError`.
 */
export function deadlineFrom(options: DeadlineOptions): Deadline {
  validateTimeout(options.timeout);

  const signals: AbortSignal[] = [];
  if (options.signal) {
    signals.push(options.signal);
  }

  let clear: () => void = () => {};
  if (options.timeout !== undefined) {
    const controller = new AbortController();
    const expire = () =>
      controller.abort(
        new DOMException(MODEL_TIMEOUT_MESSAGE, "TimeoutError"),
      );
    if (options.timeout === 0) {
      expire();
    } else {
      const timerId = setTimeout(expire, options.timeout);
      clear = () => clearTimeout(timerId);
    }
    signals.push(controller.signal);
  }

  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  const errorFrom = (error: unknown) => signal?.aborted ? signal.reason : error;

  return {
    signal,
    clear,
    errorFrom,
    async *guard<T>(stream: AsyncIterable<T>): AsyncGenerator<T> {
      try {
        yield* abortable(stream, signal);
      } catch (error) {
        throw errorFrom(error);
      } finally {
        clear();
      }
    },
  };
}

function validateTimeout(timeout: number | undefined): void {
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
    throw new TypeError(
      "Model timeout must be a finite, non-negative number",
    );
  }
}
