import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";
import type { Message } from "@/mod.ts";
import { tool } from "@/tools/mod.ts";
import { object, string } from "@huuma/validate";
import {
  anthropic,
  anthropicMessagesFrom,
  AnthropicModel,
  anthropicToolsFrom,
  mergeAnthropicModelMessages,
} from "./mod.ts";

Deno.test("anthropicToolsFrom converts tools correctly", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: object({ query: string() }),
    fn: () => "result",
  });

  const tools = anthropicToolsFrom([testTool]);
  assertEquals(tools.length, 1);
  assertEquals(tools[0].name, "test_tool");
  assertEquals(tools[0].description, "A test tool");
  assertEquals(tools[0].input_schema.type, "object");
});

Deno.test("anthropicMessagesFrom converts user message", () => {
  const msg: Message = { role: "user", contents: "Hello" };
  assertEquals(anthropicMessagesFrom([msg]), [
    { role: "user", content: "Hello" },
  ]);
});

Deno.test("anthropicMessagesFrom sends system messages as user content", () => {
  const msg: Message = {
    role: "system",
    contents: [{ text: "You are " }, { text: "an AI." }],
  };
  assertEquals(anthropicMessagesFrom([msg]), [
    { role: "user", content: "You are an AI." },
  ]);
});

Deno.test("anthropicMessagesFrom maps base64 images to image blocks", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
  };
  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "user",
    content: [{
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
    }],
  }]);
});

Deno.test("anthropicMessagesFrom maps image URLs to url sources", () => {
  const msg: Message = {
    role: "user",
    contents: [{
      file: { mimeType: "image/png", url: "https://example.com/a.png" },
    }],
  };
  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "user",
    content: [{
      type: "image",
      source: { type: "url", url: "https://example.com/a.png" },
    }],
  }]);
});

Deno.test("anthropicMessagesFrom maps base64 PDFs to document blocks", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "application/pdf", data: "aGVsbG8=" } }],
  };
  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "user",
    content: [{
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "aGVsbG8=",
      },
    }],
  }]);
});

Deno.test("anthropicMessagesFrom maps PDF URLs to document url sources", () => {
  const msg: Message = {
    role: "user",
    contents: [{
      file: { mimeType: "application/pdf", url: "https://example.com/a.pdf" },
    }],
  };
  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "user",
    content: [{
      type: "document",
      source: { type: "url", url: "https://example.com/a.pdf" },
    }],
  }]);
});

Deno.test("anthropicMessagesFrom throws on unsupported base64 image types", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "image/tiff", data: "aGVsbG8=" } }],
  };
  assertThrows(
    () => anthropicMessagesFrom([msg]),
    RangeError,
    'images of type "image/tiff"',
  );
});

Deno.test("anthropicMessagesFrom throws on unsupported image URL types", () => {
  const msg: Message = {
    role: "user",
    contents: [{
      file: { mimeType: "image/tiff", url: "https://example.com/a.tiff" },
    }],
  };
  assertThrows(
    () => anthropicMessagesFrom([msg]),
    RangeError,
    'images of type "image/tiff"',
  );
});

Deno.test("anthropicMessagesFrom throws on unsupported file types", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "audio/mpeg", data: "aGVsbG8=" } }],
  };
  assertThrows(
    () => anthropicMessagesFrom([msg]),
    RangeError,
    'file content of type "audio/mpeg"',
  );
});

Deno.test("anthropicMessagesFrom keeps string content for text-only user parts", () => {
  const msg: Message = {
    role: "user",
    contents: [{ text: "Hello " }, { text: "there" }],
  };
  assertEquals(anthropicMessagesFrom([msg]), [
    { role: "user", content: "Hello there" },
  ]);
});

Deno.test("anthropicMessagesFrom preserves part order for mixed text and image", () => {
  const msg: Message = {
    role: "user",
    contents: [
      { text: "What is in this image?" },
      { file: { mimeType: "image/jpeg", data: "aGVsbG8=" } },
      { text: "Answer briefly." },
    ],
  };
  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "user",
    content: [
      { type: "text", text: "What is in this image?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: "aGVsbG8=" },
      },
      { type: "text", text: "Answer briefly." },
    ],
  }]);
});

Deno.test("anthropicMessagesFrom converts model message with tool calls", () => {
  const msg: Message = {
    role: "model",
    contents: [
      { text: "Checking..." },
      // deno-lint-ignore no-explicit-any
      { toolCall: { id: "call-1", name: "lookup", props: { q: "x" } as any } },
    ],
    // deno-lint-ignore no-explicit-any
    toolCalls: [{ id: "call-1", name: "lookup", props: { q: "x" } as any }],
  };

  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "assistant",
    content: [
      { type: "text", text: "Checking..." },
      { type: "tool_use", id: "call-1", name: "lookup", input: { q: "x" } },
    ],
  }]);
});

Deno.test("anthropicMessagesFrom drops fully empty assistant messages", () => {
  const msg: Message = { role: "model", contents: [], toolCalls: [] };
  assertEquals(anthropicMessagesFrom([msg]), []);
});

Deno.test("anthropicMessagesFrom replays thinking with its signature", () => {
  const msg: Message = {
    role: "model",
    contents: [{ text: "The answer." }],
    toolCalls: [],
    thinking: "Pondering...",
    thinkingMeta: { signature: "sig-1" },
  };

  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Pondering...", signature: "sig-1" },
      { type: "text", text: "The answer." },
    ],
  }]);
});

Deno.test("anthropicMessagesFrom replays interleaved thinking blocks in order", () => {
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

  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Step one.", signature: "sig-1" },
      { type: "redacted_thinking", data: "blob" },
      { type: "thinking", thinking: "Step two.", signature: "sig-2" },
      { type: "text", text: "The answer." },
    ],
  }]);
});

Deno.test("anthropicMessagesFrom drops thinking without a signature", () => {
  const msg: Message = {
    role: "model",
    contents: [{ text: "The answer." }],
    toolCalls: [],
    thinking: "Pondering...",
  };

  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "assistant",
    content: [{ type: "text", text: "The answer." }],
  }]);
});

Deno.test("anthropicMessagesFrom converts tool message to tool_result blocks", () => {
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

  assertEquals(anthropicMessagesFrom([msg]), [{
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
  }]);
});

Deno.test("anthropicMessagesFrom maps tool result files to content blocks", () => {
  const msg: Message = {
    role: "tool",
    contents: [{
      toolResult: {
        id: "call-1",
        name: "screenshot",
        result: { output: "captured" },
        files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
      },
    }],
  };

  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "user",
    content: [{
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
    }],
  }]);
});

Deno.test("anthropicMessagesFrom maps tool result PDFs to document blocks", () => {
  const msg: Message = {
    role: "tool",
    contents: [{
      toolResult: {
        id: "call-1",
        name: "report",
        result: { output: "generated" },
        files: [{ file: { mimeType: "application/pdf", data: "aGVsbG8=" } }],
      },
    }],
  };

  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "user",
    content: [{
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
    }],
  }]);
});

Deno.test("anthropicMessagesFrom keeps string content for results without files beside results with files", () => {
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

  assertEquals(anthropicMessagesFrom([msg]), [{
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
  }]);
});

Deno.test("anthropicMessagesFrom throws on unsupported tool result file types", () => {
  const msg: Message = {
    role: "tool",
    contents: [{
      toolResult: {
        id: "call-1",
        name: "record",
        result: { output: "recorded" },
        files: [{ file: { mimeType: "audio/mpeg", data: "aGVsbG8=" } }],
      },
    }],
  };

  assertThrows(
    () => anthropicMessagesFrom([msg]),
    RangeError,
    'file content of type "audio/mpeg"',
  );
});

Deno.test("anthropicMessagesFrom maps files on errored tool results", () => {
  const msg: Message = {
    role: "tool",
    contents: [{
      toolResult: {
        id: "call-1",
        name: "screenshot",
        result: { error: "timeout" },
        files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
      },
    }],
  };

  assertEquals(anthropicMessagesFrom([msg]), [{
    role: "user",
    content: [{
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
    }],
  }]);
});

Deno.test("anthropicMessagesFrom drops tool messages without results", () => {
  const msg: Message = {
    role: "tool",
    contents: [
      // deno-lint-ignore no-explicit-any
      { toolCall: { id: "call-1", name: "lookup", props: { q: "x" } as any } },
    ],
  };

  assertEquals(anthropicMessagesFrom([msg]), []);
});

function messagesResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("AnthropicModel.generate calls the API and returns mapped result", async () => {
  // deno-lint-ignore no-explicit-any
  let requestBody: any = null;

  const model = new AnthropicModel({
    apiKey: "test-key",
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url.includes("/v1/messages")) {
        requestBody = JSON.parse((init as { body?: string })?.body ?? "{}");
        return Promise.resolve(messagesResponse({
          id: "msg_123",
          type: "message",
          role: "assistant",
          model: "claude-opus-4-8",
          content: [{ type: "text", text: "Hello! How can I help?" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 9, output_tokens: 12 },
        }));
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    },
  });

  const result = await model.generate({
    modelId: "claude-opus-4-8",
    system: "Be helpful.",
    messages: [{ role: "user", contents: "Hi" }],
  });

  assertEquals(requestBody.model, "claude-opus-4-8");
  assertEquals(requestBody.max_tokens, 16000);
  assertEquals(requestBody.system, "Be helpful.");
  assertEquals(requestBody.messages, [{ role: "user", content: "Hi" }]);
  assertEquals(result.modelId, "claude-opus-4-8");
  assertEquals(result.messages, [{
    role: "model",
    contents: [{ text: "Hello! How can I help?" }],
    toolCalls: [],
  }]);
  assertEquals(result.usage, {
    inputTokens: 9,
    outputTokens: 12,
    totalTokens: 21,
  });
});

Deno.test("AnthropicModel.generate maps tool_use and thinking blocks", async () => {
  const model = new AnthropicModel({
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve(messagesResponse({
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
      })),
  });

  const result = await model.generate({
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", contents: "Look up deno" }],
  });

  const toolCall = {
    id: "toolu_1",
    name: "lookup",
    // deno-lint-ignore no-explicit-any
    props: { query: "deno" } as any,
  };
  assertEquals(result.messages, [{
    role: "model",
    contents: [{ toolCall }],
    toolCalls: [toolCall],
    thinking: "Pondering...",
    thinkingMeta: {
      blocks: [
        { type: "thinking", thinking: "Pondering...", signature: "sig-1" },
      ],
    },
  }]);
});

Deno.test("AnthropicModel.generate keeps interleaved thinking blocks separate", async () => {
  const model = new AnthropicModel({
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve(messagesResponse({
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
      })),
  });

  const result = await model.generate({
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", contents: "Hi" }],
  });

  assertEquals(result.messages, [{
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
  }]);
});

Deno.test("AnthropicModel.generate throws on empty refusal response", async () => {
  const model = new AnthropicModel({
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve(messagesResponse({
        id: "msg_123",
        type: "message",
        role: "assistant",
        model: "claude-opus-4-8",
        content: [],
        stop_reason: "refusal",
        stop_sequence: null,
        usage: { input_tokens: 9, output_tokens: 0 },
      })),
  });

  await assertRejects(
    () =>
      model.generate({
        modelId: "claude-opus-4-8",
        messages: [{ role: "user", contents: "Hi" }],
      }),
    Error,
    "stop reason: refusal",
  );
});

Deno.test("AnthropicModel.stream maps text deltas and complete tool calls", async () => {
  const sse = [
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
    // deno-lint-ignore no-explicit-any
    props: { query: "deno" } as any,
  };
  assertEquals(results.length, 4);
  assertEquals(results.slice(0, 3).map((r) => r.messages[0]), [
    { role: "model", contents: [{ text: "Hel" }], toolCalls: [] },
    { role: "model", contents: [{ text: "lo" }], toolCalls: [] },
    { role: "model", contents: [{ toolCall }], toolCalls: [toolCall] },
  ]);

  // The stream ends with a usage-only result accumulated from the
  // message_start (input tokens) and message_delta (output tokens) events.
  assertEquals(results[3], {
    modelId: "claude-opus-4-8",
    messages: [],
    usage: { inputTokens: 9, outputTokens: 12, totalTokens: 21 },
  });
});

Deno.test("AnthropicModel.stream emits replayable thinking blocks", async () => {
  const sse = [
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

  assertEquals(chunks, [
    { role: "model", contents: [], toolCalls: [], thinking: "Pond" },
    { role: "model", contents: [], toolCalls: [], thinking: "ering..." },
    {
      role: "model",
      contents: [],
      toolCalls: [],
      thinkingMeta: {
        blocks: [
          { type: "thinking", thinking: "Pondering...", signature: "sig-1" },
        ],
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
  assertEquals(merged, {
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
  assertEquals(anthropicMessagesFrom([merged!]), [{
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Pondering...", signature: "sig-1" },
      { type: "redacted_thinking", data: "blob" },
      { type: "text", text: "Hello" },
    ],
  }]);
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

Deno.test("AnthropicModel.stream throws on empty refusal response", async () => {
  const model = sseModel([
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":9,"output_tokens":0}}}`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_sequence":null},"usage":{"output_tokens":0}}`,
    `event: message_stop\ndata: {"type":"message_stop"}`,
  ]);

  const stream = await model.stream({
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", contents: "Hi" }],
  });

  await assertRejects(
    async () => {
      for await (const _ of stream) {
        // drain
      }
    },
    Error,
    "stop reason: refusal",
  );
});

Deno.test("AnthropicModel.stream throws on truncated tool input JSON", async () => {
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

  await assertRejects(
    async () => {
      for await (const _ of stream) {
        // drain
      }
    },
    Error,
    'invalid input JSON for tool "lookup"',
  );
});

Deno.test("AnthropicModel.stream yields partial text on max_tokens stop", async () => {
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

  assertEquals(chunks, [
    { role: "model", contents: [{ text: "Hel" }], toolCalls: [] },
  ]);
});

Deno.test("mergeAnthropicModelMessages merges text and tool call chunks", () => {
  const toolCall = {
    id: "toolu_1",
    name: "lookup",
    // deno-lint-ignore no-explicit-any
    props: { query: "deno" } as any,
  };
  const merged = mergeAnthropicModelMessages([
    { role: "model", contents: [{ text: "Hel" }], toolCalls: [] },
    { role: "model", contents: [{ text: "lo" }], toolCalls: [] },
    { role: "model", contents: [{ toolCall }], toolCalls: [toolCall] },
  ]);

  assertEquals(merged, {
    role: "model",
    contents: [{ text: "Hello" }, { toolCall }],
    toolCalls: [toolCall],
  });
});

Deno.test("mergeAnthropicModelMessages returns undefined for empty input", () => {
  assertEquals(mergeAnthropicModelMessages([]), undefined);
});

Deno.test("anthropic factory returns AnthropicModel instance", () => {
  assertInstanceOf(anthropic({ apiKey: "test-key" }), AnthropicModel);
});
