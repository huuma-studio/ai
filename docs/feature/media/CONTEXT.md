# Media files in the message primitive — research context

- **Date:** 2026-07-05
- **Status:** Research complete, no implementation yet

Goal: let messages carry media files (images, PDFs, audio) so users can
prompt supported models with them, across all five adapters. This is the
"native image round-trip" feature the MCP research explicitly deferred
("Message contents have no image part today").

## 1. Where the primitive stands today

- `src/mod.ts` defines three content parts, discriminated by property
  presence (`"text" in part`, `"toolCall" in part`, …): `TextContent`,
  `ToolCallContent`, `ToolResultContent`.
- `UserMessage.contents: string | TextContent[]` — text only.
  `SystemMessage` likewise. `ModelMessage.contents` is
  `(TextContent | ToolCallContent)[]`.
- Anthropic, OpenAI, and Mistral flatten user/system contents through
  a local `textFrom()`; Ollama inlines the same join; all four send
  user content as a plain string. Google is the exception: it maps
  each part individually via `genAIPartFrom`. Tool results are
  flattened to a string via `toolOutputString()` everywhere.
- Consumers that narrow on contents: the adapters' text-joining code
  and `subagent`'s `finalText` (model text only). `Agent.run(prompt:
  string, …)` builds `{ role: "user", contents: prompt }` and passes
  through whatever history it is given — so media-bearing *history*
  needs no agent changes, but the `prompt` parameter itself is
  text-only today (see §5).

## 2. Provider capability landscape

Verified against the SDKs installed in this repo (type definitions in
`node_modules`), plus provider docs for wire-format semantics:

| | image input | PDF/document | audio input | video | URL source | media in tool results |
|---|---|---|---|---|---|---|
| **Anthropic** (`@anthropic-ai/sdk@0.100.1`) | `image` block, base64 or URL; jpeg/png/gif/webp only | `document` block: base64 PDF, URL PDF, plain text | ✗ | ✗ | ✓ (image + PDF) | ✓ — `tool_result.content` accepts text/image/document blocks |
| **OpenAI chat completions** (`openai@6.45.0`) | `image_url` part: HTTPS URL or `data:` URL | `file` part: `file_data` **must be a data URL**, `filename` required; or `file_id` | `input_audio` part: base64, `wav`/`mp3` only | ✗ | ✓ (images only) | ✗ — tool message is `string \| TextPart[]` |
| **Google Gemini** (`@google/genai@2.10.0`) | `inlineData` (base64 + any mimeType) or `fileData` (fileUri) | ✓ same mechanism | ✓ | ✓ | partial — `fileUri` takes Files-API URIs and YouTube URLs; arbitrary HTTP URLs are doc-ambiguous, verify empirically | ✓ — `FunctionResponse.parts` (`FunctionResponseBlob`/`FileData`) |
| **Mistral** (`@mistralai/mistralai@2.4.1`) | `image_url` chunk: URL or `data:` URL (vision models: pixtral, medium/small latest) | `document_url` chunk: URL only (Files API signed URL or public); no inline base64 | `input_audio` chunk (Voxtral models) | ✗ | ✓ | typed as possible — `ToolMessage.content` accepts `ContentChunk[]`; model support unverified |
| **Ollama** (`ollama@0.6.3`) | `Message.images?: Uint8Array[] \| string[]` (base64), multimodal models only | ✗ | ✗ | ✗ | ✗ | ✗ |

Size limits worth documenting: Anthropic ~5MB/image, 32MB request;
OpenAI 50MB total files per request; Gemini 20MB total request for
inline bytes (Files API beyond that, 2GB/file); Mistral ~10MB/image.

Two structural observations:

1. **Google is uniform, everyone else routes by media category.**
   Gemini has one `inlineData` shape for all media; Anthropic splits
   image/document; OpenAI splits image/audio/file; Mistral splits
   image/document/audio. A shared primitive keyed by **IANA mimeType**
   lets each adapter branch on `image/*` / `application/pdf` /
   `audio/*` and covers all five.
2. **Base64-plus-mimeType is the common denominator for bytes; URL is
   the common denominator for references.** Providers that want data
   URLs (OpenAI, Mistral) can derive one from `mimeType` + base64
   trivially; the reverse (parsing data URLs back apart for
   Anthropic/Google/Ollama) is the awkward direction. Store raw
   base64 + mimeType, never data URLs.

## 3. What other frameworks converged on

- **Vercel AI SDK (v5)**: `FilePart { type: 'file', data: base64 |
  URL, mediaType }` plus an `ImagePart` convenience; mimeType drives
  provider mapping; unsupported combinations throw per provider.
- **LangChain JS** standardized content blocks with
  `source_type: "base64" | "url" | "id"` + `mime_type`.
- **MCP** tool content blocks are `{ type: "image", data, mimeType }` —
  base64 + mimeType again. Mapping MCP `image` blocks into a native
  message part is the follow-up the MCP research recommends over
  today's placeholder text.
- Nobody auto-fetches URLs into bytes inside the request transform;
  frameworks either pass the URL through (and throw where unsupported)
  or leave fetching to the caller.

## 4. Fit with @huuma/ai

- **One new content part**, property-discriminated like the existing
  three, added to `src/mod.ts` and re-exported from `src/model/mod.ts`:

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

  The "exactly one of `data`/`url`" invariant stays doc-comment-only,
  matching the loose style of the existing parts; **adapters enforce it
  at runtime** and throw when both or neither are set. (A discriminated
  `{ data } | { url }` union could enforce it in types, at a cost to
  readability — not worth it while the existing parts don't.)

  `UserMessage.contents` widens to `string | (TextContent |
  FileContent)[]`. `SystemMessage` stays text-only (no provider
  accepts media in system prompts). Base64 `string` (not
  `Uint8Array`) keeps messages JSON-serializable for persisted
  histories.

- **Adapter mapping, keyed on mimeType prefix** (user messages only in
  v1):
  - *Anthropic*: `image/*` → `image` block (base64/url source);
    `application/pdf` → `document` block; else throw. Note the SDK
    types base64 `media_type` as the literal union
    `'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'`, so the
    branch must validate against those four and throw on e.g.
    `image/tiff` (consistent with the error policy) rather than cast.
  - *OpenAI*: `image/*` → `image_url` (url or composed data URL);
    `audio/wav`|`audio/mpeg` with `data` → `input_audio`;
    `application/pdf` with `data` → `file` part (data URL +
    `name ?? "file.pdf"`); PDF-by-URL and audio-by-URL throw. The SDK
    types `filename` as optional — the "required" is wire-level per
    OpenAI's docs, which the default file name covers either way.
  - *Google*: `data` → `inlineData { mimeType, data }`; `url` →
    `fileData { fileUri, mimeType }`; pass any mimeType through and
    let the API reject unsupported ones.
  - *Mistral*: `image/*` → `image_url` (url or data URL);
    `application/pdf` with `url` → `document_url`; `audio/*` →
    `input_audio`; base64 PDF throws.
  - *Ollama*: `image/*` with `data` → `images: [data]` on the user
    message; everything else throws.
  - OpenAI/Mistral user messages switch from string content to a part
    array **only when a file part is present**, so text-only requests
    keep today's wire shape.
- **Error policy: throw loudly** (`RangeError`, matching
  `genAIPartFrom`'s existing precedent) on any provider-unsupported
  mimeType/source combination. No silent dropping, no auto-fetching
  URLs to bytes — fetching would turn pure sync transforms into async
  network I/O requiring `--allow-net`. A user-side helper (e.g.
  `fileFrom(path | url)` producing a `FileContent`) can offer the
  convenience explicitly later.
- **Blast radius**: each adapter's user-message branch (the
  `textFrom()` joins in Anthropic/OpenAI/Mistral, Ollama's inline
  join, a new part case in Google's `genAIPartFrom`), plus one
  type-level widening of `Agent.run`'s `prompt` parameter (§5).
  `Tools`, `callTool`, workflow, and subagent
  need no changes. Tests follow the existing per-adapter transform
  test pattern (`ollama/transform_test.ts` etc.): one mapping case per
  provider × {image-base64, image-url, pdf, audio} plus the throw
  cases.
- **Versioning**: widening `UserMessage.contents` is breaking for
  consumers that assume `TextContent[]`; acceptable pre-1.0 (0.0.10).

## 5. Recommendation

**Ship `FileContent` for user messages first; media in tool results and
model-output media are separable follow-ups.**

- *Phase 1 — user input media* (this feature): the primitive + five
  adapter mappings + tests, as sketched above, **plus widening
  `Agent.run`'s prompt to `string | (TextContent | FileContent)[]`**.
  The prompt flows straight into `{ role: "user", contents: prompt }`
  (`src/agent/mod.ts:172`), so this is a type-level change — but
  without it the dominant use case ("prompt the agent with an image")
  would require hand-crafting a history message, which defeats the
  feature. Covers prompting with images/PDFs/audio on every provider
  that supports it, fails loudly elsewhere.
- *Phase 2 — media in tool results*: extend `ToolResultContent` (e.g.
  optional `files?: FileContent[]` beside `result`) so browser
  screenshots and MCP `image` blocks reach the model natively.
  Anthropic (`tool_result` content blocks) and Google
  (`FunctionResponse.parts`) support this natively; OpenAI/Ollama need
  the known fallback of a synthetic user message following the tool
  message — a design decision worth its own ADR.
- *Phase 3 — model-output media*: Gemini image generation returns
  `inlineData` parts and OpenAI audio-out returns `audio` on the
  assistant message; both are currently dropped. Adding `FileContent`
  to `ModelMessage.contents` when the need arises is forward-compatible
  with the phase-1 shape.

**Out of scope initially** (usable later without reshaping the API):
provider file-ID sources (OpenAI/Mistral `file_id`, Gemini Files API
upload, Anthropic Files beta) — not portable, could become an optional
provider-tagged `fileId` field later; video (Gemini-only); URL→bytes
fetching helpers; size-limit preflight validation.

**Rejected alternatives:**

- *Separate `ImageContent`/`DocumentContent`/`AudioContent` parts.*
  Multiplies union members and adapter branches without adding
  information a mimeType doesn't already carry; the ecosystem
  (Vercel, LangChain, MCP) converged on one part + mimeType.
- *Data URLs as the stored encoding.* Only two of five providers want
  them, and composing a data URL from base64+mimeType is trivial while
  parsing one apart is not. Raw base64 + explicit mimeType keeps the
  primitive canonical.
- *Auto-fetching `url` sources into base64 inside adapters.* Hidden
  network I/O in a message transform: async-ifies sync code paths,
  needs `--allow-net`, silently bloats requests, and hides failures.
  Fail loudly instead; let callers fetch.
- *Skipping unsupported media silently (Ollama PDF, OpenAI video…).*
  Cheaper to implement, but the model would answer as if it saw the
  file — the same silent-data-loss trap the MCP research documented in
  other frameworks.
