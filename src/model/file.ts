/**
 * Shared helpers for handling {@link FileContent} sources in model adapters.
 *
 * @module
 */
import type { FileContent } from "../mod.ts";

/** Resolved file source: inline base64 data or a URL reference. */
export type FileSource =
  | { kind: "data"; data: string }
  | { kind: "url"; url: string };

/**
 * Resolves the source of a file content part.
 *
 * Enforces the `FileContent` invariant that exactly one of `data`/`url` is
 * set; an empty string counts as unset.
 *
 * @param file File payload of a {@link FileContent} part.
 * @returns The inline data or URL source.
 * @throws {RangeError} When both or neither of `data`/`url` are set.
 */
export function fileSourceFrom(file: FileContent["file"]): FileSource {
  const hasData = !!file.data;
  const hasUrl = !!file.url;

  if (hasData === hasUrl) {
    throw new RangeError("file content requires exactly one of data or url");
  }

  return hasData
    ? { kind: "data", data: file.data as string }
    : { kind: "url", url: file.url as string };
}

/**
 * Composes a data URL from a file content part's base64 data.
 *
 * @param file File payload of a {@link FileContent} part.
 * @returns `data:<mimeType>;base64,<data>`.
 * @throws {RangeError} When the file carries no inline data.
 */
export function dataUrlFrom(file: FileContent["file"]): string {
  if (!file.data) {
    throw new RangeError("file content has no data to compose a data URL");
  }
  return `data:${file.mimeType};base64,${file.data}`;
}

/**
 * Labels tool-returned files in the synthetic user message emitted by
 * adapters without native tool-result media support (ADR 0004).
 *
 * The wording is a presentation detail, not stable API — consumers must
 * not parse it, and it may change without a version bump.
 *
 * @param name Tool name that produced the files.
 * @param id Identifier of the tool call the files belong to.
 * @returns The label text placed before the mapped file parts.
 */
export function toolFilesLabel(name: string, id: string): string {
  return `Files returned by tool "${name}" (call ${id}):`;
}
