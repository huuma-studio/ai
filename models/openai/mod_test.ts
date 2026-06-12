import { assertEquals, assertInstanceOf } from "@std/assert";
import type { Message, ModelMessage, ToolMessage } from "@/mod.ts";
import { tool } from "@/tools/mod.ts";
import { string } from "@huuma/validate";
import {
  openai,
  openAIMessagesFrom,
  OpenAIModel,
  openAIToolsFrom,
} from "./mod.ts";

Deno.test("openAIToolsFrom converts tools correctly", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: string(),
    fn: () => "result",
  });

  const openAITools = openAIToolsFrom([testTool]);
  assertEquals(openAITools.length, 1);
  assertEquals(openAITools[0].type, "function");
  // deno-lint-ignore no-explicit-any
  assertEquals((openAITools[0] as any).function.name, "test_tool");
  // deno-lint-ignore no-explicit-any
  assertEquals((openAITools[0] as any).function.description, "A test tool");
  // deno-lint-ignore no-explicit-any
  assertEquals((openAITools[0] as any).function.parameters, { type: "string" });
});

Deno.test("openAIMessagesFrom converts user message", () => {
  const msg: Message = { role: "user", contents: "Hello" };
  const result = openAIMessagesFrom([msg]);
  assertEquals(result, [{ role: "user", content: "Hello" }]);
});

Deno.test("openAIMessagesFrom converts user message with array contents", () => {
  const msg: Message = {
    role: "user",
    contents: [{ text: "Hello" }, { text: " world!" }],
  };
  const result = openAIMessagesFrom([msg]);
  assertEquals(result, [{ role: "user", content: "Hello world!" }]);
});

Deno.test("openAIMessagesFrom converts system message with array contents", () => {
  const msg: Message = {
    role: "system",
    contents: [{ text: "You are " }, { text: "an AI." }],
  };
  const result = openAIMessagesFrom([msg]);
  assertEquals(result, [{ role: "system", content: "You are an AI." }]);
});

Deno.test("openAIMessagesFrom converts system message", () => {
  const msg: Message = {
    role: "system",
    contents: "You are a helpful assistant.",
  };
  const result = openAIMessagesFrom([msg]);
  assertEquals(result, [{
    role: "system",
    content: "You are a helpful assistant.",
  }]);
});

Deno.test("openAIMessagesFrom converts model message with tool calls", () => {
  const msgWithContent: Message = {
    role: "model",
    contents: [
      { text: "Thinking..." },
      // deno-lint-ignore no-explicit-any
      { toolCall: { id: "1", name: "tool1", props: { arg: "val" } as any } },
    ],
    // deno-lint-ignore no-explicit-any
    toolCalls: [{ id: "1", name: "tool1", props: { arg: "val" } as any }],
  };

  const result = openAIMessagesFrom([msgWithContent]);
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "assistant");
  // deno-lint-ignore no-explicit-any
  assertEquals((result[0] as any).content, "Thinking...");
  // deno-lint-ignore no-explicit-any
  assertEquals((result[0] as any).tool_calls, [{
    id: "1",
    type: "function",
    function: { name: "tool1", arguments: '{"arg":"val"}' },
  }]);
});

Deno.test("openAIMessagesFrom converts tool message", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      { toolResult: { id: "1", name: "tool1", result: { output: "success" } } },
    ],
  };

  const result = openAIMessagesFrom([msg]);
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "tool");
  // deno-lint-ignore no-explicit-any
  assertEquals((result[0] as any).content, "success");
  // deno-lint-ignore no-explicit-any
  assertEquals((result[0] as any).tool_call_id, "1");
});

Deno.test("openAIMessagesFrom converts tool message with non-string output object", () => {
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
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "tool");
  // deno-lint-ignore no-explicit-any
  assertEquals((result[0] as any).content, '{"ok":true,"data":[1,2]}');
  // deno-lint-ignore no-explicit-any
  assertEquals((result[0] as any).tool_call_id, "2");
});

Deno.test("openAIMessagesFrom prefers error over output when both set", () => {
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
  // deno-lint-ignore no-explicit-any
  assertEquals((result[0] as any).content, '{"message":"boom"}');
});

Deno.test("openAIMessagesFrom drops fully empty assistant messages", () => {
  const msg: Message = {
    role: "model",
    contents: [],
    toolCalls: [],
  };

  const result = openAIMessagesFrom([msg]);
  assertEquals(result.length, 0);
});

Deno.test("openAIMessagesFrom keeps assistant with only tool calls", () => {
  const msg: Message = {
    role: "model",
    contents: [
      // deno-lint-ignore no-explicit-any
      { toolCall: { id: "a", name: "t", props: {} as any } },
    ],
    // deno-lint-ignore no-explicit-any
    toolCalls: [{ id: "a", name: "t", props: {} as any }],
  };

  const result = openAIMessagesFrom([msg]);
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "assistant");
  // deno-lint-ignore no-explicit-any
  assertEquals((result[0] as any).content, undefined);
  // deno-lint-ignore no-explicit-any
  assertEquals((result[0] as any).tool_calls.length, 1);
});

Deno.test("openAIMessagesFrom converts tool message with error output", () => {
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
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "tool");
  assertEquals(
    // deno-lint-ignore no-explicit-any
    (result[0] as any).content,
    '{"message":"Something went wrong"}',
  );
  // deno-lint-ignore no-explicit-any
  assertEquals((result[0] as any).tool_call_id, "3");
});

Deno.test("OpenAIModel.generate calls OpenAI API and returns mapped result", async () => {
  let fetchCalled = false;
  // deno-lint-ignore no-explicit-any
  let requestBody: any = null;

  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, init) => {
      fetchCalled = true;
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/v1/chat/completions")) {
        requestBody = JSON.parse(
          (init as { body?: string })?.body ?? "{}",
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
              object: "chat.completion",
              created: 1677652288,
              model: "gpt-4o",
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
  });

  const result = await model.generate({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "Hi" }],
  });

  assertEquals(fetchCalled, true);
  assertEquals(requestBody.model, "gpt-4o");
  assertEquals(requestBody.messages, [{ role: "user", content: "Hi" }]);
  assertEquals(result.modelId, "gpt-4o");
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

Deno.test("OpenAIModel.generate handles tool calls", async () => {
  // deno-lint-ignore no-explicit-any
  let requestBody: any = null;

  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/v1/chat/completions")) {
        requestBody = JSON.parse(
          (init as { body?: string })?.body ?? "{}",
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
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
  });

  const result = await model.generate({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "What is the weather?" }],
  });

  assertEquals(requestBody.model, "gpt-4o");
  assertEquals(result.modelId, "gpt-4o");
  assertEquals(result.messages.length, 1);
  const msg = result.messages[0] as ModelMessage;
  assertEquals(msg.role, "model");
  // deno-lint-ignore no-explicit-any
  const expectedProps = { location: "San Francisco" } as any;
  assertEquals(msg.contents, [{
    toolCall: {
      id: "call_abc",
      name: "get_weather",
      props: expectedProps,
    },
  }]);
  assertEquals(msg.toolCalls, [{
    id: "call_abc",
    name: "get_weather",
    props: expectedProps,
  }]);
});
Deno.test("OpenAIModel.generate prepends system prompt if provided", async () => {
  // deno-lint-ignore no-explicit-any
  let requestBody: any = null;

  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/v1/chat/completions")) {
        requestBody = JSON.parse(
          (init as { body?: string })?.body ?? "{}",
        );
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: "chatcmpl-123",
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "Response",
                },
              }],
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

  assertEquals(requestBody.messages, [
    { role: "system", content: "You are a helpful assistant" },
    { role: "user", content: "Hi" },
  ]);
});

Deno.test("openAIMessagesFrom drops thinking from model messages", () => {
  const msg: Message = {
    role: "model",
    contents: [{ text: "Hello" }],
    toolCalls: [],
    thinking: "internal reasoning",
  };

  const result = openAIMessagesFrom([msg]);
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "assistant");
  assertEquals((result[0] as { content?: string }).content, "Hello");
  // @ts-expect-error reasoning_content should not be present
  assertEquals(result[0].reasoning_content, undefined);
});

Deno.test("openAIMessagesFrom drops fully empty assistant even with thinking", () => {
  const msg: Message = {
    role: "model",
    contents: [],
    toolCalls: [],
    thinking: "internal reasoning",
  };

  const result = openAIMessagesFrom([msg]);
  assertEquals(result.length, 0);
});

Deno.test("openAIMessagesFrom converts tool message with multiple tool results", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      { toolResult: { id: "1", name: "tool1", result: { output: "result1" } } },
      { toolResult: { id: "2", name: "tool2", result: { output: "result2" } } },
    ],
  };

  const result = openAIMessagesFrom([msg]);
  assertEquals(result.length, 2);
  assertEquals(result[0].role, "tool");
  assertEquals((result[0] as { tool_call_id?: string }).tool_call_id, "1");
  assertEquals((result[0] as { content?: string }).content, "result1");
  assertEquals(result[1].role, "tool");
  assertEquals((result[1] as { tool_call_id?: string }).tool_call_id, "2");
  assertEquals((result[1] as { content?: string }).content, "result2");
});

Deno.test("OpenAIModel.generate handles reasoning_content", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
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
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: "The answer is 42.",
                  reasoning_content: "Let me think...",
                },
                finish_reason: "stop",
              }],
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

  assertEquals(result.messages.length, 1);
  const msg = result.messages[0] as ModelMessage;
  assertEquals(msg.role, "model");
  assertEquals(msg.contents, [{ text: "The answer is 42." }]);
  assertEquals(msg.thinking, "Let me think...");
});

Deno.test("OpenAIModel.generate handles invalid JSON in tool call arguments", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
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

  assertEquals(result.messages.length, 1);
  const msg = result.messages[0] as ModelMessage;
  assertEquals(msg.toolCalls.length, 1);
  assertEquals(msg.toolCalls[0].id, "call_bad");
  assertEquals(msg.toolCalls[0].name, "broken_tool");
  assertEquals(msg.toolCalls[0].props, {});
});

Deno.test("OpenAIModel.stream streams content and maps correctly", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
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
                'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"index":0,"delta":{"content":" world"}}]}\n\n',
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  assertEquals(results.length, 2);
  assertEquals(results[0].modelId, "gpt-4o");
  assertEquals(results[0].messages[0].contents, [{ text: "Hello" }]);
  assertEquals(results[1].messages[0].contents, [{ text: " world" }]);
});

Deno.test("OpenAIModel.stream requests usage and yields a final usage chunk", async () => {
  // deno-lint-ignore no-explicit-any
  let requestBody: any = null;

  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  assertEquals(requestBody.stream_options, { include_usage: true });
  assertEquals(results.length, 2);
  assertEquals(results[0].messages[0].contents, [{ text: "Hi" }]);
  assertEquals(results[1], {
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

Deno.test("OpenAIModel.stream streams thinking/reasoning correctly", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
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
              choices: [{ index: 0, delta: { reasoning_content: "Thinking" } }],
            };
            const chunk2 = {
              choices: [{ index: 0, delta: { reasoning_content: " process" } }],
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunk1)}\n\n`),
            );
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunk2)}\n\n`),
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

  assertEquals(results.length, 2);
  const msg1 = results[0].messages[0] as ModelMessage;
  const msg2 = results[1].messages[0] as ModelMessage;
  assertEquals(msg1.thinking, "Thinking");
  assertEquals(msg2.thinking, " process");
});

Deno.test("OpenAIModel.stream streams tool calls correctly", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/v1/chat/completions")) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            // Chunk 1: Send tool ID and name
            const chunk1 = {
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: "call_123",
                    type: "function",
                    function: {
                      name: "get_weather",
                    },
                  }],
                },
              }],
            };
            // Chunk 2: Send partial arguments (invalid JSON)
            const chunk2 = {
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: {
                      arguments: '{"loc',
                    },
                  }],
                },
              }],
            };
            // Chunk 3: Send rest of arguments (valid JSON)
            const chunk3 = {
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: 0,
                    function: {
                      arguments: 'ation":"SF"}',
                    },
                  }],
                },
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
  assertEquals(results.length, 1);
  const msg = results[0].messages[0] as ModelMessage;
  assertEquals(msg.toolCalls.length, 1);
  assertEquals(msg.toolCalls[0].id, "call_123");
  assertEquals(msg.toolCalls[0].name, "get_weather");
  // deno-lint-ignore no-explicit-any
  assertEquals(msg.toolCalls[0].props, { location: "SF" } as any);
  assertEquals(msg.contents, [{ toolCall: msg.toolCalls[0] }]);
});

Deno.test("OpenAIModel.stream flushes tool calls on finish_reason", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/v1/chat/completions")) {
        const encoder = new TextEncoder();
        const chunks = [
          {
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
            }],
          },
          {
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
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
    // deno-lint-ignore no-explicit-any
    { id: "call_1", name: "get_weather", props: { a: 1 } as any },
  ]);
});

Deno.test("OpenAIModel.stream emits earlier tool call when a new index starts", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/v1/chat/completions")) {
        const encoder = new TextEncoder();
        const chunks = [
          {
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
            }],
          },
          {
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
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
  // deno-lint-ignore no-explicit-any
  assertEquals(second.toolCalls[0].props, { b: 2 } as any);
});

Deno.test("OpenAIModel.generate maps refusal to text content", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
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
              choices: [{
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  refusal: "I can't help with that.",
                },
                finish_reason: "stop",
              }],
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

  assertEquals(result.messages.length, 1);
  assertEquals(result.messages[0].contents, [{
    text: "I can't help with that.",
  }]);
});

Deno.test("OpenAIModel.stream maps refusal deltas to text content", async () => {
  const model = new OpenAIModel({
    apiKey: "test-key",
    fetch: (input: string | URL | Request, _init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/v1/chat/completions")) {
        const encoder = new TextEncoder();
        const chunks = [
          { choices: [{ index: 0, delta: { refusal: "I can't" } }] },
          { choices: [{ index: 0, delta: { refusal: " help with that." } }] },
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
  });

  const stream = await model.stream({
    modelId: "gpt-4o",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const results = [];
  for await (const chunk of stream) {
    results.push(chunk);
  }

  assertEquals(results.length, 2);
  assertEquals(results[0].messages[0].contents, [{ text: "I can't" }]);
  assertEquals(results[1].messages[0].contents, [{
    text: " help with that.",
  }]);
});

Deno.test("openai factory returns OpenAIModel instance", () => {
  const model = openai({ apiKey: "test" });
  assertInstanceOf(model, OpenAIModel);
});

Deno.test("openai factory accepts options", () => {
  const model = openai({ apiKey: "test-key", baseURL: "https://example.com" });
  assertInstanceOf(model, OpenAIModel);
});

Deno.test("OpenAIModel has expected methods", () => {
  const model = new OpenAIModel({ apiKey: "test" });
  assertEquals(typeof model.generate, "function");
  assertEquals(typeof model.stream, "function");
});
