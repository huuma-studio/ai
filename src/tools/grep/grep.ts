import { boolean, object, string } from "@huuma/validate";
import { Tool } from "@/tools/mod.ts";

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
  /** Total number of raw matches before truncation, when known. */
  totalMatches?: number;
  /** Optional informational message. */
  message?: string;
}

/** Create a tool that searches files with grep.
 *
 * @returns A {@link Tool} that performs recursive regex searches and returns grouped matches.
 */
// deno-lint-ignore no-explicit-any
export function grep(): Tool<any, GrepResult> {
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
    fn: async ({ pattern, path, glob, caseSensitive }) => {
      const MAX_MATCHES = 100;
      const MAX_PER_FILE = 10;
      const MAX_LINE_LENGTH = 200;

      const isDir = await Deno.stat(path)
        .then((s) => s.isDirectory)
        .catch(() => false);

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

      // Terminate option processing so the user-supplied pattern and path
      // are always treated as positional arguments, preventing option injection
      // (e.g. a pattern starting with "-" from becoming a grep flag).
      args.push("--", pattern, path);

      const cmd = new Deno.Command("grep", { args });
      const { code, stdout } = await cmd.output();

      if (code === 1) {
        return { path, results: [], message: "No matches found" };
      }

      if (code !== 0) {
        throw new Error(`grep exited with code ${code}`);
      }

      const output = new TextDecoder().decode(stdout);
      const lines = output
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);

      if (isDir) {
        return parseDirectoryResults(
          lines,
          path,
          MAX_MATCHES,
          MAX_PER_FILE,
          MAX_LINE_LENGTH,
        );
      }

      return parseSingleFileResults(
        lines,
        path,
        MAX_MATCHES,
        MAX_LINE_LENGTH,
      );
    },
  });
}

function truncateLine(content: string, max: number): string {
  return content.length > max ? content.slice(0, max) + "…" : content;
}

function parseDirectoryResults(
  lines: string[],
  path: string,
  maxTotal: number,
  maxPerFile: number,
  maxLineLength: number,
): GrepResult {
  const fileMap = new Map<string, GrepMatch[]>();
  let total = 0;
  let stopped = false;

  for (const line of lines) {
    if (total >= maxTotal) {
      stopped = true;
      break;
    }

    const firstColon = line.indexOf(":");
    if (firstColon === -1) continue;
    const secondColon = line.indexOf(":", firstColon + 1);
    if (secondColon === -1) continue;

    const file = line.slice(0, firstColon);
    const lineNum = parseInt(line.slice(firstColon + 1, secondColon), 10);
    const content = line.slice(secondColon + 1).trim();

    if (!fileMap.has(file)) fileMap.set(file, []);
    const matches = fileMap.get(file)!;

    if (matches.length >= maxPerFile) continue;

    matches.push({
      line: lineNum,
      content: truncateLine(content, maxLineLength),
    });
    total++;
  }

  const results: GrepFileResult[] = [];
  for (const [file, matches] of fileMap) {
    results.push({ file, matches });
  }

  return {
    path,
    results,
    ...(stopped && {
      truncated: true,
      totalMatches: lines.length,
      message:
        `Results truncated to ${maxTotal} matches. Use a more specific pattern or path to narrow results.`,
    }),
  };
}

function parseSingleFileResults(
  lines: string[],
  path: string,
  maxTotal: number,
  maxLineLength: number,
): GrepResult {
  const truncated = lines.length > maxTotal;
  const matches: GrepMatch[] = lines
    .slice(0, maxTotal)
    .map((line) => {
      const colonIndex = line.indexOf(":");
      const content = line.slice(colonIndex + 1).trim();
      return {
        line: parseInt(line.slice(0, colonIndex), 10),
        content: truncateLine(content, maxLineLength),
      };
    });

  return {
    path,
    results: [{ file: path, matches }],
    ...(truncated && {
      truncated: true,
      totalMatches: lines.length,
      message: `Results truncated to ${maxTotal} of ${lines.length} matches`,
    }),
  };
}
