# Media in tool results (media phase 2) — implementation plan

- **Date:** 2026-07-05
- **Scope:** Phase 2 from `docs/feature/media/CONTEXT.md` §5 — deliver
  `FileContent` attached to tool results to the model, natively where
  the provider supports it, via a synthetic user message elsewhere.
  Design decisions are recorded in ADR 0004
  (`docs/adr/0004-media-in-tool-results.md`, Accepted).
- **Prerequisite:** media phase 1 complete (`docs/feature/media/`),
  specifically the `FileContent` primitive (media-01), the shared
  source helpers (media-02), and each adapter's user-content file
  mapping (media-03..07), which this phase reuses.
- **Primary motivation:** the MCP integration
  (`docs/feature/mcp/CONTEXT.md`) maps MCP `image` blocks
  (`{ data, mimeType }`) 1:1 onto `FileContent`; landing this phase
  first means MCP result mapping never ships its placeholder-text
  stopgap.
- **Verification per step:** `deno task check`, `deno task lint`,
  `deno task test` all green before moving on.

## Step 1 — finalize ADR 0004

Resolve the three open questions (files on errored results, label
wording, exact Google `FunctionResponse` parts shape from the installed
SDK types) and flip the status to Accepted. Everything below assumes
its decisions: `files?` on the primitive, branded `ToolOutput` channel,
native Anthropic/Google mapping, transform-time synthetic user message
for OpenAI/Mistral/Ollama.

## Step 2 — primitive + fail-loud baseline (keeps repo green)

**Files:** `src/mod.ts`, all five `models/*/mod.ts`

- Add `files?: FileContent[]` to `ToolResultContent.toolResult`, beside
  `result`, with JSDoc: media attached to the result; delivery depends
  on the provider (native blocks or a synthetic user message); adapters
  throw on unsupported mimeType/source combinations.
- Optional field ⇒ no type break, but the no-silent-drop policy demands
  a runtime guard: each adapter's tool-message branch throws
  `RangeError("<provider> adapter does not support tool result files yet")`
  when a result carries non-empty `files`. Steps 4–8 replace these
  throws with real delivery.

**Done when:** existing tests pass unchanged; a `ToolResultContent`
with `files` compiles; each adapter test asserts the baseline throw.

## Step 3 — `ToolOutput` channel through `callTool`

**Files:** `src/tools/mod.ts`, `src/tools/mod.test.ts` (or the existing
tools test location)

- `ToolOutput<T>` class + `toolOutput(output, files)` factory, exported
  from `@huuma/ai/tools`.
- In `callTool`'s fulfilled branch (src/tools/mod.ts:190-200): unwrap
  `instanceof ToolOutput` into
  `{ toolResult: { id, name, result: { output }, files } }`; any other
  value keeps today's path. Rejections unchanged.

**Tests:** plain return unchanged, `toolOutput` populates `files` and
unwraps `output`, a tool returning a plain object with `output`/`files`
keys is *not* unwrapped (instanceof discipline), rejection path
untouched.

## Steps 4–8 — per-adapter delivery (independent; parallelizable)

Each step replaces the step-2 throw in one adapter and reuses that
adapter's phase-1 FileContent mapping (extract to a local function if
phase 1 left it inline). Common rules: text-only tool results keep
today's exact wire shape; unsupported mimeType/source combinations
throw per the phase-1 rules; part order within a result is preserved.

### Step 4 — Anthropic (native)

`anthropicMessagesFrom`'s tool branch: when a result has files, the
`tool_result.content` string becomes a block array — one text block
(`toolOutputString(result)`) followed by the file blocks from the
phase-1 mapper (image base64/url, document base64/url, four-literal
`media_type` validation). `is_error` handling unchanged.

**Tests:** image file → text + image blocks, pdf → document block,
no-files result keeps string content, mixed results in one tool message
(one with files, one without), unsupported mime throws, files on an
errored result still map (per ADR resolution).

### Step 5 — Google (native)

`genAIPartFrom`'s `toolResult` branch: map `files` into the
`FunctionResponse` parts shape confirmed in step 1 (`data` → blob part,
`url` → file-data part), keeping `response` as today. No mimeType
filtering, matching the phase-1 Google stance.

**Tests:** data → blob part, url → file-data part, no-files result
unchanged, invariant violations throw via the shared helper.

### Step 6 — OpenAI (synthetic user message)

After emitting the tool messages for a tool `Message`: if any result
carries files, append **one** user message whose content parts are, per
result with files, a label text part
(`Files returned by tool "<name>" (call <id>):`) followed by the
phase-1 OpenAI file parts (`image_url` / `input_audio` / `file`).
Constructed at transform time only — never stored in history.

**Tests:** single result with image → tool message + synthetic user
message with label and image part, two results with files aggregate
into one synthetic message in call order, no-files tool message emits
no synthetic message (wire shape identical to today), phase-1 throw
rules apply (pdf-by-url throws), label contains tool name and call id.

### Step 7 — Mistral (synthetic user message)

Same construction as step 6 with `ContentChunk[]` parts from the
phase-1 Mistral mapper (`image_url` / `document_url` / `input_audio`).
Per ADR 0004 the typed-but-unverified native `ToolMessage.content`
chunks are *not* used.

**Tests:** mirror step 6 for the Mistral chunk shapes; pdf base64
throws (phase-1 rule).

### Step 8 — Ollama (synthetic user message)

Same construction: label text joined into `content`, `image/*` base64
collected into the synthetic message's `images` array in order;
image-by-url and non-image mimeTypes throw (phase-1 rules).

**Tests:** image lands in synthetic message `images`, order preserved
across two results, label text names both tools, no-files unchanged,
url/pdf throw.

## Step 9 — docs

**Files:** `README.md`, `src/tools/mod.ts` module JSDoc

- README "Media input" section grows a "Media from tools" subsection:
  `toolOutput` example (screenshot tool), the native-vs-synthetic
  delivery table per provider, one sentence on the fail-loud policy.
- `src/tools/mod.ts` module JSDoc: `toolOutput` example beside the
  existing `tool` example.
- Note for the MCP feature doc: result mapping should target
  `toolResult.files` (image blocks → `FileContent`), retiring the
  placeholder-text stopgap.

## Ordering and release

```
[media phase 1 complete] ──► 1 (ADR) ──► 2 (primitive) ──► 3 (ToolOutput)
                                              │
                                              └──► 4,5,6,7,8 (adapters, parallel) ──► 9 (docs)
```

- Steps 4–8 need step 2 plus their adapter's phase-1 mapping task;
  step 9 needs everything.
- Additive change (`files?` optional, `toolOutput` new): ship as
  0.0.12, non-breaking. The only behavior change without opt-in is the
  step-2 `RangeError` on a field that did not previously exist.
- Sequencing with MCP: land this phase before the MCP result-mapping
  task so MCP never ships placeholder text for images.
