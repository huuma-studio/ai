import { assertEquals, assertInstanceOf, assertRejects } from "@std/assert";
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

Deno.test("tool passes a cancellation signal and timeout to its callback", async () => {
  const controlled = tool({
    name: "controlled",
    description: "Observe controls.",
    input: object({ target: string() }),
    timeout: 1_000,
    fn: (_, context) => context,
  });

  const context = await controlled.call({ target: "page" });
  assertEquals(context.signal instanceof AbortSignal, true);
  assertEquals(context.signal.aborted, false);
  assertEquals(
    context.timeout,
    1_000,
  );
});

Deno.test("tool uses the shortest configured or caller timeout", async () => {
  let receivedTimeout: number | undefined;
  const controlled = tool({
    name: "controlled",
    description: "Observe controls.",
    input: object({ target: string() }),
    timeout: 10_000,
    fn: (_, context) => {
      receivedTimeout = context.timeout;
      return "done";
    },
  });

  await controlled.call({ target: "page" }, { timeout: 50 });
  assertEquals(receivedTimeout, 50);
});

Deno.test("tool rejects and aborts its signal when its timeout expires", async () => {
  let receivedSignal: AbortSignal | undefined;
  const hanging = tool({
    name: "hanging",
    description: "Never finishes.",
    input: object({ target: string() }),
    timeout: 5,
    fn: (_, context) => {
      receivedSignal = context.signal;
      return new Promise<string>(() => {});
    },
  });

  await assertRejects(
    () => hanging.call({ target: "page" }),
    DOMException,
    "The operation was aborted due to timeout",
  );
  assertEquals(receivedSignal?.aborted, true);
});

Deno.test("callTool forwards cancellation and returns an error result", async () => {
  const controller = new AbortController();
  const waiting = tool({
    name: "waiting",
    description: "Wait for cancellation.",
    input: object({ target: string() }),
    fn: (_, context) =>
      new Promise<string>((_, reject) => {
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
          { once: true },
        );
      }),
  });

  const pending = callTool(new Tools([waiting]), {
    signal: controller.signal,
  })([modelMessageCalling("waiting")]);
  controller.abort(new Error("run cancelled"));

  const messages = await pending;
  const toolMessage = messages.at(-1) as ToolMessage;
  const result = toolMessage.contents[0];
  if (!("toolResult" in result)) throw new Error("Expected a tool result");
  assertEquals(
    result.toolResult.result.error,
    "run cancelled",
  );
});

Deno.test("tool rejects invalid timeout configuration", () => {
  for (const timeout of [-1, Number.POSITIVE_INFINITY, Number.NaN]) {
    try {
      tool({
        name: "invalid",
        description: "Invalid timeout.",
        input: object({ target: string() }),
        timeout,
        fn: () => "never",
      });
      throw new Error("Expected constructor to reject invalid timeout");
    } catch (error) {
      assertInstanceOf(error, TypeError);
    }
  }
});

Deno.test("tool rejects a zero timeout before invoking its callback", async () => {
  let invoked = false;
  const controlled = tool({
    name: "controlled",
    description: "Must not run.",
    input: object({ target: string() }),
    fn: () => {
      invoked = true;
      return "done";
    },
  });

  await assertRejects(
    () => controlled.call({ target: "page" }, { timeout: 0 }),
    DOMException,
    "The tool operation timed out",
  );
  assertEquals(invoked, false);
});
