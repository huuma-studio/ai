import { encodeBase64 } from "@std/encoding/base64";
import { object } from "@huuma/validate/object";
import { string } from "@huuma/validate/string";
import { type Tool, tool, type ToolOutput, toolOutput } from "../mod.ts";

/** Options for configuring the image tool. */
export interface ImageToolOptions {
  /** Maximum image size in bytes. Defaults to 5 MB (5 * 1024 * 1024). */
  maxBytes?: number;
  /**
   * Sniffed MIME types the tool attaches. Defaults to PNG, JPEG, GIF,
   * and WebP — the four formats every mainstream provider accepts.
   */
  allowedMimeTypes?: string[];
}

/** Default maximum image size: 5 MB, the strictest mainstream provider cap. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** MIME types the magic-byte sniffer can detect. */
const SNIFFABLE_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
];

/** Magic-byte signatures of the supported image formats. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF87a_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]; // "GIF87a"
const GIF89a_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // "GIF89a"
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50]; // "WEBP", at offset 8

/** Create a tool that reads an image file and attaches it for the model.
 *
 * The `read_image` tool loads the requested path, sniffs the image's
 * MIME type from magic bytes — the file extension is never trusted —
 * and returns it as a base64 {@linkcode FileContent} part on the tool
 * result, ready for provider-native delivery. Files larger than
 * `maxBytes` (5 MB by default) fail fast with a descriptive error
 * instead of surfacing opaque provider errors at request time.
 *
 * @example
 * ```typescript
 * import { agent } from "jsr:@huuma/ai/agent";
 * import { openai } from "jsr:@huuma/ai/models/openai";
 * import { image } from "jsr:@huuma/ai/tools";
 *
 * const assistant = agent({
 *   model: openai({ apiKey: Deno.env.get("OPENAI_API_KEY") }),
 *   modelId: "gpt-5.5",
 *   systemPrompt: "You describe images concisely.",
 *   tools: [image()],
 * });
 *
 * // The model calls read_image with { path: "./photo.png" } and the
 * // image arrives as an image/png file part on the tool result.
 * const messages = await assistant.run("What is in ./photo.png?");
 * ```
 *
 * @param options Optional size cap and allowed MIME types.
 * @returns A {@link Tool} that attaches image files to its tool results.
 */
export function image(
  {
    maxBytes = DEFAULT_MAX_BYTES,
    allowedMimeTypes = SNIFFABLE_IMAGE_MIME_TYPES,
  }: ImageToolOptions = {},
  // deno-lint-ignore no-explicit-any
): Tool<any, ToolOutput<string>> {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Image maxBytes must be a finite, positive number");
  }

  return tool({
    name: "read_image",
    description:
      "Read an image file from the file system and attach it so you can see it. Supported formats: PNG, JPEG, GIF, WebP.",
    input: object({
      path: string(),
    }),
    fn: async ({ path }, context) => {
      throwIfAborted(context.signal);

      let stat: Deno.FileInfo;
      try {
        stat = await Deno.stat(path);
      } catch (error) {
        throw mapFileSystemError(error, path);
      }

      if (stat.isDirectory) {
        throw new Error(`Path is a directory, not a file: ${path}`);
      }

      if (stat.size > maxBytes) {
        throw new Error(
          `Image too large: ${path} is ${stat.size} bytes, which exceeds the ${maxBytes} byte limit.`,
        );
      }

      throwIfAborted(context.signal);

      let bytes: Uint8Array;
      try {
        bytes = await Deno.readFile(path);
      } catch (error) {
        throw mapFileSystemError(error, path);
      }

      // The file may have grown between stat and read, so re-check the
      // actual byte count before encoding it into the conversation.
      if (bytes.byteLength > maxBytes) {
        throw new Error(
          `Image too large: ${path} is ${bytes.byteLength} bytes, which exceeds the ${maxBytes} byte limit.`,
        );
      }

      const mimeType = sniffImageMime(bytes);
      if (mimeType === undefined) {
        throw new Error(
          `Unsupported image format: ${path}. Supported formats: ${
            SNIFFABLE_IMAGE_MIME_TYPES.join(", ")
          }.`,
        );
      }

      if (!allowedMimeTypes.includes(mimeType)) {
        throw new Error(
          `Image type not allowed: ${path} is ${mimeType}. Allowed types: ${
            allowedMimeTypes.join(", ")
          }.`,
        );
      }

      const data = encodeBase64(bytes);
      return toolOutput(
        `Image loaded: ${path} (${mimeType}, ${bytes.byteLength} bytes).`,
        [{ file: { mimeType, data } }],
      );
    },
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

/** Sniff an image's MIME type from its magic bytes.
 *
 * Only header bytes are inspected — the tool never decodes pixel data.
 * Returns `undefined` when the bytes match no supported format.
 */
function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (hasPrefix(bytes, PNG_SIGNATURE)) return "image/png";
  if (hasPrefix(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (
    hasPrefix(bytes, GIF87a_SIGNATURE) || hasPrefix(bytes, GIF89a_SIGNATURE)
  ) {
    return "image/gif";
  }
  if (hasPrefix(bytes, RIFF_SIGNATURE) && hasPrefix(bytes, WEBP_SIGNATURE, 8)) {
    return "image/webp";
  }
  return undefined;
}

function hasPrefix(
  bytes: Uint8Array,
  signature: number[],
  offset = 0,
): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** Map file-system errors to descriptive tool errors, mirroring readFile(). */
function mapFileSystemError(error: unknown, path: string): unknown {
  if (error instanceof Deno.errors.NotFound) {
    return new Error(`Image not found: ${path}`);
  }
  if (error instanceof Deno.errors.PermissionDenied) {
    return new Error(
      `Permission denied: ${path}. Make sure to run with --allow-read.`,
    );
  }
  if (error instanceof Deno.errors.IsADirectory) {
    return new Error(`Path is a directory, not a file: ${path}`);
  }
  return error;
}
