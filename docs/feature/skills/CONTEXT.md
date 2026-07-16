# Skills tool hardening — review context

- **Date:** 2026-07-16
- **Status:** Review complete, implementation planned

Goal: make the existing `skills()` factory (`src/tools/skills/skills.ts`,
landed in the initial tool batch with no review, tests, docs, or barrel
export) production-ready: correct loading of Agent-Skills-style `SKILL.md`
folders, misconfiguration surfaced instead of swallowed, bundled skill
resources reachable by agents, exported from `@huuma/ai/tools`.

## 1. Current implementation review

Eighteen findings, numbered for reference from PLAN.md and ADR 0005.

### Correctness

1. **Not exported from the tools barrel.** `src/tools/mod.ts` re-exports
   every factory except `skills` — the module is dead code for JSR
   consumers. (`skills.ts:23`)
2. **Metadata silently stripped.** `metadata: object({})` validates against
   an empty key set, and `ObjectSchema.validate` copies only
   schema-declared keys (verified in `@huuma/validate` 0.1.x
   `object.ts` — see §3) — `retrieve_skill` always returns `metadata: {}`
   no matter what the author wrote. Worse, a non-object `metadata` fails
   validation and the whole skill is dropped. (`skills.ts:11`)
3. **`allowed-tools` rejects the spec's list form.** The Agent Skills
   frontmatter allows a YAML list; the schema only accepts a string, so a
   skill using the list form fails validation and silently disappears.
   (`skills.ts:12`)
4. **Absolute `path` breaks.** `join(Deno.cwd(), path)` with an absolute
   path produces `"<cwd>/<abs-path>"`. Must use `resolve()`. (`skills.ts:30`)
5. **`path` resolved lazily against a mutable cwd.** Resolution happens at
   first tool call, not at factory time — a `Deno.chdir()` in between
   points the factory at the wrong directory. Resolve eagerly in the
   factory closure. (`skills.ts:30`)
6. **First-call race duplicates the scan.** The cache holds the finished
   array, not the in-flight promise. `callTool` executes a model turn's
   tool calls concurrently (`Promise.allSettled`), so `list_skills` +
   `retrieve_skill` in one turn each run a full directory walk. Cache the
   promise. (`skills.ts:24-27`)
7. **Nondeterministic ordering.** `Deno.readDir` yields in OS order, so
   `list_skills` output and duplicate-name resolution (`find` picks the
   first match) vary across machines. Sort folders by name before
   processing. (`skills.ts:33`, `skills.ts:92`)
8. **Symlinked skill folders are skipped.** `entry.isDirectory` is `false`
   for a symlink to a directory — a common way to share skills between
   projects. (`skills.ts:34`)

### Operability

9. **Blanket `catch { continue; }` swallows everything.** A folder without
   `SKILL.md` (fine to skip) is indistinguishable from unreadable files,
   YAML syntax errors, and missing frontmatter — a broken skill vanishes
   with zero signal. Only `Deno.errors.NotFound` should skip silently;
   everything else must produce a diagnostic. (`skills.ts:56-58`)
10. **`console.warn` hardcoded in a library.** Frontmatter-validation
    warnings go straight to the console with no way to route them into the
    host's logging. Inject an `onWarning` callback (defaulting to
    `console.warn` to preserve behavior). (`skills.ts:44-47`)
11. **Duplicate skill names undetected.** Two folders declaring the same
    frontmatter `name` — retrieval silently picks one. Warn; first in
    sorted folder order wins.
12. **Unhelpful not-found error.** `Skill "x" not found` gives the model
    nothing to recover with. List the available skill names in the message
    (consistent with `cli`'s allowed-commands error style).

### Capability gaps

13. **Bundled resources are unreachable.** Real skills ship
    `scripts/`, `references/`, templates next to `SKILL.md`; the body
    references them by relative path. `retrieve_skill` returns only the
    body — an agent has no way to resolve those references. Return the
    skill's absolute directory `path` so an agent equipped with
    `files`/`grep`/`cli` tools can read them.
14. **Retrieval only matches frontmatter `name`.** Models frequently echo
    the folder name from `list_skills`. Fall back to folder-name lookup.
15. **Model-facing descriptions are thin.** Neither tool description tells
    the model *when* to list or retrieve, and `retrieve_skill` doesn't say
    the returned instructions should then be followed. Production skill
    harnesses live or die on this wording.

### Hygiene

16. **No tests** — every other factory has colocated tests plus `testdata/`
    fixtures where needed.
17. **No JSDoc** — exported symbols are undocumented (JSR publish scoring,
    and the repo convention is a module docblock + `@example` per factory,
    including required Deno permissions).
18. **No README entry** — "What is included" and the permissions section
    don't mention skills (`--allow-read`).

## 2. The Agent Skills format

The ecosystem convention (Anthropic's Agent Skills, adopted by Claude
Code and others) the loader targets:

- A skill is a folder containing `SKILL.md` — YAML frontmatter plus a
  markdown body of procedural instructions.
- Frontmatter fields: `name` (required; spec wants lowercase/hyphens,
  ≤64 chars, matching the folder name), `description` (required — the
  text the model uses to decide relevance), optional `license`,
  `compatibility`, `metadata` (a map of arbitrary author-defined keys),
  and `allowed-tools` (string in some hosts, YAML list in the spec —
  both forms exist in the wild).
- **Progressive disclosure** is the core idea: the model sees only
  name + description until it decides a skill is relevant, then loads
  the full body on demand. Keeps many skills cheap in context.
- Skills bundle supporting resources next to `SKILL.md` (`scripts/`,
  `references/`, templates) and reference them by relative path from the
  body; the host is expected to make those reachable.
- Hosts are lenient in practice: skills authored for other ecosystems
  should still load, so validation failures warn rather than reject
  wherever possible.

## 3. `@huuma/validate` capabilities

Verified against the pinned 0.1.x sources (jsr cache):

- **`ObjectSchema.validate` strips unknown keys** — it builds the result
  by iterating only the schema's declared keys. Root cause of finding 2:
  `object({})` maps any object to `{}`. There is no strict/passthrough
  mode on `object()`.
- **`unknown()` exists** — pure pass-through (`validate` returns the
  value untouched), `isRequired: false` by default. Suitable for
  `metadata` preservation; typed `unknown` on the way out.
- **`union()` semantics verified** — `UnionSchema.validate` runs the
  value through every member schema and returns the first passing
  result, so `union([string(), array(string())])` accepts both
  `allowed-tools` wire forms. **Correction (verified against the
  resolved 0.1.5 in the jsr cache, not the local sibling checkout):**
  `UnionSchema` extends `BaseSchema`, not `PrimitiveSchema`, so it has
  **no `.optional()`** method — only `PrimitiveSchema`/`ObjectSchema`/
  `ArraySchema` do. The earlier note was wrong. The implemented optional
  union is `union([string(), array(string()), undef()])`: the `undef()`
  member lets an absent value pass and return `undefined`, reproducing
  the documented optional-union semantics without `.optional()`.
- No regex/pattern constraint on `string()` — name-format checks would
  be plain code, reinforcing the lenient warn-don't-reject posture.

## 4. Fit with @huuma/ai

- **Tool factory shape.** `skills()` returning a tuple of two `Tool`s
  fits the existing factory model; no changes to `Agent`, `Tools`,
  `callTool`, or adapters. The two-tool split is the progressive
  disclosure model expressed as tools.
- **Error path.** `callTool` formats thrown errors as
  `{ result: { error } }` (ADR 0001: errors propagate) — a thrown
  not-found from `retrieve_skill` is model-visible, so listing available
  names in the message is a recovery hint, not noise.
- **Concurrency.** `callTool` runs a turn's calls via
  `Promise.allSettled` — the loader's cache must hold the in-flight
  promise, not the finished array (finding 6).
- **Frozen toolsets.** `Agent` snapshots tools at construction (ADR
  0001); a permanent per-factory cache of the skills scan is consistent
  with that model, the same way `McpConnection.refresh()` deliberately
  does not mutate existing agents (ADR 0002).
- **Publishing.** `deno.json` already excludes `**/testdata/` and
  `**/*.test.ts`; fixture skills and tests need no config changes.
  `deno task test` already passes `--allow-read`.

## 5. Recommendation

**Harden in place as a tool factory; decisions recorded in ADR 0005;
implementation plan in PLAN.md.**

- Fix findings 1–15 in `src/tools/skills/skills.ts`; export from the
  barrel; add fixtures + tests, JSDoc, README + permissions docs
  (findings 16–18).
- `SkillsToolOptions`: `path?: string` (default `"./skills"`),
  `onWarning?: (message: string) => void` (default `console.warn`).
- Corrected frontmatter schema: `metadata: unknown()`,
  `allowed-tools: union([string(), array(string())]).optional()`.
- `retrieve_skill` returns the skill's absolute directory `path` and
  renames `body` → `instructions`; lookup accepts frontmatter name or
  folder name. Return-shape change is safe only while the factory is
  unexported — the barrel export must land in the same change.

**Rejected alternatives** (full rationale in ADR 0005):

- *System-prompt injection of skill summaries* (the Claude Code model) —
  different feature with `Agent`-level implications; the two-tool shape
  doesn't preclude it later.
- *Strict spec validation* (name format, name-matches-folder, length
  caps) — rejects skills authored for other ecosystems; warn instead.
- *Cache invalidation / `refresh()` handle / file watching* — permanent
  cache matches the frozen-toolset model; a new factory call re-scans.
  Revisit with a `McpConnection`-style handle if it bites.
- *Enforcing `allowed-tools`* — an agent-level concern; the loader
  parses and returns it verbatim.
