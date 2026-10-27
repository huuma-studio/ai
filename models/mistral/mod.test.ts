/**
 * Tests for the Mistral model adapter.
 *
 * @module
 */
import { expect, test } from "vite-plus/test";
import { HTTPClient } from "@mistralai/mistralai";
import type { JSONSchema } from "@huuma/validate";
import type { Message, ModelMessage, ToolMessage } from "../../src/mod.ts";
import { tool } from "../../src/tools/mod.ts";
import { object, string } from "@huuma/validate";
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
  const body =
    input instanceof Request
      ? await input.clone().text()
      : typeof init?.body === "string"
        ? init.body
        : "{}";
  return JSON.parse(body) as Record<string, unknown>;
}

test("mistralToolsFrom converts tools correctly", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: string(),
    fn: () => "result",
  });

  const mistralTools = mistralToolsFrom([testTool]);
  expect(mistralTools.length).toStrictEqual(1);
  expect(mistralTools[0].type).toStrictEqual("function");
  expect(mistralTools[0].function.name).toStrictEqual("test_tool");
  expect(mistralTools[0].function.description).toStrictEqual("A test tool");
  expect(mistralTools[0].function.parameters).toStrictEqual({ type: "string" });
});

test("mistralToolsFrom reuses the cached schema of Tool instances", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: object({ query: string() }),
    fn: () => "result",
  });

  const [first] = mistralToolsFrom([testTool]);
  const [second] = mistralToolsFrom([testTool]);
  expect(first.function.parameters === second.function.parameters).toStrictEqual(true);
  expect(first.function.parameters === (testTool.jsonSchema as object)).toStrictEqual(true);
});

test("mistralToolsFrom converts structural tools without a cached schema", () => {
  const converted = mistralToolsFrom([
    {
      name: "structural",
      description: "A structural tool",
      input: object({ query: string() }),
    },
  ]);

  expect(converted).toStrictEqual([
    {
      type: "function",
      function: {
        name: "structural",
        description: "A structural tool",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
  ]);
});

test("mistralMessagesFrom converts user message", () => {
  const msg: Message = { role: "user", contents: "Hello" };
  const result = mistralMessagesFrom([msg]);
  expect(result).toStrictEqual([{ role: "user", content: "Hello" }]);
});

test("mistralMessagesFrom converts user message with array contents", () => {
  const msg: Message = {
    role: "user",
    contents: [{ text: "Hello" }, { text: " world!" }],
  };
  const result = mistralMessagesFrom([msg]);
  expect(result).toStrictEqual([{ role: "user", content: "Hello world!" }]);
});

test("mistralMessagesFrom maps base64 images to data URL chunks", () => {
  const msg: Message = {
    role: "user",
    contents: [{ text: "What is this?" }, { file: { mimeType: "image/png", data: "aGVsbG8=" } }],
  };
  expect(mistralMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        { type: "image_url", imageUrl: "data:image/png;base64,aGVsbG8=" },
      ],
    },
  ]);
});

test("mistralMessagesFrom passes image URLs through", () => {
  const msg: Message = {
    role: "user",
    contents: [
      {
        file: { mimeType: "image/png", url: "https://example.com/a.png" },
      },
    ],
  };
  expect(mistralMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [{ type: "image_url", imageUrl: "https://example.com/a.png" }],
    },
  ]);
});

test("mistralMessagesFrom maps PDF URLs to document_url chunks", () => {
  const msg: Message = {
    role: "user",
    contents: [
      {
        file: { mimeType: "application/pdf", url: "https://example.com/a.pdf" },
      },
    ],
  };
  expect(mistralMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [{ type: "document_url", documentUrl: "https://example.com/a.pdf" }],
    },
  ]);
});

test("mistralMessagesFrom throws on base64 PDFs", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "application/pdf", data: "aGVsbG8=" } }],
  };
  expect(() => mistralMessagesFrom([msg])).toThrow(RangeError);
  expect(() => mistralMessagesFrom([msg])).toThrow("base64 PDFs");
});

test("mistralMessagesFrom maps audio data and URLs to input_audio chunks", () => {
  const data: Message = {
    role: "user",
    contents: [{ file: { mimeType: "audio/mpeg", data: "aGVsbG8=" } }],
  };
  expect(mistralMessagesFrom([data])).toStrictEqual([
    {
      role: "user",
      content: [{ type: "input_audio", inputAudio: "aGVsbG8=" }],
    },
  ]);

  const url: Message = {
    role: "user",
    contents: [
      {
        file: { mimeType: "audio/mpeg", url: "https://example.com/a.mp3" },
      },
    ],
  };
  expect(mistralMessagesFrom([url])).toStrictEqual([
    {
      role: "user",
      content: [{ type: "input_audio", inputAudio: "https://example.com/a.mp3" }],
    },
  ]);
});

test("mistralMessagesFrom throws on unsupported file types", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "video/mp4", data: "aGVsbG8=" } }],
  };
  expect(() => mistralMessagesFrom([msg])).toThrow(RangeError);
  expect(() => mistralMessagesFrom([msg])).toThrow('file content of type "video/mp4"');
});

test("mistralMessagesFrom converts system message with array contents", () => {
  const msg: Message = {
    role: "system",
    contents: [{ text: "You are " }, { text: "an AI." }],
  };
  const result = mistralMessagesFrom([msg]);
  expect(result).toStrictEqual([{ role: "system", content: "You are an AI." }]);
});

test("mistralMessagesFrom converts system message", () => {
  const msg: Message = {
    role: "system",
    contents: "You are a helpful assistant.",
  };
  const result = mistralMessagesFrom([msg]);
  expect(result).toStrictEqual([
    {
      role: "system",
      content: "You are a helpful assistant.",
    },
  ]);
});

test("mistralMessagesFrom converts model message with tool calls", () => {
  const msgWithContent: Message = {
    role: "model",
    contents: [
      { text: "Thinking..." },
      { toolCall: { id: "1", name: "tool1", props: props({ arg: "val" }) } },
    ],
    toolCalls: [{ id: "1", name: "tool1", props: props({ arg: "val" }) }],
  };

  const result = mistralMessagesFrom([msgWithContent]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("assistant");
  expect((result[0] as { content?: string }).content).toStrictEqual("Thinking...");
  expect((result[0] as { toolCalls?: unknown }).toolCalls).toStrictEqual([
    {
      id: "1",
      type: "function",
      function: { name: "tool1", arguments: '{"arg":"val"}' },
    },
  ]);
});

test("mistralMessagesFrom converts tool message", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [{ toolResult: { id: "1", name: "tool1", result: { output: "success" } } }],
  };

  const result = mistralMessagesFrom([msg]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("tool");
  expect((result[0] as { content?: string }).content).toStrictEqual("success");
  expect((result[0] as { toolCallId?: string }).toolCallId).toStrictEqual("1");
  expect((result[0] as { name?: string }).name).toStrictEqual("tool1");
});

test("mistralMessagesFrom appends a synthetic user message for tool result files", () => {
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
    ],
  };

  expect(mistralMessagesFrom([msg])).toStrictEqual([
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

test("mistralMessagesFrom aggregates files of multiple tool results into one synthetic user message", () => {
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
  expect(result.length).toStrictEqual(3);
  expect(result[2]).toStrictEqual({
    role: "user",
    content: [
      { type: "text", text: 'Files returned by tool "screenshot" (call 1):' },
      { type: "image_url", imageUrl: "data:image/png;base64,aGVsbG8=" },
      { type: "text", text: 'Files returned by tool "camera" (call 2):' },
      { type: "image_url", imageUrl: "data:image/jpeg;base64,d29ybGQ=" },
    ],
  });
});

test("mistralMessagesFrom folds tool result files into a following user message", () => {
  const messages: Message[] = [
    {
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
      ],
    },
    { role: "user", contents: "What do you see?" },
  ];

  expect(mistralMessagesFrom(messages)).toStrictEqual([
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

test("mistralMessagesFrom throws on tool result base64 PDFs", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "1",
          name: "report",
          result: { output: "generated" },
          files: [{ file: { mimeType: "application/pdf", data: "aGVsbG8=" } }],
        },
      },
    ],
  };

  expect(() => mistralMessagesFrom([msg])).toThrow(RangeError);
  expect(() => mistralMessagesFrom([msg])).toThrow("base64 PDFs");
});

test("mistralMessagesFrom converts tool message with non-string output object", () => {
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
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("tool");
  expect((result[0] as { content?: string }).content).toStrictEqual('{"ok":true,"data":[1,2]}');
  expect((result[0] as { toolCallId?: string }).toolCallId).toStrictEqual("2");
});

test("mistralMessagesFrom prefers error over output when both set", () => {
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
  expect((result[0] as { content?: string }).content).toStrictEqual('{"message":"boom"}');
});

test("mistralMessagesFrom drops fully empty assistant messages", () => {
  const msg: Message = {
    role: "model",
    contents: [],
    toolCalls: [],
  };

  const result = mistralMessagesFrom([msg]);
  expect(result.length).toStrictEqual(0);
});

test("mistralMessagesFrom keeps assistant with only tool calls", () => {
  const msg: Message = {
    role: "model",
    contents: [{ toolCall: { id: "a", name: "t", props: props({}) } }],
    toolCalls: [{ id: "a", name: "t", props: props({}) }],
  };

  const result = mistralMessagesFrom([msg]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("assistant");
  expect((result[0] as { content?: string }).content).toStrictEqual(undefined);
  expect(((result[0] as { toolCalls?: unknown[] }).toolCalls ?? []).length).toStrictEqual(1);
});

test("mistralMessagesFrom converts tool message with multiple tool results", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      { toolResult: { id: "1", name: "tool1", result: { output: "result1" } } },
      { toolResult: { id: "2", name: "tool2", result: { output: "result2" } } },
    ],
  };

  const result = mistralMessagesFrom([msg]);
  expect(result.length).toStrictEqual(2);
  expect(result[0].role).toStrictEqual("tool");
  expect((result[0] as { toolCallId?: string }).toolCallId).toStrictEqual("1");
  expect((result[0] as { content?: string }).content).toStrictEqual("result1");
  expect(result[1].role).toStrictEqual("tool");
  expect((result[1] as { toolCallId?: string }).toolCallId).toStrictEqual("2");
  expect((result[1] as { content?: string }).content).toStrictEqual("result2");
});

test("mistralMessagesFrom prepends system prompt if provided", () => {
  const result = mistralMessagesFrom(
    [{ role: "user", contents: "Hi" }],
    "You are a helpful assistant",
  );

  expect(result).toStrictEqual([
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "Hi" },
  ]);
});

test("mistralMessagesFrom handles multi-turn history", () => {
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
  expect(result).toStrictEqual([
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi there" },
    { role: "user", content: "How are you?" },
  ]);
});

test("mistralUsageFrom maps usage correctly", () => {
  const usage = mistralUsageFrom({
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
  });

  expect(usage).toStrictEqual({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
  });
});

test("mistralUsageFrom returns undefined for empty usage", () => {
  expect(mistralUsageFrom(undefined)).toStrictEqual(undefined);
  expect(mistralUsageFrom({})).toStrictEqual(undefined);
});

test("MistralModel.generate calls API and returns mapped result", async () => {
  let fetchCalled = false;
  let requestBody: Record<string, unknown> | null = null;

  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalled = true;
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/v1/chat/completions")) {
          requestBody = await requestBodyFrom(input, init);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "chatcmpl-123",
                object: "chat.completion",
                created: 1677652288,
                model: "mistral-large-latest",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: "Hello! how can I help you today?",
                    },
                    finish_reason: "stop",
                  },
                ],
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

  expect(fetchCalled).toStrictEqual(true);
  expect(requestBody!.model).toStrictEqual("mistral-large-latest");
  expect(requestBody!.messages).toStrictEqual([{ role: "user", content: "Hi" }]);
  expect(result.modelId).toStrictEqual("mistral-large-latest");
  expect(result.messages.length).toStrictEqual(1);
  expect(result.messages[0].role).toStrictEqual("model");
  expect(result.messages[0].contents).toStrictEqual([
    {
      text: "Hello! how can I help you today?",
    },
  ]);
  expect(result.usage).toStrictEqual({
    inputTokens: 9,
    outputTokens: 12,
    totalTokens: 21,
  });
});

test("MistralModel.generate handles tool calls", async () => {
  let requestBody: Record<string, unknown> | null = null;

  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/v1/chat/completions")) {
          requestBody = await requestBodyFrom(input, init);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "chatcmpl-123",
                object: "chat.completion",
                created: 1677652288,
                model: "mistral-large-latest",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call_abc",
                          type: "function",
                          function: {
                            name: "get_weather",
                            arguments: '{"location":"San Francisco"}',
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
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

  expect(requestBody!.model).toStrictEqual("mistral-large-latest");
  expect(result.modelId).toStrictEqual("mistral-large-latest");
  expect(result.messages.length).toStrictEqual(1);
  const msg = result.messages[0] as ModelMessage;
  expect(msg.role).toStrictEqual("model");
  expect(msg.contents).toStrictEqual([
    {
      toolCall: {
        id: "call_abc",
        name: "get_weather",
        props: props({ location: "San Francisco" }),
      },
    },
  ]);
  expect(msg.toolCalls).toStrictEqual([
    {
      id: "call_abc",
      name: "get_weather",
      props: props({ location: "San Francisco" }),
    },
  ]);
});

test("MistralModel.generate prepends system prompt if provided", async () => {
  let requestBody: Record<string, unknown> | null = null;

  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/v1/chat/completions")) {
          requestBody = await requestBodyFrom(input, init);
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "chatcmpl-123",
                object: "chat.completion",
                created: 1677652288,
                model: "mistral-large-latest",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: "Response",
                    },
                    finish_reason: "stop",
                  },
                ],
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

  expect(requestBody!.messages).toStrictEqual([
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "Hi" },
  ]);
});

test("MistralModel.generate handles invalid JSON in tool call arguments", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/v1/chat/completions")) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                id: "chatcmpl-123",
                object: "chat.completion",
                created: 1677652288,
                model: "mistral-large-latest",
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: null,
                      tool_calls: [
                        {
                          id: "call_bad",
                          type: "function",
                          function: {
                            name: "broken_tool",
                            arguments: "this is not json",
                          },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
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

  expect(result.messages.length).toStrictEqual(1);
  const msg = result.messages[0] as ModelMessage;
  expect(msg.toolCalls.length).toStrictEqual(1);
  expect(msg.toolCalls[0].id).toStrictEqual("call_bad");
  expect(msg.toolCalls[0].name).toStrictEqual("broken_tool");
  expect(msg.toolCalls[0].props).toStrictEqual({});
});

test("MistralModel.stream streams content and maps correctly", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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

  expect(results.length).toStrictEqual(2);
  expect(results[0].modelId).toStrictEqual("mistral-large-latest");
  expect(results[0].messages[0].contents).toStrictEqual([{ text: "Hello" }]);
  expect(results[1].messages[0].contents).toStrictEqual([{ text: " world" }]);
});

test("MistralModel.stream yields a final usage chunk", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
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

  expect(results.length).toStrictEqual(2);
  expect(results[0].messages[0].contents).toStrictEqual([{ text: "Hi" }]);
  expect(results[1]).toStrictEqual({
    modelId: "mistral-large-latest",
    messages: [],
    usage: {
      inputTokens: 9,
      outputTokens: 12,
      totalTokens: 21,
    },
  });
});

test("MistralModel.stream streams tool calls correctly", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/v1/chat/completions")) {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              const chunk1 = {
                id: "1",
                model: "mistral-large-latest",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: "call_123",
                          type: "function",
                          function: {
                            name: "get_weather",
                            arguments: "",
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              const chunk2 = {
                id: "1",
                model: "mistral-large-latest",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: {
                            name: "get_weather",
                            arguments: '{"loc',
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              const chunk3 = {
                id: "1",
                model: "mistral-large-latest",
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          function: {
                            name: "get_weather",
                            arguments: 'ation":"SF"}',
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };

              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk1)}\n\n`));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk2)}\n\n`));
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk3)}\n\n`));
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

  expect(results.length).toStrictEqual(1);
  const msg = results[0].messages[0] as ModelMessage;
  expect(msg.toolCalls.length).toStrictEqual(1);
  expect(msg.toolCalls[0].id).toStrictEqual("call_123");
  expect(msg.toolCalls[0].name).toStrictEqual("get_weather");
  expect(msg.toolCalls[0].props).toStrictEqual(props({ location: "SF" }));
  expect(msg.contents).toStrictEqual([{ toolCall: msg.toolCalls[0] }]);
});

test("MistralModel.stream flushes tool calls on finish_reason", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/v1/chat/completions")) {
          const encoder = new TextEncoder();
          const chunks = [
            {
              id: "1",
              model: "mistral-large-latest",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: { name: "get_weather", arguments: '{"a":1}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "1",
              model: "mistral-large-latest",
              choices: [
                {
                  index: 0,
                  delta: { content: "Done" },
                  finish_reason: "tool_calls",
                },
              ],
            },
          ];
          const stream = new ReadableStream({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
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

  expect(results.length).toStrictEqual(2);
  expect(results[0].messages[0].contents).toStrictEqual([{ text: "Done" }]);
  const toolMsg = results[1].messages[0] as ModelMessage;
  expect(toolMsg.toolCalls).toStrictEqual([
    { id: "call_1", name: "get_weather", props: props({ a: 1 }) },
  ]);
});

test("MistralModel.stream emits earlier tool call when a new index starts", async () => {
  const model = new MistralModel({
    apiKey: "test-key",
    httpClient: new HTTPClient({
      fetcher: (input: RequestInfo | URL, _init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes("/v1/chat/completions")) {
          const encoder = new TextEncoder();
          const chunks = [
            {
              id: "1",
              model: "mistral-large-latest",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: { name: "tool_a", arguments: "{}" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "1",
              model: "mistral-large-latest",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 1,
                        id: "call_2",
                        type: "function",
                        function: { name: "tool_b", arguments: '{"b":2}' },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
          ];
          const stream = new ReadableStream({
            start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
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

  expect(results.length).toStrictEqual(2);
  const first = results[0].messages[0] as ModelMessage;
  expect(first.toolCalls[0].id).toStrictEqual("call_1");
  expect(first.toolCalls[0].name).toStrictEqual("tool_a");
  const second = results[1].messages[0] as ModelMessage;
  expect(second.toolCalls[0].id).toStrictEqual("call_2");
  expect(second.toolCalls[0].name).toStrictEqual("tool_b");
  expect(second.toolCalls[0].props).toStrictEqual(props({ b: 2 }));
});

test("mistral factory returns MistralModel instance", () => {
  const model = mistral({ apiKey: "test" });
  expect(model).toBeInstanceOf(MistralModel);
});

test("MistralModel has expected methods", () => {
  const model = new MistralModel({ apiKey: "test" });
  expect(typeof model.generate).toStrictEqual("function");
  expect(typeof model.stream).toStrictEqual("function");
});
