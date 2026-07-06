/**
 * Tests for the Mistral model adapter.
 *
 * @module
 */
import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import { HTTPClient } from "@mistralai/mistralai";
import type { JSONSchema } from "@huuma/validate";
import type { Message, ModelMessage, ToolMessage } from "@/mod.ts";
import { tool } from "@/tools/mod.ts";
import { string } from "@huuma/validate";
import {
  mistral,
  MistralModel,
  mistralMessagesFrom,
  mistralToolsFrom,
  mistralUsageFrom,
} from "./mod.ts";

function props(value: Record<string, unknown>): JSONSchema {
  return value as unknown as JSONSchema;
}

async function requestBodyFrom(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const body = input instanceof Request
    ? await input.clone().text()
    : init?.body?.toString() ?? "{}";
  return JSON.parse(body) as Record<string, unknown>;
}

Deno.test("mistralToolsFrom converts tools correctly", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: string(),
    fn: () => "result",
  });

  const mistralTools = mistralToolsFrom([testTool]);
  assertEquals(mistralTools.length, 1);
  assertEquals(mistralTools[0].type, "function");
  assertEquals(mistralTools[0].function.name, "test_tool");
  assertEquals(mistralTools[0].function.description, "A test tool");
  assertEquals(mistralTools[0].function.parameters, { type: "string" });
});

Deno.test("mistralMessagesFrom converts user message", () => {
  const msg: Message = { role: "user", contents: "Hello" };
  const result = mistralMessagesFrom([msg]);
  assertEquals(result, [{ role: "user", content: "Hello" }]);
});

Deno.test("mistralMessagesFrom converts user message with array contents", () => {
  const msg: Message = {
    role: "user",
    contents: [{ text: "Hello" }, { text: " world!" }],
  };
  const result = mistralMessagesFrom([msg]);
  assertEquals(result, [{ role: "user", content: "Hello world!" }]);
});

Deno.test("mistralMessagesFrom maps base64 images to data URL chunks", () => {
  const msg: Message = {
    role: "user",
    contents: [
      { text: "What is this?" },
      { file: { mimeType: "image/png", data: "aGVsbG8=" } },
    ],
  };
  assertEquals(mistralMessagesFrom([msg]), [{
    role: "user",
    content: [
      { type: "text", text: "What is this?" },
      { type: "image_url", imageUrl: "data:image/png;base64,aGVsbG8=" },
    ],
  }]);
});

Deno.test("mistralMessagesFrom passes image URLs through", () => {
  const msg: Message = {
    role: "user",
    contents: [{
      file: { mimeType: "image/png", url: "https://example.com/a.png" },
    }],
  };
  assertEquals(mistralMessagesFrom([msg]), [{
    role: "user",
    content: [
      { type: "image_url", imageUrl: "https://example.com/a.png" },
    ],
  }]);
});

Deno.test("mistralMessagesFrom maps PDF URLs to document_url chunks", () => {
  const msg: Message = {
    role: "user",
    contents: [{
      file: { mimeType: "application/pdf", url: "https://example.com/a.pdf" },
    }],
  };
  assertEquals(mistralMessagesFrom([msg]), [{
    role: "user",
    content: [
      { type: "document_url", documentUrl: "https://example.com/a.pdf" },
    ],
  }]);
});

Deno.test("mistralMessagesFrom throws on base64 PDFs", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "application/pdf", data: "aGVsbG8=" } }],
  };
  assertThrows(
    () => mistralMessagesFrom([msg]),
    RangeError,
    "base64 PDFs",
  );
});

Deno.test("mistralMessagesFrom maps audio data and URLs to input_audio chunks", () => {
  const data: Message = {
    role: "user",
    contents: [{ file: { mimeType: "audio/mpeg", data: "aGVsbG8=" } }],
  };
  assertEquals(mistralMessagesFrom([data]), [{
    role: "user",
    content: [{ type: "input_audio", inputAudio: "aGVsbG8=" }],
  }]);

  const url: Message = {
    role: "user",
    contents: [{
      file: { mimeType: "audio/mpeg", url: "https://example.com/a.mp3" },
    }],
  };
  assertEquals(mistralMessagesFrom([url]), [{
    role: "user",
    content: [
      { type: "input_audio", inputAudio: "https://example.com/a.mp3" },
    ],
  }]);
});

Deno.test("mistralMessagesFrom throws on unsupported file types", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "video/mp4", data: "aGVsbG8=" } }],
  };
  assertThrows(
    () => mistralMessagesFrom([msg]),
    RangeError,
    'file content of type "video/mp4"',
  );
});

Deno.test("mistralMessagesFrom converts system message with array contents", () => {
  const msg: Message = {
    role: "system",
    contents: [{ text: "You are " }, { text: "an AI." }],
  };
  const result = mistralMessagesFrom([msg]);
  assertEquals(result, [{ role: "system", content: "You are an AI." }]);
});

Deno.test("mistralMessagesFrom converts system message", () => {
  const msg: Message = {
    role: "system",
    contents: "You are a helpful assistant.",
  };
  const result = mistralMessagesFrom([msg]);
  assertEquals(result, [{
    role: "system",
    content: "You are a helpful assistant.",
  }]);
});

Deno.test("mistralMessagesFrom converts model message with tool calls", () => {
  const msgWithContent: Message = {
    role: "model",
    contents: [
      { text: "Thinking..." },
      { toolCall: { id: "1", name: "tool1", props: props({ arg: "val" }) } },
    ],
    toolCalls: [{ id: "1", name: "tool1", props: props({ arg: "val" }) }],
  };

  const result = mistralMessagesFrom([msgWithContent]);
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "assistant");
  assertEquals((result[0] as { content?: string }).content, "Thinking...");
  assertEquals(
    (result[0] as { toolCalls?: unknown }).toolCalls,
    [{
      id: "1",
      type: "function",
      function: { name: "tool1", arguments: '{"arg":"val"}' },
    }],
  );
});

Deno.test("mistralMessagesFrom converts tool message", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      { toolResult: { id: "1", name: "tool1", result: { output: "success" } } },
    ],
  };

  const result = mistralMessagesFrom([msg]);
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "tool");
  assertEquals((result[0] as { content?: string }).content, "success");
  assertEquals((result[0] as { toolCallId?: string }).toolCallId, "1");
  assertEquals((result[0] as { name?: string }).name, "tool1");
});

Deno.test("mistralMessagesFrom appends a synthetic user message for tool result files", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [{
      toolResult: {
        id: "1",
        name: "screenshot",
        result: { output: "captured" },
        files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
      },
    }],
  };

  assertEquals(mistralMessagesFrom([msg]), [
    {
      role: "tool",
      content: "captured",
      toolCallId: "1",
      name: "screenshot",
    },
    {
      role: "user",
      content: [
        { type: "text", text: 'Files returned by tool "screenshot" (call 1):' },
        { type: "image_url", imageUrl: "data:image/png;base64,aGVsbG8=" },
      ],
    },
  ]);
});

Deno.test("mistralMessagesFrom aggregates files of multiple tool results into one synthetic user message", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "1",
          name: "screenshot",
          result: { output: "captured" },
          files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
        },
      },
      {
        toolResult: {
          id: "2",
          name: "camera",
          result: { output: "photographed" },
          files: [{ file: { mimeType: "image/jpeg", data: "d29ybGQ=" } }],
        },
      },
    ],
  };

  const result = mistralMessagesFrom([msg]);
  assertEquals(result.length, 3);
  assertEquals(result[2], {
    role: "user",
    content: [
      { type: "text", text: 'Files returned by tool "screenshot" (call 1):' },
      { type: "image_url", imageUrl: "data:image/png;base64,aGVsbG8=" },
      { type: "text", text: 'Files returned by tool "camera" (call 2):' },
      { type: "image_url", imageUrl: "data:image/jpeg;base64,d29ybGQ=" },
    ],
  });
});

Deno.test("mistralMessagesFrom folds tool result files into a following user message", () => {
  const messages: Message[] = [
    {
      role: "tool",
      contents: [{
        toolResult: {
          id: "1",
          name: "screenshot",
          result: { output: "captured" },
          files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
        },
      }],
    },
    { role: "user", contents: "What do you see?" },
  ];

  assertEquals(mistralMessagesFrom(messages), [
    {
      role: "tool",
      content: "captured",
      toolCallId: "1",
      name: "screenshot",
    },
    {
      role: "user",
      content: [
        { type: "text", text: 'Files returned by tool "screenshot" (call 1):' },
        { type: "image_url", imageUrl: "data:image/png;base64,aGVsbG8=" },
        { type: "text", text: "What do you see?" },
      ],
    },
  ]);
});

Deno.test("mistralMessagesFrom throws on tool result base64 PDFs", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [{
      toolResult: {
        id: "1",
        name: "report",
        result: { output: "generated" },
        files: [{ file: { mimeType: "application/pdf", data: "aGVsbG8=" } }],
      },
    }],
  };

  assertThrows(
    () => mistralMessagesFrom([msg]),
    RangeError,
    "base64 PDFs",
  );
});

Deno.test("mistralMessagesFrom converts tool message with non-string output object", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "2",
          name: "tool2",
          result: { output: { ok: true, data: [1, 2] } },
        },
      },
    ],
  };

  const result = mistralMessagesFrom([msg]);
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "tool");
  assertEquals(
    (result[0] as { content?: string }).content,
    '{"ok":true,"data":[1,2]}',
  );
  assertEquals((result[0] as { toolCallId?: string }).toolCallId, "2");
});

Deno.test("mistralMessagesFrom prefers error over output when both set", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "5",
          name: "tool5",
          result: { output: "ignored", error: { message: "boom" } },
        },
      },
    ],
  };

  const result = mistralMessagesFrom([msg]);
  assertEquals((result[0] as { content?: string }).content, '{"message":"boom"}');
});

Deno.test("mistralMessagesFrom drops fully empty assistant messages", () => {
  const msg: Message = {
    role: "model",
    contents: [],
    toolCalls: [],
  };

  const result = mistralMessagesFrom([msg]);
  assertEquals(result.length, 0);
});

Deno.test("mistralMessagesFrom keeps assistant with only tool calls", () => {
  const msg: Message = {
    role: "model",
    contents: [{ toolCall: { id: "a", name: "t", props: props({}) } }],
    toolCalls: [{ id: "a", name: "t", props: props({}) }],
  };

  const result = mistralMessagesFrom([msg]);
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "assistant");
  assertEquals((result[0] as { content?: string }).content, undefined);
  assertEquals(
    ((result[0] as { toolCalls?: unknown[] }).toolCalls ?? []).length,
    1,
  );
});

Deno.test("mistralMessagesFrom converts tool message with multiple tool results", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      { toolResult: { id: "1", name: "tool1", result: { output: "result1" } } },
      { toolResult: { id: "2", name: "tool2", result: { output: "result2" } } },
    ],
  };

  const result = mistralMessagesFrom([msg]);
  assertEquals(result.length, 2);
  assertEquals(result[0].role, "tool");
  assertEquals((result[0] as { toolCallId?: string }).toolCallId, "1");
  assertEquals((result[0] as { content?: string }).content, "result1");
  assertEquals(result[1].role, "tool");
  assertEquals((result[1] as { toolCallId?: string }).toolCallId, "2");
  assertEquals((result[1] as { content?: string }).content, "result2");
});

Deno.test("mistralMessagesFrom prepends system prompt if provided", () => {
  const result = mistralMessagesFrom(
    [{ role: "user", contents: "Hi" }],
    "You are a helpful assistant",
  );

  assertEquals(result, [
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "Hi" },
  ]);
});

Deno.test("mistralMessagesFrom handles multi-turn history", () => {
  const messages: Message[] = [
    { role: "user", contents: "Hello" },
    {
      role: "model",
      contents: [{ text: "Hi there" }],
      toolCalls: [],
    },
    { role: "user", contents: "How are you?" },
  ];

  const result = mistralMessagesFrom(messages);
  assertEquals(result, [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
    { role: "user", content: "How are you?" },
  ]);
});

Deno.test("mistralUsageFrom maps usage correctly", () => {
  const usage = mistralUsageFrom({
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });

  assertEquals(usage, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
});

Deno.test("mistralUsageFrom returns undefined for empty usage", () => {
  assertEquals(mistralUsageFrom(undefined), undefined);
  assertEquals(mistralUsageFrom({}), undefined);
});

Deno.test("MistralModel.generate calls API and returns mapped result", async () => {
  let fetchCalled = false;
  let requestBody: Record<string, unknown> | null = null;

  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalled = true;
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        if (url.includes("/v1/chat/completions")) {
          requestBody = await requestBodyFrom(input, init);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "chatcmpl-123",
                object: "chat.completion",
                created: 1677652288,
                model: "mistral-large-latest",
                choices: [{
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "Hello! how can I help you today?",
                  },
                  finish_reason: "stop",
                }],
                usage: {
                  prompt_tokens: 9,
                  completion_tokens: 12,
                  total_tokens: 21,
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
        return Promise.resolve(new Response("Not found", { status: 404 }));
      },
    }),
  });

  const result = await model.generate({
    modelId: "mistral-large-latest",
    messages: [{ role: "user", contents: "Hi" }],
  });

  assertEquals(fetchCalled, true);
  assertEquals(requestBody!.model, "mistral-large-latest");
  assertEquals(requestBody!.messages, [{ role: "user", content: "Hi" }]);
  assertEquals(result.modelId, "mistral-large-latest");
  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].role, "model");
  assertEquals(result.messages[0].contents, [{
    text: "Hello! how can I help you today?",
  }]);
  assertEquals(result.usage, {
    inputTokens: 9,
    outputTokens: 12,
    totalTokens: 21,
  });
});

Deno.test("MistralModel.generate handles tool calls", async () => {
  let requestBody: Record<string, unknown> | null = null;

  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        if (url.includes("/v1/chat/completions")) {
          requestBody = await requestBodyFrom(input, init);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "chatcmpl-123",
                object: "chat.completion",
                created: 1677652288,
                model: "mistral-large-latest",
                choices: [{
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{
                      id: "call_abc",
                      type: "function",
                      function: {
                        name: "get_weather",
                        arguments: '{"location":"San Francisco"}',
                      },
                    }],
                  },
                  finish_reason: "tool_calls",
                }],
                usage: {
                  prompt_tokens: 50,
                  completion_tokens: 20,
                  total_tokens: 70,
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
        return Promise.resolve(new Response("Not found", { status: 404 }));
      },
    }),
  });

  const result = await model.generate({
    modelId: "mistral-large-latest",
    messages: [{ role: "user", contents: "What is the weather?" }],
  });

  assertEquals(requestBody!.model, "mistral-large-latest");
  assertEquals(result.modelId, "mistral-large-latest");
  assertEquals(result.messages.length, 1);
  const msg = result.messages[0] as ModelMessage;
  assertEquals(msg.role, "model");
  assertEquals(msg.contents, [{
    toolCall: {
      id: "call_abc",
      name: "get_weather",
      props: props({ location: "San Francisco" }),
    },
  }]);
  assertEquals(msg.toolCalls, [{
    id: "call_abc",
    name: "get_weather",
    props: props({ location: "San Francisco" }),
  }]);
});

Deno.test("MistralModel.generate prepends system prompt if provided", async () => {
  let requestBody: Record<string, unknown> | null = null;

  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        if (url.includes("/v1/chat/completions")) {
          requestBody = await requestBodyFrom(input, init);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "chatcmpl-123",
                object: "chat.completion",
                created: 1677652288,
                model: "mistral-large-latest",
                choices: [{
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "Response",
                  },
                  finish_reason: "stop",
                }],
                usage: {
                  prompt_tokens: 5,
                  completion_tokens: 1,
                  total_tokens: 6,
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
        return Promise.resolve(new Response("Not found", { status: 404 }));
      },
    }),
  });

  await model.generate({
    modelId: "mistral-large-latest",
    system: "You are a helpful assistant",
    messages: [{ role: "user", contents: "Hi" }],
  });

  assertEquals(requestBody!.messages, [
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "Hi" },
  ]);
});

Deno.test("MistralModel.generate handles invalid JSON in tool call arguments", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        if (url.includes("/v1/chat/completions")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "chatcmpl-123",
                object: "chat.completion",
                created: 1677652288,
                model: "mistral-large-latest",
                choices: [{
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [{
                      id: "call_bad",
                      type: "function",
                      function: {
                        name: "broken_tool",
                        arguments: "this is not json",
                      },
                    }],
                  },
                  finish_reason: "tool_calls",
                }],
                usage: {
                  prompt_tokens: 5,
                  completion_tokens: 1,
                  total_tokens: 6,
                },
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }
        return Promise.resolve(new Response("Not found", { status: 404 }));
      },
    }),
  });

  const result = await model.generate({
    modelId: "mistral-large-latest",
    messages: [{ role: "user", contents: "Call the tool" }],
  });

  assertEquals(result.messages.length, 1);
  const msg = result.messages[0] as ModelMessage;
  assertEquals(msg.toolCalls.length, 1);
  assertEquals(msg.toolCalls[0].id, "call_bad");
  assertEquals(msg.toolCalls[0].name, "broken_tool");
  assertEquals(msg.toolCalls[0].props, {});
});

Deno.test("MistralModel.stream streams content and maps correctly", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        if (url.includes("/v1/chat/completions")) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"1","model":"mistral-large-latest","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n',
                ),
              );
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"1","model":"mistral-large-latest","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n',
                ),
              );
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"1","model":"mistral-large-latest","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
                ),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return Promise.resolve(
            new Response(stream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }),
          );
        }
        return Promise.resolve(new Response("Not found", { status: 404 }));
      },
    }),
  });

  const stream = await model.stream({
    modelId: "mistral-large-latest",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  assertEquals(results.length, 2);
  assertEquals(results[0].modelId, "mistral-large-latest");
  assertEquals(results[0].messages[0].contents, [{ text: "Hello" }]);
  assertEquals(results[1].messages[0].contents, [{ text: " world" }]);
});

Deno.test("MistralModel.stream yields a final usage chunk", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        if (url.includes("/v1/chat/completions")) {
          const encoder = new TextEncoder();
          const chunks = [
            {
              id: "1",
              model: "mistral-large-latest",
              choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
            },
            {
              id: "1",
              model: "mistral-large-latest",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
            {
              id: "1",
              model: "mistral-large-latest",
              choices: [],
              usage: {
                prompt_tokens: 9,
                completion_tokens: 12,
                total_tokens: 21,
              },
            },
          ];
          const stream = new ReadableStream({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                );
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return Promise.resolve(
            new Response(stream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }),
          );
        }
        return Promise.resolve(new Response("Not found", { status: 404 }));
      },
    }),
  });

  const stream = await model.stream({
    modelId: "mistral-large-latest",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  assertEquals(results.length, 2);
  assertEquals(results[0].messages[0].contents, [{ text: "Hi" }]);
  assertEquals(results[1], {
    modelId: "mistral-large-latest",
    messages: [],
    usage: {
      inputTokens: 9,
      outputTokens: 12,
      totalTokens: 21,
    },
  });
});

Deno.test("MistralModel.stream streams tool calls correctly", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        if (url.includes("/v1/chat/completions")) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              const chunk1 = {
                id: "1",
                model: "mistral-large-latest",
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: 0,
                      id: "call_123",
                      type: "function",
                      function: {
                        name: "get_weather",
                        arguments: "",
                      },
                    }],
                  },
                  finish_reason: null,
                }],
              };
              const chunk2 = {
                id: "1",
                model: "mistral-large-latest",
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: 0,
                      function: {
                        name: "get_weather",
                        arguments: '{"loc',
                      },
                    }],
                  },
                  finish_reason: null,
                }],
              };
              const chunk3 = {
                id: "1",
                model: "mistral-large-latest",
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: 0,
                      function: {
                        name: "get_weather",
                        arguments: 'ation":"SF"}',
                      },
                    }],
                  },
                  finish_reason: null,
                }],
              };

              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk1)}\n\n`),
              );
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk2)}\n\n`),
              );
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk3)}\n\n`),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return Promise.resolve(
            new Response(stream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }),
          );
        }
        return Promise.resolve(new Response("Not found", { status: 404 }));
      },
    }),
  });

  const stream = await model.stream({
    modelId: "mistral-large-latest",
    messages: [{ role: "user", contents: "What is the weather?" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  assertEquals(results.length, 1);
  const msg = results[0].messages[0] as ModelMessage;
  assertEquals(msg.toolCalls.length, 1);
  assertEquals(msg.toolCalls[0].id, "call_123");
  assertEquals(msg.toolCalls[0].name, "get_weather");
  assertEquals(msg.toolCalls[0].props, props({ location: "SF" }));
  assertEquals(msg.contents, [{ toolCall: msg.toolCalls[0] }]);
});

Deno.test("MistralModel.stream flushes tool calls on finish_reason", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        if (url.includes("/v1/chat/completions")) {
          const encoder = new TextEncoder();
          const chunks = [
            {
              id: "1",
              model: "mistral-large-latest",
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "get_weather", arguments: '{"a":1}' },
                  }],
                },
                finish_reason: null,
              }],
            },
            {
              id: "1",
              model: "mistral-large-latest",
              choices: [{
                index: 0,
                delta: { content: "Done" },
                finish_reason: "tool_calls",
              }],
            },
          ];
          const stream = new ReadableStream({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                );
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return Promise.resolve(
            new Response(stream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }),
          );
        }
        return Promise.resolve(new Response("Not found", { status: 404 }));
      },
    }),
  });

  const stream = await model.stream({
    modelId: "mistral-large-latest",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  assertEquals(results.length, 2);
  assertEquals(results[0].messages[0].contents, [{ text: "Done" }]);
  const toolMsg = results[1].messages[0] as ModelMessage;
  assertEquals(toolMsg.toolCalls, [
    { id: "call_1", name: "get_weather", props: props({ a: 1 }) },
  ]);
});

Deno.test("MistralModel.stream emits earlier tool call when a new index starts", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        if (url.includes("/v1/chat/completions")) {
          const encoder = new TextEncoder();
          const chunks = [
            {
              id: "1",
              model: "mistral-large-latest",
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "tool_a", arguments: "{}" },
                  }],
                },
                finish_reason: null,
              }],
            },
            {
              id: "1",
              model: "mistral-large-latest",
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 1,
                    id: "call_2",
                    type: "function",
                    function: { name: "tool_b", arguments: '{"b":2}' },
                  }],
                },
                finish_reason: null,
              }],
            },
          ];
          const stream = new ReadableStream({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
                );
              }
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return Promise.resolve(
            new Response(stream, {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            }),
          );
        }
        return Promise.resolve(new Response("Not found", { status: 404 }));
      },
    }),
  });

  const stream = await model.stream({
    modelId: "mistral-large-latest",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  assertEquals(results.length, 2);
  const first = results[0].messages[0] as ModelMessage;
  assertEquals(first.toolCalls[0].id, "call_1");
  assertEquals(first.toolCalls[0].name, "tool_a");
  const second = results[1].messages[0] as ModelMessage;
  assertEquals(second.toolCalls[0].id, "call_2");
  assertEquals(second.toolCalls[0].name, "tool_b");
  assertEquals(second.toolCalls[0].props, props({ b: 2 }));
});

Deno.test("mistral factory returns MistralModel instance", () => {
  const model = mistral({ apiKey: "test" });
  assertInstanceOf(model, MistralModel);
});

Deno.test("MistralModel has expected methods", () => {
  const model = new MistralModel({ apiKey: "test" });
  assertEquals(typeof model.generate, "function");
  assertEquals(typeof model.stream, "function");
});
