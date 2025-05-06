# @huuma/ai

A lightweight Deno library for interacting with AI models, with a focus on Google's Gemini models.

## Features

- Type-safe interface for AI model interactions
- Support for Google's Gemini models (2.0 Flash, 2.5 Pro, etc.)
- Structured message handling for conversations
- Tool calling support
- Streaming responses

## Installation

### Using JSR (JavaScript Registry)

```ts
// In your deno.json
// "imports": {
//   "@huuma/ai": "jsr:@huuma/ai@^0.0.1"
// }

import { google } from "@huuma/ai";
```

## Setup

Before using the library, make sure you have:

1. A Google API key for Gemini (get one at the [Google AI Studio](https://makersuite.google.com/app/apikey))
2. Deno installed on your system (https://deno.com/manual/getting_started/installation)

## Usage

### Basic Example

```ts
import { google } from "@huuma/ai";

// Initialize with your API key
const model = google({ apiKey: Deno.env.get("GOOGLE_API_KEY") });

// Generate a response
const result = await model.generate({
  modelId: "gemini-2.0-flash",
  messages: [
    {
      role: "user",
      contents: "What's the capital of France?"
    }
  ]
});

console.log(result.messages[0].contents);
```

### Using Tool Calls

```ts
import { google } from "@huuma/ai";
import type { Tool } from "@huuma/ai";

// Define a tool
const weatherTool: Tool = {
  name: "get_weather",
  description: "Get the current weather for a location",
  input: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "The city and state or country"
      }
    },
    required: ["location"]
  }
};

// Initialize model with API key
const model = google({ apiKey: Deno.env.get("GOOGLE_API_KEY") });

// Generate a response with tool capability
const result = await model.generate({
  modelId: "gemini-2.0-flash",
  messages: [
    {
      role: "user",
      contents: "What's the weather like in Paris?"
    }
  ],
  tools: [weatherTool]
});

console.log(result.messages[0]);
```

### Streaming Responses

```ts
import { google } from "@huuma/ai";

// Initialize with your API key
const model = google({ apiKey: Deno.env.get("GOOGLE_API_KEY") });

// Stream a response
const stream = await model.stream({
  modelId: "gemini-2.0-flash",
  messages: [
    {
      role: "user",
      contents: "Write a short story about a robot learning to paint."
    }
  ]
});

// Process the streamed chunks
for await (const chunk of stream) {
  for (const message of chunk.messages) {
    for (const content of message.contents) {
      if ("text" in content) {
        console.log(content.text);
      }
    }
  }
}
```

## Available Models

The library supports various Gemini models:

- `gemini-2.0-flash-lite` and `gemini-2.0-flash-lite-001`
- `gemini-2.0-flash` and `gemini-2.0-flash-001`
- `gemini-2.5-flash-preview-04-17`
- `gemini-2.5-pro-preview-03-25` and `gemini-2.5-pro-exp-03-25`
- Custom models with `custom-{model-name}`

## API Reference

### Types

The library provides several TypeScript types for structured interaction:

- `Message`: Base message type
- `SytemMessage`, `ModelMessage`, `UserMessage`, `ToolMessage`: Role-specific message types
- `TextContent`: Text content within messages
- `ToolCallContent`: Tool call content within messages
- `ToolResultContent`: Tool result content within messages
- `Tool`: Definition for tools that models can call

### GoogleGenAIModel

The main class for interacting with Google's Gemini models.

#### Constructor

```ts
constructor(options: { apiKey: string })
```

#### Methods

- `generate({ modelId, messages, tools, system })`: Generate a completion
- `stream({ modelId, messages, tools, system })`: Stream a completion

## License

See the [LICENSE](./LISENCE) file for details.
