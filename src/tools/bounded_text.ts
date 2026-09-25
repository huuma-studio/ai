/**
 * Size-capped text reading shared by the tools that return text from
 * sources of unknown size — web pages, files, command output.
 *
 * Each tool keeps its source-specific policy (how to open the source,
 * what its size is, how long to wait for its end); this module owns the
 * parts that are the same for every source: validating the cap, reading
 * a byte stream into text without holding more than the cap, and telling
 * the model that the result was cut short.
 *
 * @module
 */

/** Text read from a stream, and whether the stream went on past the cap. */
export interface BoundedText {
  /** The decoded text, at most `maxBytes` of the stream's UTF-8 bytes. */
  text: string;
  /** Whether the stream had more bytes than `maxBytes`. */
  truncated: boolean;
}

/** Options for {@linkcode readTextBounded}. */
export interface ReadTextBoundedOptions {
  /** Stops reading: the stream is cancelled and the signal's reason thrown. */
  signal?: AbortSignal;
  /**
   * How long a stream that reached the cap exactly may take to report its
   * end before it counts as truncated, in milliseconds. Omit it to wait
   * for the stream's next read, which suits sources that end promptly —
   * a file, or a response whose length is known.
   */
  endOfStreamGrace?: number;
}

/** Validate a `maxBytes` option when a tool is created.
 *
 * The cap must be able to bound a read, so anything other than a positive
 * integer throws a {@linkcode TypeError}.
 */
export function validateMaxBytes(maxBytes: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive integer");
  }
}

/**
 * Read at most `maxBytes` of a byte stream as UTF-8 text. At the cap the
 * rest of the stream is cancelled, and a multi-byte character split by the
 * cut is dropped rather than decoded into a replacement character.
 *
 * The cap bounds the text kept, not the bytes the source delivers: reads
 * return whole chunks, so the chunk crossing the cap — or the one read to
 * check for the end — is received and then discarded past the cap. At most
 * one chunk beyond `maxBytes` is ever held.
 *
 * A stream that reaches the cap exactly may be complete or may continue;
 * {@linkcode ReadTextBoundedOptions.endOfStreamGrace} decides how long to
 * wait for its end. More data, or none within the grace period, counts as
 * truncated.
 *
 * The stream is always released: read to its end, cancelled at the cap, or
 * cancelled when reading fails or is aborted.
 */
export async function readTextBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  { signal, endOfStreamGrace }: ReadTextBoundedOptions = {},
): Promise<BoundedText> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      if (received === maxBytes) {
        if (await endsWithin(reader, endOfStreamGrace)) {
          return { text: text + decoder.decode(), truncated: false };
        }
        await reader.cancel();
        return { text, truncated: true };
      }
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode(), truncated: false };
      const remaining = maxBytes - received;
      if (value.byteLength > remaining) {
        text += decoder.decode(value.subarray(0, remaining), { stream: true });
        await reader.cancel();
        return { text, truncated: true };
      }
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch (error) {
    // An errored stream rejects the cancel too; the read error is the one
    // worth reporting.
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Append the note that tells the model a result was cut at `maxBytes`.
 *
 * @param total The source's full size, named in the note when it is known
 * to exceed the cap.
 */
export function withTruncationNotice(
  text: string,
  maxBytes: number,
  total?: number,
): string {
  const size = total !== undefined && total > maxBytes
    ? ` of ${formatBytes(total)}`
    : "";
  return `${text}\n\n…[truncated: showing the first ${
    formatBytes(maxBytes)
  }${size}]`;
}

/** Format a byte count for a tool description or note, e.g. `512 KiB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${+(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

/** Whether the stream reports its end within `ms`, or at its next read when
 * `ms` is omitted. A chunk arriving instead, or nothing at all, means it
 * continues. */
async function endsWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number | undefined,
): Promise<boolean> {
  const next = reader.read().then(({ done }) => done);
  if (ms === undefined) return await next;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      next,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
