# MCP client support — research context

- **Date:** 2026-07-04
- **Status:** Research complete, no implementation yet

Goal: let a `@huuma/ai` agent use tools served by MCP servers (stdio and
Streamable HTTP), fitting the existing `Tool` / tool-factory model.

## 1. Protocol landscape (July 2026)

- Current stable spec revision is **2025-11-25**. The next revision,
  **2026-07-28**, is a release candidate landing in ~3.5 weeks with
  breaking changes: the `initialize`/`initialized` handshake and
  `Mcp-Session-Id` header are removed (stateless core), Roots/Sampling/
  Logging are deprecated, Tasks/Apps become extensions.
- Transports a client needs in practice: **stdio** (dominant for local
  servers; newline-delimited JSON-RPC over a spawned subprocess) and
  **Streamable HTTP** (hosted servers; every POST may answer as plain
  JSON *or* an SSE stream, sessions via `Mcp-Session-Id`, negotiated
  version echoed in `MCP-Protocol-Version` on every request). The old
  HTTP+SSE transport (2024-11-05) is deprecated long-tail.
- Tool results are arrays of typed content: `text`, `image`, `audio`,
  `resource_link`, embedded `resource`, plus `isError` and optional
  `structuredContent`/`outputSchema`. Real servers overwhelmingly return
  `text` (often JSON-in-text); `image` is common from browser/screenshot
  tools; the rest are rare. Execution failures arrive as a *successful*
  response with `isError: true` — protocol errors are JSON-RPC errors.

## 2. SDK options (verified empirically under Deno)

Verified in a scratch project with `@modelcontextprotocol/sdk@1.29.0`
via `npm:` specifiers, Deno 2.x:

- **stdio round-trip works**: `StdioClientTransport` spawning a child
  Deno process, `listTools()` returning clean JSON Schema, `callTool()`
  round-trip. Needs `--allow-run` (plus `--allow-read`, `--allow-env`).
- **Streamable HTTP client works**: verified against the public
  DeepWiki MCP server (`https://mcp.deepwiki.com/mcp`). Needs
  `--allow-net`.
- Cost: v1 is a monolith — ~91 transitive deps (~4.3 MB) including
  express/hono even for client-only use. Not on JSR.

SDK timing is the pivotal fact: **v2 splits the monolith** into
`@modelcontextprotocol/client` / `/server` / `/core`, explicitly
supports Deno, accepts any Standard Schema validator, and goes **stable
2026-07-28** (currently `2.0.0-beta.2`). v1 stays supported ≥6 months
after that.

Hand-rolling a minimal client (~1–2k lines) is feasible but poorly
timed: the wire protocol itself changes in the 2026-07-28 revision, so
we would chase two spec revisions ourselves instead of letting the SDK
absorb the churn. No mature Deno-native MCP client library exists on
JSR (the ecosystem there is server-side toolkits).

## 3. What other frameworks converged on

Survey of Vercel AI SDK, Mastra, OpenAI Agents SDK JS,
@langchain/mcp-adapters, and the Claude Agent SDK:

1. **JSON Schema pass-through won.** Every framework passes the
   server's `inputSchema` through raw. Mastra converted JSON Schema →
   zod, accumulated silent-data-loss bugs (results stripped to `{}`,
   zod v4 breakage), and ripped the conversion out in 1.8.1.
2. **Namespacing:** three conventions in the wild
   (`server_tool`, `mcp__server__tool`, `mcp_${server}__${tool}`).
   Flat merge with silent last-wins (Vercel, LangChain post-0.6) is a
   recognized mistake; OpenAI throws on duplicates. Hard-won details:
   always call the server with the *original* tool name (prefix is
   model-visible only) and respect the provider-side
   `^[a-zA-Z0-9_-]{1,64}$` tool-name constraint.
3. **Lazy connect, cached list, explicit refresh.** Nobody connects in
   a constructor; nobody reliably consumes `tools/list_changed`
   (LangChain fires a callback but doesn't refresh). Lifecycle hygiene
   dominates the issue trackers: zombie stdio children, leaked SSE
   sessions, closing mid-stream, double-connect races.
4. **Raw result envelopes are the default and they're mediocre.**
   Vercel/Mastra hand the model JSON-stringified base64 for images. The
   better designs map `text`/`image` to model-native parts, keep blobs
   out of context, prefer `structuredContent` when present, and route
   `isError: true` into the normal model-visible tool-error path
   rather than a hard throw.
5. **Convergent user API:** a record of servers with transport inferred
   from the config shape (`command` → stdio, `url` → HTTP with legacy
   SSE fallback on 4xx), per-server error policy so one dead server
   doesn't take down the rest.

## 4. Fit with @huuma/ai

- `Tool.input` only needs the `Schema<T>` *interface* from
  `@huuma/validate` (`validate()` + `jsonSchema()`), and adapters call
  `input.jsonSchema()` (`models/anthropic/mod.ts:759`). A ~10-line
  wrapper that returns the server's raw JSON Schema and validates as
  pass-through makes an MCP tool an ordinary `Tool` — no changes to
  `Agent`, `Tools`, `callTool`, or any adapter. Client-side input
  validation is deliberately skipped: per spec (SEP-1303), input
  validation errors should surface as tool execution errors from the
  server anyway.
- Adapters already stringify tool output (`toolOutputString`), so
  flattening MCP content to text is consistent with the existing
  design. Message contents have no image part today; native image
  round-trip is a separate cross-adapter feature, out of scope here.
- `Agent` snapshots tools at construction, so tools must exist before
  `agent()` is called → the factory should connect and list **eagerly**
  (a deliberate, documented divergence from the lazy-connect norm,
  which exists in other frameworks because their tool sets are resolved
  per run).
- `callTool` already formats thrown errors as `{ result: { error } }`;
  mapping `isError: true` results onto that path keeps MCP tools
  consistent with every other tool (ADR 0001: "errors propagate").

## 5. Recommendation

**Integrate via the official SDK, isolated behind one module; ship the
huuma-side design now, swap the SDK to v2 after 2026-07-28.**

- `src/tools/mcp/mcp.ts`, re-exported from `@huuma/ai/tools`. Async
  factory (name TBD, e.g. `mcp()`):

  ```ts
  const github = await mcp({
    name: "github",                                  // namespace + prefix
    transport: { command: "npx", args: ["-y", "..."] } // stdio
    //         | { url: "https://api.example.com/mcp", headers },
    // allowedTools?: string[], timeout?: number
  });

  const assistant = agent({ ..., tools: [...github.tools()] });
  // github.refresh(), await github.close()
  ```

  Returns a handle: `tools(): Tool[]` (cached), `refresh()` (re-list),
  `close()` (must be called; stdio spawns a child process). One handle
  per server — multi-server is composition (`[...a.tools(),
  ...b.tools()]`), matching the one-factory-per-concern style of
  `subagent`.
- Tool names exposed to the model as `${name}_${tool}` (collision-safe
  in `Tools`' silently-replacing map), truncated at 64 chars, original
  name used for `callTool` against the server.
- Result mapping: prefer `structuredContent` (JSON-stringified), else
  join `text` blocks; describe non-text blocks as placeholder text for
  now; `isError: true` → throw with joined text so the existing
  `callTool` error path applies.
- Keep all SDK contact (client construction, transports, lifecycle) in
  one internal module so the v1 → `@modelcontextprotocol/client` v2
  swap after 2026-07-28 touches a single file. Dependency:
  `npm:@modelcontextprotocol/sdk@^1.29.0` in `deno.json` imports.
- Document permissions: stdio → `--allow-run --allow-read --allow-env`;
  HTTP → `--allow-net`.

**Out of scope initially** (each usable later without reshaping the
API): OAuth for protected servers, elicitation/sampling/roots,
resources and prompts, `tools/list_changed` auto-refresh (manual
`refresh()` instead), image/audio content as native message parts,
and exposing huuma tools *as* an MCP server.

**Rejected alternatives:**

- *Hand-rolled minimal client.* Fits the dependency-light ethos and is
  ~1–2k lines, but the wire protocol is mid-breaking-change
  (2026-07-28) and the correctness surface is real: handshake ordering,
  version negotiation, dual JSON/SSE response modes, session
  management, reconnection. Revisit only if the SDK's Deno support
  regresses; the seam module keeps that door open.
- *Waiting for / building on the v2 beta now.* Stable is ~3.5 weeks
  out; v1 is verified working today and stays supported ≥6 months.
  Building the huuma layer now against v1 costs one contained
  migration later.
- *JSON Schema → `@huuma/validate` conversion.* The ecosystem's
  documented dead end (Mastra 1.8.1 removal); pass-through wrapper
  instead.
