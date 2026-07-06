import { assertEquals } from "@std/assert";
import { object, string } from "@huuma/validate";
import type { Message, ToolMessage } from "@/mod.ts";
import { callTool, tool, toolOutput, Tools } from "./mod.ts";

function modelMessageCalling(name: string, id = "call-1"): Message {
  // deno-lint-ignore no-explicit-any
  const toolCall = { id, name, props: { target: "page" } as any };
  return { role: "model", contents: [{ toolCall }], toolCalls: [toolCall] };
}

Deno.test("callTool unwraps toolOutput into result output and files", async () => {
  const screenshot = tool({
    name: "screenshot",
    description: "Take a screenshot.",
    input: object({ target: string() }),
    fn: () =>
      toolOutput("captured", [
        { file: { mimeType: "image/png", data: "aGVsbG8=" } },
      ]),
  });

  const messages = await callTool(new Tools([screenshot]))([
    modelMessageCalling("screenshot"),
  ]);

  const toolMessage = messages.at(-1) as ToolMessage;
  assertEquals(toolMessage.contents, [{
    toolResult: {
      id: "call-1",
      name: "screenshot",
      result: { output: "captured" },
      files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
    },
  }]);
});

Deno.test("callTool keeps plain returns unchanged without files", async () => {
  const lookup = tool({
    name: "lookup",
    description: "Look something up.",
    input: object({ target: string() }),
    fn: () => "found",
  });

  const messages = await callTool(new Tools([lookup]))([
    modelMessageCalling("lookup"),
  ]);

  const toolMessage = messages.at(-1) as ToolMessage;
  assertEquals(toolMessage.contents, [{
    toolResult: {
      id: "call-1",
      name: "lookup",
      result: { output: "found" },
    },
  }]);
});

Deno.test("callTool does not unwrap plain objects with output and files keys", async () => {
  const data = {
    output: "captured",
    files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
  };
  const lookup = tool({
    name: "lookup",
    description: "Look something up.",
    input: object({ target: string() }),
    fn: () => data,
  });

  const messages = await callTool(new Tools([lookup]))([
    modelMessageCalling("lookup"),
  ]);

  const toolMessage = messages.at(-1) as ToolMessage;
  assertEquals(toolMessage.contents, [{
    toolResult: {
      id: "call-1",
      name: "lookup",
      result: { output: data },
    },
  }]);
});

Deno.test("callTool maps rejections to error results without files", async () => {
  const failing = tool({
    name: "failing",
    description: "Always fails.",
    input: object({ target: string() }),
    fn: () => {
      throw new Error("boom");
    },
  });

  const messages = await callTool(new Tools([failing]))([
    modelMessageCalling("failing"),
  ]);

  const toolMessage = messages.at(-1) as ToolMessage;
  assertEquals(toolMessage.contents, [{
    toolResult: {
      id: "call-1",
      name: "failing",
      result: { error: "boom" },
    },
  }]);
});
