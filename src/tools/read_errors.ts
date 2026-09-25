/**
 * Error messages shared by the tools that read files from disk.
 *
 * @module
 */

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
