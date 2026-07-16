# Plan — Production-ready skills tool factory

> The review findings (referenced below as "finding N") live in
> `docs/feature/skills/CONTEXT.md` §1; the design decisions are settled
> in `docs/adr/0005-skills-as-a-tool-factory.md`. This plan covers
> implementation only.

## Goal

Make `skills()` a production-ready tool factory: correctly loading
Agent-Skills-style `SKILL.md` folders, surfacing (not swallowing)
misconfiguration, exposing bundled skill resources to agents, exported from
`@huuma/ai/tools`, documented, and tested like every other factory.

The interaction model stays progressive disclosure: `list_skills` returns
cheap name/description pairs; `retrieve_skill` loads one skill's full
instructions on demand.

## Scope

In scope:

- Fix findings 1–15 in `src/tools/skills/skills.ts` (plus barrel edit).
- `SkillsToolOptions` interface: `path?: string` (default `"./skills"`),
  `onWarning?: (message: string) => void` (default `console.warn`).
- Tests with fixture skills under `src/tools/skills/testdata/`
  (already publish-excluded via `**/testdata/`).
- JSDoc + README + permissions docs (findings 16–18).

Out of scope (non-goals settled in ADR 0005):

- Cache invalidation / file watching — the per-factory cache is
  permanent by design; constructing a new factory re-scans. Document it.
- Enforcing `allowed-tools` — parsed and returned verbatim.
- Strict spec validation — the loader warns rather than rejects.
- Auto-injecting skill summaries into the system prompt.
- Body-size budgeting / truncation.

## Technical findings

### Corrected frontmatter schema

`@huuma/validate` 0.1.x ships everything needed (verified against the
pinned sources — CONTEXT.md §3, including `union()` validate semantics):

```ts
import { array, object, string, undef, union, unknown } from "@huuma/validate";

const skillFrontmatterSchema = object({
  name: string().notEmpty(),
  description: string().notEmpty(),
  license: string().optional(),
  compatibility: string().optional(),
  metadata: unknown(),                                                  // finding 2
  "allowed-tools": union([string(), array(string()), undef()]),        // finding 3
});
```

> **Schema note (implementation-time correction):** the original draft
> used `union([string(), array(string())]).optional()`, but the resolved
> `@huuma/validate@0.1.5` `UnionSchema` has no `.optional()` method. The
> implemented form adds `undef()` as a union member to make the field
> optional — see CONTEXT.md §3 for the verified rationale.

`unknown()` is `isRequired: false` by default and passes any value
through untouched — metadata survives verbatim, absent stays
`undefined`.

### Loader shape

```ts
export function skills(
  { path = "./skills", onWarning = console.warn }: SkillsToolOptions = {},
) {
  const root = resolve(path);            // findings 4, 5 — eager, absolute-safe
  let loading: Promise<SkillInfo[]> | null = null;

  function loadSkills(): Promise<SkillInfo[]> {
    loading ??= scan().catch((error) => { // finding 6 — promise, not array
      loading = null;                     // transient failure: next call retries
      throw error;
    });
    return loading;
  }
  ...
}
```

Cache semantics (ADR 0005): a **successful** scan — including the empty
result when the skills directory doesn't exist — is cached for the
factory's lifetime. A **rejected** scan (e.g. permission error,
`path` pointing at a file) resets `loading` so the next call retries;
the rejection itself surfaces as a normal model-visible tool error via
`callTool`.

`scan()`:

- Collect `Deno.readDir` entries where `entry.isDirectory`, or
  `entry.isSymlink` and `Deno.stat(join(root, entry.name))` reports a
  directory (finding 8; `stat` follows symlinks — wrap it in try/catch,
  a broken symlink throws `NotFound` and is skipped silently). Sort by
  name (finding 7).
- Per folder: read `SKILL.md`. `Deno.errors.NotFound` → skip silently
  (not a skill folder). Any other read error, `extract()` throw (missing
  or malformed frontmatter), or validation failure → `onWarning(...)`
  with the `SKILL.md` path and reason, then skip (findings 9, 10).
- Track seen names; duplicate → `onWarning`, keep the first in sorted
  order (finding 11).
- `SkillInfo` gains `path: string` — the skill folder's absolute path
  (finding 13).

### Tool surfaces

Model-facing wording is part of the spec (finding 15) — use these
strings verbatim:

`list_skills` description:

> Lists the skills available to you. Skills are folders of procedural
> instructions for specialized tasks; each entry has a name and a
> description of when it applies. When a user request matches a skill's
> description, call retrieve_skill with its name and follow the
> returned instructions instead of improvising the task yourself.

Returns `{ name, description }[]` — `folder` was an implementation
detail leaking to the model; drop it now that retrieval accepts either
identifier.

`retrieve_skill` description:

> Retrieves the full instructions for a skill by name (use list_skills
> to see what is available). The result contains `instructions` to
> follow and `path`, the skill's directory on disk. Relative file
> references in the instructions (scripts, references, templates)
> resolve against `path` — read those files with your other tools when
> the instructions call for them.

Lookup by frontmatter `name`, falling back to folder name (finding 14).
Not found → throw
`Skill "x" not found. Available skills: a, b, c` (finding 12; thrown, so
`callTool`'s error path makes it model-visible per ADR 0001). Found →
`{ name, description, path, metadata, "allowed-tools", instructions }`
where `path` is the skill directory, `instructions` is the body, and
`metadata`/`allowed-tools` carry the frontmatter values verbatim
(`undefined` when absent — key omission vs. `undefined` is implementer's
choice, tests must not assert it).

Return-shape note: `folder`/`frontmatter`/`body` were never consumable
(not exported, `metadata` always `{}`), so reshaping is safe — no
compatibility burden, provided the barrel export lands in the same
change. Exported `SkillInfo` keeps `folder`, `frontmatter`, `body` and
adds `path` for programmatic users.

### Permissions

`--allow-read` for the skills directory. Already covered by
`deno task test` flags.

## Implementation steps

### 1. Rewrite the loader and tools

**File:** `src/tools/skills/skills.ts`

All of the above: `SkillsToolOptions`, eager `resolve`, promise cache
with rejection reset, sorted + symlink-aware walk, corrected frontmatter
schema, warning diagnostics, duplicate detection, `path` on `SkillInfo`,
both lookup keys, the verbatim tool descriptions, module docblock +
JSDoc with `@example` (mirroring `cli.ts`/`subagent.ts` style, noting
`--allow-read`, the permanent cache, and the return tuple
`[listSkills, retrieveSkill]`).

### 2. Barrel export

**File:** `src/tools/mod.ts`

```ts
export {
  type SkillFrontmatter,
  type SkillInfo,
  skills,
  type SkillsToolOptions,
} from "@/tools/skills/skills.ts";
```

### 3. Test fixtures

**Directory:** `src/tools/skills/testdata/skills/`

- `web-research/SKILL.md` — full frontmatter (license, compatibility,
  populated `metadata`, `allowed-tools` as YAML list) + body referencing
  `references/sources.md` (create that file, to assert `path` resolution).
- `commit-style/SKILL.md` — minimal frontmatter, `allowed-tools` as
  string.
- `broken-yaml/SKILL.md` — unparseable frontmatter.
- `missing-desc/SKILL.md` — frontmatter without `description`.
- `no-frontmatter/SKILL.md` — plain markdown, no front matter block.
- `not-a-skill/notes.txt` — folder without `SKILL.md`.
- `dupe-a/SKILL.md`, `dupe-b/SKILL.md` — same frontmatter `name`.
- A stray top-level file (e.g. `README.md`) — non-directory entry.

The dupe pair matters beyond test 7: a full scan emits **exactly one**
duplicate warning, which is the observable signal test 10 counts.

### 4. Tests

**File:** `src/tools/skills/skills.test.ts`

Using the fixtures with `skills({ path, onWarning: collect })` where
`collect` pushes into an array:

1. **Lists valid skills only**, sorted, `{ name, description }` shape;
   broken fixtures excluded.
2. **Warnings emitted** for broken-yaml, missing-desc, no-frontmatter,
   and the duplicate — one per problem, message contains the `SKILL.md`
   path; none for `not-a-skill` or the stray file.
3. **Retrieve by name** returns instructions, populated `metadata`
   (finding 2 regression), list-form `allowed-tools` (finding 3
   regression), and absolute `path` pointing at the fixture folder.
4. **Retrieve by folder name** resolves the same skill.
5. **String-form `allowed-tools`** parses (commit-style fixture).
6. **Unknown name throws** with available names in the message.
7. **Duplicate name** resolves to the sorted-first folder (`dupe-a`).
8. **Missing skills directory** → `list_skills` returns `[]`, no throw,
   no warning.
9. **Absolute `path` option** works (finding 4 regression).
10. **Concurrent first calls share one scan** (finding 6 regression) —
    the internal array is not observable through the tool surface (both
    tools map it into fresh objects), so count warnings instead: fire
    both tools without awaiting between
    (`await Promise.all([list.call({}), retrieve.call({ name })])`) and
    assert exactly **one** duplicate-name warning was collected — two
    scans would emit two.
11. **Failed scan retries** — factory pointed at a *file* (not a
    directory): first call rejects (model-visible error); replace the
    file with a directory containing a valid skill; second call
    succeeds. Proves the rejected promise wasn't cached. Build the
    mutable path under a `Deno.makeTempDir()`, not in `testdata/`.
12. **Agent end-to-end** — `StubModel` (pattern from `agent/mod.test.ts`)
    scripted to call `list_skills` then `retrieve_skill`; asserts the
    tools work through `Agent.run`/`callTool`.

### 5. README

**File:** `README.md`

- "What is included": skills factory with a short example (factory →
  spread the tuple into `agent({ tools })`).
- Permissions section: `--allow-read` for the skills directory.

### 6. Validate

- `deno task check`, `deno task lint`, `deno task test`.
- `deno task publish:dry-run` — `skills.ts` ships under `./tools`;
  `testdata/` and tests excluded (existing globs cover both).

## File map

```
src/tools/skills/skills.ts                 # rewrite — loader + tools + docs
src/tools/skills/skills.test.ts            # new — tests
src/tools/skills/testdata/                 # new — fixture skills (unpublished)
src/tools/mod.ts                           # edit — barrel export
README.md                                  # edit — docs + permissions
docs/adr/0005-skills-as-a-tool-factory.md  # exists — decisions
docs/feature/skills/CONTEXT.md             # exists — review findings + research
docs/feature/skills/TASKS.json             # exists — task breakdown
```

## Risks

- **Permanent cache surprises long-running hosts.** Skills edited on disk
  aren't picked up until a new factory is constructed. Accepted —
  consistent with the frozen-toolset model (ADR 0005) — but must be
  documented prominently; revisit with a `refresh()` handle (the
  `McpConnection` precedent) if it bites.
- **Lenient loading hides authoring mistakes from the model.** A skill
  that fails validation is invisible to the agent; only `onWarning` knows.
  Mitigated by making warnings actionable (path + reason) and routable.
- **`unknown()` for `metadata` accepts scalars.** The spec says map, we
  pass through anything. Deliberate leniency; tightening later to
  warn-on-non-object is cheap and non-breaking.
- **Return-shape change of `retrieve_skill`.** Safe today only because the
  factory was never exported; landing step 2 in the same change closes
  that window.
