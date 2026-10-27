/**
 * Opening files for reading, shared by the tools that read files from disk.
 *
 * @module
 */
import type { Stats } from "node:fs";
import { type FileHandle, open, stat } from "node:fs/promises";
import { hasErrorCode, IS_A_DIRECTORY, NOT_FOUND, PERMISSION_DENIED } from "./fs_errors.ts";

/** A regular file opened for reading, and its size when it was opened. */
export interface OpenedFile {
  file: FileHandle;
  size: number;
}

/**
 * Open the regular file at `path` for reading.
 *
 * FIFOs and device nodes are rejected before they are opened: opening a
 * FIFO blocks until a writer appears, and reading one or a device like
 * `/dev/zero` may wait or run forever — and a read already waiting on the
 * operating system cannot be interrupted, not even by an abort. Regular
 * files always reach their end.
 *
 * The path can be swapped for a special file between that check and the
 * open, so the opened handle is checked again; every read runs against
 * that verified handle. The caller owns the returned file.
 *
 * @param subject What the path is expected to be, e.g. `File` or `Image`,
 * naming it in the not-found message.
 */
export async function openRegularFile(path: string, subject = "File"): Promise<OpenedFile> {
  try {
    assertRegularFile(await stat(path), path);
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      assertRegularFile(info, path);
      return { file, size: info.size };
    } catch (error) {
      await file.close();
      throw error;
    }
  } catch (error) {
    throw mapReadError(error, path, subject);
  }
}

/** Turn a file-system error from reading `path` into a message the model
 * can act on. Other errors are returned unchanged.
 *
 * @param subject What the path was expected to be, e.g. `File` or `Image`,
 * naming it in the not-found message.
 */
export function mapReadError(error: unknown, path: string, subject = "File"): unknown {
  if (hasErrorCode(error, NOT_FOUND)) {
    return new Error(`${subject} not found: ${path}`);
  }
  if (hasErrorCode(error, ...PERMISSION_DENIED)) {
    return new Error(`Permission denied: ${path}`);
  }
  if (hasErrorCode(error, IS_A_DIRECTORY)) {
    return new Error(`Path is a directory, not a file: ${path}`);
  }
  return error;
}

function assertRegularFile(info: Stats, path: string): void {
  if (info.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${path}`);
  }
  if (!info.isFile()) {
    throw new Error(`Path is not a regular file: ${path}`);
  }
}
