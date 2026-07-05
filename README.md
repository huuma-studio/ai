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
| Mistral | synthetic user message after the tool messages |
| Ollama | synthetic user message (base64 images only) |

The synthetic user message exists only on the wire — shared history keeps
the canonical `files` shape, so the same history replayed against a
native provider uses its native path. Per-file support and throw rules
match the user-message table above; files are never silently dropped.

## What is included

- Shared message and content types in `@huuma/ai`.
- A common `BaseModel` interface in `@huuma/ai/model`.
- Model adapters for Anthropic Claude, OpenAI, Google Gemini, Mistral, and
  Ollama in `@huuma/ai/models`.
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
results flatten to text (`structuredContent` preferred); execution failures
reported by the server surface as regular tool errors. stdio transports need
`--allow-run --allow-read --allow-env`; HTTP transports need `--allow-net`.
Design record: `docs/adr/0002-mcp-servers-as-a-tool-factory.md`.

## Permissions

Some bundled tools require Deno permissions when called, such as `--allow-read`,
`--allow-write`, `--allow-run`, `--allow-net`, or `--allow-env`, depending on
the tool and provider configuration. MCP transports: stdio needs
`--allow-run --allow-read --allow-env`; Streamable HTTP needs `--allow-net`.
