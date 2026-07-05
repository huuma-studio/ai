# Plan — MCP client support as a tool factory

> Research and design rationale live in `docs/feature/mcp/CONTEXT.md`.
> This plan covers implementation only and is the foundation for the
> detailed task breakdown.

## Goal

Add an `mcp` tool factory to `@huuma/ai/tools` that connects to an MCP
server (stdio or Streamable HTTP), lists its tools, and exposes each as
an ordinary `Tool` an agent can use. The factory returns a connection
handle owning the lifecycle (`tools()`, `refresh()`, `close()`).

## Scope

In scope:

- `mcp({ name, transport, ... })` async factory returning an
  `McpConnection` handle.
- Transports: stdio (`{ command, args?, env?, cwd? }`), Streamable HTTP
  (`{ url, headers? }`), and a structural escape hatch accepting any
  SDK-compatible transport instance (also what the in-memory tests use).
- JSON Schema pass-through: a `Schema`-interface wrapper around the
  server's raw `inputSchema`; no conversion, no client-side validation.
- Tool naming: model-visible names prefixed `${name}_${toolName}`,
  64-char cap, original name used when calling the server.
- Result mapping: `structuredContent` preferred, else joined `text`
  blocks, placeholders for non-text content; `isError: true` throws so
  `callTool`'s existing error path applies.
- `allowedTools` filter and per-call `timeout` option.
- Re-export from `@huuma/ai/tools`; README + permissions docs.
- ADR 0002 recording the decisions.
- Tests: pure helpers, in-memory integration, one stdio integration
  test spawning a real child process.

Out of scope (explicit non-goals from CONTEXT.md — none require
reshaping this API later):

- OAuth / protected servers beyond static `headers`.
- Elicitation, sampling, roots, resources, prompts.
- `tools/list_changed` auto-refresh (manual `refresh()` only).
- Image/audio tool results as native message parts (needs new message
  content types across all adapters — separate feature).
- Exposing huuma tools *as* an MCP server.
- Legacy HTTP+SSE fallback transport (deprecated long-tail; the SDK
  seam leaves room to add it).

## Technical findings

### Dependency and the SDK seam

`npm:@modelcontextprotocol/sdk@^1.29.0` goes into `deno.json` imports.
Both client transports are verified working under Deno 2.x (stdio child
spawn and Streamable HTTP against a public server). JSR allows npm
dependencies — this package already ships several.

The SDK is mid-rewrite: v2 (`@modelcontextprotocol/client`, explicit
Deno support) goes stable 2026-07-28, and the spec revision landing the
same day removes the initialize handshake and session headers. Every
`@modelcontextprotocol/sdk` import therefore lives in **one file**,
`src/tools/mcp/client.ts`, behind narrow internal types. The v1 → v2
swap later touches only that file.

```ts
// types.ts — internal contract, no SDK imports; client.ts implements it:
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: JSONSchema;
}
export interface McpCallResult {
  content: McpContentBlock[];   // text | image | audio | resource(_link)
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
export interface McpClient {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: unknown, timeout?: number): Promise<McpCallResult>;
  close(): Promise<void>;
}
export function connect(transport: McpTransportOptions): Promise<McpClient>;
```

Transport selection by config shape: `command` → `StdioClientTransport`;
`url` → `StreamableHTTPClientTransport`; an object with `start`/`send`/
`close` methods → used as-is (structural `McpTransport` interface, no
SDK type exported). The escape-hatch pattern is Vercel's — it doubles
as the test seam via the SDK's `InMemoryTransport`.

### Schema pass-through

`Tool.input` needs only the `Schema<T>` interface from `@huuma/validate`
(`validate`, `infer`, `jsonSchema()`, `isRequired()` —
`schema.ts:34-39`), and adapters serialize via `input.jsonSchema()`.
The wrapper:

```ts
class PassthroughSchema implements Schema<Record<string, unknown>> {
  readonly infer!: Record<string, unknown>;
  #schema: JSONSchema;
  constructor(schema: JSONSchema) { this.#schema = schema; }
  validate(value: unknown): Validation<Record<string, unknown>> {
    return { value: (value ?? {}) as Record<string, unknown>, errors: undefined };
  }
  jsonSchema(): JSONSchema { return this.#schema; }
  isRequired(): boolean { return true; }
}
```

No client-side validation is deliberate: per spec (SEP-1303), input
validation is the server's job and surfaces as a tool execution error.
Ecosystem precedent: every surveyed framework passes JSON Schema
through raw; Mastra's schema-conversion attempt was reverted after
silent-data-loss bugs.

Servers with no-arg tools may return `inputSchema` without
`properties`; pass through unchanged (providers that require
`properties: {}` are an adapter concern, not this factory's).

### Tool naming

- Model-visible name: `${name}_${toolName}` — collision-safe across
  servers, and `Tools.add()` replaces silently so unprefixed names from
  two servers would clobber each other.
- Validate `name` (the server label) against `^[A-Za-z0-9_-]+$` at
  factory time; throw otherwise. Combined names respect the provider
  constraint `^[a-zA-Z0-9_-]{1,64}$`: names over 64 chars are truncated
  to 59 and suffixed with `_` + 4-hex djb2 hash of the full name
  (deterministic, no collisions in practice).
- The `Tool.fn` closure captures the **original** server-side tool name
  and uses it for `callTool` — the prefix exists only for the model.
  (Convention lifted from the OpenAI Agents SDK; LangChain's
  non-sanitizing pass-through is a documented source of provider 400s.)

### Result mapping

Flattening `McpCallResult` → `string` (adapters already stringify tool
output via `toolOutputString`, so string output is the native shape):

1. `isError: true` → `throw new Error(joinedText)` — propagates through
   `callTool`'s `Promise.allSettled` into `{ result: { error } }`,
   model-visible, consistent with every other tool (ADR 0001).
2. Else `structuredContent` present → `JSON.stringify(structuredContent)`
   (spec: servers also serialize it into a text block — prefer the
   structured form, drop the duplicate text).
3. Else join `text` blocks with `"\n"`; non-text blocks become
   placeholders: `[image ${mimeType}]`, `[audio ${mimeType}]`,
   `[resource ${uri}]` — honest degradation until message content
   types support binary parts.

### Eager connect, snapshot semantics

`await mcp(...)` connects and lists tools before returning — a
deliberate divergence from the lazy-connect norm of other frameworks,
because `Agent` snapshots tools at construction; there is no per-run
tool resolution to defer into.

Consequence to document on `refresh()`: it re-lists and rebuilds the
cached `Tool[]`, affecting subsequent `tools()` calls — an `Agent`
already constructed keeps its snapshot. Refreshing an agent means
constructing a new one. (Matches the frozen-toolset model from
ADR 0001; no framework surveyed reliably consumes `tools/list_changed`
either.)

`close()` is required — stdio spawns a child process. Calls on a
closed connection reject via the SDK and surface as normal tool errors.

### Permissions

stdio: `--allow-run` (+ `--allow-read`, `--allow-env` for command
resolution and env pass-through). HTTP: `--allow-net`. The existing
`deno task test` flags already cover all of these.

## Implementation steps

### 1. ADR

**File:** `docs/adr/0002-mcp-servers-as-a-tool-factory.md`

Record: official SDK v1 behind a single-module seam (rejected:
hand-rolled client, waiting for v2); eager connect + frozen snapshot;
prefix naming with original-name dispatch; text flattening with
placeholder degradation; `isError` → thrown error; non-goals list.
Condense from CONTEXT.md §5.

### 2. Dependency

**File:** `deno.json`

Add `"@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@^1.29.0"`
to `imports`. Add `"**/testdata/"` to `publish.exclude` (test fixture
server, step 5).

### 3. SDK seam

**Files:** `src/tools/mcp/types.ts`, `src/tools/mcp/client.ts`

- `types.ts` (no SDK imports): `McpToolDef`, `McpContentBlock`,
  `McpCallResult`, `McpClient`, transport options union + structural
  `McpTransport`.
- `client.ts` (the only SDK-importing file): `connect(options)` —
  build transport by config shape, `new Client({ name: "@huuma/ai",
  version })`, `client.connect(transport)`, return the narrow
  `McpClient` wrapper. `callTool` forwards `timeout` as SDK
  `RequestOptions.timeout` when set.
- No huuma types leak in; no SDK types leak out.

### 4. Factory and handle

**File:** `src/tools/mcp/mcp.ts`

Pure pieces live in small internal modules (not exported from the
tools barrel) so they are implementable and testable independently:

- `src/tools/mcp/schema.ts` — `PassthroughSchema`.
- `src/tools/mcp/naming.ts` — server-name validation and
  `modelToolName(server, tool)` (sanitize + prefix + cap). MCP allows
  `.` in tool names, the provider constraint does not — characters
  outside `[A-Za-z0-9_-]` are replaced with `_` before capping.
- `src/tools/mcp/content.ts` — `flattenResult(result)` (mapping rules
  above).

`mcp.ts` composes them:

- `McpToolsOptions`: `name`, `transport`, `allowedTools?: string[]`,
  `timeout?: number` (ms, per tool call).
- `McpConnection` class: holds the `McpClient` + cached `Tool[]`.
  - `tools(): Tool<any, string>[]` — cached copy.
  - `refresh(): Promise<void>` — re-list, rebuild, replace cache.
  - `close(): Promise<void>` — delegate to client.
  - Tool building: filter by `allowedTools` (original names), wrap each
    `McpToolDef` as `new Tool({ name: modelToolName(...), description:
    def.description ?? "", input: new PassthroughSchema(def.inputSchema),
    fn: (props) => flattenResult(await client.callTool(def.name, props,
    timeout)) })`. No try/catch in `fn` — errors propagate (ADR 0001
    convention).
- `mcp(options): Promise<McpConnection>` — validate `name`, connect,
  initial list, return handle.
- Standard `@example` docblock mirroring `cli.ts`/`subagent.ts` style,
  including the `close()` obligation and required Deno permissions.

### 5. Test fixture server

**File:** `src/tools/mcp/testdata/server.ts`

Small stdio MCP server built on the SDK's server API (dev-only file,
excluded from publish): an `add` tool (returns text), an `echo_json`
tool (returns `structuredContent` + duplicate text block), a `fail`
tool (returns `isError: true`). Run by the stdio integration test via
`deno run`.

### 6. Tests

**Files:** unit tests colocated per internal module
(`schema.test.ts`, `naming.test.ts`, `content.test.ts`);
`src/tools/mcp/mcp.test.ts` for integration;
`src/tools/mcp/mcp_stdio.test.ts` for the child-process test.

In-memory cases (SDK `InMemoryTransport.createLinkedPair()`, real SDK
server in-process, client side passed through the custom-transport
escape hatch):

1. **Lists and wraps tools.** Names are `${server}_${tool}`;
   `tool.input.jsonSchema()` returns the server's schema unchanged.
2. **Calls with original name.** Server receives the unprefixed name;
   text result round-trips.
3. **Prefers structuredContent.** Tool returning both structured and
   text content yields the JSON string.
4. **Flattens multi-content.** Text blocks joined with `"\n"`; image
   block becomes `[image image/png]` placeholder.
5. **isError throws.** `tool.call(...)` rejects with the joined text;
   via `callTool` it lands in `{ result: { error } }`.
6. **allowedTools filters.** Only listed originals are exposed.
7. **Name capping.** A >64-char combined name is truncated with the
   hash suffix and stays within `^[a-zA-Z0-9_-]{1,64}$`.
8. **Invalid server name throws** at factory time.
9. **refresh() picks up changes.** Register an extra tool on the
   server, `refresh()`, assert the new `tools()` set; previously
   returned arrays are unchanged.
10. **Agent end-to-end.** `StubModel` (pattern from `agent/mod.test.ts`)
    scripted to call an MCP tool — asserts the wrapped tool works
    through `Agent.run`/`callTool`, not just direct `call()`.

stdio integration (guards the Deno node-compat path, the SDK's
least-tested surface):

11. **Spawned server round-trip.** `mcp({ transport: { command:
    Deno.execPath(), args: ["run", ...] } })` against
    `testdata/server.ts`; list, call `add`, `close()`; assert the call
    result and that `close()` resolves (child reaped).

Run: `deno task test` (existing flags suffice).

### 7. Re-export from the tools barrel

**File:** `src/tools/mod.ts`

```ts
export {
  mcp,
  McpConnection,
  type McpToolsOptions,
} from "@/tools/mcp/mcp.ts";
```

### 8. README

**File:** `README.md`

- Extend "What is included" with MCP server tools.
- Short example: `mcp()` → spread `tools()` into `agent()` → `close()`.
- Extend the Permissions section: stdio → `--allow-run --allow-read
  --allow-env`; HTTP → `--allow-net`.

### 9. Validate

- `deno task check` — including the `tools/mod.ts` ↔ `mcp.ts` cycle
  (same pre-existing safe pattern as every factory) and npm types.
- `deno task lint`.
- `deno task test` — new tests plus existing suite.
- `deno task publish:dry-run` — `mcp.ts`/`client.ts` ship under
  `./tools`; `testdata/` and test files excluded.

## File map

```
src/tools/mcp/types.ts                         # new — internal contract (no SDK imports)
src/tools/mcp/client.ts                        # new — SDK seam (only SDK-importing file)
src/tools/mcp/schema.ts (+ .test.ts)           # new — pass-through Schema
src/tools/mcp/naming.ts (+ .test.ts)           # new — name validation, prefix, cap
src/tools/mcp/content.ts (+ .test.ts)          # new — result flattening
src/tools/mcp/mcp.ts                           # new — factory + handle, composes the above
src/tools/mcp/mcp.test.ts                      # new — in-memory integration tests
src/tools/mcp/mcp_stdio.test.ts                # new — stdio child-process test
src/tools/mcp/testdata/server.ts               # new — stdio test fixture (unpublished)
src/tools/mod.ts                               # edit — re-export
deno.json                                      # edit — dependency + publish exclude
README.md                                      # edit — docs + permissions
docs/adr/0002-mcp-servers-as-a-tool-factory.md # exists — decision
docs/feature/mcp/CONTEXT.md                    # exists — research
docs/feature/mcp/TASKS.json                    # exists — task breakdown
```

## Risks

- **SDK v1 → v2 migration debt.** Accepted knowingly (v2 stable
  2026-07-28); confined to `client.ts` by construction. The public
  factory API is SDK-agnostic.
- **Spec revision 2026-07-28.** Handshake/session removal is absorbed
  by the SDK upgrade, not by this code. Servers adopting the new
  revision before we upgrade may negotiate down or fail — the SDK
  handles version negotiation.
- **Deno node-compat for stdio.** Verified working today but it is the
  SDK's least-tested path; test 11 exists to catch regressions on Deno
  upgrades.
- **Stale snapshots by design.** `refresh()` does not mutate existing
  agents' toolsets — documented, consistent with the frozen-toolset
  model. A live-updating toolset would require `Agent`-level changes.
- **Degraded binary content.** Image/audio results reach the model as
  placeholders until message content types grow binary parts —
  tracked as the follow-up that unlocks screenshot-style tools.
- **No auth beyond headers.** Static `headers` covers token-based
  servers; OAuth-protected servers are out of scope until the v2 SDK
  (which ships the auth machinery) lands.
