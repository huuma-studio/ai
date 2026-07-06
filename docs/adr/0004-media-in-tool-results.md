# ADR 0004 — Media in tool results

- **Status:** Accepted
- **Date:** 2026-07-05 (accepted 2026-07-06)

> Numbering note: ADR 0003 ("media as a mimeType-keyed file content
> part", media phase 1) has since landed; this ADR builds on it.

## Context

Tools increasingly return media, not just text: browser/screenshot tools
return images, and MCP tool results carry typed `image`/`audio` content
blocks whose shape (`{ data, mimeType }`) maps 1:1 onto the phase-1
`FileContent` part. Today `ToolResultContent` carries only
`result: { output?, error? }`, and every adapter flattens it to a string
via `toolOutputString` — media returned by a tool never reaches the
model. The planned MCP integration would have to describe images as
placeholder text (its documented stopgap) unless this gap is closed.

Provider support is split. All type claims below are verified against
the installed SDKs (`@anthropic-ai/sdk` 0.100.1, `@google/genai` 2.10.0,
`openai` 6.45.0, `@mistralai/mistralai` 2.4.1, `ollama` 0.6.3):

| Provider | Media in tool results |
|---|---|
| Anthropic | ✓ native — `ToolResultBlockParam.content` accepts `string \| Array<TextBlockParam \| ImageBlockParam \| SearchResultBlockParam \| DocumentBlockParam \| …>` |
| Google | ✓ native — `FunctionResponse.parts?: FunctionResponsePart[]` (`inlineData` blob / `fileData` URI) |
| OpenAI (chat completions) | ✗ — `ChatCompletionToolMessageParam.content: string \| Array<ChatCompletionContentPartText>` (text-only) |
| Mistral | typed as possible (`ToolMessage.content: string \| ContentChunk[] \| null`) but model support unverified |
| Ollama | ✗ in practice — the SDK has one role-agnostic `Message { content: string; images?: … }`, so `images` on a tool message type-checks, but consumption there is unverified; documented use is user messages |

There is a second, less obvious gap: `callTool` (src/tools/mod.ts)
constructs `ToolResultContent` from the tool's raw return value, so
tools also need a *channel* to attach files to their result.

## Decision

1. **Primitive.** Add an optional `files?: FileContent[]` to
   `ToolResultContent.toolResult`, beside `result`. Optional keeps the
   change non-breaking; `result` stays the model-visible payload and
   `files` carries media alongside it.

2. **Channel: a branded output wrapper.** Export from `@huuma/ai/tools`:

   ```ts
   class ToolOutput<T = unknown> { output: T; files: FileContent[] }
   toolOutput<T>(output: T, files: FileContent[]): ToolOutput<T>
   ```

   `callTool` detects `ToolOutput` via `instanceof` and unwraps it into
   `{ result: { output }, files }`. Every other return value behaves
   exactly as today. `instanceof` (not shape-sniffing) so a tool that
   legitimately returns `{ output, files }` data is never
   misinterpreted.

3. **Native mapping where the provider supports it.**
   - *Anthropic:* when a result has files, `tool_result.content` becomes
     a block array — one text block (`toolOutputString(result)`) followed
     by image/document blocks reusing the phase-1 `fileBlockFrom` mapper
     (models/anthropic/mod.ts). Its return type
     (`ImageBlockParam | DocumentBlockParam`) is a subset of the
     tool_result content union, so reuse type-checks as-is. Same
     four-literal `media_type` validation (applied to base64 *and* URL
     sources since 737cc82), same throw policy.
   - *Google:* map files into `FunctionResponse` parts
     (`inlineData`-style blob for `data`, file data for `url`), keeping
     `response` as today.

4. **Fallback for OpenAI, Mistral, Ollama: a synthetic user message,
   constructed at transform time only.** When a tool message contains
   results with files, the adapter emits the tool message(s) exactly as
   today, then appends **one** synthetic user message carrying, per
   result with files: a text part labelling the origin
   (`Files returned by tool "<name>" (call <id>):`) followed by the
   mapped file parts (reusing each adapter's phase-1 user-content
   mapping, including its throw rules; Ollama collects `image/*` base64
   into `images` and throws on everything else).

   The synthetic message exists **only on the wire**. Shared `Message[]`
   history keeps the canonical `ToolResultContent.files` shape, so
   histories stay provider-portable and replaying the same history
   against Anthropic later uses the native path.

5. **Mistral uses the fallback, not its typed `ContentChunk[]` tool
   message.** The SDK types permit chunks in tool messages, but model
   support is unverified — an API that accepts blocks the model ignores
   is silent data loss, the exact failure mode the media research
   rejected. Revisit natively once verified empirically.

6. **Fail-loud policy carries over.** An adapter that cannot deliver a
   given file (unsupported mimeType/source combination per the phase-1
   rules) throws `RangeError`; files are never silently dropped.

## Consequences

- MCP tool results (and any huuma tool via `toolOutput`) can deliver
  images to every provider that can consume them, with one predictable
  degradation shape elsewhere.
- The synthetic user message changes wire-level history for
  OpenAI/Mistral/Ollama when (and only when) files are present;
  text-only tool results keep today's exact wire shape.
- Multi-turn tool loops on the fallback providers see an extra user
  turn after tool results. The labelling text ties files to their call
  id so attribution survives multiple parallel tool calls.
- `Tool`/`callTool` contract grows one additive concept (`ToolOutput`);
  `subagent`, `Agent`, and `Tools` are untouched.

## Resolved questions

1. **Files on errored results: forwarded.** A tool may attach a
   diagnostic screenshot alongside an error. Files are delivered
   regardless of whether the result carries `output` or `error` — the
   label text (fallback) or block adjacency (native) makes the
   association clear. Adapters must not gate file mapping on the
   error state; `is_error`-style handling is unchanged. Note that
   `callTool` itself can never produce this combination: its rejection
   path (src/tools/mod.ts:203-216) builds `result: { error }` from a
   thrown value, where no `ToolOutput` exists to unwrap. The case
   arises from manually constructed histories and from MCP results,
   whose `isError: true` responses may carry image blocks — which is
   why adapters must still handle it.
2. **Label wording is a presentation detail, not stable API.** The
   synthetic-message label is
   `Files returned by tool "<name>" (call <id>):`. It exists for model
   attribution across parallel tool calls; consumers must not parse it,
   and its exact text may change without a version bump. Tests assert
   the presence of tool name and call id, not the full string.
3. **Google part shape: verified against the installed `@google/genai`
   types.** `FunctionResponse` carries
   `parts?: FunctionResponsePart[]`, where each part is either
   `{ inlineData: { mimeType, data } }` (`FunctionResponseBlob`,
   base64) or `{ fileData: { fileUri, mimeType } }`
   (`FunctionResponseFileData`). Mapping: `FileContent` `data` source →
   `inlineData`, `url` source → `fileData`, mirroring the phase-1
   user-content mapping (models/google/mod.ts). The SDK docs flag
   `fileData` as Vertex-only ("not supported in Gemini API"); per the
   phase-1 Google stance we map it anyway and let the API reject it —
   a loud server-side error, not a silent drop.

## Alternatives considered

- **Shape-sniffing tool returns** (`if ("files" in output)`) instead of
  a branded wrapper. Rejected: misinterprets tools whose legitimate
  output happens to carry those keys; magic shapes are undebuggable.
- **Native Mistral tool-message chunks now.** Rejected until verified —
  typed-but-ignored content is silent data loss (see Decision 5).
- **Images directly on the Ollama tool message.** The SDK's single
  role-agnostic `Message` interface means `images` on a `role: "tool"`
  message type-checks, but nothing documents the runtime consuming
  images outside user messages. Rejected for the same
  typed-but-unverified reason as Mistral; the synthetic user message is
  the verified delivery path.
- **Persisting the synthetic user message in shared history.**
  Rejected: history would become provider-shaped, breaking replay
  against providers with native support and polluting the canonical
  message log with transport workarounds.
- **Native-only support (throw on OpenAI/Mistral/Ollama).** Rejected:
  screenshots-from-tools is the dominant real use case and OpenAI is
  too large a provider to exclude; the fallback is well-precedented.
- **Stringifying base64 into the tool result text** (Vercel/Mastra
  behavior documented in the MCP research). Rejected: burns context on
  bytes the model cannot decode; the media research called this out as
  the anti-pattern to avoid.
