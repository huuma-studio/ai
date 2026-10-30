/** Whether `error` is a Node.js system error with one of the given codes.
 *
 * @param error Caught value.
 * @param codes System error codes such as `ENOENT` or `EACCES`.
 * @returns `true` when the error's `code` is one of `codes`.
 */
export function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(error.code as string);
}

/** Codes Node.js reports for a missing path. */
export const NOT_FOUND = "ENOENT";
/** Codes Node.js reports for a denied file-system operation. */
export const PERMISSION_DENIED: string[] = ["EACCES", "EPERM"];
/** Code Node.js reports when a file operation hits a directory. */
export const IS_A_DIRECTORY = "EISDIR";
/** Code Node.js reports when a path already exists. */
export const ALREADY_EXISTS = "EEXIST";
