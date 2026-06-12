import { assertEquals } from "@std/assert";

import type { Message, ToolMessage } from "@/mod.ts";
import { tool } from "@/tools/mod.ts";
import { string } from "@huuma/validate";
import type { ChatResponse } from "ollama";
import { ollamaMessagesFrom, ollamaToolsFrom, ollamaUsageFrom } from "./mod.ts";

Deno.test("ollamaToolsFrom converts tools correctly", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: string(),
    fn: () => "result",
  });

  const ollamaTools = ollamaToolsFrom([testTool]);
  assertEquals(ollamaTools.length, 1);
  assertEquals(ollamaTools[0].function.name, "test_tool");
  assertEquals(ollamaTools[0].function.description, "A test tool");
  // Expecting JSON schema. string() -> { type: "string" }
  assertEquals(ollamaTools[0].function.parameters, { type: "string" });
});

Deno.test("ollamaMessagesFrom converts user message", () => {
  const msg: Message = { role: "user", contents: "Hello" };
  const result = ollamaMessagesFrom([msg]);
  assertEquals(result, [{ role: "user", content: "Hello" }]);
});

Deno.test("ollamaMessagesFrom converts model message with tool calls", () => {
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

  const result = ollamaMessagesFrom([msgWithContent]);
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "assistant");
  assertEquals(result[0].content, "Thinking...");
  assertEquals(result[0].tool_calls, [{
    function: { name: "tool1", arguments: { arg: "val" } },
  }]);
});

Deno.test("ollamaMessagesFrom converts tool message", () => {
  const msg: ToolMessage = {
    role: "tool",
    contents: [
      { toolResult: { id: "1", name: "tool1", result: { output: "success" } } },
    ],
  };

  const result = ollamaMessagesFrom([msg]);
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "tool");
  assertEquals(result[0].content, "success");
  // @ts-ignore: tool_name check
  assertEquals(result[0].tool_name, "tool1");
});

Deno.test("ollamaMessagesFrom serializes object output as JSON", () => {
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
  assertEquals(result[0].content, '{"ok":true,"items":[1,2]}');
});

Deno.test("ollamaMessagesFrom serializes error output and prefers it over output", () => {
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
  assertEquals(result[0].content, '{"message":"boom"}');
});

Deno.test("ollamaMessagesFrom round-trips assistant thinking", () => {
  const msg: Message = {
    role: "model",
    contents: [{ text: "Answer" }],
    toolCalls: [],
    thinking: "deliberating...",
  };

  const result = ollamaMessagesFrom([msg]);
  assertEquals(result.length, 1);
  assertEquals(result[0].role, "assistant");
  assertEquals(result[0].content, "Answer");
  assertEquals(result[0].thinking, "deliberating...");
});

Deno.test("ollamaMessagesFrom keeps a thinking-only assistant message", () => {
  const msg: Message = {
    role: "model",
    contents: [],
    toolCalls: [],
    thinking: "reasoning trace",
  };

  const result = ollamaMessagesFrom([msg]);
  assertEquals(result.length, 1);
  assertEquals(result[0].content, "");
  assertEquals(result[0].thinking, "reasoning trace");
});

Deno.test("ollamaMessagesFrom drops fully empty assistant messages", () => {
  const msg: Message = {
    role: "model",
    contents: [],
    toolCalls: [],
  };

  const result = ollamaMessagesFrom([msg]);
  assertEquals(result.length, 0);
});

Deno.test("ollamaUsageFrom maps token counts from a done response", () => {
  const usage = ollamaUsageFrom(
    {
      done: true,
      prompt_eval_count: 9,
      eval_count: 12,
    } as ChatResponse,
  );

  assertEquals(usage, { inputTokens: 9, outputTokens: 12, totalTokens: 21 });
});

Deno.test("ollamaUsageFrom returns undefined for intermediate chunks", () => {
  const usage = ollamaUsageFrom({ done: false } as ChatResponse);
  assertEquals(usage, undefined);
});

Deno.test("ollamaUsageFrom returns undefined when no counts are reported", () => {
  const usage = ollamaUsageFrom({ done: true } as ChatResponse);
  assertEquals(usage, undefined);
});
