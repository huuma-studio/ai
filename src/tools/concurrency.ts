/**
 * Bounded-concurrency helpers shared by the tool batch execution paths.
 *
 * @module
 */

/** Validate a `maxConcurrency` option before a batch runs.
 *
 * `undefined` means unlimited and always passes — the backward-compatible
 * default. Anything else must be able to bound a batch: zero, negatives,
 * non-integers, and non-finite values would deadlock or mislead, so they
 * throw a {@linkcode TypeError}.
 */
export function validateMaxConcurrency(
  maxConcurrency: number | undefined,
): void {
  if (
    maxConcurrency !== undefined &&
    (!Number.isInteger(maxConcurrency) || maxConcurrency < 1)
  ) {
    throw new TypeError("maxConcurrency must be a positive integer");
  }
}

/**
 * Map `items` through `mapper` like `Promise.allSettled`, but with at most
 * `maxConcurrency` executions overlapping.
 *
 * Executions start in input order: a worker pool claims indices
 * sequentially, so item `i` only starts once every earlier item has
 * started and a slot has freed up. A slot is released the moment a
 * mapper settles — successfully or not — so one slow or failing call
 * never blocks the rest of the batch. Settled results are index-aligned
 * with the input exactly like `allSettled`, letting callers map results
 * back to `items[i]` without reordering.
 *
 * `undefined` means unlimited: the batch takes the plain `allSettled`
 * path and every execution starts immediately, preserving the behavior
 * of callers that do not opt into a cap.
 */
export async function mapSettled<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  maxConcurrency?: number,
): Promise<PromiseSettledResult<R>[]> {
  if (maxConcurrency === undefined) {
    return await Promise.allSettled(
      items.map((item, index) => mapper(item, index)),
    );
  }
  validateMaxConcurrency(maxConcurrency);

  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = {
          status: "fulfilled",
          value: await mapper(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(maxConcurrency, items.length) },
    () => runWorker(),
  );
  await Promise.all(workers);
  return results;
}