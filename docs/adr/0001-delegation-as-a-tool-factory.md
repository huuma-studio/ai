# ADR 0001 — Delegation as a tool factory

- **Status:** Accepted
- **Date:** 2026-07-02

## Context

`@huuma/ai` provides `Agent`, a self-contained orchestration loop over a
model, tools, and a system prompt. We want a parent agent to be able to hand
a task to a sub-agent and receive a result, without the parent carrying the
sub-agent's intermediate work in its own context.

Two shapes were considered:

- **Static delegation** — a tool factory bound to one pre-configured
  `Agent` instance at construction time. The parent model supplies only a
  prompt.
- **Dynamic dispatch** — a tool that takes both a target name and a prompt,
  looking the sub-agent up from a registry at call time.

## Decision

Delegation is a **tool factory**, `subagent`, living in
`src/tools/subagent/subagent.ts` and re-exported from `@huuma/ai/tools`.

```ts
subagent<T extends string>({
  name: string,          // tool name the parent model calls
  description: string,   // guides the parent on when/how to delegate
  agent: Agent<T>,       // the bound sub-agent
})
```

The factory returns a `Tool` whose `fn` calls `agent.run(prompt)` and
returns the final assistant text to the parent. The parent model identifies
the sub-agent and its role through the developer-authored `name` and
`description`. The factory is generic over the adapter's model id because
`Agent<"some-model-id">` is not assignable to `Agent<string>`
(`BaseModel<T>` uses `T` contravariantly).

Consequences, each an explicit choice:

- **Static, not dynamic.** One tool per sub-agent. Multiple sub-agents are
  multiple tools with distinct names. A registry can be built on top later.
- **No parent history.** The sub-agent starts fresh; each delegation call is
  independent and stateless.
- **Sub-agent uses only its own tools.** The parent's tools are not
  inherited.
- **No recursion guard — acyclic by construction.** `subagent` captures
  the agent when the factory runs, and `Agent` copies its tools at
  construction with no later registration, so every delegation edge
  points from a later-constructed tool to an earlier-constructed agent
  whose toolset was already frozen. A cycle would require an agent
  constructed before itself; with the public API used normally, the
  delegation graph is a DAG and chains are finite. Deliberate lazy
  indirection (a wrapper tool closing over a later-assigned reference)
  can create a cycle — the developer then owns termination. Recursion
  limits belong to a future dynamic-dispatch/registry layer, where
  string-keyed lookup can create cycles at runtime. Run-length control
  is a separate concern: `Agent.run` has no turn bound with or without
  delegation; a general `maxTurns` on `Agent` would be the broader
  control.
- **Siloed `onMessage`.** The sub-agent's `onMessage` is whatever it was
  constructed with. Sub-agent messages do not propagate to the parent's
  observer. Threading the parent's `RunOptions.onMessage` into a tool's
  `fn` would require changing the `Tool`/`callTool` contract, which is out
  of scope.
- **Errors propagate.** The tool's `fn` does not catch exceptions.
  `callTool`'s existing `Promise.allSettled` handling surfaces them to the
  parent model as `{ result: { error } }`, consistent with every other tool.
- **Concurrency is the default.** Multiple delegation tool calls in one
  parent turn run in parallel via `callTool`'s `Promise.allSettled`, exactly
  like any other tool.

## Alternatives considered

- **Dynamic dispatch with a named registry.** Rejected as the starting
  shape: it pushes tool selection onto the model via a string argument,
  which is less reliable than the model picking the right tool by name, and
  is buildable on top of static delegation anyway.
- **Returning the full sub-agent message history.** Rejected: it bloats the
  parent's context and defeats the purpose of delegation, which is context
  isolation. Developer observability is already available via the
  sub-agent's own `onMessage`.
- **Inheriting the parent's tools.** Rejected: it blurs the boundary
  between parent and sub-agent and risks a privileged parent leaking
  capabilities (e.g. `rm`) to a sub-agent that should be constrained.
- **Propagating the sub-agent's `onMessage` to the parent's caller.**
  Rejected: the `Tool`/`callTool` contract has no path to pass calling
  context into `fn`, and interleaving sub-agent messages into the parent's
  stream creates an attribution problem.
- **Bounding recursion with a `maxDepth` option.** Two mechanisms were
  considered and both rejected. A shared per-instance in-flight counter
  (increment on entry, decrement in `finally`) cannot distinguish
  recursion from concurrency: `callTool` runs same-turn tool calls in
  parallel via `Promise.allSettled`, so a sibling call to the same tool
  would observe the first call's increment and be falsely rejected,
  breaking parallel fan-out to one sub-agent. Chain-scoped depth via
  `AsyncLocalStorage` (`node:async_hooks`) has the right semantics —
  parallel siblings inherit their chain's depth — but introduces ambient
  state and a `node:` builtin to guard a scenario the construction model
  already prevents (see the acyclic-by-construction consequence). If
  chain-scoped context is ever genuinely needed (depth, tracing,
  `onMessage` propagation), the honest fix is an explicit context
  parameter on the `Tool`/`callTool` contract — a separate decision.
