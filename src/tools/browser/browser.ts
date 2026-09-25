import { object } from "@huuma/validate/object";
import { type Tool, tool } from "@/tools/mod.ts";
import { string } from "@huuma/validate/string";
import { NodeHtmlMarkdown } from "node-html-markdown";
import {
  formatBytes,
  readTextBounded,
  validateMaxBytes,
  withTruncationNotice,
} from "@/tools/bounded_text.ts";

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
  validateMaxBytes(maxBytes);

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
        const contentLength = Number.isFinite(total) ? total : undefined;
        const { text, truncated } = await readTextBounded(
          response.body ?? ReadableStream.from([]),
          maxBytes,
          { endOfStreamGrace: endOfBodyGrace(contentLength, maxBytes) },
        );
        const markdown = NodeHtmlMarkdown.translate(text);
        return truncated
          ? withTruncationNotice(markdown, maxBytes, contentLength)
          : markdown;
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
 * How long a body that reached the cap exactly may take to end. A
 * `Content-Length` of exactly `maxBytes` proves it is complete, so its end
 * is simply awaited; otherwise it is awaited only briefly — a complete page
 * closes right after its last chunk, while waiting indefinitely would hang
 * on a server that holds the connection open.
 */
function endOfBodyGrace(
  contentLength: number | undefined,
  maxBytes: number,
): number | undefined {
  return contentLength === maxBytes ? undefined : END_OF_BODY_GRACE_MS;
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${+(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}
