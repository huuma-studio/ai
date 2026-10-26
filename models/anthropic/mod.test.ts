import { expect, test } from "vite-plus/test";
import type { Message } from "../../src/mod.ts";
import { tool } from "../../src/tools/mod.ts";
import { object, string } from "@huuma/validate";
import {
  anthropic,
  anthropicMessagesFrom,
  AnthropicModel,
  anthropicToolsFrom,
  mergeAnthropicModelMessages,
} from "./mod.ts";

test("anthropicToolsFrom converts tools correctly", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: object({ query: string() }),
    fn: () => "result",
  });

  const tools = anthropicToolsFrom([testTool]);
  expect(tools.length).toStrictEqual(1);
  expect(tools[0].name).toStrictEqual("test_tool");
  expect(tools[0].description).toStrictEqual("A test tool");
  expect(tools[0].input_schema.type).toStrictEqual("object");
});

test("anthropicToolsFrom reuses the tool's cached JSON Schema", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: object({ query: string() }),
    fn: () => "result",
  });

  const [first] = anthropicToolsFrom([testTool]);
  const [second] = anthropicToolsFrom([testTool]);
  expect(first.input_schema === second.input_schema).toBe(true);
  expect(first.input_schema === (testTool.jsonSchema as object)).toBe(true);
});

test("anthropicMessagesFrom converts user message", () => {
  const msg: Message = { role: "user", contents: "Hello" };
  expect(anthropicMessagesFrom([msg])).toStrictEqual([{ role: "user", content: "Hello" }]);
});

test("anthropicMessagesFrom sends system messages as user content", () => {
  const msg: Message = {
    role: "system",
    contents: [{ text: "You are " }, { text: "an AI." }],
  };
  expect(anthropicMessagesFrom([msg])).toStrictEqual([{ role: "user", content: "You are an AI." }]);
});

test("anthropicMessagesFrom maps base64 images to image blocks", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
  };
  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
        },
      ],
    },
  ]);
});

test("anthropicMessagesFrom maps image URLs to url sources", () => {
  const msg: Message = {
    role: "user",
    contents: [
      {
        file: { mimeType: "image/png", url: "https://example.com/a.png" },
      },
    ],
  };
  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "url", url: "https://example.com/a.png" },
        },
      ],
    },
  ]);
});

test("anthropicMessagesFrom maps base64 PDFs to document blocks", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "application/pdf", data: "aGVsbG8=" } }],
  };
  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "aGVsbG8=",
          },
        },
      ],
    },
  ]);
});

test("anthropicMessagesFrom maps PDF URLs to document url sources", () => {
  const msg: Message = {
    role: "user",
    contents: [
      {
        file: { mimeType: "application/pdf", url: "https://example.com/a.pdf" },
      },
    ],
  };
  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "url", url: "https://example.com/a.pdf" },
        },
      ],
    },
  ]);
});

test("anthropicMessagesFrom throws on unsupported base64 image types", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "image/tiff", data: "aGVsbG8=" } }],
  };
  expect(() => anthropicMessagesFrom([msg])).toThrow(RangeError);
  expect(() => anthropicMessagesFrom([msg])).toThrow('images of type "image/tiff"');
});

test("anthropicMessagesFrom throws on unsupported image URL types", () => {
  const msg: Message = {
    role: "user",
    contents: [
      {
        file: { mimeType: "image/tiff", url: "https://example.com/a.tiff" },
      },
    ],
  };
  expect(() => anthropicMessagesFrom([msg])).toThrow(RangeError);
  expect(() => anthropicMessagesFrom([msg])).toThrow('images of type "image/tiff"');
});

test("anthropicMessagesFrom throws on unsupported file types", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "audio/mpeg", data: "aGVsbG8=" } }],
  };
  expect(() => anthropicMessagesFrom([msg])).toThrow(RangeError);
  expect(() => anthropicMessagesFrom([msg])).toThrow('file content of type "audio/mpeg"');
});

test("anthropicMessagesFrom keeps string content for text-only user parts", () => {
  const msg: Message = {
    role: "user",
    contents: [{ text: "Hello " }, { text: "there" }],
  };
  expect(anthropicMessagesFrom([msg])).toStrictEqual([{ role: "user", content: "Hello there" }]);
});

test("anthropicMessagesFrom preserves part order for mixed text and image", () => {
  const msg: Message = {
    role: "user",
    contents: [
      { text: "What is in this image?" },
      { file: { mimeType: "image/jpeg", data: "aGVsbG8=" } },
      { text: "Answer briefly." },
    ],
  };
  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" },
        },
        { type: "text", text: "Answer briefly." },
      ],
    },
  ]);
});

test("anthropicMessagesFrom converts model message with tool calls", () => {
  const msg: Message = {
    role: "model",
    contents: [
      { text: "Checking..." },
      { toolCall: { id: "call-1", name: "lookup", props: { q: "x" } as any } },
    ],
    toolCalls: [{ id: "call-1", name: "lookup", props: { q: "x" } as any }],
  };

  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking..." },
        { type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } },
      ],
    },
  ]);
});

test("anthropicMessagesFrom drops fully empty assistant messages", () => {
  const msg: Message = { role: "model", contents: [], toolCalls: [] };
  expect(anthropicMessagesFrom([msg])).toStrictEqual([]);
});

test("anthropicMessagesFrom replays thinking with its signature", () => {
  const msg: Message = {
    role: "model",
    contents: [{ text: "The answer." }],
    toolCalls: [],
    thinking: "Pondering...",
    thinkingMeta: { signature: "sig-1" },
  };

  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Pondering...", signature: "sig-1" },
        { type: "text", text: "The answer." },
      ],
    },
  ]);
});

test("anthropicMessagesFrom replays interleaved thinking blocks in order", () => {
  const msg: Message = {
    role: "model",
    contents: [{ text: "The answer." }],
    toolCalls: [],
    thinking: "Step one.Step two.",
    thinkingMeta: {
      blocks: [
        { type: "thinking", thinking: "Step one.", signature: "sig-1" },
        { type: "redacted_thinking", data: "blob" },
        { type: "thinking", thinking: "Step two.", signature: "sig-2" },
      ],
    },
  };

  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Step one.", signature: "sig-1" },
        { type: "redacted_thinking", data: "blob" },
        { type: "thinking", thinking: "Step two.", signature: "sig-2" },
        { type: "text", text: "The answer." },
      ],
    },
  ]);
});

test("anthropicMessagesFrom drops thinking without a signature", () => {
  const msg: Message = {
    role: "model",
    contents: [{ text: "The answer." }],
    toolCalls: [],
    thinking: "Pondering...",
  };

  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "assistant",
      content: [{ type: "text", text: "The answer." }],
    },
  ]);
});

test("anthropicMessagesFrom converts tool message to tool_result blocks", () => {
  const msg: Message = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "call-1",
          name: "lookup",
          result: { output: "found" },
        },
      },
      {
        toolResult: {
          id: "call-2",
          name: "lookup",
          result: { error: "boom" },
        },
      },
    ],
  };

  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: "found",
          is_error: false,
        },
        {
          type: "tool_result",
          tool_use_id: "call-2",
          content: "boom",
          is_error: true,
        },
      ],
    },
  ]);
});

test("anthropicMessagesFrom maps tool result files to content blocks", () => {
  const msg: Message = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "call-1",
          name: "screenshot",
          result: { output: "captured" },
          files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
        },
      },
    ],
  };

  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: [
            { type: "text", text: "captured" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
            },
          ],
          is_error: false,
        },
      ],
    },
  ]);
});

test("anthropicMessagesFrom omits the text block for file-only tool results", () => {
  const msg: Message = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "call-1",
          name: "screenshot",
          result: {},
          files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
        },
      },
    ],
  };

  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
            },
          ],
          is_error: false,
        },
      ],
    },
  ]);
});

test("anthropicMessagesFrom maps tool result PDFs to document blocks", () => {
  const msg: Message = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "call-1",
          name: "report",
          result: { output: "generated" },
          files: [{ file: { mimeType: "application/pdf", data: "aGVsbG8=" } }],
        },
      },
    ],
  };

  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: [
            { type: "text", text: "generated" },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "aGVsbG8=",
              },
            },
          ],
          is_error: false,
        },
      ],
    },
  ]);
});

test("anthropicMessagesFrom keeps string content for results without files beside results with files", () => {
  const msg: Message = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "call-1",
          name: "screenshot",
          result: { output: "captured" },
          files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
        },
      },
      {
        toolResult: {
          id: "call-2",
          name: "lookup",
          result: { output: "found" },
        },
      },
    ],
  };

  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: [
            { type: "text", text: "captured" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aGVsbG8=",
              },
            },
          ],
          is_error: false,
        },
        {
          type: "tool_result",
          tool_use_id: "call-2",
          content: "found",
          is_error: false,
        },
      ],
    },
  ]);
});

test("anthropicMessagesFrom throws on unsupported tool result file types", () => {
  const msg: Message = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "call-1",
          name: "record",
          result: { output: "recorded" },
          files: [{ file: { mimeType: "audio/mpeg", data: "aGVsbG8=" } }],
        },
      },
    ],
  };

  expect(() => anthropicMessagesFrom([msg])).toThrow(RangeError);
  expect(() => anthropicMessagesFrom([msg])).toThrow('file content of type "audio/mpeg"');
});

test("anthropicMessagesFrom maps files on errored tool results", () => {
  const msg: Message = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "call-1",
          name: "screenshot",
          result: { error: "timeout" },
          files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
        },
      },
    ],
  };

  expect(anthropicMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call-1",
          content: [
            { type: "text", text: "timeout" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
            },
          ],
          is_error: true,
        },
      ],
    },
  ]);
});

test("anthropicMessagesFrom drops tool messages without results", () => {
  const msg: Message = {
    role: "tool",
    contents: [{ toolCall: { id: "call-1", name: "lookup", props: { q: "x" } as any } }],
  };

  expect(anthropicMessagesFrom([msg])).toStrictEqual([]);
});

function messagesResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("AnthropicModel.generate calls the API and returns mapped result", async () => {
  let requestBody: any = null;

  const model = new AnthropicModel({
    apiKey: "test-key",
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/v1/messages")) {
        requestBody = JSON.parse((init as { body?: string })?.body ?? "{}");
        return Promise.resolve(
          messagesResponse({
            id: "msg_123",
            type: "message",
            role: "assistant",
            model: "claude-opus-4-8",
            content: [{ type: "text", text: "Hello! How can I help?" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 9, output_tokens: 12 },
          }),
        );
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    },
  });

  const result = await model.generate({
    modelId: "claude-opus-4-8",
    system: "Be helpful.",
    messages: [{ role: "user", contents: "Hi" }],
  });

  expect(requestBody.model).toStrictEqual("claude-opus-4-8");
  expect(requestBody.max_tokens).toStrictEqual(16000);
  expect(requestBody.system).toStrictEqual("Be helpful.");
  expect(requestBody.messages).toStrictEqual([{ role: "user", content: "Hi" }]);
  expect(result.modelId).toStrictEqual("claude-opus-4-8");
  expect(result.messages).toStrictEqual([
    {
      role: "model",
      contents: [{ text: "Hello! How can I help?" }],
      toolCalls: [],
    },
  ]);
  expect(result.usage).toStrictEqual({
    inputTokens: 9,
    outputTokens: 12,
    totalTokens: 21,
  });
});

test("AnthropicModel.generate maps tool_use and thinking blocks", async () => {
  const model = new AnthropicModel({
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve(
        messagesResponse({
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            { type: "thinking", thinking: "Pondering...", signature: "sig-1" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "lookup",
              input: { query: "deno" },
            },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: { input_tokens: 9, output_tokens: 12 },
        }),
      ),
  });

  const result = await model.generate({
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", contents: "Look up deno" }],
  });

  const toolCall = {
    id: "toolu_1",
    name: "lookup",
    props: { query: "deno" } as any,
  };
  expect(result.messages).toStrictEqual([
    {
      role: "model",
      contents: [{ toolCall }],
      toolCalls: [toolCall],
      thinking: "Pondering...",
      thinkingMeta: {
        blocks: [{ type: "thinking", thinking: "Pondering...", signature: "sig-1" }],
      },
    },
  ]);
});

test("AnthropicModel.generate keeps interleaved thinking blocks separate", async () => {
  const model = new AnthropicModel({
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve(
        messagesResponse({
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [
            { type: "thinking", thinking: "Step one.", signature: "sig-1" },
            { type: "redacted_thinking", data: "blob" },
            { type: "thinking", thinking: "Step two.", signature: "sig-2" },
            { type: "text", text: "Done." },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 9, output_tokens: 12 },
        }),
      ),
  });

  const result = await model.generate({
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", contents: "Hi" }],
  });

  expect(result.messages).toStrictEqual([
    {
      role: "model",
      contents: [{ text: "Done." }],
      toolCalls: [],
      thinking: "Step one.Step two.",
      thinkingMeta: {
        blocks: [
          { type: "thinking", thinking: "Step one.", signature: "sig-1" },
          { type: "redacted_thinking", data: "blob" },
          { type: "thinking", thinking: "Step two.", signature: "sig-2" },
        ],
      },
    },
  ]);
});

test("AnthropicModel.generate throws on empty refusal response", async () => {
  const model = new AnthropicModel({
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve(
        messagesResponse({
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [],
          stop_reason: "refusal",
          stop_sequence: null,
          usage: { input_tokens: 9, output_tokens: 0 },
        }),
      ),
  });

  const error = await model
    .generate({
      modelId: "claude-opus-4-8",
      messages: [{ role: "user", contents: "Hi" }],
    })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("stop reason: refusal");
});

test("AnthropicModel.stream maps text deltas and complete tool calls", async () => {
  const sse =
    [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":0}}}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"deno\\"}"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":12}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ].join("\n\n") + "\n\n";

  const model = anthropic({
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve(
        new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
  });

  const stream = await model.stream({
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", contents: "Look up deno" }],
  });

  const results = [];
  for await (const result of stream) {
    results.push(result);
  }

  const toolCall = {
    id: "toolu_1",
    name: "lookup",
    props: { query: "deno" } as any,
  };
  expect(results.length).toStrictEqual(4);
  expect(results.slice(0, 3).map((r) => r.messages[0])).toStrictEqual([
    { role: "model", contents: [{ text: "Hel" }], toolCalls: [] },
    { role: "model", contents: [{ text: "lo" }], toolCalls: [] },
    { role: "model", contents: [{ toolCall }], toolCalls: [toolCall] },
  ]);

  // The stream ends with a usage-only result accumulated from the
  // message_start (input tokens) and message_delta (output tokens) events.
  expect(results[3]).toStrictEqual({
    modelId: "claude-opus-4-8",
    messages: [],
    usage: { inputTokens: 9, outputTokens: 12, totalTokens: 21 },
  });
});

test("AnthropicModel.stream emits replayable thinking blocks", async () => {
  const sse =
    [
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":0}}}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Pond"}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ering..."}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-1"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"blob"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":1}`,
      `event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Hel"}}`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"lo"}}`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":2}`,
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":12}}`,
      `event: message_stop\ndata: {"type":"message_stop"}`,
    ].join("\n\n") + "\n\n";

  const model = anthropic({
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve(
        new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
  });

  const stream = await model.stream({
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const chunks = [];
  for await (const result of stream) {
    chunks.push(...result.messages);
  }

  expect(chunks).toStrictEqual([
    { role: "model", contents: [], toolCalls: [], thinking: "Pond" },
    { role: "model", contents: [], toolCalls: [], thinking: "ering..." },
    {
      role: "model",
      contents: [],
      toolCalls: [],
      thinkingMeta: {
        blocks: [{ type: "thinking", thinking: "Pondering...", signature: "sig-1" }],
      },
    },
    {
      role: "model",
      contents: [],
      toolCalls: [],
      thinkingMeta: {
        blocks: [{ type: "redacted_thinking", data: "blob" }],
      },
    },
    { role: "model", contents: [{ text: "Hel" }], toolCalls: [] },
    { role: "model", contents: [{ text: "lo" }], toolCalls: [] },
  ]);

  // The merged message round-trips into Anthropic request content.
  const merged = mergeAnthropicModelMessages(chunks);
  expect(merged).toStrictEqual({
    role: "model",
    contents: [{ text: "Hello" }],
    toolCalls: [],
    thinking: "Pondering...",
    thinkingMeta: {
      blocks: [
        { type: "thinking", thinking: "Pondering...", signature: "sig-1" },
        { type: "redacted_thinking", data: "blob" },
      ],
    },
  });
  expect(anthropicMessagesFrom([merged!])).toStrictEqual([
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Pondering...", signature: "sig-1" },
        { type: "redacted_thinking", data: "blob" },
        { type: "text", text: "Hello" },
      ],
    },
  ]);
});

function sseModel(events: string[]): AnthropicModel {
  const sse = events.join("\n\n") + "\n\n";
  return anthropic({
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve(
        new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
  });
}

test("AnthropicModel.stream throws on empty refusal response", async () => {
  const model = sseModel([
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":0}}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null},"usage":{"output_tokens":0}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ]);

  const stream = await model.stream({
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const error = await (async () => {
    for await (const _ of stream) {
      // drain
    }
  })().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("stop reason: refusal");
});

test("AnthropicModel.stream throws on truncated tool input JSON", async () => {
  const model = sseModel([
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":0}}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"lookup","input":{}}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":12}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ]);

  const stream = await model.stream({
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", contents: "Look up deno" }],
  });

  const error = await (async () => {
    for await (const _ of stream) {
      // drain
    }
  })().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('invalid input JSON for tool "lookup"');
});

test("AnthropicModel.stream yields partial text on max_tokens stop", async () => {
  const model = sseModel([
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":0}}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":12}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ]);

  const stream = await model.stream({
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", contents: "Hi" }],
  });

  const chunks = [];
  for await (const result of stream) {
    chunks.push(...result.messages);
  }

  expect(chunks).toStrictEqual([{ role: "model", contents: [{ text: "Hel" }], toolCalls: [] }]);
});

test("mergeAnthropicModelMessages merges text and tool call chunks", () => {
  const toolCall = {
    id: "toolu_1",
    name: "lookup",
    props: { query: "deno" } as any,
  };
  const merged = mergeAnthropicModelMessages([
    { role: "model", contents: [{ text: "Hel" }], toolCalls: [] },
    { role: "model", contents: [{ text: "lo" }], toolCalls: [] },
    { role: "model", contents: [{ toolCall }], toolCalls: [toolCall] },
  ]);

  expect(merged).toStrictEqual({
    role: "model",
    contents: [{ text: "Hello" }, { toolCall }],
    toolCalls: [toolCall],
  });
});

test("mergeAnthropicModelMessages returns undefined for empty input", () => {
  expect(mergeAnthropicModelMessages([])).toStrictEqual(undefined);
});

test("anthropic factory returns AnthropicModel instance", () => {
  expect(anthropic({ apiKey: "test-key" })).toBeInstanceOf(AnthropicModel);
});
