import { object } from "@huuma/validate/object";
import { type Tool, tool } from "@/tools/mod.ts";
import { string } from "@huuma/validate/string";
import { NodeHtmlMarkdown } from "node-html-markdown";

/** Options for configuring the fetch-website tool. */
export interface FetchWebsiteOptions {
  /** Maximum duration of each fetch in milliseconds. Defaults to 30s. */
  timeout?: number;
  /**
   * Maximum number of response-body bytes kept per fetch. Larger pages are
   * cut off at this size and marked as truncated, and the rest of the
   * download is cancelled. Defaults to 2 MiB.
   *
   * The cap applies to retained response-body bytes, not to network traffic
   * or the returned Markdown: the body arrives in chunks of the transport's
   * choosing, so up to one chunk past the cap may be received before the
   * download is cancelled. Decoding and Markdown conversion use additional
   * memory, and the returned Markdown and truncation notice may exceed the cap.
   */
  maxBytes?: number;
}

/** Default maximum duration of a fetch. */
export const DEFAULT_FETCH_WEBSITE_TIMEOUT = 30_000;

/** Default maximum number of response-body bytes kept per fetch. */
export const DEFAULT_FETCH_WEBSITE_MAX_BYTES = 2 * 1024 * 1024;

/** How long a body that reached the cap exactly, with no known length, may
 * take to end before it is treated as truncated. */
const END_OF_BODY_GRACE_MS = 100;

/** Create a tool that fetches a website and converts HTML to Markdown.
 *
 * The download is bounded in time and size: the call is cancelled after
 * `timeout` (or when the caller aborts), and at most `maxBytes` of the body
 * are read — the rest of the download is cancelled and the result ends
 * with a truncation notice, so a huge or endless page cannot exhaust
 * memory.
 *
 * @param options Optional timeout and body-size cap.
 * @returns A {@link Tool} that downloads the given URL and returns Markdown text.
 */
export function fetchWebsite(
  options?: FetchWebsiteOptions,
  // deno-lint-ignore no-explicit-any
): Tool<any, string> {
  const timeout = options?.timeout ?? DEFAULT_FETCH_WEBSITE_TIMEOUT;
  const maxBytes = options?.maxBytes ?? DEFAULT_FETCH_WEBSITE_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive integer");
  }

  return tool({
    name: "fetch_website",
    description:
      `Fetch a website and return its content as Markdown converted from the HTML. Pages larger than ${
        formatBytes(maxBytes)
      } are truncated, and the request times out after ${
        formatDuration(timeout)
      }.`,
    input: object({
      url: string(),
    }),
    timeout,
    fn: async ({ url }, { signal }) => {
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
          );
        }
        const total = Number(response.headers.get("content-length"));
        const { text, truncated } = await readText(
          response,
          maxBytes,
          Number.isFinite(total) ? total : undefined,
        );
        const markdown = NodeHtmlMarkdown.translate(text);
        if (!truncated) return markdown;
        const size = Number.isFinite(total) && total > maxBytes
          ? ` of ${formatBytes(total)}`
          : "";
        return `${markdown}\n\n…[truncated: showing the first ${
          formatBytes(maxBytes)
        }${size}]`;
      } catch (error) {
        if (error instanceof Error) {
          throw new Error(`Error fetching ${url}: ${error.message}`);
        }
        throw error;
      }
    },
  });
}

/**
 * Keep at most `maxBytes` of the body as UTF-8 text. At the cap the rest
 * of the download is cancelled, and a multi-byte character split by the
 * cut is dropped rather than decoded into a replacement character. Reads
 * return whole transport chunks, so the chunk crossing the cap — or the
 * one read to check for the end below — is received and then discarded
 * past the cap: at most one chunk beyond `maxBytes` is ever held.
 *
 * A body that reaches the cap exactly may be complete or may continue. A
 * `Content-Length` of exactly `maxBytes` settles it; otherwise the end of
 * the stream is awaited only briefly — a complete page closes right after
 * its last chunk, while waiting indefinitely would hang on a server that
 * holds the connection open. More data, or none within the grace period,
 * counts as truncated.
 */
async function readText(
  response: Response,
  maxBytes: number,
  contentLength: number | undefined,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let received = 0;
  try {
    while (true) {
      if (received === maxBytes && contentLength !== maxBytes) {
        const ended = await endsWithin(reader, END_OF_BODY_GRACE_MS);
        if (ended) return { text: text + decoder.decode(), truncated: false };
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
  } finally {
    reader.releaseLock();
  }
}

/** Whether the stream reports its end within `ms`. A chunk arriving
 * instead, or nothing at all, means it continues. */
async function endsWithin(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read().then(({ done }) => done),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${+(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
