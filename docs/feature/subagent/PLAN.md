# Plan — Sub-agent delegation tool

> Design decisions are settled in `docs/feature/subagent/CONTEXT.md` and
> `docs/adr/0001-delegation-as-a-tool-factory.md`. This plan covers
> implementation only.

## Goal

Add a `subagent` tool factory to `@huuma/ai/tools` that lets a parent agent
delegate a task to a pre-configured `Agent` and receive its final assistant
text. The parent identifies the sub-agent through the developer-authored
tool `name` and `description`.

## Scope

In scope:

- `subagent({ name, description, agent })` factory returning a `Tool`.
- Final-text extraction from the sub-agent's run.
- Re-export from `@huuma/ai/tools`.
- Tests using the existing `StubModel` pattern.
- README entry under "What is included".

Out of scope (explicit non-goals from the ADR):

- Dynamic dispatch / named registry of sub-agents.
- Propagating the sub-agent's `onMessage` to the parent's caller.
- Sharing the parent's conversation history with the sub-agent.
- Inheriting the parent's tools.
- A recursion guard (`maxDepth`) — delegation graphs are acyclic by
  construction; see Technical findings and the ADR.
- A `maxTurns` run-length bound on `Agent` (a general control that would
  cover delegation too — separate feature).

## Technical findings

### Import cycle

`tools/mod.ts` defines `Tool` and re-exports every factory
(`cli`, `grep`, …). Each factory file imports `Tool` from `tools/mod.ts`,
forming a cycle that already exists and works because ESM live bindings
resolve `Tool` by the time a factory is *called* (not at module-eval time).
`subagent.ts` follows the same pattern — `import { Tool } from
"@/tools/mod.ts"` is safe.

`Agent` is needed only as a type (the factory receives an instance and
calls `agent.run(prompt)`). Use a type-only import to avoid any runtime
edge into `agent/mod.ts`:

```ts
import type { Agent } from "@/agent/mod.ts";
```

### Final-text extraction

`ModelMessage.contents` is `(TextContent | ToolCallContent)[]` where
`TextContent = { text: string }` and `ToolCallContent = { toolCall: {...} }`.
The agent loop ends on a model message with no tool calls, so the last
message is the final model message. Robustly: iterate backwards to the
last `model` message, filter contents to `TextContent`, join `.text` with
`"\n"`. Return `""` when no model message exists.

### No recursion guard — acyclic by construction

Earlier drafts bounded delegation depth with a `maxDepth` option. Both
candidate mechanisms were rejected: a shared closure counter counts
in-flight calls, not nesting, and falsely rejects same-turn parallel
fan-out to the same tool; `AsyncLocalStorage` has the right semantics
but adds ambient state and a `node:` builtin to guard a scenario the
construction model already prevents.

It prevents it structurally: `subagent({ agent })` captures the agent
when the factory runs, and `Agent` copies its tools at construction with
no later registration. A tool bound to agent B can therefore only be
created after B, whose toolset was frozen before that — every delegation
edge points from a later-constructed object to an earlier-constructed
one, and a cycle would require an agent constructed before itself. With
the public API used normally, the delegation graph is a DAG and chains
are finite. Creating a cycle requires deliberate lazy indirection (e.g.
a wrapper tool whose `fn` closes over a later-assigned reference); a
developer doing that owns termination.

Where limits do belong, later:

- A dynamic-dispatch/registry layer (an explicit ADR non-goal for now)
  can create cycles at runtime via string-keyed lookup — that layer must
  bring its own depth control, threaded explicitly through its own
  machinery.
- Chain-scoped context in general (depth, tracing, `onMessage`
  propagation) keeps hitting the same wall: `Tool.fn(props)` receives no
  calling context. If it is ever genuinely needed, the honest fix is
  extending the `Tool`/`callTool` contract with a context parameter — a
  separate decision.
- Run-length control is orthogonal: `Agent.run` has no turn bound with
  or without delegation. A general `maxTurns` on `Agent` would bound
  every loop, delegation included — a separate feature.

### Error handling

No try/catch around `agent.run(prompt)` in the tool's `fn`. Exceptions
propagate to `callTool`'s `Promise.allSettled`, which formats them as
`{ result: { error } }` to the parent model, consistent with every
other tool.

## Implementation steps

### 1. Create the factory

**File:** `src/tools/subagent/subagent.ts`

- Import `Tool` from `@/tools/mod.ts` (value).
- `import type { Agent } from "@/agent/mod.ts"`.
- `import type { Message, TextContent } from "@/mod.ts"`.
- Import `object`, `string` from `@huuma/validate`.
- Define and export `SubagentToolOptions`:
  ```ts
  export interface SubagentToolOptions<T extends string> {
    /** Tool name the parent model calls to delegate. */
    name: string;
    /** Description guiding the parent model on when/how to delegate. */
    description: string;
    /** The pre-configured sub-agent to delegate to. */
    agent: Agent<T>;
  }
  ```
- Define a module-private `finalText(messages: Message[]): string` helper
  (iterate backwards to the last `model` message, join `TextContent.text`
  with `"\n"`; return `""` when no model message exists).
- Define and export `subagent<T extends string>(options): Tool<any, string>`:
  - Return `new Tool({ name, description, input: object({ prompt: string() }),
    fn })`.
  - `fn`: `const messages = await agent.run(prompt); return
    finalText(messages);` — no try/catch, no shared state across calls.
- Add the standard `@example` docblock mirroring `cli.ts` style. Because
  the sub-agent receives no parent history, the example's `description`
  should tell the parent model to send self-contained prompts, e.g.
  "Delegate research tasks. Provide a self-contained prompt with all
  needed context."

### 2. Re-export from the tools barrel

**File:** `src/tools/mod.ts`

Add alongside the other tool re-exports:

```ts
export {
  subagent,
  type SubagentToolOptions,
} from "@/tools/subagent/subagent.ts";
```

### 3. Tests

**File:** `src/tools/subagent/subagent.test.ts`

Reuse the `StubModel` + `modelMessage` helpers from
`agent/mod.test.ts` (re-define locally — they are not exported). Cases:

1. **Delegates and returns final text.** A sub-agent whose stub model
   responds with `modelMessage("Done.")` — call `subagent(...).call({
   prompt: "go" })` and assert the result equals `"Done."`.
2. **Passes the prompt as the user message.** Inspect the stub model's
   recorded `calls[0].messages` to confirm `[{ role: "user", contents: "go"
   }]` and that no parent history is forwarded.
3. **Returns empty string when no model message.** Stub returns an
   empty `messages: []` (or only a user/tool message) — assert `""`.
4. **Joins multiple text parts.** Stub returns a model message with two
   `TextContent` parts — assert they are joined with `"\n"`.
5. **Ignores trailing tool-call content.** Stub returns a model message
   whose `contents` mixes a `ToolCallContent` and `TextContent` — assert
   only the text part is returned.
6. **Concurrent delegations run independently.** Two concurrent
   top-level calls on the same instance — `Promise.all([t.call({ prompt:
   "a" }), t.call({ prompt: "b" })])` against two identical scripted
   responses — assert both resolve. Guards the ADR's "concurrency is the
   default" behavior against shared state creeping into the factory.
7. **Errors propagate.** Sub-agent's stub model rejects (empty scripted
   responses) — assert `tool.call(...)` rejects with the model error.

Run: `deno task test` (the task already grants the needed permissions).

### 4. Update README

**File:** `README.md`

- Add `subagent` to the "What is included" bullet for `@huuma/ai/tools`,
  e.g. extend the line to mention "sub-agent delegation".
- Optionally add a short example block showing `subagent` usage, mirroring
  the existing `cli` example style.

### 5. Validate

- `deno task check` — type-check, including the type-only `Agent` import
  and the `tools/mod.ts` ↔ `subagent.ts` cycle.
- `deno task lint`.
- `deno task test` — run the new test file (and confirm existing tests
  still pass).
- `deno task publish:dry-run` — confirm `subagent.ts` ships under
  `./tools` and the test file is excluded by the existing
  `**/*.test.ts` publish rule.

## File map

```
src/tools/subagent/subagent.ts          # new — factory
src/tools/subagent/subagent.test.ts     # new — tests
src/tools/mod.ts                        # edit — re-export
README.md                               # edit — docs
docs/feature/subagent/CONTEXT.md        # exists — glossary
docs/adr/0001-delegation-as-a-tool-factory.md  # exists — decision
```

## Risks

- **No recursion guard.** Delegation cycles are impossible through
  normal construction (edges point from later- to earlier-constructed
  objects); deliberate lazy indirection can create one, and the
  developer then owns termination. A future dynamic-dispatch layer must
  bring its own depth control.
- **No run-length bound.** `Agent.run` has no turn limit, with or
  without delegation. A general `maxTurns` on `Agent` is the right
  future control and is out of scope here — note `workflow` already
  supports an optional `maxSteps` that `Agent` simply doesn't pass.
- **No sub-agent error enrichment.** The parent sees the raw rejection
  message via `callTool`. Intentional — consistent with other tools.
