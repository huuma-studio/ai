# Media files in the message primitive — implementation plan

- **Date:** 2026-07-05
- **Scope:** Phase 1 from CONTEXT.md §5 — user-input media only. Media in
  tool results (phase 2) and model-output media (phase 3) are explicitly
  out of scope.
- **Verification per step:** `deno task check`, `deno task lint`,
  `deno task test` all green before moving on.

## Step 1 — `FileContent` primitive + type widening (keeps repo green)

**Files:** `src/mod.ts`, `src/model/mod.ts`, all five `models/*/mod.ts`

Add the new property-discriminated part to `src/mod.ts`, exactly as
specified in CONTEXT.md §4:

```ts
/** Media/file content part. */
export type FileContent = {
  file: {
    /** IANA MIME type, e.g. "image/png", "application/pdf". */
    mimeType: string;
    /** Base64-encoded bytes (no data-URL prefix). Exactly one of `data`/`url`. */
    data?: string;
    /** Publicly reachable URL. */
    url?: string;
    /** Optional file name (OpenAI requires one for PDF input). */
    name?: string;
  };
};
```

- Widen `UserMessage.contents` to `string | (TextContent | FileContent)[]`.
- `SystemMessage` stays `string | TextContent[]` — no provider accepts
  media in system prompts.
- Re-export `FileContent` from `src/model/mod.ts`.
- The exactly-one-of `data`/`url` invariant stays doc-comment-only in the
  type; runtime enforcement lives in the adapters (step 2 helper).

This widening breaks type-check in every adapter's user-message path
(`textFrom` in anthropic/openai/mistral, the inline `.map(c => c.text)`
joins in ollama, `genAIPartsFrom`/`genAIPartFrom` param types in google).
To keep the repo green without pulling all mapping work into one giant
change, this step updates each adapter minimally: accept the widened type
and `throw new RangeError(...)` when a file part is encountered. The real
mappings replace those throws in steps 3–7 (Google's existing
`RangeError` fallthrough in `genAIPartFrom` already gives this behavior
once the param type is widened).

**Done when:** a `UserMessage` with
`[{ text: "..." }, { file: { mimeType: "image/png", data: "..." } }]`
compiles; all existing tests pass unchanged.

## Step 2 — shared source helpers

**Files:** new `src/model/file.ts` (+ test), re-export from `src/model/mod.ts`

Two tiny helpers all five adapters share, so the runtime invariant and the
data-URL composition are written once:

- `fileSourceFrom(file)` → `{ kind: "data", data } | { kind: "url", url }`;
  throws `RangeError` when both or neither of `data`/`url` are set
  (treat empty string as unset).
- `dataUrlFrom(file)` → `` `data:${mimeType};base64,${data}` ``; throws
  when there is no `data`. Needed because OpenAI and Mistral want data
  URLs while the primitive stores raw base64 (CONTEXT.md §2 observation 2).

Per-provider mimeType routing stays in the adapters — only the
source-shape logic is shared.

**Tests:** data-only, url-only, both-set throws, neither-set throws,
data-URL composition.

## Steps 3–7 — per-adapter mapping (independent; parallelizable)

Each step touches one adapter + its test file, replacing the step-1 throw
with the mapping from CONTEXT.md §4. Common rules for all five:

- Route on mimeType prefix: `image/*`, `application/pdf`, `audio/*`.
- Fail loudly: `RangeError` naming the provider and the offending
  mimeType/source combination. Never drop a part silently, never fetch a
  URL into bytes.
- User messages only; system-message paths keep today's text-only join.
- Adapters that currently send user content as a plain string (all but
  Google) switch to a content-part array **only when a file part is
  present**, so text-only requests keep today's wire shape.

### Step 3 — Anthropic (`models/anthropic/mod.ts`)

Split the combined `system || user` branch in `anthropicMessagesFrom`
(mod.ts:256-258) so user messages can carry blocks:

- `image/*` + data → `{ type: "image", source: { type: "base64", media_type, data } }`.
  The SDK types `media_type` as the literal union
  `image/jpeg | image/png | image/gif | image/webp` — validate against
  those four and throw on anything else (e.g. `image/tiff`); no casting.
- `image/*` + url → `{ type: "image", source: { type: "url", url } }`
- `application/pdf` + data → `{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }`
- `application/pdf` + url → `{ type: "document", source: { type: "url", url } }`
- anything else → throw.

**Tests** (`mod_test.ts`): image base64, image URL, PDF base64, PDF URL,
unsupported image subtype throws, audio throws, text-only user message
still sends string content, mixed text+image preserves part order.

### Step 4 — OpenAI (`models/openai/mod.ts`)

User branch (mod.ts:174) sends `ChatCompletionContentPart[]` when a file
part is present:

- `image/*` → `{ type: "image_url", image_url: { url: url ?? dataUrlFrom(file) } }`
- `audio/wav` | `audio/mpeg` + data → `{ type: "input_audio", input_audio: { data, format: "wav" | "mp3" } }`;
  audio by URL throws (chat completions has no audio-URL input).
- `application/pdf` + data → `{ type: "file", file: { filename: name ?? "file.pdf", file_data: dataUrlFrom(file) } }`
  — `file_data` must be a data URL and a filename is wire-required even
  though the SDK types it optional; PDF by URL throws.
- anything else → throw.

**Tests:** image base64 → data URL, image URL pass-through, wav/mp3
format mapping, audio-by-URL throws, PDF default + explicit filename,
PDF-by-URL throws, unsupported mimeType throws, text-only stays string.

### Step 5 — Google (`models/google/mod.ts`)

Smallest change: widen `genAIPartsFrom`/`genAIPartFrom` and add a
`"file" in content` branch before the existing `RangeError` fallthrough
(mod.ts:319):

- data → `{ inlineData: { mimeType, data } }`
- url → `{ fileData: { fileUri: url, mimeType } }`

No mimeType filtering — Gemini takes images/PDF/audio/video through the
same shape; let the API reject what it doesn't support. Add a code
comment noting `fileUri` is verified for Files-API URIs and YouTube URLs
while arbitrary HTTP URLs are doc-ambiguous (CONTEXT.md §2).

**Tests:** data → `inlineData`, url → `fileData`, video passes through
(no filtering), invariant violations throw via the shared helper.

### Step 6 — Mistral (`models/mistral/mod.ts`)

User branch (mod.ts:214) sends `ContentChunk[]` when a file part is
present:

- `image/*` → `{ type: "image_url", imageUrl: url ?? dataUrlFrom(file) }`
- `application/pdf` + url → `{ type: "document_url", documentUrl: url }`;
  PDF base64 throws (`document_url` is URL-only; the Files-API
  signed-URL flow is out of scope).
- `audio/*` → `input_audio` chunk (accepts base64 or URL in the same
  string field).
- anything else → throw.

**Tests:** image base64 → data URL, image URL pass-through, PDF URL,
PDF base64 throws, audio base64 and URL, unsupported mimeType throws,
text-only stays string.

### Step 7 — Ollama (`models/ollama/mod.ts`)

User branch (mod.ts:328-330): join text parts into `content` as today;
collect `image/*` file parts with `data` into the message's
`images: string[]` (base64 verbatim, order preserved). Image by URL
throws (no URL source, and adapters never fetch); any non-image mimeType
throws.

**Tests** (`transform_test.ts`): single image lands in `images`, multiple
images preserve order alongside joined text, image-by-URL throws,
PDF throws, text-only message has no `images` field.

## Step 8 — widen `Agent.run` prompt

**Files:** `src/agent/mod.ts`, `src/agent/mod.test.ts`

`run(prompt: string, …)` → `run(prompt: string | (TextContent | FileContent)[], …)`.
The prompt flows unchanged into `{ role: "user", contents: prompt }`
(src/agent/mod.ts:172), so this is type-level plus JSDoc noting that
media support depends on the adapter/provider and unsupported
combinations throw at request time. Without this, the dominant use case
("prompt the agent with an image") would require hand-crafting history.

**Test:** `run()` with `[{ text }, { file }]` emits a user message
carrying both parts verbatim (existing fake-model pattern in
`mod.test.ts`).

## Step 9 — ADR

**Files:** `docs/adr/0003-media-as-a-file-content-part.md`

Record the decisions in the style of ADR 0001/0002: one mimeType-keyed
`FileContent` part (not per-category parts); raw base64 + mimeType as
canonical encoding (not data URLs); exactly-one-of `data`/`url` enforced
at runtime; fail-loud `RangeError` policy (no silent drops, no
auto-fetching); phases 2–3 deferred with the forward-compatibility
argument. Include the rejected alternatives from CONTEXT.md with reasons.
Can be written any time — no code dependency.

## Step 10 — docs

**Files:** `README.md`, `src/mod.ts` module JSDoc

- README "Media input" section: one runnable `agent().run(...)` example
  with an image `FileContent`, the provider capability matrix from
  CONTEXT.md §2 as a compact table, and the fail-loud policy in a
  sentence.
- `src/mod.ts` module JSDoc: a `FileContent` example next to the
  existing `Message` example.

## Ordering and release

```
1 (primitive) ──► 2 (helpers) ──► 3,4,5,6,7 (adapters, parallel) ──┐
        │                                                          ├──► 10 (docs)
        └──► 8 (Agent.run) ────────────────────────────────────────┘
9 (ADR) — independent
```

- Steps 3–7 are independent of each other once 1+2 land.
- Step 10 needs step 8 as well as the adapters: the README example
  calls `agent().run(...)` with a file part, which only type-checks
  once the prompt parameter is widened.
- Widening `UserMessage.contents` is breaking for consumers assuming
  `TextContent[]` — acceptable pre-1.0; ship as `0.0.11` and note the
  break in the release notes.
- Deferred for later (no API reshaping needed): provider file-ID
  sources, video (Gemini-only), URL→bytes helpers (e.g. `fileFrom(path)`),
  size-limit preflight, tool-result media (phase 2), model-output media
  (phase 3).
