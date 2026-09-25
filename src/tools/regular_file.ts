/**
 * Opening files for reading, shared by the tools that read files from disk.
 *
 * @module
 */

/** A regular file opened for reading, and its size when it was opened. */
export interface OpenedFile {
  file: Deno.FsFile;
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
export async function openRegularFile(
  path: string,
  subject = "File",
): Promise<OpenedFile> {
  try {
    assertRegularFile(await Deno.stat(path), path);
    const file = await Deno.open(path, { read: true });
    try {
      const info = await file.stat();
      assertRegularFile(info, path);
      return { file, size: info.size };
    } catch (error) {
      file.close();
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
export function mapReadError(
  error: unknown,
  path: string,
  subject = "File",
): unknown {
  if (error instanceof Deno.errors.NotFound) {
    return new Error(`${subject} not found: ${path}`);
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

function assertRegularFile(info: Deno.FileInfo, path: string): void {
  if (info.isDirectory) {
    throw new Error(`Path is a directory, not a file: ${path}`);
  }
  if (!info.isFile) {
    throw new Error(`Path is not a regular file: ${path}`);
  }
}
