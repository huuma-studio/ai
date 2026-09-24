/**
 * Cancellation helper shared by the model adapters' streams.
 *
 * @module
 */

/**
 * Re-yield `stream`, checking `signal` before every result and once more
 * when the stream ends.
 *
 * Some provider SDKs (OpenAI, Anthropic) end iteration silently when their
 * request is aborted, and adapters buffer results — several tool calls can
 * complete on one chunk and are yielded back to back without touching the
 * transport. Checking only the transport would let a consumer that aborts
 * after one result still receive the next, or mistake a truncated response
 * for a complete one. Checking before each yield guarantees that once
 * `signal` aborts, the next step throws its reason and nothing more is
 * delivered; the source is closed through `return()` as the loop unwinds.
 */
export async function* abortable<T>(
  stream: AsyncIterable<T>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  for await (const result of stream) {
    signal?.throwIfAborted();
    yield result;
  }
  signal?.throwIfAborted();
}
