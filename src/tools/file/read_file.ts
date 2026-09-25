import { number, object, string } from "@huuma/validate";
import { type Tool, tool } from "../mod.ts";
import {
  type BoundedText,
  fitJsonString,
  formatBytes,
  readTextBounded,
  validateMaxBytes,
} from "../bounded_text.ts";
import { mapReadError, openRegularFile } from "../regular_file.ts";

/** Options for configuring the read-file tool. */
export interface ReadFileOptions {
  /**
   * Maximum size of a read's content, in bytes. Larger files are returned
   * in pages of at most this size, each ending with a note saying where to
   * continue. Defaults to 512 KiB.
   *
   * The cap applies both to the bytes read and to the content's size once
   * JSON-escaped for the model request, so a file of quotes or control
   * characters is cut earlier rather than growing past the cap on the wire.
   */
  maxBytes?: number;
}

/**
 * Default maximum number of bytes returned per read: 512 KiB, half the
 * Huuma API's 1 MiB message limit, leaving room for JSON escaping, the
 * truncation note, and the rest of the conversation in the same request.
 */
export const DEFAULT_READ_FILE_MAX_BYTES = 512 * 1024;

/** Create a tool that reads a text file.
 *
 * A read returns at most `maxBytes` of the file, cut so that JSON-escaped
 * it takes at most `maxBytes` in the model request — so a huge file can
 * neither exhaust memory nor produce a tool result too large to send. A
 * larger file stays fully readable: the model pages through it with the
 * `offset` and `limit` byte inputs, and each partial result ends with a note
 * naming the bytes shown, the file's size, and the offset to continue at.
 *
 * @param options Optional size cap.
 * @returns A {@link Tool} that returns the contents of the requested file path.
 */
// deno-lint-ignore no-explicit-any
export function readFile(options?: ReadFileOptions): Tool<any, string> {
  const maxBytes = options?.maxBytes ?? DEFAULT_READ_FILE_MAX_BYTES;
  validateMaxBytes(maxBytes);

  return tool({
    name: "read_file",
    description:
      `Read the content of a text file from the file system. Use this to inspect code, configuration files, or documentation. A read returns at most ${
        formatBytes(maxBytes)
      }; a larger file is returned in parts, each ending with a note giving the offset to continue from. Optional "offset" (byte to start at, default 0) and "limit" (number of bytes to read) select a part of the file.`,
    input: object({
      path: string(),
      offset: number().optional(),
      limit: number().optional(),
    }),
    fn: async ({ path, offset = 0, limit }, { signal }) => {
      validateWindow(offset, limit);
      const length = Math.min(limit ?? maxBytes, maxBytes);
      // Read at least one whole character, so a cap smaller than a character
      // still moves forward; the fit below trims the text to the cap.
      const read = await readWindow(
        path,
        offset,
        Math.max(length, MAX_UTF8_CHARACTER_BYTES),
        signal,
      );
      const text = fitWithProgress(read.text, length);
      const more = read.truncated || text.length < read.text.length;
      if (offset === 0 && !more) return text;
      const end = read.start + new TextEncoder().encode(text).byteLength;
      return `${text}\n\n${windowNotice(read.start, end, read.size, more)}`;
    },
  });
}

/** The most bytes one character takes in UTF-8. */
const MAX_UTF8_CHARACTER_BYTES = 4;

/** Check the model's `offset` and `limit` inputs. */
function validateWindow(offset: number, limit: number | undefined): void {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`offset must be a non-negative integer, got ${offset}`);
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error(`limit must be a positive integer, got ${limit}`);
  }
}

/** Text read from a window of a file, the byte it starts at, and the file's
 * size. */
interface FileWindow extends BoundedText {
  start: number;
  size: number;
}

/** Read at most `length` bytes of the file at `path` as text, starting at
 * the first character at or after `offset`. */
async function readWindow(
  path: string,
  offset: number,
  length: number,
  signal: AbortSignal,
): Promise<FileWindow> {
  const { file, size } = await openRegularFile(path);
  let start: number;
  try {
    if (offset > size) {
      throw new Error(
        `offset ${offset} is past the end of ${path} (${size} bytes)`,
      );
    }
    start = await textStart(file, offset);
    await file.seek(start, Deno.SeekMode.Start);
  } catch (error) {
    file.close();
    throw mapReadError(error, path);
  }
  try {
    // The stream owns the handle from here: it closes the file when it is
    // read to the end, cancelled at the cap, or fails.
    // Keeping a byte-order mark matches Deno.readTextFile and keeps every
    // byte of the file in the text, so offsets stay exact.
    const bounded = await readTextBounded(file.readable, length, {
      signal,
      ignoreBOM: true,
    });
    return { ...bounded, start, size };
  } catch (error) {
    throw mapReadError(error, path);
  }
}

/**
 * The byte where text starting at `offset` begins: an offset inside a
 * multi-byte character moves to the next character, so that the text
 * returned is exactly the file's bytes from there on — keeping the offsets
 * reported to the model exact.
 */
async function textStart(file: Deno.FsFile, offset: number): Promise<number> {
  await file.seek(offset, Deno.SeekMode.Start);
  const head = new Uint8Array(3);
  const read = await file.read(head) ?? 0;
  let skip = 0;
  while (skip < read && (head[skip] & 0xc0) === 0x80) skip++;
  return offset + skip;
}

/** Fit `text` into `maxBytes` once JSON-escaped, but keep at least its first
 * character: a cap smaller than one character's escape must not stop
 * paging from moving forward. */
function fitWithProgress(text: string, maxBytes: number): string {
  const fitted = fitJsonString(text, maxBytes).text;
  if (fitted !== "" || text === "") return fitted;
  return String.fromCodePoint(text.codePointAt(0)!);
}

/** The note ending a partial read: which bytes it shows, and where to go
 * on from if the file continues. `end` is exclusive. */
function windowNotice(
  start: number,
  end: number,
  size: number,
  more: boolean,
): string {
  const total = size < 1024
    ? `${size} bytes`
    : `${size} bytes (${formatBytes(size)})`;
  if (end === start) {
    return `…[end of file: no text after byte ${start} of ${total}]`;
  }
  const shown = `showing bytes ${start}–${end - 1} of ${total}`;
  return more
    ? `…[truncated: ${shown}. Call read_file with offset ${end} to continue.]`
    : `…[${shown}; end of file]`;
}
