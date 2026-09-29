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

/** Deadline inputs shared by every model adapter's generate options. */
export interface DeadlineOptions {
  /** Aborted when the caller cancels the call. */
  signal?: AbortSignal;
  /** Maximum duration of the call in milliseconds. */
  timeout?: number;
}

/** A combined cancellation signal for one model call. */
export interface Deadline {
  /**
   * Caller cancellation and the deadline combined with `AbortSignal.any` —
   * whichever fires first aborts it. `undefined` when neither is given, so
   * the request runs exactly as before deadlines existed.
   */
  signal: AbortSignal | undefined;

  /**
   * Disarms the deadline. A model call that finishes, fails, or — for
   * streams — ends iteration before the deadline must not leak a live
   * timer until the deadline elapses; a no-op without a timeout.
   */
  clear(): void;
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
    if (options.timeout === 0) {
      controller.abort(
        new DOMException("The model call timed out", "TimeoutError"),
      );
    } else {
      const timerId = setTimeout(() => {
        controller.abort(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          ),
        );
      }, options.timeout);
      clear = () => clearTimeout(timerId);
    }
    signals.push(controller.signal);
  }

  return {
    signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
    clear,
  };
}

function validateTimeout(timeout: number | undefined): void {
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
    throw new TypeError(
      "Model timeout must be a finite, non-negative number",
    );
  }
}
