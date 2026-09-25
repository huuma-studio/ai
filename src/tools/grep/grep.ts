import { boolean, object, string } from "@huuma/validate";
import { Tool } from "@/tools/mod.ts";
import {
  cappedLine,
  type LineBuilder,
  readLines,
} from "@/tools/bounded_text.ts";

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
/** Most characters kept of the file name or line number in grep's output. */
const MAX_FIELD_LENGTH = 64 * 1024;
/** Most lines of grep's error output reported, and characters of each. */
const MAX_ERROR_LINES = 5;
const MAX_ERROR_LINE_LENGTH = 500;

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
      const run = await runGrep(
        grepArgs({ pattern, path, glob, caseSensitive, isDir }),
        isDir ? 2 : 1,
        collector,
        signal,
      );

      const failure = searchFailure(run);
      if (failure) throw new Error(failure);
      if (!run.stopped && run.code === 1) {
        return { path, results: [], message: "No matches found" };
      }
      return collector.result(run.stopped);
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

/** One line of grep's output: the fields before the content — the file
 * and line number, or just the line number — and the content. */
interface OutputLine {
  fields: string[];
  content: string;
}

/**
 * A {@linkcode LineBuilder} parsing grep's output lines as they arrive:
 * `fieldCount` colon-terminated fields, then the matching line's content.
 * The content's leading whitespace is skipped before anything is kept, and
 * only `MAX_LINE_LENGTH` characters of it are, so neither deep indentation
 * nor a huge line can crowd out the match. A line without all its fields is
 * finished as `undefined`.
 */
function outputLine(fieldCount: number): LineBuilder<OutputLine | undefined> {
  let fields: string[] = [];
  let field = "";
  let content = "";
  let more = false;

  return {
    append(text) {
      let index = 0;
      while (fields.length < fieldCount) {
        const colon = text.indexOf(":", index);
        const end = colon === -1 ? text.length : colon;
        field += text.slice(index, end).slice(
          0,
          MAX_FIELD_LENGTH - field.length,
        );
        if (colon === -1) return;
        fields.push(field);
        field = "";
        index = colon + 1;
      }
      if (more) return;
      if (content === "") {
        while (index < text.length && /\s/.test(text[index])) index++;
      }
      const room = MAX_LINE_LENGTH - content.length;
      content += text.slice(index, index + room);
      // Anything but whitespace past the kept part means the line is cut.
      if (/\S/.test(text.slice(index + room))) more = true;
    },
    finish() {
      const line = fields.length === fieldCount
        ? { fields, content: more ? `${content}…` : content.trimEnd() }
        : undefined;
      fields = [];
      field = "";
      content = "";
      more = false;
      return line;
    },
  };
}

/** Collects matches from grep's output lines, one line at a time. */
interface MatchCollector {
  /** Add one output line. Returns false once the match cap is reached and
   * the line did not fit, so the search can stop. */
  add(line: OutputLine): boolean;
  /** The result, marked truncated when the search stopped at the cap. */
  result(stopped: boolean): GrepResult;
}

/** How a grep run ended. */
export interface GrepRun {
  /** grep's exit code; meaningless when the search was stopped. */
  code: number;
  /** Whether the search was stopped once the match cap was reached. */
  stopped: boolean;
  /** The start of grep's error output. */
  errors: string[];
}

/**
 * Run grep and feed its output to `collector` line by line, stopping grep
 * as soon as the collector is full. Only the collected matches and the
 * kept part of one output line are ever held. grep's error output is read
 * alongside, keeping only its start. The signal kills grep and rejects the
 * call.
 */
async function runGrep(
  args: string[],
  fieldCount: number,
  collector: MatchCollector,
  signal: AbortSignal,
): Promise<GrepRun> {
  const child = new Deno.Command("grep", {
    args,
    signal,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  // Drained to the end, so grep never blocks on a full error pipe.
  const errors = errorLines(child.stderr);

  let stopped = false;
  try {
    for await (const line of readLines(child.stdout, outputLine(fieldCount))) {
      if (line === undefined) continue;
      if (!collector.add(line)) {
        stopped = true;
        break;
      }
    }
  } catch (error) {
    killQuietly(child);
    await Promise.all([child.status, errors]);
    throw error;
  }
  // grep that ran to the end exits on its own; one stopped at the cap is
  // still searching. An abort has killed it already.
  if (stopped) killQuietly(child);
  const [{ code }, errorOutput] = await Promise.all([child.status, errors]);
  signal.throwIfAborted();
  return { code, stopped, errors: errorOutput };
}

/** The first lines of grep's error output. */
async function errorLines(
  stream: ReadableStream<Uint8Array>,
): Promise<string[]> {
  const lines: string[] = [];
  const builder = cappedLine(MAX_ERROR_LINE_LENGTH);
  for await (const line of readLines(stream, builder)) {
    if (lines.length < MAX_ERROR_LINES) lines.push(line);
  }
  return lines;
}

/**
 * Why a grep run failed, or `undefined` if it did not. Exit code 1 means no
 * matches and anything above it an error. A search stopped at the cap was
 * killed, so its exit code means nothing; errors grep reported before it
 * was stopped — an unreadable file, say — still fail it rather than being
 * hidden behind the matches found elsewhere. Warnings, which grep prints
 * for searches that succeed, do not.
 */
export function searchFailure(
  { code, stopped, errors }: GrepRun,
): string | undefined {
  const detail = errors.length > 0 ? `: ${errors.join("; ")}` : "";
  if (stopped) {
    const failed = errors.some((line) => !WARNING.test(line));
    return failed ? `grep reported errors${detail}` : undefined;
  }
  return code > 1 ? `grep exited with code ${code}${detail}` : undefined;
}

/** A warning line from grep, whatever program name it is prefixed with. */
const WARNING = /^[^:]*: warning: /;

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
    add({ fields: [file, lineNum], content }) {
      if (total >= MAX_MATCHES) return false;

      if (!fileMap.has(file)) fileMap.set(file, []);
      const matches = fileMap.get(file)!;

      if (matches.length >= MAX_PER_FILE) return true;

      matches.push({ line: parseInt(lineNum, 10), content });
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
    add({ fields: [lineNum], content }) {
      if (matches.length >= MAX_MATCHES) return false;
      matches.push({ line: parseInt(lineNum, 10), content });
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
