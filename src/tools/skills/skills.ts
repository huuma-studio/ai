/**
 * Skills tool factory — progressive disclosure of Agent-Skills-style
 * `SKILL.md` folders.
 *
 * A skill is a folder containing `SKILL.md` (YAML frontmatter with `name`
 * and `description` plus a markdown body of procedural instructions) and
 * optionally bundled resources (`scripts/`, `references/`, templates) the
 * body references by relative path. The factory exposes two tools:
 *
 * - `list_skills` returns cheap `{ name, description }` pairs.
 * - `retrieve_skill` loads one skill's full instructions and the skill
 *   folder's absolute `path` so an agent equipped with `files`/`grep`/`cli`
 *   tools can resolve relative references on demand.
 *
 * Loading is **lenient**: a missing skills directory yields an empty list,
 * a folder without `SKILL.md` is skipped silently, and every other failure
 * (unreadable file, YAML error, missing or invalid frontmatter, duplicate
 * name) is reported through the `onWarning` callback and skipped — skills
 * authored for other ecosystems keep loading. The scan runs once per
 * factory and is cached for the factory's lifetime; a rejected scan (e.g.
 * `path` points at a file, or a permission error) resets the cache so the
 * next call retries. Construct a new factory to re-scan disk.
 *
 * Requires `--allow-read` for the skills directory.
 *
 * @example
 * ```typescript
 * import { agent } from "jsr:@huuma/ai/agent";
 * import { skills } from "jsr:@huuma/ai/tools";
 *
 * const [listSkills, retrieveSkill] = skills({ path: "./skills" });
 *
 * const assistant = agent({
 *   // ...
 *   tools: [listSkills, retrieveSkill],
 * });
 * ```
 *
 * @module
 */
import { array, object, string, undef, union, unknown } from "@huuma/validate";
import { extract } from "@std/front-matter/yaml";
import { join, resolve } from "@std/path";
import { tool, type Tool } from "@/tools/mod.ts";

const skillFrontmatterSchema = object({
  name: string().notEmpty(),
  description: string().notEmpty(),
  license: string().optional(),
  compatibility: string().optional(),
  // `unknown()` passes the author's map through verbatim; `object({})`
  // would strip unknown keys, and a non-object would reject the skill.
  metadata: unknown(),
  // The spec allows a YAML list; some hosts use a string. `undef()` makes
  // the field optional (the pinned `@huuma/validate` has no `.optional()`
  // on `UnionSchema`).
  "allowed-tools": union([string(), array(string()), undef()]),
});

/** Validated frontmatter of a `SKILL.md`. */
export interface SkillFrontmatter {
  /** Skill name (matches the folder name by convention). */
  name: string;
  /** When this skill applies — the model uses this to decide relevance. */
  description: string;
  /** Optional SPDX license identifier. */
  license?: string;
  /** Optional host compatibility constraint. */
  compatibility?: string;
  /** Arbitrary author-defined map, passed through verbatim. */
  metadata?: unknown;
  /** Tools the skill expects, string or list form, not enforced. */
  "allowed-tools"?: string | string[];
}

/** A loaded skill: its folder name, absolute path, frontmatter, and body. */
export interface SkillInfo {
  /** Skill folder name (not exposed to the model). */
  folder: string;
  /** Absolute path of the skill folder on disk. */
  path: string;
  /** Validated frontmatter. */
  frontmatter: SkillFrontmatter;
  /** Markdown body — the procedural instructions. */
  body: string;
}

/** Options for configuring the {@link skills} factory. */
export interface SkillsToolOptions {
  /** Path to the skills directory (default `"./skills"`). Resolved to an
   * absolute path eagerly at factory time. */
  path?: string;
  /** Callback for load diagnostics (default `console.warn`). Each message
   * includes the offending `SKILL.md` path and the reason. */
  onWarning?: (message: string) => void;
}

/** Create the `list_skills` and `retrieve_skill` tool pair.
 *
 * The returned tuple is spread into an `agent`'s `tools`. The scan runs
 * once and is cached for the factory's lifetime; a rejected scan resets the
 * cache so the next call retries. Construct a new factory to re-scan disk.
 *
 * @example
 * ```typescript
 * import { skills } from "jsr:@huuma/ai/tools";
 *
 * const [listSkills, retrieveSkill] = skills({
 *   path: "./skills",
 *   onWarning: (message) => console.error(message),
 * });
 * ```
 *
 * @param options Configuration including the skills directory path and a
 * warning callback.
 * @returns A `[listSkills, retrieveSkill]` tuple of {@link Tool}s.
 */
// deno-lint-ignore no-explicit-any
type SkillsToolPair = readonly [Tool<any, unknown>, Tool<any, unknown>];

export function skills(
  { path = "./skills", onWarning = console.warn }: SkillsToolOptions = {},
): SkillsToolPair {
  const root = resolve(path);
  let loading: Promise<SkillInfo[]> | null = null;

  function loadSkills(): Promise<SkillInfo[]> {
    // Cache the in-flight promise: a model turn's tool calls run
    // concurrently (Promise.allSettled), so caching the finished array
    // would double-scan. A rejected scan resets the cache so the next
    // call retries; a successful scan (including the empty result for a
    // missing directory) is cached for the factory's lifetime.
    loading ??= scan().catch((error) => {
      loading = null;
      throw error;
    });
    return loading;
  }

  async function scan(): Promise<SkillInfo[]> {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(root)) {
        entries.push(entry);
      }
    } catch (error) {
      // A missing skills directory is not an error: yield an empty list.
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      // Anything else (path points at a file, permission error) rejects
      // the scan; loadSkills resets the cache so the next call retries.
      throw error;
    }

    // Collect directory entries, following symlinks (a symlink to a
    // directory reports `isDirectory: false`). A broken symlink throws
    // `NotFound` from `stat` and is skipped silently.
    const folders: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory) {
        folders.push(entry.name);
      } else if (entry.isSymlink) {
        try {
          const stat = await Deno.stat(join(root, entry.name));
          if (stat.isDirectory) folders.push(entry.name);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          continue;
        }
      }
    }

    // Deterministic order: listings are stable and duplicate frontmatter
    // names resolve to the sorted-first folder.
    folders.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);

    const loaded: SkillInfo[] = [];
    const seenNames = new Set<string>();

    for (const folderName of folders) {
      await processFolder(folderName);
    }

    return loaded;

    async function processFolder(folderName: string) {
      const skillMdPath = join(root, folderName, "SKILL.md");

      let content: string;
      try {
        content = await Deno.readTextFile(skillMdPath);
      } catch (error) {
        // A folder without `SKILL.md` is not a skill — skip silently.
        if (error instanceof Deno.errors.NotFound) return;
        onWarning(`Failed to read ${skillMdPath}: ${describe(error)}`);
        return;
      }

      let attrs: unknown;
      let body: string;
      try {
        ({ attrs, body } = extract(content));
      } catch (error) {
        onWarning(
          `Failed to parse frontmatter in ${skillMdPath}: ${describe(error)}`,
        );
        return;
      }

      const validation = skillFrontmatterSchema.validate(attrs);
      if (validation.errors) {
        onWarning(
          `Invalid frontmatter in ${skillMdPath}: ${
            validation.errors.map((e) => e.message).join("; ")
          }`,
        );
        return;
      }

      const frontmatter = validation.value;
      if (seenNames.has(frontmatter.name)) {
        onWarning(
          `Duplicate skill name "${frontmatter.name}" in ${skillMdPath}; keeping the first in sorted order`,
        );
        return;
      }
      seenNames.add(frontmatter.name);

      loaded.push({
        folder: folderName,
        path: join(root, folderName),
        frontmatter,
        body,
      });
    }
  }

  const listSkills = tool({
    name: "list_skills",
    description:
      "Lists the skills available to you. Skills are folders of procedural instructions for specialized tasks; each entry has a name and a description of when it applies. When a user request matches a skill's description, call retrieve_skill with its name and follow the returned instructions instead of improvising the task yourself.",
    input: object({}),
    fn: async () => {
      const loaded = await loadSkills();
      return loaded.map(({ frontmatter }) => ({
        name: frontmatter.name,
        description: frontmatter.description,
      }));
    },
  });

  const retrieveSkill = tool({
    name: "retrieve_skill",
    description:
      "Retrieves the full instructions for a skill by name (use list_skills to see what is available). The result contains `instructions` to follow and `path`, the skill's directory on disk. Relative file references in the instructions (scripts, references, templates) resolve against `path` — read those files with your other tools when the instructions call for them.",
    input: object({
      name: string().notEmpty(),
    }),
    fn: async ({ name }) => {
      const loaded = await loadSkills();
      const skill = loaded.find((s) => s.frontmatter.name === name) ??
        loaded.find((s) => s.folder === name);

      if (!skill) {
        const available = loaded.map((s) => s.frontmatter.name).join(", ");
        throw new Error(
          `Skill "${name}" not found. Available skills: ${available}`,
        );
      }

      return {
        name: skill.frontmatter.name,
        description: skill.frontmatter.description,
        path: skill.path,
        metadata: skill.frontmatter.metadata,
        "allowed-tools": skill.frontmatter["allowed-tools"],
        instructions: skill.body,
      };
    },
  });

  return [listSkills, retrieveSkill] as const;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}