import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { type JSONSchema, object, type Schema, string } from "@huuma/validate";
import type { Message, ToolMessage } from "@/mod.ts";
import {
  callTool,
  DEFAULT_CLI_TIMEOUT,
  tool,
  toolOutput,
  Tools,
} from "./mod.ts";
import { toolCallResourceSnapshot } from "./tool_call_resources.ts";

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

// Sustained-load shape for the Tool.call memory regression tests
// (spec 61): batches of quick calls that each arm a long deadline, with
// a forced full GC between batches.
const SUSTAINED_BATCHES = 10;
const SUSTAINED_CALLS_PER_BATCH = 1_000;
// Calibrated against the pre-fix machinery: it retained ~2 KiB per
// completed call (~2 MiB per 1 000-call batch), while the fixed path
// stays within ~20 KiB of GC noise between batch medians. The 1 MiB
// bounds sit far from both behaviors.
const ALLOWED_HEAP_GROWTH = 1_048_576;
const REQUIRED_LEGACY_GROWTH = 1_048_576;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Medians of the first and last steady-state batch windows. The opening
 * batches absorb one-time warmup (JIT compilation, lazy runtime state)
 * and are discarded; retention reads as growth between the windows.
 */
function steadyStateMedians(
  samples: number[],
): { early: number; late: number } {
  const steady = samples.slice(3);
  if (steady.length < 6) {
    throw new Error("steadyStateMedians needs at least 9 batches");
  }
  return {
    early: median(steady.slice(0, 3)),
    late: median(steady.slice(-3)),
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(2)} MiB`;
}

/**
 * Runs awaited calls in batches, forcing a full GC after each batch and
 * recording `Deno.memoryUsage().heapUsed`. Forced GC needs the V8 hook
 * supplied by the test task's `--v8-flags=--expose-gc`.
 */
async function sustainedHeapUsed(
  batches: number,
  callsPerBatch: number,
  call: () => Promise<unknown>,
): Promise<number[]> {
  const forceGc = (globalThis as { gc?: () => void }).gc;
  if (!forceGc) {
    throw new Error(
      "forced GC is unavailable; run the suite with " +
        "`--v8-flags=--expose-gc` (the `deno task test` default)",
    );
  }
  const samples: number[] = [];
  for (let batch = 0; batch < batches; batch += 1) {
    for (let index = 0; index < callsPerBatch; index += 1) {
      await call();
    }
    // Drain pending microtasks and queued timer callbacks so the sample
    // reflects live objects only.
    await new Promise((resolve) => setTimeout(resolve, 0));
    forceGc();
    samples.push(Deno.memoryUsage().heapUsed);
  }
  return samples;
}

/**
 * The pre-fix `Tool.call` deadline machinery: `AbortSignal.timeout` arms
 * an un-cancellable timer, its signal feeds an `AbortSignal.any`
 * composite, and the abort listener behind the pending `aborted`
 * promise is never removed. Completed calls leave the whole island
 * rooted until the deadline fires — the retention spec 61 fixed.
 */
function preFixDeadlineCall(
  fn: () => string,
  timeout: number,
): Promise<string> {
  const signal = AbortSignal.any([AbortSignal.timeout(timeout)]);
  const aborted = new Promise<never>((_, reject) => {
    const rejectOnAbort = () => reject(signal.reason);
    if (signal.aborted) rejectOnAbort();
    else signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  const execution = Promise.resolve().then(fn);
  return Promise.race([execution, aborted]);
}

/**
 * The comparison test is opt-in: it arms ten thousand real 120 s
 * deadline timers and asserts visible growth, so it stays out of the
 * default suite. `querySync` needs no permission, so runs without
 * `--allow-env` skip it instead of failing to load.
 */
function legacyComparisonRequested(): boolean {
  const status = Deno.permissions.querySync({
    name: "env",
    variable: "HUUMA_TOOL_MEMORY_LEGACY",
  });
  return status.state === "granted" &&
    Deno.env.get("HUUMA_TOOL_MEMORY_LEGACY") === "1";
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

Deno.test("tool releases deadline resources when calls settle", async () => {
  const quick = tool({
    name: "quick",
    description: "Finishes immediately.",
    input: object({ target: string() }),
    timeout: 120_000,
    fn: () => "done",
  });
  const failing = tool({
    name: "failing",
    description: "Rejects immediately.",
    input: object({ target: string() }),
    timeout: 120_000,
    fn: () => {
      throw new Error("boom");
    },
  });
  const before = toolCallResourceSnapshot();

  for (let index = 0; index < 1_000; index += 1) {
    await quick.call({ target: "page" });
  }
  await assertRejects(() => failing.call({ target: "page" }), Error, "boom");

  const after = toolCallResourceSnapshot();
  assertEquals(after.armedTimeouts - before.armedTimeouts, 1_001);
  assertEquals(after.clearedTimeouts - before.clearedTimeouts, 1_001);
  assertEquals(after.addedAbortListeners - before.addedAbortListeners, 1_001);
  assertEquals(
    after.removedAbortListeners - before.removedAbortListeners,
    1_001,
  );
  assertEquals(after.activeTimeouts, before.activeTimeouts);
  assertEquals(after.activeAbortListeners, before.activeAbortListeners);
});

Deno.test("tool rejects and aborts its signal when its timeout expires", async () => {
  let receivedSignal: AbortSignal | undefined;
  const before = toolCallResourceSnapshot();
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
  const after = toolCallResourceSnapshot();
  assertEquals(after.armedTimeouts - before.armedTimeouts, 1);
  assertEquals(after.clearedTimeouts - before.clearedTimeouts, 1);
  assertEquals(after.addedAbortListeners - before.addedAbortListeners, 1);
  assertEquals(after.removedAbortListeners - before.removedAbortListeners, 1);
  assertEquals(after.activeTimeouts, before.activeTimeouts);
  assertEquals(after.activeAbortListeners, before.activeAbortListeners);
});

Deno.test("tool sustained load keeps heap flat between forced GCs", async () => {
  const quick = tool({
    name: "sustained",
    description: "Finishes immediately.",
    input: object({ target: string() }),
    // Mirrors the bundled cli default: short calls that each arm a long
    // deadline — the exact leak scenario from spec 61.
    timeout: DEFAULT_CLI_TIMEOUT,
    fn: () => "done",
  });

  const samples = await sustainedHeapUsed(
    SUSTAINED_BATCHES,
    SUSTAINED_CALLS_PER_BATCH,
    () => quick.call({ target: "page" }),
  );
  const { early, late } = steadyStateMedians(samples);
  const growth = late - early;
  assert(
    growth <= ALLOWED_HEAP_GROWTH,
    `sustained calls grew the heap between batch medians ` +
      `(${formatBytes(early)} -> ${formatBytes(late)}, +${formatBytes(growth)}): ` +
      `deadline timers or abort listeners are retained past call completion`,
  );
});

Deno.test({
  name:
    "pre-fix deadline machinery retains heap under sustained load (comparison)",
  // Comparison run for the flat-heap test above; documents the growth
  // the cleanup fix removed. Reproduce on demand with:
  //   HUUMA_TOOL_MEMORY_LEGACY=1 deno task test src/tools/mod.test.ts
  ignore: !legacyComparisonRequested(),
  async fn() {
    const samples = await sustainedHeapUsed(
      SUSTAINED_BATCHES,
      SUSTAINED_CALLS_PER_BATCH,
      () => preFixDeadlineCall(() => "done", DEFAULT_CLI_TIMEOUT),
    );
    const { early, late } = steadyStateMedians(samples);
    const growth = late - early;
    assert(
      growth >= REQUIRED_LEGACY_GROWTH,
      `expected pre-fix retention growth between batch medians ` +
        `(${formatBytes(early)} -> ${formatBytes(late)}, +${formatBytes(growth)}): ` +
        `the comparison no longer shows the original leak and needs recalibrating`,
    );
  },
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
