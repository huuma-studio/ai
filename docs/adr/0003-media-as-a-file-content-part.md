# ADR 0003 — Media as a mimeType-keyed file content part

- **Status:** Accepted
- **Date:** 2026-07-05

## Context

Messages could carry only text: `UserMessage.contents` was
`string | TextContent[]`, and every adapter flattened user content to a
plain string. Users could not prompt supported models with images, PDFs,
or audio — the "native image round-trip" the MCP research explicitly
deferred.

Provider support is heterogeneous. Gemini takes any media through one
`inlineData`/`fileData` shape; Anthropic splits image/document blocks;
OpenAI chat completions splits image/audio/file parts; Mistral splits
image/document/audio chunks; Ollama takes only base64 images on a
message-level `images` array. Two structural facts cut across all five:

1. Every provider's routing is decidable from an IANA MIME type
   (`image/*`, `application/pdf`, `audio/*`).
2. Base64-plus-mimeType is the common denominator for bytes, URL for
   references. Providers that want data URLs (OpenAI, Mistral) can
   compose one from mimeType + base64 trivially; parsing a data URL
   back apart for the others is the awkward direction.

The ecosystem (Vercel AI SDK, LangChain, MCP) converged on the same
answer: one file/media part carrying raw data or a reference plus an
explicit MIME type.

Full research: `docs/feature/media/CONTEXT.md`.

## Decision

One new property-discriminated content part in `src/mod.ts`, keyed by
IANA mimeType:

```ts
export type FileContent = {
  file: {
    mimeType: string;   // IANA, e.g. "image/png", "application/pdf"
    data?: string;      // base64, no data-URL prefix
    url?: string;       // publicly reachable URL
    name?: string;      // optional (OpenAI requires one for PDF input)
  };
};
```

`UserMessage.contents` widens to `string | (TextContent | FileContent)[]`
and `Agent.run`'s prompt widens the same way; `SystemMessage` stays
text-only (no provider accepts media in system prompts). Phase 1 covers
user input media only.

Consequences, each an explicit choice:

- **Raw base64 + mimeType is the canonical encoding, never data URLs.**
  Composing a data URL where a provider wants one (OpenAI, Mistral) is
  one template string — `dataUrlFrom` in `src/model/file.ts`; parsing
  one apart for the providers that want raw bytes is not. Base64
  `string` rather than `Uint8Array` keeps messages JSON-serializable
  for persisted histories.
- **Exactly one of `data`/`url`, enforced at runtime by adapters.** The
  invariant stays doc-comment-only in the type, matching the loose
  style of the existing parts; the shared `fileSourceFrom` helper
  throws `RangeError` when both or neither are set (empty string counts
  as unset). A discriminated `{ data } | { url }` union would enforce
  it in types at a cost to readability the existing parts don't pay.
- **Adapters route on mimeType prefix and fail loudly.** Each adapter
  maps `image/*` / `application/pdf` / `audio/*` to its native shapes
  and throws `RangeError` — naming the provider and the offending
  mimeType/source combination — on anything it cannot represent
  (Anthropic non-jpeg/png/gif/webp base64 images and audio, OpenAI
  audio/PDF by URL, Mistral base64 PDFs, Ollama everything but base64
  images). Google passes any mimeType through and lets the API reject.
  No part is ever dropped silently: a silently skipped image means the
  model answers as if it saw the file.
- **No auto-fetching URLs into bytes.** Message transforms stay pure
  and synchronous; fetching would require `--allow-net`, hide network
  failures inside request mapping, and silently bloat requests. Where a
  provider has no URL source, the adapter throws and the caller
  fetches.
- **Text-only wire shapes are unchanged.** Adapters that send user
  content as a plain string switch to a content-part array only when a
  file part is present, so existing requests are byte-identical.
- **The widening is breaking pre-1.0.** Consumers assuming
  `UserMessage.contents: string | TextContent[]` must widen; shipped in
  0.0.11 with release-note callout.

Deferred, forward-compatible with this shape: media in tool results
(phase 2, ADR 0004 — `FileContent` reused beside `result`), model-output
media (phase 3 — adding `FileContent` to `ModelMessage.contents` when
Gemini image-out/OpenAI audio-out support lands), provider file-ID
sources (a provider-tagged `fileId` field can sit beside `data`/`url`
later), video (Gemini-only today), and URL→bytes convenience helpers
(e.g. `fileFrom(path)` producing a `FileContent` explicitly, outside the
transforms).

## Rejected alternatives

- **Separate `ImageContent`/`DocumentContent`/`AudioContent` parts.**
  Multiplies union members and adapter branches without adding
  information a mimeType doesn't already carry, and the category an
  adapter routes on differs per provider anyway. Vercel, LangChain, and
  MCP all converged on one part + mimeType.
- **Data URLs as the stored encoding.** Only two of five providers want
  them; the other three would parse data URLs apart on every request.
  Raw base64 + explicit mimeType keeps the primitive canonical and the
  conversion in the cheap direction.
- **Auto-fetching `url` sources into base64 inside adapters.** Hidden
  network I/O in a message transform: async-ifies sync code paths,
  needs `--allow-net`, and hides failures where the caller can't handle
  them. Fail loudly instead; let callers fetch.
- **Skipping unsupported media silently** (Ollama PDFs, OpenAI video,
  …). Cheaper to implement, but the model answers as if it saw the
  file — the same silent-data-loss trap the MCP research documented in
  other frameworks.
- **Enforcing `data`/`url` exclusivity in the type system.** A
  discriminated source union catches mistakes at compile time but reads
  worse at every use site, and the existing parts already rely on
  documented invariants over encoded ones. Runtime enforcement in one
  shared helper gives the same failure visibility.
