import { expect, test } from "vite-plus/test";

import type { Message, ToolMessage } from "../../src/mod.ts";
import { tool } from "../../src/tools/mod.ts";
import { object, string } from "@huuma/validate";
import type { ChatResponse } from "ollama";
import { ollamaMessagesFrom, ollamaToolsFrom, ollamaUsageFrom } from "./mod.ts";

test("ollamaToolsFrom converts tools correctly", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: string(),
    fn: () => "result",
  });

  const ollamaTools = ollamaToolsFrom([testTool]);
  expect(ollamaTools.length).toStrictEqual(1);
  expect(ollamaTools[0].function.name).toStrictEqual("test_tool");
  expect(ollamaTools[0].function.description).toStrictEqual("A test tool");
  // Expecting JSON schema. string() -> { type: "string" }
  expect(ollamaTools[0].function.parameters).toStrictEqual({ type: "string" });
});

test("ollamaToolsFrom reuses the tool's cached JSON Schema", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: object({ query: string() }),
    fn: () => "result",
  });

  const [first] = ollamaToolsFrom([testTool]);
  const [second] = ollamaToolsFrom([testTool]);
  expect(first.function.parameters === second.function.parameters).toStrictEqual(true);
  expect(first.function.parameters === (testTool.jsonSchema as object)).toStrictEqual(true);
});

test("ollamaMessagesFrom converts user message", () => {
  const msg: Message = { role: "user", contents: "Hello" };
  const result = ollamaMessagesFrom([msg]);
  expect(result).toStrictEqual([{ role: "user", content: "Hello" }]);
});

test("ollamaMessagesFrom collects base64 images into images", () => {
  const msg: Message = {
    role: "user",
    contents: [
      { text: "What is in this image?" },
      { file: { mimeType: "image/png", data: "aGVsbG8=" } },
    ],
  };
  expect(ollamaMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: "What is in this image?",
      images: ["aGVsbG8="],
    },
  ]);
});

test("ollamaMessagesFrom preserves image order alongside joined text", () => {
  const msg: Message = {
    role: "user",
    contents: [
      { text: "Compare " },
      { file: { mimeType: "image/png", data: "Zmlyc3Q=" } },
      { text: "with" },
      { file: { mimeType: "image/jpeg", data: "c2Vjb25k" } },
    ],
  };
  expect(ollamaMessagesFrom([msg])).toStrictEqual([
    {
      role: "user",
      content: "Compare with",
      images: ["Zmlyc3Q=", "c2Vjb25k"],
    },
  ]);
});

test("ollamaMessagesFrom throws on images by URL", () => {
  const msg: Message = {
    role: "user",
    contents: [
      {
        file: { mimeType: "image/png", url: "https://example.com/a.png" },
      },
    ],
  };
  expect(() => ollamaMessagesFrom([msg])).toThrow(RangeError);
  expect(() => ollamaMessagesFrom([msg])).toThrow("images by URL");
});

test("ollamaMessagesFrom throws on non-image file content", () => {
  const msg: Message = {
    role: "user",
    contents: [{ file: { mimeType: "application/pdf", data: "aGVsbG8=" } }],
  };
  expect(() => ollamaMessagesFrom([msg])).toThrow(RangeError);
  expect(() => ollamaMessagesFrom([msg])).toThrow('file content of type "application/pdf"');
});

test("ollamaMessagesFrom omits images for text-only messages", () => {
  const msg: Message = {
    role: "user",
    contents: [{ text: "Hello" }, { text: " world!" }],
  };
  expect(ollamaMessagesFrom([msg])).toStrictEqual([{ role: "user", content: "Hello world!" }]);
});

test("ollamaMessagesFrom converts model message with tool calls", () => {
  const msgWithContent: Message = {
    role: "model",
    contents: [
      { text: "Thinking..." },
      { toolCall: { id: "1", name: "tool1", props: { arg: "val" } as any } },
    ],
    toolCalls: [{ id: "1", name: "tool1", props: { arg: "val" } as any }],
  };

  const result = ollamaMessagesFrom([msgWithContent]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("assistant");
  expect(result[0].content).toStrictEqual("Thinking...");
  expect(result[0].tool_calls).toStrictEqual([
    {
      function: { name: "tool1", arguments: { arg: "val" } },
    },
  ]);
});

test("ollamaMessagesFrom converts tool message", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [{ toolResult: { id: "1", name: "tool1", result: { output: "success" } } }],
  };

  const result = ollamaMessagesFrom([msg]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("tool");
  expect(result[0].content).toStrictEqual("success");
  // @ts-ignore: tool_name check
  expect(result[0].tool_name).toStrictEqual("tool1");
});

test("ollamaMessagesFrom appends a synthetic user message for tool result files", () => {
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

  expect(ollamaMessagesFrom([msg])).toStrictEqual([
    { role: "tool", content: "captured", tool_name: "screenshot" },
    {
      role: "user",
      content: 'Files returned by tool "screenshot" (call 1):',
      images: ["aGVsbG8="],
    },
  ]);
});

test("ollamaMessagesFrom preserves file order across multiple tool results", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "1",
          name: "screenshot",
          result: { output: "captured" },
          files: [
            { file: { mimeType: "image/png", data: "aGVsbG8=" } },
            { file: { mimeType: "image/png", data: "c2Vjb25k" } },
          ],
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

  expect(ollamaMessagesFrom([msg])).toStrictEqual([
    { role: "tool", content: "captured", tool_name: "screenshot" },
    { role: "tool", content: "photographed", tool_name: "camera" },
    {
      role: "user",
      content: 'Files returned by tool "screenshot" (call 1):',
      images: ["aGVsbG8=", "c2Vjb25k"],
    },
    {
      role: "user",
      content: 'Files returned by tool "camera" (call 2):',
      images: ["d29ybGQ="],
    },
  ]);
});

test("ollamaMessagesFrom throws on tool result images by URL", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "1",
          name: "screenshot",
          result: { output: "captured" },
          files: [
            {
              file: { mimeType: "image/png", url: "https://example.com/a.png" },
            },
          ],
        },
      },
    ],
  };

  expect(() => ollamaMessagesFrom([msg])).toThrow(RangeError);
  expect(() => ollamaMessagesFrom([msg])).toThrow("images by URL");
});

test("ollamaMessagesFrom throws on non-image tool result files", () => {
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

  expect(() => ollamaMessagesFrom([msg])).toThrow(RangeError);
  expect(() => ollamaMessagesFrom([msg])).toThrow('file content of type "application/pdf"');
});

test("ollamaMessagesFrom serializes object output as JSON", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "1",
          name: "tool1",
          result: { output: { ok: true, items: [1, 2] } },
        },
      },
    ],
  };

  const result = ollamaMessagesFrom([msg]);
  expect(result[0].content).toStrictEqual('{"ok":true,"items":[1,2]}');
});

test("ollamaMessagesFrom serializes error output and prefers it over output", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      {
        toolResult: {
          id: "1",
          name: "tool1",
          result: { output: "ignored", error: { message: "boom" } },
        },
      },
    ],
  };

  const result = ollamaMessagesFrom([msg]);
  expect(result[0].content).toStrictEqual('{"message":"boom"}');
});

test("ollamaMessagesFrom round-trips assistant thinking", () => {
  const msg: Message = {
    role: "model",
    contents: [{ text: "Answer" }],
    toolCalls: [],
    thinking: "deliberating...",
  };

  const result = ollamaMessagesFrom([msg]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].role).toStrictEqual("assistant");
  expect(result[0].content).toStrictEqual("Answer");
  expect(result[0].thinking).toStrictEqual("deliberating...");
});

test("ollamaMessagesFrom keeps a thinking-only assistant message", () => {
  const msg: Message = {
    role: "model",
    contents: [],
    toolCalls: [],
    thinking: "reasoning trace",
  };

  const result = ollamaMessagesFrom([msg]);
  expect(result.length).toStrictEqual(1);
  expect(result[0].content).toStrictEqual("");
  expect(result[0].thinking).toStrictEqual("reasoning trace");
});

test("ollamaMessagesFrom drops fully empty assistant messages", () => {
  const msg: Message = {
    role: "model",
    contents: [],
    toolCalls: [],
  };

  const result = ollamaMessagesFrom([msg]);
  expect(result.length).toStrictEqual(0);
});

test("ollamaUsageFrom maps token counts from a done response", () => {
  const usage = ollamaUsageFrom({
    done: true,
    prompt_eval_count: 9,
    eval_count: 12,
  } as ChatResponse);

  expect(usage).toStrictEqual({ inputTokens: 9, outputTokens: 12, totalTokens: 21 });
});

test("ollamaUsageFrom returns undefined for intermediate chunks", () => {
  const usage = ollamaUsageFrom({ done: false } as ChatResponse);
  expect(usage).toStrictEqual(undefined);
});

test("ollamaUsageFrom returns undefined when no counts are reported", () => {
  const usage = ollamaUsageFrom({ done: true } as ChatResponse);
  expect(usage).toStrictEqual(undefined);
});
