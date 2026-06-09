# @huuma/ai

Composable AI primitives for Deno and TypeScript: unified chat-model adapters, agent orchestration, workflows, and tool factories.

## Example

```typescript
import { agent } from "jsr:@huuma/ai/agent";
import { openai } from "jsr:@huuma/ai/models/openai";
import { cli } from "jsr:@huuma/ai/tools";

const assistant = agent({
  model: openai({ apiKey: Deno.env.get("OPENAI_API_KEY") }),
  modelId: "gpt-4o-mini",
  systemPrompt: "You are a concise TypeScript assistant.",
  tools: [cli({ allowedCommands: ["deno"] })],
});

const messages = await assistant.run("Check the current Deno version.");
console.log(messages.at(-1));
```

## What is included

- Shared message and content types in `@huuma/ai`.
- A common `BaseModel` interface in `@huuma/ai/model`.
- Model adapters for OpenAI, Google Gemini, and Ollama in `@huuma/ai/models`.
- Agent orchestration in `@huuma/ai/agent`.
- Lightweight workflow primitives in `@huuma/ai/workflow`.
- Tool factories for CLI execution, file operations, grep, website fetching, web search, and skill loading in `@huuma/ai/tools`.

## Permissions

Some bundled tools require Deno permissions when called, such as `--allow-read`, `--allow-write`, `--allow-run`, `--allow-net`, or `--allow-env`, depending on the tool and provider configuration.
