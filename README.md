# @huuma/ai

Composable AI primitives for Deno and TypeScript: unified chat-model adapters,
agent orchestration, workflows, and tool factories.

## Example

```typescript
import { agent } from "jsr:@huuma/ai/agent";
import { openai } from "jsr:@huuma/ai/models/openai";
import { cli } from "jsr:@huuma/ai/tools";

const assistant = agent({
  model: openai({ apiKey: Deno.env.get("OPENAI_API_KEY") }),
  modelId: "gpt-5.5",
  systemPrompt: "You are a concise TypeScript assistant.",
  tools: [cli({ allowedCommands: ["deno"] })],
});

const messages = await assistant.run("Check the current Deno version.");
console.log(messages.at(-1));
```

CLI commands run with stdin closed. Tools that can prompt or open a pager should
also receive their command-specific non-interactive environment settings. For
example, configure GitHub CLI like this:

```typescript
const gh = cli({
  allowedCommands: ["gh"],
  // Only enable when child processes run in an external OS sandbox.
  allowUnsafeEnvironmentVariables: true,
  // Trusted configuration overrides same-named values supplied by the agent.
  env: { GIT_TERMINAL_PROMPT: "0" },
});

await gh.call({
  command: "gh",
  args: ["pr", "view", "--json", "title"],
  env: {
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
  },
});
```

Per-call environment variables are disabled by default. Enabling
`allowUnsafeEnvironmentVariables` permits arbitrary string-valued variables and
means `allowedCommands` is no longer a security boundary: variables such as
`PATH`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, and runtime-specific options can
execute additional code. Only enable it when child processes are protected by
an external OS sandbox. Trusted `CliToolOptions.env` values remain available
without the unsafe opt-in and override same-named per-call values.

Set `GH_TOKEN` or `GITHUB_TOKEN` in the parent process when non-interactive
authentication is needed; child commands inherit the parent environment. Keep
secrets in the parent or trusted tool configuration rather than exposing them
through model-generated tool calls.

The same agent can be backed by Mistral:

```typescript
import { agent } from "jsr:@huuma/ai/agent";
import { mistral } from "jsr:@huuma/ai/models/mistral";

const assistant = agent({
  model: mistral({ apiKey: Deno.env.get("MISTRAL_API_KEY") }),
  modelId: "mistral-large-latest",
  systemPrompt: "You are a concise TypeScript assistant.",
});
```

The same agent can be backed by Z.AI (GLM Coding Plan):

```typescript
import { agent } from "jsr:@huuma/ai/agent";
import { zai } from "jsr:@huuma/ai/models/zai";

const assistant = agent({
  model: zai({ apiKey: Deno.env.get("ZAI_CODING_API_KEY") }),
  modelId: "glm-5.3",
  systemPrompt: "You are a concise TypeScript assistant.",
});
```

The Z.AI adapter targets the **GLM Coding Plan** endpoint at
`https://api.z.ai/api/coding/paas/v4/` by default. Supported model IDs are
`glm-5.3`, `glm-5-turbo`, and `glm-4.7` (requests for GLM-5.2/GLM-5.1
auto-route to GLM-5.3). The API is fully OpenAI Chat Completions-compatible,
so the adapter wraps the OpenAI SDK with a pre-configured base URL.

Z.AI-specific options — `thinking`, `reasoning_effort`, `do_sample`, and
`tool_stream` — are passed through the `options` field:

```typescript
import { zai } from "jsr:@huuma/ai/models/zai";
import { cli } from "jsr:@huuma/ai/tools";

const model = zai({ apiKey: Deno.env.get("ZAI_CODING_API_KEY") });

// Generation with thinking controls
const result = await model.generate({
  modelId: "glm-4.7",
  messages: [{ role: "user", contents: "Debug this function." }],
  options: {
    thinking: { type: "enabled", clear_thinking: false },
    reasoning_effort: "max",
  },
});

// Streaming with tools
const stream = await model.stream({
  modelId: "glm-5.3",
  messages: [{ role: "user", contents: "List the files in this directory." }],
  tools: [cli({ allowedCommands: ["ls"] })],
  options: { reasoning_effort: "high" },
});
```

Preserved Thinking is enabled by default on the Coding Plan endpoint. The
adapter round-trips `reasoning_content` in assistant messages so that prior
thinking state carries across tool-call iterations — sending incomplete or
missing thinking blocks degrades model performance and cache hit rates.

An agent can delegate tasks to another agent through the `subagent` tool. The
sub-agent runs its own loop and only its final answer reaches the parent:

```typescript
import { agent } from "jsr:@huuma/ai/agent";
import { openai } from "jsr:@huuma/ai/models/openai";
import { cli, subagent } from "jsr:@huuma/ai/tools";

const researcher = agent({
  model: openai({ apiKey: Deno.env.get("OPENAI_API_KEY") }),
  modelId: "gpt-5.5",
  systemPrompt: "You research topics and answer concisely.",
  tools: [cli({ allowedCommands: ["deno"] })],
});

const assistant = agent({
  model: openai({ apiKey: Deno.env.get("OPENAI_API_KEY") }),
  modelId: "gpt-5.5",
  systemPrompt: "You are a concise TypeScript assistant.",
  tools: [
    subagent({
      name: "research",
      description:
        "Delegate research tasks. Provide a self-contained prompt with all needed context.",
      agent: researcher,
    }),
  ],
});
```

## Media input

User messages and agent prompts can carry files next to text. A file part
holds an IANA MIME type plus either base64 `data` (no data-URL prefix) or a
publicly reachable `url` — exactly one of the two:

```typescript
import { agent } from "jsr:@huuma/ai/agent";
import { anthropic } from "jsr:@huuma/ai/models/anthropic";

const assistant = agent({
  model: anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") }),
  modelId: "claude-sonnet-4-6",
  systemPrompt: "You describe images concisely.",
});

import { encodeBase64 } from "jsr:@std/encoding/base64";

const image = await Deno.readFile("photo.png");
const messages = await assistant.run([
  { text: "What is in this image?" },
  {
    file: {
      mimeType: "image/png",
      data: encodeBase64(image),
    },
  },
]);
console.log(messages.at(-1));
```

What each adapter supports:

| Provider | Image | PDF | Audio | By URL |
| --- | --- | --- | --- | --- |
| Anthropic | ✓ (jpeg/png/gif/webp as base64) | ✓ | ✗ | ✓ image + PDF |
| OpenAI | ✓ | ✓ (base64 only) | ✓ wav/mp3 (base64 only) | ✓ images only |
| Z.AI | ✓ | ✓ (base64 only) | ✓ wav/mp3 (base64 only) | ✓ images only |
| Google Gemini | ✓ | ✓ | ✓ (+ video) | ✓ |
| Mistral | ✓ | ✓ (URL only) | ✓ | ✓ |
| Ollama | ✓ (base64 only) | ✗ | ✗ | ✗ |

Unsupported mimeType/source combinations throw a `RangeError` at request
time — no part is ever dropped silently, and adapters never fetch URLs
into bytes themselves.

### Media from tools

Tools can return media alongside their output by wrapping the return
value with `toolOutput`:

```typescript
import { tool, toolOutput } from "jsr:@huuma/ai/tools";
import { object, string } from "jsr:@huuma/validate";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const screenshot = tool({
  name: "screenshot",
  description: "Take a screenshot of a page.",
  input: object({ url: string() }),
  fn: async ({ url }) => {
    const png = await capture(url); // Uint8Array
    return toolOutput("Screenshot captured.", [
      { file: { mimeType: "image/png", data: encodeBase64(png) } },
    ]);
  },
});
```

The files land on the tool result's `files` field and are delivered to
the model in a provider-dependent way:

| Provider | Delivery |
| --- | --- |
| Anthropic | native — content blocks inside `tool_result` |
| Google Gemini | native — `FunctionResponse` parts |
| OpenAI | synthetic user message after the tool messages |
| Z.AI | synthetic user message after the tool messages |
| Mistral | synthetic user message after the tool messages |
| Ollama | synthetic user message (base64 images only) |

The synthetic user message exists only on the wire — shared history keeps
the canonical `files` shape, so the same history replayed against a
native provider uses its native path. Per-file support and throw rules
match the user-message table above; files are never silently dropped.

## What is included

- Shared message and content types in `@huuma/ai`.
- A common `BaseModel` interface in `@huuma/ai/model`.
- Model adapters for Anthropic Claude, OpenAI, Google Gemini, Mistral, Ollama,
  and Z.AI (GLM Coding Plan) in `@huuma/ai/models`.
- Agent orchestration in `@huuma/ai/agent`.
- Lightweight workflow primitives in `@huuma/ai/workflow`.
- Tool factories for CLI execution, file operations, grep, website fetching, web
  search, skill loading, sub-agent delegation, and MCP servers in
  `@huuma/ai/tools`.

## MCP servers

`mcp()` connects to a Model Context Protocol server and exposes its tools as
ordinary tools — nothing else changes:

```typescript
import { mcp } from "jsr:@huuma/ai/tools";

const deepwiki = await mcp({
  name: "deepwiki", // model-visible tools become deepwiki_<tool>
  transport: { url: "https://mcp.deepwiki.com/mcp" }, // or { command, args } for stdio
});

const assistant = agent({ /* ... */ tools: [...deepwiki.tools()] });
// later — required, stdio transports own a child process:
await deepwiki.close();
```

Multi-server setups compose handles: `[...a.tools(), ...b.tools()]`. Tool
results flatten to text (`structuredContent` preferred); `image` and `audio`
content blocks land on the tool result's `files` field and are delivered
per provider exactly like media from tools above; execution failures
reported by the server surface as regular tool errors. stdio transports need
`--allow-run --allow-read --allow-env`; HTTP transports need `--allow-net`.

The client implements the **MCP 2026-07-28** specification revision via
`@modelcontextprotocol/sdk@^1.30.0`. Tool definitions with a `title` field
have it surfaced in the model-visible description. `resource_link` content
blocks carry optional `description`, `size`, `title`, and `icons` fields.

**MRTR (Model Requesting Tool Result):** when a server returns
`resultType: "input_required"`, the tool call throws an error with the
server's text content (or a descriptive fallback) rather than silently
returning incomplete data. This client has no user-in-the-loop, so
interactive tool flows are not supported — the error surfaces to the agent
so it can self-correct or report the need for additional input.

**Deprecated features:** Roots, Sampling, Logging, HTTP+SSE transport, and
OAuth Dynamic Client Registration are still functional in the SDK but are
not adopted by this client. New code should not rely on them; they may be
removed in a future spec revision.

Design record: `docs/adr/0002-mcp-servers-as-a-tool-factory.md`.

## Skills

`skills()` loads Agent-Skills-style `SKILL.md` folders from a directory and
exposes them as two tools implementing progressive disclosure: `list_skills`
returns cheap `{ name, description }` pairs, and `retrieve_skill` loads one
skill's full instructions plus the skill folder's absolute `path` so an agent
equipped with `files`/`grep`/`cli` can resolve bundled resources referenced
by relative path. Loading is lenient — a missing directory yields an empty
list and misconfigured skills warn through `onWarning` instead of failing
the scan — and the scan is cached for the factory's lifetime:

```typescript
import { agent } from "jsr:@huuma/ai/agent";
import { openai } from "jsr:@huuma/ai/models/openai";
import { skills } from "jsr:@huuma/ai/tools";

const [listSkills, retrieveSkill] = skills({
  path: "./.agents/skills", // default
  onWarning: (message) => console.warn(message), // default
});

const assistant = agent({
  model: openai({ apiKey: Deno.env.get("OPENAI_API_KEY") }),
  modelId: "gpt-5.5",
  systemPrompt: "You follow skill instructions precisely.",
  tools: [listSkills, retrieveSkill],
});
```

Construct a new factory to re-scan disk; the cache does not watch files.
Design record: `docs/adr/0005-skills-as-a-tool-factory.md`.

## Permissions

Some bundled tools require Deno permissions when called, such as `--allow-read`,
`--allow-write`, `--allow-run`, `--allow-net`, or `--allow-env`, depending on
the tool and provider configuration. MCP transports: stdio needs
`--allow-run --allow-read --allow-env`; Streamable HTTP needs `--allow-net`.
The `skills` factory needs `--allow-read` for the skills directory.
