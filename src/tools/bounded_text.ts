/**
 * Size-capped text reading shared by the tools that return text from
 * sources of unknown size — web pages, files, command output.
 *
 * Each tool keeps its source-specific policy (how to open the source,
 * what its size is, how long to wait for its end); this module owns the
 * parts that are the same for every source: validating the cap, reading a
 * byte stream into text or lines without holding more than the cap,
 * fitting text into what it may take up in a model request, and telling
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
  /**
   * Stops reading: the stream is cancelled at once, even while a read is
   * waiting on it, and the signal's reason thrown.
   */
  signal?: AbortSignal;
  /**
   * How long a stream that reached the cap exactly may take to report its
   * end before it counts as truncated, in milliseconds. Omit it to wait
   * for the stream's next read, which suits sources that end promptly —
   * a file, or a response whose length is known.
   */
  endOfStreamGrace?: number;
  /**
   * Keep a byte-order mark at the start of the stream as U+FEFF instead of
   * dropping it, as `Deno.readTextFile` does. Then every byte of the stream
   * is in the text.
   */
  ignoreBOM?: boolean;
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
 *
 * The cap bounds bytes, not the text's size once escaped for a model
 * request; see {@linkcode fitJsonString} for that.
 */
export async function readTextBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  { signal, endOfStreamGrace, ignoreBOM = false }: ReadTextBoundedOptions = {},
): Promise<BoundedText> {
  const reader = stream.getReader();
  // Cancelling ends a read that is waiting on a stalled source, so an
  // abort releases the source right away instead of at its next chunk.
  const cancelOnAbort = () => reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener("abort", cancelOnAbort, { once: true });
  // A read ended by that cancel reports `done`: the abort must win over
  // treating the stream as complete.
  const next = async () => {
    const result = await reader.read();
    signal?.throwIfAborted();
    return result;
  };
  const decoder = new TextDecoder("utf-8", { ignoreBOM });
  let text = "";
  let received = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      if (received === maxBytes) {
        if (await endsWithin(next, endOfStreamGrace)) {
          return { text: text + decoder.decode(), truncated: false };
        }
        await reader.cancel();
        return { text, truncated: true };
      }
      const { done, value } = await next();
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
    signal?.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
}

/**
 * Builds one line at a time for {@linkcode readLines} from the pieces of it
 * that arrive, deciding what of the line to keep.
 */
export interface LineBuilder<T> {
  /** Add the next piece of the current line. */
  append(text: string): void;
  /** The finished line; the builder then starts on the next one. */
  finish(): T;
}

/** A {@linkcode LineBuilder} keeping at most `maxLength` characters of each
 * line and discarding the rest as it arrives. */
export function cappedLine(maxLength: number): LineBuilder<string> {
  let line = "";
  return {
    append(text) {
      if (line.length < maxLength) {
        line += text.slice(0, maxLength - line.length);
      }
    },
    finish() {
      const finished = line;
      line = "";
      return finished;
    },
  };
}

/**
 * Read a byte stream as UTF-8 lines, split at `\n`. `builder` receives each
 * line in pieces as they arrive and keeps what it needs, so a huge line is
 * never held whole — see {@linkcode cappedLine}.
 *
 * Lines are produced as the stream delivers them, so a consumer can stop
 * early: breaking out of the loop cancels the stream. A last line without a
 * trailing newline is produced too.
 */
export async function* readLines<T>(
  stream: ReadableStream<Uint8Array>,
  builder: LineBuilder<T>,
): AsyncGenerator<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      const text = done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      let start = 0;
      while (true) {
        const end = text.indexOf("\n", start);
        const piece = text.slice(start, end === -1 ? text.length : end);
        if (piece !== "") {
          builder.append(piece);
          pending = true;
        }
        if (end === -1) break;
        yield builder.finish();
        pending = false;
        start = end + 1;
      }
      if (done) {
        if (pending) yield builder.finish();
        return;
      }
    }
  } finally {
    // Stopping early, or a failed read, leaves the stream open.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Cut `text` so that, encoded as a JSON string, it takes at most `maxBytes`
 * UTF-8 bytes, not counting the surrounding quotes.
 *
 * A tool's text result is JSON-escaped once in the model request, and
 * escaping inflates it: a quote or newline takes 2 bytes and other control
 * characters take 6. Capping the bytes read alone lets a file of NUL bytes
 * grow sixfold in the request; this bounds what is actually sent. The cut
 * never splits a surrogate pair.
 */
export function fitJsonString(
  text: string,
  maxBytes: number,
): { text: string; trimmed: boolean } {
  let size = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    let cost: number;
    let units = 1;
    if (code === 0x22 || code === 0x5c || SHORT_ESCAPES.has(code)) {
      cost = 2;
    } else if (code < 0x20) {
      cost = 6;
    } else if (code < 0x80) {
      cost = 1;
    } else if (code < 0x800) {
      cost = 2;
    } else if (
      isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1))
    ) {
      cost = 4;
      units = 2;
    } else if (isHighSurrogate(code) || isLowSurrogate(code)) {
      // A lone surrogate is escaped as \uXXXX.
      cost = 6;
    } else {
      cost = 3;
    }
    if (size + cost > maxBytes) {
      return { text: text.slice(0, index), trimmed: true };
    }
    size += cost;
    index += units - 1;
  }
  return { text, trimmed: false };
}

/** Control characters JSON escapes in two bytes: \b \t \n \f \r. */
const SHORT_ESCAPES = new Set([0x08, 0x09, 0x0a, 0x0c, 0x0d]);

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Append the note that tells the model a result was cut short.
 *
 * @param shownBytes How much of the source the result shows.
 * @param total The source's full size, named in the note when it is known
 * to exceed what is shown.
 */
export function withTruncationNotice(
  text: string,
  shownBytes: number,
  total?: number,
): string {
  const size = total !== undefined && total > shownBytes
    ? ` of ${formatBytes(total)}`
    : "";
  return `${text}\n\n…[truncated: showing the first ${
    formatBytes(shownBytes)
  }${size}]`;
}

/** Format a byte count for a tool description or note, e.g. `512 KiB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${+(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KiB`;
  return bytes === 1 ? "1 byte" : `${bytes} bytes`;
}

/** Whether the stream reports its end within `ms`, or at its next read when
 * `ms` is omitted. A chunk arriving instead, or nothing at all, means it
 * continues. */
async function endsWithin(
  next: () => Promise<ReadableStreamReadResult<Uint8Array>>,
  ms: number | undefined,
): Promise<boolean> {
  const ended = next().then(({ done }) => done);
  if (ms === undefined) return await ended;
  // Once the grace period wins, the read is settled only by the caller's
  // cancel — or rejected by an abort nobody awaits any more.
  ended.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ended,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
