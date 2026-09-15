import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { type JSONSchema, object, type Schema, string } from "@huuma/validate";
import type { Message, ToolMessage } from "@/mod.ts";
import { callTool, tool, toolOutput, Tools } from "./mod.ts";

function modelMessageCalling(name: string, id = "call-1"): Message {
  // deno-lint-ignore no-explicit-any
  const toolCall = { id, name, props: { target: "page" } as any };
  return { role: "model", contents: [{ toolCall }], toolCalls: [toolCall] };
}

function modelMessageCallingEach(count: number, name: string): Message {
  const toolCalls = Array.from({ length: count }, (_, i) => ({
    id: `call-${i + 1}`,
    name,
    // deno-lint-ignore no-explicit-any
    props: { target: String(i) } as any,
  }));
  return {
    role: "model",
    contents: toolCalls.map((toolCall) => ({ toolCall })),
    toolCalls,
  };
}

function toolResultIds(message: ToolMessage): string[] {
  return message.contents.map((content) => {
    if (!("toolResult" in content)) {
      throw new Error("expected a tool result content");
    }
    return content.toolResult.id;
  });
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

Deno.test("callTool bounds overlapping executions to maxConcurrency", async () => {
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  const slow = tool({
    name: "slow",
    description: "Record start and finish.",
    input: object({ target: string() }),
    fn: async ({ target }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${target}`);
      // Staggered delays keep every settle on its own tick, so start
      // order stays deterministic without racing equal timers.
      await new Promise((resolve) =>
        setTimeout(resolve, 20 + Number(target) * 10)
      );
      events.push(`finish:${target}`);
      active -= 1;
      return `done:${target}`;
    },
  });

  const messages = await callTool(new Tools([slow]), { maxConcurrency: 2 })([
    modelMessageCallingEach(5, "slow"),
  ]);

  assertEquals(maxActive, 2);
  assertEquals(events.filter((event) => event.startsWith("start:")), [
    "start:0",
    "start:1",
    "start:2",
    "start:3",
    "start:4",
  ]);
  assertEquals(events.filter((event) => event.startsWith("finish:")), [
    "finish:0",
    "finish:1",
    "finish:2",
    "finish:3",
    "finish:4",
  ]);
  assertEquals(toolResultIds(messages.at(-1) as ToolMessage), [
    "call-1",
    "call-2",
    "call-3",
    "call-4",
    "call-5",
  ]);
});

Deno.test("callTool starts every call before any settles by default", async () => {
  const events: string[] = [];
  const releasers: Array<(value: string) => void> = [];
  const gated = tool({
    name: "gated",
    description: "Run until released.",
    input: object({ target: string() }),
    fn: ({ target }) =>
      new Promise<string>((resolve) => {
        events.push(`start:${target}`);
        releasers.push((value) => resolve(`${value}:${target}`));
      }),
  });

  const pending = callTool(new Tools([gated]))([
    modelMessageCallingEach(5, "gated"),
  ]);
  // Yield one macrotask: the unbounded batch starts every call on
  // microtasks before any of them can settle.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(events, [
    "start:0",
    "start:1",
    "start:2",
    "start:3",
    "start:4",
  ]);
  assertEquals(releasers.length, 5);

  for (const release of releasers) release("done");
  const messages = await pending;

  const toolMessage = messages.at(-1) as ToolMessage;
  assertEquals(toolMessage.contents.map((content) => {
    if (!("toolResult" in content)) {
      throw new Error("expected a tool result content");
    }
    return content.toolResult.result.output;
  }), ["done:0", "done:1", "done:2", "done:3", "done:4"]);
});

Deno.test("callTool keeps success and error outcomes aligned per call under the cap", async () => {
  const flaky = tool({
    name: "flaky",
    description: "Fail odd targets.",
    input: object({ target: string() }),
    fn: async ({ target }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (Number(target) % 2 === 1) throw new Error(`boom:${target}`);
      return `ok:${target}`;
    },
  });

  const messages = await callTool(new Tools([flaky]), { maxConcurrency: 2 })(
    [modelMessageCallingEach(5, "flaky")],
  );

  const toolMessage = messages.at(-1) as ToolMessage;
  assertEquals(toolMessage.contents, [
    { toolResult: { id: "call-1", name: "flaky", result: { output: "ok:0" } } },
    { toolResult: { id: "call-2", name: "flaky", result: { error: "boom:1" } } },
    { toolResult: { id: "call-3", name: "flaky", result: { output: "ok:2" } } },
    { toolResult: { id: "call-4", name: "flaky", result: { error: "boom:3" } } },
    { toolResult: { id: "call-5", name: "flaky", result: { output: "ok:4" } } },
  ]);
});

Deno.test("callTool rejects invalid maxConcurrency values", () => {
  const invalid = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY];
  for (const maxConcurrency of invalid) {
    assertThrows(
      () => callTool(new Tools([]), { maxConcurrency }),
      TypeError,
      "maxConcurrency must be a positive integer",
    );
  }
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

Deno.test("tool memoizes its input's JSON Schema on first access", () => {
  const wrapped = object({ target: string() });
  let conversions = 0;
  const counting: Schema<unknown> = {
    infer: undefined,
    validate: (value, key) => wrapped.validate(value, key),
    jsonSchema(): JSONSchema {
      conversions += 1;
      return wrapped.jsonSchema();
    },
    isRequired: () => wrapped.isRequired(),
  };

  const memoized = tool({
    name: "memoized",
    description: "Memoize schema conversions.",
    input: counting,
    fn: () => "done",
  });

  const first = memoized.jsonSchema;
  const second = memoized.jsonSchema;
  assertEquals(conversions, 1);
  assertEquals(first === second, true);
  assertEquals(first, {
    type: "object",
    properties: { target: { type: "string" } },
    required: ["target"],
  });
});

Deno.test("tool freezes its cached JSON Schema against mutation", () => {
  const frozen = tool({
    name: "frozen",
    description: "Guard the shared schema.",
    input: object({ target: string() }),
    fn: () => "done",
  });

  const schema = frozen.jsonSchema;
  assertThrows(() => {
    (schema as { type?: string }).type = "number";
  }, TypeError);
  assertThrows(() => {
    const properties = schema.properties as Record<string, unknown>;
    (properties.target as { type?: string }).type = "number";
  }, TypeError);
  assertEquals(frozen.jsonSchema.type, "object");
  assertEquals(
    (frozen.jsonSchema.properties as Record<string, unknown>).target,
    { type: "string" },
  );
});