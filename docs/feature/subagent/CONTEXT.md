# Context — @huuma/ai

A glossary of the domain language used across `@huuma/ai`. Implementation
details live in code and ADRs, not here.

## Terms

### Sub-agent

An `Agent` instance invoked by another agent through a tool. The sub-agent
runs its own orchestration loop (model, tools, system prompt) and returns a
result to the calling agent. A sub-agent is bound to a single tool at
tool-creation time; the calling agent supplies only the prompt.

### Delegation

The act of a parent agent calling a sub-agent via a delegation tool. The
parent agent does not see the sub-agent's internal messages — it receives
only the sub-agent's result.
