import { boolean, object, string } from "@huuma/validate";
import { Tool } from "@/tools/mod.ts";
import { readLines } from "@/tools/bounded_text.ts";

/** A single grep match with line number and content. */
export interface GrepMatch {
  /** 1-indexed line number where the match occurred. */
  line: number;
  /** Matching line content, possibly truncated. */
  content: string;
}

/** Grouped grep matches for one file. */
export interface GrepFileResult {
  /** Path to the matched file. */
  file: string;
  /** Matches found in the file. */
  matches: GrepMatch[];
}

/** Result returned by the grep tool. */
export interface GrepResult {
  /** Searched path. */
  path: string;
  /** Matching files and lines. */
  results: GrepFileResult[];
  /** Whether results were truncated to keep output concise. */
  truncated?: boolean;
  /**
   * Total number of raw matches before truncation, when known.
   *
   * @deprecated No longer reported: the search stops once the match cap is
   * reached, so the total is not known.
   */
  totalMatches?: number;
  /** Optional informational message. */
  message?: string;
}

/** Options for configuring the grep tool. */
export interface GrepOptions {
  /** Maximum duration of each search in milliseconds. Defaults to 30s. */
  timeout?: number;
}

/** Default maximum duration of a search. */
export const DEFAULT_GREP_TIMEOUT = 30_000;

/** Most matches returned in total. */
const MAX_MATCHES = 100;
/** Most matches returned per file when searching a directory. */
const MAX_PER_FILE = 10;
/** Most characters of a matching line returned. */
const MAX_LINE_LENGTH = 200;
/**
 * Most characters of a line of grep's output kept while reading it. The
 * line holds the file name and line number before the content, whose
 * leading whitespace is trimmed before it is cut to `MAX_LINE_LENGTH` —
 * so this leaves ample room, while a huge line (minified code, say) never
 * has to be held whole.
 */
const MAX_OUTPUT_LINE_LENGTH = 64 * 1024;

/** Create a tool that searches files with grep.
 *
 * The search is bounded: grep's output is read as it arrives and the
 * search is stopped as soon as the match cap is reached, instead of
 * buffering everything grep finds. Each search is cancelled after
 * `timeout`, or when the caller aborts.
 *
 * @param options Optional timeout.
 * @returns A {@link Tool} that performs recursive regex searches and returns grouped matches.
 */
// deno-lint-ignore no-explicit-any
export function grep(options?: GrepOptions): Tool<any, GrepResult> {
  return new Tool({
    name: "grep",
    description:
      "Search for a regex pattern in a file or directory. Searches recursively when given a directory path. Returns matching lines grouped by file with line numbers. Results are capped at 10 matches per file and 100 total matches to keep output concise. Use the glob parameter to filter by file extension (e.g. '*.ts'). Matching is case-insensitive by default.",
    input: object({
      pattern: string(),
      path: string(),
      glob: string().optional(),
      caseSensitive: boolean().optional(),
    }),
    timeout: options?.timeout ?? DEFAULT_GREP_TIMEOUT,
    fn: async ({ pattern, path, glob, caseSensitive }, { signal }) => {
      const isDir = await Deno.stat(path)
        .then((s) => s.isDirectory)
        .catch(() => false);

      const collector = isDir ? directoryMatches(path) : fileMatches(path);
      const { code, stopped } = await runGrep(
        grepArgs({ pattern, path, glob, caseSensitive, isDir }),
        collector,
        signal,
      );

      // A search stopped at the cap was killed; its exit code means nothing.
      if (!stopped) {
        if (code === 1) {
          return { path, results: [], message: "No matches found" };
        }
        if (code !== 0) {
          throw new Error(`grep exited with code ${code}`);
        }
      }
      return collector.result(stopped);
    },
  });
}

/** Build grep's arguments for a search. */
function grepArgs(
  { pattern, path, glob, caseSensitive, isDir }: {
    pattern: string;
    path: string;
    glob?: string;
    caseSensitive?: boolean;
    isDir: boolean;
  },
): string[] {
  const args = ["-n", "--binary-files=without-match"];

  if (!caseSensitive) args.push("-i");

  if (isDir) {
    args.push("-r");
    args.push(
      "--exclude-dir=node_modules",
      "--exclude-dir=.git",
      "--exclude-dir=dist",
      "--exclude-dir=build",
      "--exclude-dir=coverage",
    );
    if (glob) args.push(`--include=${glob}`);
  }

  // Let grep itself stop reading a file once it has found enough: past the
  // per-file cap in a directory, or one past the total cap in a single file
  // (the extra match shows the results were truncated).
  args.push(`--max-count=${isDir ? MAX_PER_FILE : MAX_MATCHES + 1}`);

  // Terminate option processing so the user-supplied pattern and path
  // are always treated as positional arguments, preventing option injection
  // (e.g. a pattern starting with "-" from becoming a grep flag).
  args.push("--", pattern, path);
  return args;
}

/** Collects matches from grep's output lines, one line at a time. */
interface MatchCollector {
  /** Add one output line. Returns false once the match cap is reached and
   * the line did not fit, so the search can stop. */
  add(line: string): boolean;
  /** The result, marked truncated when the search stopped at the cap. */
  result(stopped: boolean): GrepResult;
}

/**
 * Run grep and feed its output to `collector` line by line, stopping grep
 * as soon as the collector is full. Only the collected matches and one
 * output line are ever held. The signal kills grep and rejects the call.
 */
async function runGrep(
  args: string[],
  collector: MatchCollector,
  signal: AbortSignal,
): Promise<{ code: number; stopped: boolean }> {
  const child = new Deno.Command("grep", {
    args,
    signal,
    stdin: "null",
    stdout: "piped",
    stderr: "null",
  }).spawn();

  let stopped = false;
  try {
    for await (const line of readLines(child.stdout, MAX_OUTPUT_LINE_LENGTH)) {
      if (line.length === 0) continue;
      if (!collector.add(line)) {
        stopped = true;
        break;
      }
    }
  } catch (error) {
    killQuietly(child);
    await child.status;
    throw error;
  }
  // grep that ran to the end exits on its own; one stopped at the cap is
  // still searching. An abort has killed it already.
  if (stopped) killQuietly(child);
  const { code } = await child.status;
  signal.throwIfAborted();
  return { code, stopped };
}

/** Kill `child` unless it has already exited. */
function killQuietly(child: Deno.ChildProcess): void {
  try {
    child.kill();
  } catch {
    // Already exited.
  }
}

/** Matches from a recursive search, grouped by file. */
function directoryMatches(path: string): MatchCollector {
  const fileMap = new Map<string, GrepMatch[]>();
  let total = 0;

  return {
    add(line) {
      if (total >= MAX_MATCHES) return false;

      const firstColon = line.indexOf(":");
      if (firstColon === -1) return true;
      const secondColon = line.indexOf(":", firstColon + 1);
      if (secondColon === -1) return true;

      const file = line.slice(0, firstColon);
      const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
      const content = line.slice(secondColon + 1).trim();

      if (!fileMap.has(file)) fileMap.set(file, []);
      const matches = fileMap.get(file)!;

      if (matches.length >= MAX_PER_FILE) return true;

      matches.push({
        line: lineNum,
        content: truncateLine(content, MAX_LINE_LENGTH),
      });
      total++;
      return true;
    },
    result(stopped) {
      const results: GrepFileResult[] = [];
      for (const [file, matches] of fileMap) {
        results.push({ file, matches });
      }
      return {
        path,
        results,
        ...(stopped && {
          truncated: true,
          message:
            `Results truncated to ${MAX_MATCHES} matches. Use a more specific pattern or path to narrow results.`,
        }),
      };
    },
  };
}

/** Matches from a search of a single file. */
function fileMatches(path: string): MatchCollector {
  const matches: GrepMatch[] = [];

  return {
    add(line) {
      if (matches.length >= MAX_MATCHES) return false;
      const colonIndex = line.indexOf(":");
      const content = line.slice(colonIndex + 1).trim();
      matches.push({
        line: parseInt(line.slice(0, colonIndex), 10),
        content: truncateLine(content, MAX_LINE_LENGTH),
      });
      return true;
    },
    result(stopped) {
      return {
        path,
        results: [{ file: path, matches }],
        ...(stopped && {
          truncated: true,
          message:
            `Results truncated to the first ${MAX_MATCHES} matches. Use a more specific pattern to narrow results.`,
        }),
      };
    },
  };
}

function truncateLine(content: string, max: number): string {
  return content.length > max ? content.slice(0, max) + "…" : content;
}
