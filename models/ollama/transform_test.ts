import { assertEquals } from "@std/assert";

import type { Message, ToolMessage } from "@/mod.ts";
import { tool } from "@/tools/mod.ts";
import { string } from "@huuma/validate";
import { ollamaMessagesFrom, ollamaToolsFrom } from "./mod.ts";

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
