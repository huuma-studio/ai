# ADR 0002 — MCP servers as a tool factory

- **Status:** Accepted
- **Date:** 2026-07-04

## Context

`@huuma/ai` agents use tools created by factories in `@huuma/ai/tools`.
The Model Context Protocol (MCP) is the ecosystem standard for serving
tools out-of-process: local servers speak newline-delimited JSON-RPC
over stdio, hosted servers speak Streamable HTTP. We want an agent to
use tools from an MCP server without changing `Agent`, `Tools`,
`callTool`, or any model adapter.

Two shapes were considered for the protocol layer:

- **Official SDK** — `npm:@modelcontextprotocol/sdk` (v1), the
  reference client; verified working under Deno 2.x for both stdio and
  Streamable HTTP transports.
- **Hand-rolled client** — ~1–2k lines of JSON-RPC framing, transport
  and lifecycle code with zero dependencies.

Timing matters: the spec revision landing 2026-07-28 makes breaking
wire-protocol changes (initialize handshake and session headers
removed), and the SDK's v2 — split into `@modelcontextprotocol/client`
with explicit Deno support — goes stable the same day.

Full research: `docs/feature/mcp/CONTEXT.md`.

## Decision

MCP support is a **tool factory**, `mcp`, living in
`src/tools/mcp/mcp.ts` and re-exported from `@huuma/ai/tools`, built on
the official SDK v1 confined behind a single-module seam.

```ts
const github = await mcp({
  name: "github",                       // namespace, validated [A-Za-z0-9_-]+
  transport: { command, args?, env?, cwd? }   // stdio
           | { url, headers? }                // Streamable HTTP
           | McpTransport,                    // structural escape hatch
  allowedTools?: string[],              // filter by original tool name
  timeout?: number,                     // per tool call, ms
});

const assistant = agent({ ..., tools: [...github.tools()] });
await github.close();                   // required — stdio spawns a child
```

The factory connects, lists the server's tools, and wraps each as an
ordinary `Tool` whose `input` is a pass-through `Schema` around the
server's raw JSON Schema and whose `fn` calls the server and flattens
the result to a string. The handle exposes `tools()` (cached),
`refresh()` (re-list), and `close()`.

Consequences, each an explicit choice:

- **Official SDK v1, isolated in `client.ts`.** Every
  `@modelcontextprotocol/sdk` import lives in one file behind narrow
  internal types. The v1 → v2 swap after 2026-07-28 touches only that
  file; the public factory API is SDK-agnostic.
- **Eager connect and list.** `Agent` snapshots tools at construction,
  so there is no per-run resolution to defer into — a deliberate
  divergence from the lazy-connect norm of frameworks that resolve
  tools per run. `refresh()` affects subsequent `tools()` calls only;
  an already-constructed agent keeps its snapshot, consistent with the
  frozen-toolset model of ADR 0001.
- **JSON Schema pass-through, no client-side validation.** The
  wrapper satisfies the `Schema` interface (`validate` passes values
  through, `jsonSchema()` returns the server's schema verbatim). Input
  validation is the server's job and surfaces as a tool execution
  error (spec SEP-1303). No conversion to `@huuma/validate` schemas —
  the ecosystem's documented dead end (Mastra shipped JSON-Schema→zod
  conversion, accumulated silent-data-loss bugs, and removed it).
- **Prefixed model-visible names, original names on the wire.** Tools
  are exposed as `${name}_${toolName}` — `Tools.add()` replaces
  silently, so unprefixed names from two servers would clobber each
  other. Names are capped at 64 chars (truncate + deterministic hash
  suffix) to satisfy the provider constraint `^[a-zA-Z0-9_-]{1,64}$`.
  The server is always called with the original tool name; the prefix
  exists only for the model.
- **Results flatten to strings.** Adapters already stringify tool
  output, so string output is the native shape. Precedence:
  `structuredContent` as JSON, else `text` blocks joined with `"\n"`;
  image/audio/resource blocks degrade to `[image image/png]`-style
  placeholders until message content types support binary parts.
- **`isError: true` throws.** MCP reports tool execution failures as
  successful responses with an error flag; the wrapper converts them to
  thrown errors so `callTool`'s existing `Promise.allSettled` path
  formats them as `{ result: { error } }` — model-visible, consistent
  with every other tool (ADR 0001: errors propagate).
- **One handle per server.** Multi-server is composition:
  `[...a.tools(), ...b.tools()]`. No registry, no config record —
  matching the one-factory-per-concern style of `subagent`.
- **Caller-owned lifecycle.** `close()` is the caller's obligation;
  stdio transports own a child process. Calls after close reject and
  surface as normal tool errors.
- **Permissions are documented, not hidden.** stdio needs
  `--allow-run --allow-read --allow-env`; HTTP needs `--allow-net`.

Out of scope, each addable without reshaping the API: OAuth beyond
static `headers`, elicitation/sampling/roots, resources and prompts,
`tools/list_changed` auto-refresh (manual `refresh()` instead), binary
tool results as native message parts, the deprecated HTTP+SSE fallback
transport, and exposing huuma tools *as* an MCP server.

## Alternatives considered

- **Hand-rolled minimal client.** Fits the dependency-light ethos
  (SDK v1 drags ~91 transitive deps including server-side frameworks),
  and several production clients do exactly this. Rejected on timing
  and correctness surface: the wire protocol itself changes on
  2026-07-28, so we would chase two spec revisions instead of letting
  the SDK absorb the churn — and the handshake ordering, version
  negotiation, dual JSON/SSE response modes, session management and
  reconnection logic are all easy to get subtly wrong. The `client.ts`
  seam keeps this door open if the SDK's Deno support regresses.
- **Waiting for / building on the v2 SDK beta.** Stable is ~3.5 weeks
  out; v1 is verified working today and supported ≥6 months past v2.
  Building now against v1 costs one contained migration later and
  avoids beta churn.
- **Converting JSON Schema to `@huuma/validate` schemas.** Would give
  client-side validation and typed props, but schema conversion is
  lossy and the failure mode is silent data corruption, not errors —
  demonstrated at scale by Mastra's revert. Pass-through is what every
  surveyed framework converged on.
- **Lazy connect (connect on first tool call).** The norm elsewhere,
  but their tool sets resolve per run; huuma agents freeze tools at
  construction, so laziness would only move the connection error from
  `await mcp(...)` — where the caller can handle it — into the first
  tool call mid-run, where the model sees it.
- **Config record of multiple servers** (`{ servers: { a: ..., b: ... } }`,
  the Mastra/LangChain shape). Rejected as the starting point: it adds
  aggregate lifecycle and partial-failure policy for something
  composition already expresses; a multi-server convenience can be
  built on top of single-server handles later.
- **Silent collision handling** (flat merge, last wins — Vercel and
  LangChain's default). Rejected: silent clobbering in `Tools`' map is
  exactly the failure mode namespacing exists to prevent. Prefixing by
  default follows Mastra/Claude; throwing on duplicates (OpenAI) was
  unnecessary once names are namespaced per server.
