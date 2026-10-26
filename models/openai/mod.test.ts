import { expect, test } from "vite-plus/test";
import type { Message, ModelMessage, ToolMessage } from "../../src/mod.ts";
import { tool } from "../../src/tools/mod.ts";
import { object, type Schema, string } from "@huuma/validate";
import { openai, openAIMessagesFrom, OpenAIModel, openAIToolsFrom } from "./mod.ts";

test("openAIToolsFrom converts tools correctly", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: string(),
    fn: () => "result",
  });

  const openAITools = openAIToolsFrom([testTool]);
  expect(openAITools.length).toStrictEqual(1);
  expect(openAITools[0].type).toStrictEqual("function");
  expect((openAITools[0] as any).function.name).toStrictEqual("test_tool");
  expect((openAITools[0] as any).function.description).toStrictEqual("A test tool");
  expect((openAITools[0] as any).function.parameters).toStrictEqual({ type: "string" });
});

test("openAIToolsFrom reuses the tool's cached JSON Schema", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: object({ query: string() }),
    fn: () => "result",
  });

  const [first] = openAIToolsFrom([testTool]);
  const [second] = openAIToolsFrom([testTool]);
  const firstFunction = (first as any).function as { parameters?: object };
  const secondFunction = (second as any).function as { parameters?: object };
  expect(firstFunction.parameters === secondFunction.parameters).toStrictEqual(true);
  expect(firstFunction.parameters === (testTool.jsonSchema as object)).toStrictEqual(true);
});

test("OpenAIModel converts a tool's schema once across repeated generate and stream calls", async () => {
  const wrapped = object({ query: string() });
  let conversions = 0;
  const counting: Schema<unknown> & { conversions: number } = {
    infer: undefined,
    validate: (value, key) => wrapped.validate(value, key),
    jsonSchema() {
      conversions += 1;
      return wrapped.jsonSchema();
    },
    isRequired: () => wrapped.isRequired(),
    get conversions() {
      return conversions;
    },
  };
  const counted = tool({
    name: "counted",
    description: "Counts schema conversions.",
    input: counting,
    fn: () => "result",
  });

  const bodies: Record<string, unknown>[] = [];
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (requestInput: string | URL | Request, init) => {
      const url =
        typeof requestInput === "string"
          ? requestInput
          : requestInput instanceof URL
            ? requestInput.toString()
            : requestInput.url;
      if (!url.includes("/v1/chat/completions")) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }

      const body = JSON.parse((init as { body?: string })?.body ?? "{}") as Record<string, unknown>;
      bodies.push(body);

      if (body.stream === true) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n'),
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

      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "chatcmpl-123",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Hello" },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    },
  });

  const messages: Message[] = [{ role: "user", contents: "Hi" }];
  await model.generate({ modelId: "gpt-4o", messages, tools: [counted] });
  await model.generate({ modelId: "gpt-4o", messages, tools: [counted] });
  const stream = await model.stream({
    modelId: "gpt-4o",
    messages,
    tools: [counted],
  });
  for await (const _ of stream) {
    // drain
  }

  expect(counting.conversions).toStrictEqual(1);
  expect(bodies.length).toStrictEqual(3);
  const expectedTools = [
    {
      type: "function",
      function: {
        name: "counted",
        description: "Counts schema conversions.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
  ];
  for (const body of bodies) {
    expect(body.tools).toStrictEqual(expectedTools);
  }
});

test("openAIMessagesFrom converts user message", () => {
  const msg: Message = { role: "user", contents: "Hello" };
  const result = openAIMessagesFrom([msg]);
  expect(result).toStrictEqual([{ role: "user", content: "Hello" }]);
});

test("openAIMessagesFrom converts user message with array contents", () => {
  const msg: Message = {
    role: "user",
    contents: [{ text: "Hello" }, { text: " world!" }],
  };
  const result = openAIMessagesFrom([msg]);
  expect(result).toStrictEqual([{ role: "user", content: "Hello world!" }]);
});

test("openAIMessagesFrom maps base64 images to data URLs", () => {
  const msg: Message = {
    role: "user",
    contents: [{ text: "What is this?" }, { file: { mimeType: "image/png", data: "aGVsbG8=" } }],
  };
  expect(openAIMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "What is this?" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,aGVsbG8=" },
        },
      ],
    },
  ]);
});

test("openAIMessagesFrom passes image URLs through", () => {
  const msg: Message = {
    role: "user",
    contents: [
      {
        file: { mimeType: "image/png", url: "https://example.com/a.png" },
      },
    ],
  };
  expect(openAIMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: { url: "https://example.com/a.png" },
        },
      ],
    },
  ]);
});

test("openAIMessagesFrom maps audio data to input_audio formats", () => {
  const wav: Message = {
    role: "user",
    contents: [{ file: { mimeType: "audio/wav", data: "aGVsbG8=" } }],
  };
  expect(openAIMessagesFrom([wav])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "input_audio",
          input_audio: { data: "aGVsbG8=", format: "wav" },
        },
      ],
    },
  ]);

  const mp3: Message = {
    role: "user",
    contents: [{ file: { mimeType: "audio/mpeg", data: "aGVsbG8=" } }],
  };
  expect(openAIMessagesFrom([mp3])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "input_audio",
          input_audio: { data: "aGVsbG8=", format: "mp3" },
        },
      ],
    },
  ]);
});

test("openAIMessagesFrom throws on audio by URL", () => {
  const msg: Message = {
    role: "user",
    contents: [
      {
        file: { mimeType: "audio/wav", url: "https://example.com/a.wav" },
      },
    ],
  };
  expect(() => openAIMessagesFrom([msg])).toThrow(RangeError);
  expect(() => openAIMessagesFrom([msg])).toThrow("audio by URL");
});

test("openAIMessagesFrom maps base64 PDFs to file parts with default filename", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "application/pdf", data: "aGVsbG8=" } }],
  };
  expect(openAIMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "file",
          file: {
            filename: "file.pdf",
            file_data: "data:application/pdf;base64,aGVsbG8=",
          },
        },
      ],
    },
  ]);
});

test("openAIMessagesFrom keeps explicit PDF filenames", () => {
  const msg: Message = {
    role: "user",
    contents: [
      {
        file: {
          mimeType: "application/pdf",
          data: "aGVsbG8=",
          name: "report.pdf",
        },
      },
    ],
  };
  expect(openAIMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "file",
          file: {
            filename: "report.pdf",
            file_data: "data:application/pdf;base64,aGVsbG8=",
          },
        },
      ],
    },
  ]);
});

test("openAIMessagesFrom throws on PDFs by URL", () => {
  const msg: Message = {
    role: "user",
    contents: [
      {
        file: { mimeType: "application/pdf", url: "https://example.com/a.pdf" },
      },
    ],
  };
  expect(() => openAIMessagesFrom([msg])).toThrow(RangeError);
  expect(() => openAIMessagesFrom([msg])).toThrow("PDFs by URL");
});

test("openAIMessagesFrom throws on unsupported file types", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "video/mp4", data: "aGVsbG8=" } }],
  };
  expect(() => openAIMessagesFrom([msg])).toThrow(RangeError);
  expect(() => openAIMessagesFrom([msg])).toThrow('file content of type "video/mp4"');
});

test("openAIMessagesFrom converts system message with array contents", () => {
  const msg: Message = {
    role: "system",
    contents: [{ text: "You are " }, { text: "an AI." }],
  };
  const result = openAIMessagesFrom([msg]);
  expect(result).toStrictEqual([{ role: "system", content: "You are an AI." }]);
});

test("openAIMessagesFrom converts system message", () => {
  const msg: Message = {
    role: "system",
    contents: "You are a helpful assistant.",
  };
  const result = openAIMessagesFrom([msg]);
  expect(result).toStrictEqual([
    {
      role: "system",
      content: "You are a helpful assistant.",
    },
  ]);
});

test("openAIMessagesFrom converts model message with tool calls", () => {
  const msgWithContent: Message = {
    role: "model",
    contents: [
      { text: "Thinking..." },
      { toolCall: { id: "1", name: "tool1", props: { arg: "val" } as any } },
    ],
    toolCalls: [{ id: "1", name: "tool1", props: { arg: "val" } as any }],
  };

  const result = openAIMessagesFrom([msgWithContent]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("assistant");
  expect((result[0] as any).content).toStrictEqual("Thinking...");
  expect((result[0] as any).tool_calls).toStrictEqual([
    {
      id: "1",
      type: "function",
      function: { name: "tool1", arguments: '{"arg":"val"}' },
    },
  ]);
});

test("openAIMessagesFrom converts tool message", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [{ toolResult: { id: "1", name: "tool1", result: { output: "success" } } }],
  };

  const result = openAIMessagesFrom([msg]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("tool");
  expect((result[0] as any).content).toStrictEqual("success");
  expect((result[0] as any).tool_call_id).toStrictEqual("1");
});

test("openAIMessagesFrom appends a synthetic user message for tool result files", () => {
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

  expect(openAIMessagesFrom([msg])).toStrictEqual([
    { role: "tool", tool_call_id: "1", content: "captured" },
    {
      role: "user",
      content: [
        { type: "text", text: 'Files returned by tool "screenshot" (call 1):' },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,aGVsbG8=" },
        },
      ],
    },
  ]);
});

test("openAIMessagesFrom aggregates files of multiple tool results into one synthetic user message", () => {
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
          name: "lookup",
          result: { output: "found" },
        },
      },
      {
        toolResult: {
          id: "3",
          name: "camera",
          result: { output: "photographed" },
          files: [{ file: { mimeType: "image/jpeg", data: "d29ybGQ=" } }],
        },
      },
    ],
  };

  expect(openAIMessagesFrom([msg])).toStrictEqual([
    { role: "tool", tool_call_id: "1", content: "captured" },
    { role: "tool", tool_call_id: "2", content: "found" },
    { role: "tool", tool_call_id: "3", content: "photographed" },
    {
      role: "user",
      content: [
        { type: "text", text: 'Files returned by tool "screenshot" (call 1):' },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,aGVsbG8=" },
        },
        { type: "text", text: 'Files returned by tool "camera" (call 3):' },
        {
          type: "image_url",
          image_url: { url: "data:image/jpeg;base64,d29ybGQ=" },
        },
      ],
    },
  ]);
});

test("openAIMessagesFrom throws on tool result PDFs by URL", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "1",
          name: "report",
          result: { output: "generated" },
          files: [
            {
              file: { mimeType: "application/pdf", url: "https://example.com/a.pdf" },
            },
          ],
        },
      },
    ],
  };

  expect(() => openAIMessagesFrom([msg])).toThrow(RangeError);
});

test("openAIMessagesFrom converts tool message with non-string output object", () => {
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

  const result = openAIMessagesFrom([msg]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("tool");
  expect((result[0] as any).content).toStrictEqual('{"ok":true,"data":[1,2]}');
  expect((result[0] as any).tool_call_id).toStrictEqual("2");
});

test("openAIMessagesFrom prefers error over output when both set", () => {
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

  const result = openAIMessagesFrom([msg]);
  expect((result[0] as any).content).toStrictEqual('{"message":"boom"}');
});

test("openAIMessagesFrom drops fully empty assistant messages", () => {
  const msg: Message = {
    role: "model",
    contents: [],
    toolCalls: [],
  };

  const result = openAIMessagesFrom([msg]);
  expect(result.length).toStrictEqual(0);
});

test("openAIMessagesFrom keeps assistant with only tool calls", () => {
  const msg: Message = {
    role: "model",
    contents: [{ toolCall: { id: "a", name: "t", props: {} as any } }],
    toolCalls: [{ id: "a", name: "t", props: {} as any }],
  };

  const result = openAIMessagesFrom([msg]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("assistant");
  expect((result[0] as any).content).toStrictEqual(undefined);
  expect((result[0] as any).tool_calls.length).toStrictEqual(1);
});

test("openAIMessagesFrom converts tool message with error output", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "3",
          name: "tool3",
          result: { error: { message: "Something went wrong" } },
        },
      },
    ],
  };

  const result = openAIMessagesFrom([msg]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("tool");
  expect((result[0] as any).content).toStrictEqual('{"message":"Something went wrong"}');
  expect((result[0] as any).tool_call_id).toStrictEqual("3");
});

test("OpenAIModel.generate calls OpenAI API and returns mapped result", async () => {
  let fetchCalled = false;
  let requestBody: any = null;

  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, init) => {
      fetchCalled = true;
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        requestBody = JSON.parse((init as { body?: string })?.body ?? "{}");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
              object: "chat.completion",
              created: 1677652288,
              model: "gpt-4o",
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
  });

  const result = await model.generate({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "Hi" }],
  });

  expect(fetchCalled).toStrictEqual(true);
  expect(requestBody.model).toStrictEqual("gpt-4o");
  expect(requestBody.messages).toStrictEqual([{ role: "user", content: "Hi" }]);
  expect(result.modelId).toStrictEqual("gpt-4o");
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

test("OpenAIModel.generate handles tool calls", async () => {
  let requestBody: any = null;

  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        requestBody = JSON.parse((init as { body?: string })?.body ?? "{}");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
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
  });

  const result = await model.generate({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "What is the weather?" }],
  });

  expect(requestBody.model).toStrictEqual("gpt-4o");
  expect(result.modelId).toStrictEqual("gpt-4o");
  expect(result.messages.length).toStrictEqual(1);
  const msg = result.messages[0] as ModelMessage;
  expect(msg.role).toStrictEqual("model");
  const expectedProps = { location: "San Francisco" } as any;
  expect(msg.contents).toStrictEqual([
    {
      toolCall: {
        id: "call_abc",
        name: "get_weather",
        props: expectedProps,
      },
    },
  ]);
  expect(msg.toolCalls).toStrictEqual([
    {
      id: "call_abc",
      name: "get_weather",
      props: expectedProps,
    },
  ]);
});
test("OpenAIModel.generate prepends system prompt if provided", async () => {
  let requestBody: any = null;

  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        requestBody = JSON.parse((init as { body?: string })?.body ?? "{}");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "Response",
                  },
                },
              ],
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
  });

  await model.generate({
    modelId: "gpt-4o",
    system: "You are a helpful assistant",
    messages: [{ role: "user", contents: "Hi" }],
  });

  expect(requestBody.messages).toStrictEqual([
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "Hi" },
  ]);
});

test("openAIMessagesFrom drops thinking from model messages", () => {
  const msg: Message = {
    role: "model",
    contents: [{ text: "Hello" }],
    toolCalls: [],
    thinking: "internal reasoning",
  };

  const result = openAIMessagesFrom([msg]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("assistant");
  expect((result[0] as { content?: string }).content).toStrictEqual("Hello");
  // @ts-expect-error reasoning_content should not be present
  expect(result[0].reasoning_content).toStrictEqual(undefined);
});

test("openAIMessagesFrom drops fully empty assistant even with thinking", () => {
  const msg: Message = {
    role: "model",
    contents: [],
    toolCalls: [],
    thinking: "internal reasoning",
  };

  const result = openAIMessagesFrom([msg]);
  expect(result.length).toStrictEqual(0);
});

test("openAIMessagesFrom converts tool message with multiple tool results", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      { toolResult: { id: "1", name: "tool1", result: { output: "result1" } } },
      { toolResult: { id: "2", name: "tool2", result: { output: "result2" } } },
    ],
  };

  const result = openAIMessagesFrom([msg]);
  expect(result.length).toStrictEqual(2);
  expect(result[0].role).toStrictEqual("tool");
  expect((result[0] as { tool_call_id?: string }).tool_call_id).toStrictEqual("1");
  expect((result[0] as { content?: string }).content).toStrictEqual("result1");
  expect(result[1].role).toStrictEqual("tool");
  expect((result[1] as { tool_call_id?: string }).tool_call_id).toStrictEqual("2");
  expect((result[1] as { content?: string }).content).toStrictEqual("result2");
});

test("OpenAIModel.generate handles reasoning_content", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: "The answer is 42.",
                    reasoning_content: "Let me think...",
                  },
                  finish_reason: "stop",
                },
              ],
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
  });

  const result = await model.generate({
    modelId: "o3",
    messages: [{ role: "user", contents: "What is the meaning of life?" }],
  });

  expect(result.messages.length).toStrictEqual(1);
  const msg = result.messages[0] as ModelMessage;
  expect(msg.role).toStrictEqual("model");
  expect(msg.contents).toStrictEqual([{ text: "The answer is 42." }]);
  expect(msg.thinking).toStrictEqual("Let me think...");
});

test("OpenAIModel.generate handles invalid JSON in tool call arguments", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
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
  });

  const result = await model.generate({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "Call the tool" }],
  });

  expect(result.messages.length).toStrictEqual(1);
  const msg = result.messages[0] as ModelMessage;
  expect(msg.toolCalls.length).toStrictEqual(1);
  expect(msg.toolCalls[0].id).toStrictEqual("call_bad");
  expect(msg.toolCalls[0].name).toStrictEqual("broken_tool");
  expect(msg.toolCalls[0].props).toStrictEqual({});
});

test("OpenAIModel.stream streams content and maps correctly", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n'),
            );
            controller.enqueue(
              encoder.encode('data: {"choices":[{"index":0,"delta":{"content":" world"}}]}\n\n'),
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  expect(results.length).toStrictEqual(2);
  expect(results[0].modelId).toStrictEqual("gpt-4o");
  expect(results[0].messages[0].contents).toStrictEqual([{ text: "Hello" }]);
  expect(results[1].messages[0].contents).toStrictEqual([{ text: " world" }]);
});

test("OpenAIModel.stream requests usage and yields a final usage chunk", async () => {
  let requestBody: any = null;

  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        requestBody = JSON.parse((init as { body?: string })?.body ?? "{}");
        const encoder = new TextEncoder();
        const chunks = [
          { choices: [{ index: 0, delta: { content: "Hi" } }] },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
          // Final usage-only chunk sent by OpenAI when
          // stream_options.include_usage is set.
          {
            choices: [],
            usage: {
              prompt_tokens: 9,
              completion_tokens: 12,
              total_tokens: 21,
              prompt_tokens_details: { cached_tokens: 4 },
              completion_tokens_details: { reasoning_tokens: 3 },
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  expect(requestBody.stream_options).toStrictEqual({ include_usage: true });
  expect(results.length).toStrictEqual(2);
  expect(results[0].messages[0].contents).toStrictEqual([{ text: "Hi" }]);
  expect(results[1]).toStrictEqual({
    modelId: "gpt-4o",
    messages: [],
    usage: {
      inputTokens: 9,
      outputTokens: 12,
      totalTokens: 21,
      cacheReadInputTokens: 4,
      thinkingTokens: 3,
    },
  });
});

test("OpenAIModel.stream streams thinking/reasoning correctly", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const chunk1 = {
              choices: [{ index: 0, delta: { reasoning_content: "Thinking" } }],
            };
            const chunk2 = {
              choices: [{ index: 0, delta: { reasoning_content: " process" } }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk1)}\n\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk2)}\n\n`));
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  expect(results.length).toStrictEqual(2);
  const msg1 = results[0].messages[0] as ModelMessage;
  const msg2 = results[1].messages[0] as ModelMessage;
  expect(msg1.thinking).toStrictEqual("Thinking");
  expect(msg2.thinking).toStrictEqual(" process");
});

test("OpenAIModel.stream streams tool calls correctly", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            // Chunk 1: Send tool ID and name
            const chunk1 = {
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
                        },
                      },
                    ],
                  },
                },
              ],
            };
            // Chunk 2: Send partial arguments (invalid JSON)
            const chunk2 = {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: {
                          arguments: '{"loc',
                        },
                      },
                    ],
                  },
                },
              ],
            };
            // Chunk 3: Send rest of arguments (valid JSON)
            const chunk3 = {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: {
                          arguments: 'ation":"SF"}',
                        },
                      },
                    ],
                  },
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "What is the weather?" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  // The tool call is emitted once, after its arguments are complete,
  // instead of partially on every delta.
  expect(results.length).toStrictEqual(1);
  const msg = results[0].messages[0] as ModelMessage;
  expect(msg.toolCalls.length).toStrictEqual(1);
  expect(msg.toolCalls[0].id).toStrictEqual("call_123");
  expect(msg.toolCalls[0].name).toStrictEqual("get_weather");
  expect(msg.toolCalls[0].props).toStrictEqual({ location: "SF" } as any);
  expect(msg.contents).toStrictEqual([{ toolCall: msg.toolCalls[0] }]);
});

test("OpenAIModel.stream flushes tool calls on finish_reason", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        const encoder = new TextEncoder();
        const chunks = [
          {
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
              },
            ],
          },
          {
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
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
    { id: "call_1", name: "get_weather", props: { a: 1 } as any },
  ]);
});

test("OpenAIModel.stream emits earlier tool call when a new index starts", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        const encoder = new TextEncoder();
        const chunks = [
          {
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
              },
            ],
          },
          {
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
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
  expect(second.toolCalls[0].props).toStrictEqual({ b: 2 } as any);
});

test("OpenAIModel.generate maps refusal to text content", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: null,
                    refusal: "I can't help with that.",
                  },
                  finish_reason: "stop",
                },
              ],
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
  });

  const result = await model.generate({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "Hi" }],
  });

  expect(result.messages.length).toStrictEqual(1);
  expect(result.messages[0].contents).toStrictEqual([
    {
      text: "I can't help with that.",
    },
  ]);
});

test("OpenAIModel.stream maps refusal deltas to text content", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/v1/chat/completions")) {
        const encoder = new TextEncoder();
        const chunks = [
          { choices: [{ index: 0, delta: { refusal: "I can't" } }] },
          { choices: [{ index: 0, delta: { refusal: " help with that." } }] },
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  expect(results.length).toStrictEqual(2);
  expect(results[0].messages[0].contents).toStrictEqual([{ text: "I can't" }]);
  expect(results[1].messages[0].contents).toStrictEqual([
    {
      text: " help with that.",
    },
  ]);
});

test("openai factory returns OpenAIModel instance", () => {
  const model = openai({ apiKey: "test" });
  expect(model).toBeInstanceOf(OpenAIModel);
});

test("openai factory accepts options", () => {
  const model = openai({ apiKey: "test-key", baseURL: "https://example.com" });
  expect(model).toBeInstanceOf(OpenAIModel);
});

test("OpenAIModel has expected methods", () => {
  const model = new OpenAIModel({ apiKey: "test" });
  expect(typeof model.generate).toStrictEqual("function");
  expect(typeof model.stream).toStrictEqual("function");
});
