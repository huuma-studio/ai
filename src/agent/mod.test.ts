import { assertEquals, assertRejects, assertStrictEquals, assertThrows } from "@std/assert";
import { agent, DEFAULT_MAX_MODEL_CALLS, FINISH_TURN_TOOL } from "@/agent/mod.ts";
import type {
  BaseModel,
  JSONSchema,
  Message,
  ModelResult,
  ModelUsage,
  ToolMessage,
  ToolResultContent,
} from "@/agent/mod.ts";
import { tool } from "@/tools/mod.ts";
import { object, string } from "@huuma/validate";

type ScriptedResponse =
  | Message[]
  | { messages: Message[]; usage?: ModelUsage };

class StubModel implements BaseModel<string> {
  calls: { messages: Message[]; system?: string }[] = [];
  #responses: ScriptedResponse[];

  constructor(responses: ScriptedResponse[]) {
    this.#responses = responses;
  }

  generate(args: unknown): Promise<ModelResult<string>> {
    const { messages, system } = args as {
      messages: Message[];
      system?: string;
    };
    this.calls.push({ messages, system });

    const response = this.#responses.shift();
    if (!response) {
      return Promise.reject(new Error("No scripted response left"));
    }
    const { messages: messagesToReturn, usage } = Array.isArray(response)
      ? { messages: response, usage: undefined }
      : response;
    return Promise.resolve({
      modelId: "stub",
      messages: messagesToReturn,
      ...(usage ? { usage } : {}),
    });
  }

  stream(): Promise<AsyncGenerator<ModelResult>> {
    return Promise.reject(new Error("Not implemented"));
  }
}

function modelMessage(text: string): Message {
  return { role: "model", contents: [{ text }], toolCalls: [] };
}

Deno.test("agent - run sends the prompt and returns the conversation", async () => {
  const model = new StubModel([[modelMessage("Hello!")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
  });

  const messages = await assistant.run("Hi");

  assertEquals(messages, [
    { role: "user", contents: "Hi" },
    modelMessage("Hello!"),
  ]);
  assertEquals(model.calls[0].system, "Be helpful.");
  assertEquals(model.calls[0].messages, [{ role: "user", contents: "Hi" }]);
});

Deno.test("agent - run passes text and file prompt parts through verbatim", async () => {
  const model = new StubModel([[modelMessage("A cat.")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
  });

  const prompt = [
    { text: "What is in this image?" },
    { file: { mimeType: "image/png", data: "aGVsbG8=" } },
  ];
  const messages = await assistant.run(prompt);

  assertEquals(model.calls[0].messages, [
    { role: "user", contents: prompt },
  ]);
  assertEquals(messages, [
    { role: "user", contents: prompt },
    modelMessage("A cat."),
  ]);
});

Deno.test("agent - run continues from prior history", async () => {
  const history: Message[] = [
    { role: "user", contents: "What is Deno?" },
    modelMessage("A JavaScript runtime."),
  ];
  const model = new StubModel([[modelMessage("Ryan Dahl.")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
  });

  const messages = await assistant.run("Who created it?", history);

  assertEquals(model.calls[0].messages, [
    ...history,
    { role: "user", contents: "Who created it?" },
  ]);
  assertEquals(messages, [
    ...history,
    { role: "user", contents: "Who created it?" },
    modelMessage("Ryan Dahl."),
  ]);
});

Deno.test("agent - run executes tool calls and feeds results back", async () => {
  const toolCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const model = new StubModel([
    [{
      role: "model",
      contents: [{ toolCall }],
      toolCalls: [toolCall],
    }],
    [modelMessage("Greeted Huuma.")],
  ]);

  const greetedWith: string[] = [];
  const greet = tool({
    name: "greet",
    description: "Greet someone by name.",
    input: object({ name: string() }),
    fn: ({ name }) => {
      greetedWith.push(name);
      return `Hello, ${name}!`;
    },
  });

  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [greet],
  });

  const messages = await assistant.run("Greet Huuma");

  assertEquals(greetedWith, ["Huuma"]);

  const toolMessage = messages.at(-2);
  assertEquals(toolMessage?.role, "tool");
  assertEquals(messages.at(-1), modelMessage("Greeted Huuma."));

  // the second model call sees the tool result
  assertEquals(model.calls.length, 2);
  assertEquals(model.calls[1].messages.at(-1)?.role, "tool");
});

Deno.test("agent - onMessage receives each emitted message in order", async () => {
  const toolCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const model = new StubModel([
    [{
      role: "model",
      contents: [{ toolCall }],
      toolCalls: [toolCall],
    }],
    [modelMessage("Greeted Huuma.")],
  ]);

  const greet = tool({
    name: "greet",
    description: "Greet someone by name.",
    input: object({ name: string() }),
    fn: ({ name }) => `Hello, ${name}!`,
  });

  const emitted: Message[] = [];
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [greet],
    onMessage: async (message) => {
      await Promise.resolve();
      emitted.push(message);
    },
  });

  const messages = await assistant.run("Greet Huuma");

  assertEquals(emitted, messages);
  assertEquals(emitted.map((message) => message.role), [
    "user",
    "model",
    "tool",
    "model",
  ]);
});

Deno.test("agent - onMessage does not receive prior history", async () => {
  const history: Message[] = [
    { role: "user", contents: "What is Deno?" },
    modelMessage("A JavaScript runtime."),
  ];
  const model = new StubModel([[modelMessage("Ryan Dahl.")]]);

  const emitted: Message[] = [];
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    onMessage: (message) => {
      emitted.push(message);
    },
  });

  await assistant.run("Who created it?", history);

  assertEquals(emitted, [
    { role: "user", contents: "Who created it?" },
    modelMessage("Ryan Dahl."),
  ]);
});

Deno.test("agent - per-run onMessage overrides the agent-level callback", async () => {
  const model = new StubModel([[modelMessage("Hello!")]]);

  const agentLevel: Message[] = [];
  const runLevel: Message[] = [];
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    onMessage: (message) => {
      agentLevel.push(message);
    },
  });

  const messages = await assistant.run("Hi", [], {
    onMessage: (message) => {
      runLevel.push(message);
    },
  });

  assertEquals(agentLevel, []);
  assertEquals(runLevel, messages);
});

Deno.test("agent - per-run onMessage attributes messages of concurrent runs", async () => {
  const model = new StubModel([
    [modelMessage("First answer.")],
    [modelMessage("Second answer.")],
  ]);

  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
  });

  const emittedA: Message[] = [];
  const emittedB: Message[] = [];
  const [messagesA, messagesB] = await Promise.all([
    assistant.run("First?", [], {
      onMessage: (message) => {
        emittedA.push(message);
      },
    }),
    assistant.run("Second?", [], {
      onMessage: (message) => {
        emittedB.push(message);
      },
    }),
  ]);

  assertEquals(emittedA, messagesA);
  assertEquals(emittedB, messagesB);
});

Deno.test("agent - onMessage errors warn but do not abort the run", async () => {
  const model = new StubModel([[modelMessage("Hello!")]]);

  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    onMessage: () => {
      throw new Error("consumer failure");
    },
  });

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const messages = await assistant.run("Hi");

    assertEquals(messages, [
      { role: "user", contents: "Hi" },
      modelMessage("Hello!"),
    ]);
    // one warning per emitted message (user + model)
    assertEquals(warnings.length, 2);
    assertEquals(warnings[0][0], "[Huuma Agent] onMessage callback failed:");
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("agent - onMessage receives accumulated usage across model calls", async () => {
  const toolCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const model = new StubModel([
    {
      messages: [{
        role: "model",
        contents: [{ toolCall }],
        toolCalls: [toolCall],
      }],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
    {
      messages: [modelMessage("Greeted Huuma.")],
      usage: { inputTokens: 20, outputTokens: 7, totalTokens: 27 },
    },
  ]);

  const greet = tool({
    name: "greet",
    description: "Greet someone by name.",
    input: object({ name: string() }),
    fn: ({ name }) => `Hello, ${name}!`,
  });

  const reported: (ModelUsage | undefined)[] = [];
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [greet],
    onMessage: (_message, usage) => {
      reported.push(usage);
    },
  });

  await assistant.run("Greet Huuma");

  // Each message carries the run total at the time it is emitted: the
  // user prompt precedes any model call, the first model message and
  // the tool result reflect the first call, and the final model
  // message covers the whole run.
  assertEquals(reported, [
    undefined,
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
  ]);
});

Deno.test("agent - onMessage usage stays undefined without model usage", async () => {
  const model = new StubModel([[modelMessage("Hello!")]]);

  const reported: (ModelUsage | undefined)[] = [];
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    onMessage: (_message, usage) => {
      reported.push(usage);
    },
  });

  await assistant.run("Hi");

  assertEquals(reported, [undefined, undefined]);
});

Deno.test("agent - onMessage usage stays undefined for empty usage objects", async () => {
  const model = new StubModel([
    { messages: [modelMessage("Hello!")], usage: {} },
  ]);

  const reported: (ModelUsage | undefined)[] = [];
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    onMessage: (_message, usage) => {
      reported.push(usage);
    },
  });

  await assistant.run("Hi");

  assertEquals(reported, [undefined, undefined]);
});

Deno.test("agent - onMessage usage snapshots are mutation-safe", async () => {
  const toolCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const model = new StubModel([
    {
      messages: [{
        role: "model",
        contents: [{ toolCall }],
        toolCalls: [toolCall],
      }],
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    },
    {
      messages: [modelMessage("Greeted Huuma.")],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ]);

  const greet = tool({
    name: "greet",
    description: "Greet someone by name.",
    input: object({ name: string() }),
    fn: ({ name }) => `Hello, ${name}!`,
  });

  const totals: (number | undefined)[] = [];
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [greet],
  });

  await assistant.run("Greet Huuma", [], {
    onMessage: (_message, usage) => {
      totals.push(usage?.totalTokens);
      if (usage) {
        // Mutating the snapshot must not corrupt the run's accumulator.
        usage.totalTokens = 0;
      }
    },
  });

  assertEquals(totals, [undefined, 7, 7, 9]);
});

Deno.test("agent - run surfaces model errors", async () => {
  const model = new StubModel([]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
  });

  await assertRejects(
    () => assistant.run("Hi"),
    Error,
    "No scripted response left",
  );
});

// --- finish_turn helpers -------------------------------------------------

function finishTurnCall(
  id: string,
  outcome: string,
  message: string,
): { toolCall: { id: string; name: string; props: JSONSchema } } {
  return {
    toolCall: {
      id,
      name: FINISH_TURN_TOOL,
      props: { outcome, message } as unknown as JSONSchema,
    },
  };
}

function finishTurnModelMessage(
  ...calls: ReturnType<typeof finishTurnCall>[]
): Message {
  const toolCalls = calls.map((c) => c.toolCall);
  return {
    role: "model",
    contents: calls,
    toolCalls,
  };
}

function toolMessageOf(
  ...results: { id: string; name: string; result: { output?: unknown; error?: unknown } }[]
): Message {
  return {
    role: "tool",
    contents: results.map((r) => ({ toolResult: r })),
  } as Message;
}

function resultOf(message: Message | undefined, index = 0): ToolResultContent {
  if (!message || message.role !== "tool") {
    throw new Error("expected a tool message");
  }
  const content = message.contents[index];
  if (!content || !("toolResult" in content)) {
    throw new Error("expected a tool result content");
  }
  return content as ToolResultContent;
}

// --- onMessageError policy ----------------------------------------------

Deno.test("agent - onMessageError 'throw' rejects on prompt delivery and skips the model", async () => {
  const model = new StubModel([[modelMessage("Hi")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    onMessage: () => {
      throw new Error("consumer failure");
    },
    onMessageError: "throw",
  });

  await assertRejects(
    () => assistant.run("Hi"),
    Error,
    "consumer failure",
  );
  assertEquals(model.calls.length, 0);
});

Deno.test("agent - onMessageError 'throw' rejects on model delivery and skips tool calls", async () => {
  const toolCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const model = new StubModel([
    [{ role: "model", contents: [{ toolCall }], toolCalls: [toolCall] }],
    [modelMessage("Greeted Huuma.")],
  ]);
  const greetedWith: string[] = [];
  const greet = tool({
    name: "greet",
    description: "Greet.",
    input: object({ name: string() }),
    fn: ({ name }) => {
      greetedWith.push(name);
      return `Hello, ${name}!`;
    },
  });

  let calls = 0;
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [greet],
    onMessage: () => {
      calls += 1;
      if (calls === 2) throw new Error("consumer failure");
    },
    onMessageError: "throw",
  });

  await assertRejects(
    () => assistant.run("Greet Huuma"),
    Error,
    "consumer failure",
  );
  // prompt was emitted, model message delivery threw, tool never ran
  assertEquals(calls, 2);
  assertEquals(greetedWith, []);
});

Deno.test("agent - onMessageError 'throw' rejects on tool-result delivery and skips the next model request", async () => {
  const toolCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const model = new StubModel([
    [{ role: "model", contents: [{ toolCall }], toolCalls: [toolCall] }],
    [modelMessage("Greeted Huuma.")],
  ]);
  const greet = tool({
    name: "greet",
    description: "Greet.",
    input: object({ name: string() }),
    fn: ({ name }) => `Hello, ${name}!`,
  });

  let calls = 0;
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [greet],
    onMessage: () => {
      calls += 1;
      if (calls === 3) throw new Error("consumer failure");
    },
    onMessageError: "throw",
  });

  await assertRejects(
    () => assistant.run("Greet Huuma"),
    Error,
    "consumer failure",
  );
  // prompt + model message + tool result emitted; tool ran; second model call never made
  assertEquals(calls, 3);
  assertEquals(model.calls.length, 1);
});

Deno.test("agent - per-run onMessageError overrides the agent-level policy", async () => {
  const model = new StubModel([[modelMessage("Hi")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    onMessage: () => {
      throw new Error("consumer failure");
    },
    onMessageError: "throw",
  });

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const messages = await assistant.run("Hi", [], { onMessageError: "warn" });
    assertEquals(messages, [
      { role: "user", contents: "Hi" },
      modelMessage("Hi"),
    ]);
    assertEquals(warnings.length, 2);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("agent - onMessageError defaults to 'warn' when unset at both levels", async () => {
  const model = new StubModel([[modelMessage("Hi")]]);
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const assistant = agent({
      model,
      modelId: "stub",
      systemPrompt: "Be helpful.",
      onMessage: () => {
        throw new Error("consumer failure");
      },
    });
    await assistant.run("Hi");
    assertEquals(warnings.length, 2);
  } finally {
    console.warn = originalWarn;
  }
});

// --- finish_turn enablement --------------------------------------------

Deno.test("agent - finish_turn tool is absent by default", async () => {
  const seen: string[] = [];
  const model = new StubModel([[modelMessage("Hi")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [],
  });
  // Wrap the model to capture the tools list without breaking the run.
  const originalGenerate = model.generate.bind(model);
  model.generate = (args: unknown) => {
    const { tools } = args as { tools?: { name: string }[] };
    seen.push(...(tools ?? []).map((t) => t.name));
    return originalGenerate(args);
  };

  await assistant.run("Hi");
  assertEquals(seen, []);
});

Deno.test("agent - finish_turn tool is present when opted in", async () => {
  const seen: string[] = [];
  const model = new StubModel([[modelMessage("Hi")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    finishTurn: true,
  });
  const originalGenerate = model.generate.bind(model);
  model.generate = (args: unknown) => {
    const { tools } = args as { tools?: { name: string }[] };
    seen.push(...(tools ?? []).map((t) => t.name));
    return originalGenerate(args);
  };

  await assistant.run("Hi");
  assertEquals(seen, [FINISH_TURN_TOOL]);
});

Deno.test("agent - consumer tool named finish_turn fails construction", () => {
  const model = new StubModel([]);
  const conflicting = tool({
    name: FINISH_TURN_TOOL,
    description: "mine",
    input: object({}),
    fn: () => "ok",
  });

  assertThrows(
    () =>
      agent({
        model,
        modelId: "stub",
        systemPrompt: "Be helpful.",
        tools: [conflicting],
      }),
    Error,
    FINISH_TURN_TOOL,
  );
});

// --- finish_turn successful termination ---------------------------------

Deno.test("agent - a valid finish_turn emits model + tool messages and stops the run", async () => {
  const model = new StubModel([
    [finishTurnModelMessage(
      finishTurnCall("call-1", "question", "Which database should I use?"),
    )],
  ]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    finishTurn: true,
  });

  const emitted: Message[] = [];
  const messages = await assistant.run("Hi", [], {
    onMessage: (m) => {
      emitted.push(m);
    },
  });

  assertEquals(emitted.map((m) => m.role), ["user", "model", "tool"]);
  const toolMessage = messages.at(-1) as ToolMessage;
  assertEquals(toolMessage.contents, [{
    toolResult: {
      id: "call-1",
      name: FINISH_TURN_TOOL,
      result: {
        output: {
          outcome: "question",
          message: "Which database should I use?",
        },
      },
    },
  }]);
  // Only one model request was made; no follow-up after the tool result.
  assertEquals(model.calls.length, 1);
});

Deno.test("agent - finish_turn message is preserved verbatim, not trimmed", async () => {
  const model = new StubModel([
    [finishTurnModelMessage(
      finishTurnCall("call-1", "completion", "  done  \n"),
    )],
  ]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    finishTurn: true,
  });

  const messages = await assistant.run("Hi");
  const toolMessage = messages.at(-1) as ToolMessage;
  assertEquals(resultOf(toolMessage, 0).toolResult.result.output, {
    outcome: "completion",
    message: "  done  \n",
  });
});

Deno.test("agent - finish_turn remains terminal when a sibling tool fails", async () => {
  const boomCall = {
    id: "call-1",
    name: "boom",
    props: {} as unknown as JSONSchema,
  };
  const finishCall = finishTurnCall("call-2", "completion", "Done.");
  const model = new StubModel([
    [{
      role: "model",
      contents: [{ toolCall: boomCall }, finishCall],
      toolCalls: [boomCall, finishCall.toolCall],
    }],
  ]);
  const boom = tool({
    name: "boom",
    description: "Always fails.",
    input: object({}),
    fn: () => {
      throw new Error("boom");
    },
  });
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [boom],
    finishTurn: true,
  });

  const messages = await assistant.run("Hi");
  const toolMessage = messages.at(-1) as ToolMessage;
  assertEquals(toolMessage.contents.length, 2);
  // Both calls received a result.
  assertEquals(resultOf(toolMessage, 0).toolResult.result.error, "boom");
  assertEquals(resultOf(toolMessage, 1).toolResult.result.output, {
    outcome: "completion",
    message: "Done.",
  });
  // The run stopped after the tool result despite the sibling failure.
  assertEquals(model.calls.length, 1);
});

Deno.test("agent - finish_turn beside a successful sibling tool still stops", async () => {
  const greetCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const finishCall = finishTurnCall("call-2", "completion", "Done.");
  const model = new StubModel([
    [{
      role: "model",
      contents: [{ toolCall: greetCall }, finishCall],
      toolCalls: [greetCall, finishCall.toolCall],
    }],
  ]);
  const greetedWith: string[] = [];
  const greet = tool({
    name: "greet",
    description: "Greet.",
    input: object({ name: string() }),
    fn: ({ name }) => {
      greetedWith.push(name);
      return `Hello, ${name}!`;
    },
  });
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [greet],
    finishTurn: true,
  });

  await assistant.run("Hi");
  assertEquals(greetedWith, ["Huuma"]);
  assertEquals(model.calls.length, 1);
});

// --- finish_turn invalid and duplicate calls ----------------------------

Deno.test("agent - invalid finish_turn outcome yields an error result and a retry opportunity", async () => {
  const model = new StubModel([
    [finishTurnModelMessage(
      finishTurnCall("call-1", "wip", "huh?"),
    )],
    [modelMessage("Recovered.")],
  ]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    finishTurn: true,
  });

  const messages = await assistant.run("Hi");
  const firstTool = messages.at(-2) as ToolMessage;
  assertEquals(resultOf(firstTool, 0).toolResult.name, FINISH_TURN_TOOL);
  assertEquals(
    typeof resultOf(firstTool, 0).toolResult.result.error,
    "string",
  );
  // The run did not stop — a second model request was made.
  assertEquals(model.calls.length, 2);
  assertEquals(messages.at(-1), modelMessage("Recovered."));
});

Deno.test("agent - blank finish_turn message yields an error result and a retry opportunity", async () => {
  const model = new StubModel([
    [finishTurnModelMessage(
      finishTurnCall("call-1", "question", "   \n\t "),
    )],
    [modelMessage("Recovered.")],
  ]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    finishTurn: true,
  });

  const messages = await assistant.run("Hi");
  const firstTool = messages.at(-2) as ToolMessage;
  assertEquals(
    resultOf(firstTool, 0).toolResult.result.error,
    "finish_turn message must contain at least one non-whitespace character",
  );
  assertEquals(model.calls.length, 2);
});

Deno.test("agent - duplicate finish_turn calls each receive a deterministic error and the run continues", async () => {
  const model = new StubModel([
    [finishTurnModelMessage(
      finishTurnCall("call-1", "question", "A?"),
      finishTurnCall("call-2", "completion", "B."),
    )],
    [modelMessage("Recovered.")],
  ]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    finishTurn: true,
  });

  const messages = await assistant.run("Hi");
  const firstTool = messages.at(-2) as ToolMessage;
  assertEquals(firstTool.contents.length, 2);
  assertEquals(
    resultOf(firstTool, 0).toolResult.result.error,
    resultOf(firstTool, 1).toolResult.result.error,
  );
  assertEquals(
    resultOf(firstTool, 0).toolResult.result.error,
    "Issue exactly one finish_turn call per turn; multiple finish_turn calls in a single response are not allowed.",
  );
  // Non-terminal: the model gets another request.
  assertEquals(model.calls.length, 2);
});

// --- history continuation with finish_turn ------------------------------

Deno.test("agent - history ending in a successful finish_turn result can be continued without a dangling tool call", async () => {
  const priorTool: Message = toolMessageOf({
    id: "call-1",
    name: FINISH_TURN_TOOL,
    result: {
      output: { outcome: "question", message: "Which database?" },
    },
  });
  const history: Message[] = [
    { role: "user", contents: "Set up a DB." },
    finishTurnModelMessage(
      finishTurnCall("call-1", "question", "Which database?"),
    ),
    priorTool,
  ];
  const model = new StubModel([[modelMessage("Got it.")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    finishTurn: true,
  });

  const emitted: Message[] = [];
  const messages = await assistant.run("Postgres.", history, {
    onMessage: (m) => {
      emitted.push(m);
    },
  });

  // History is not re-emitted; only the new prompt and the new reply.
  assertEquals(emitted, [
    { role: "user", contents: "Postgres." },
    modelMessage("Got it."),
  ]);
  assertEquals(model.calls[0].messages, [
    ...history,
    { role: "user", contents: "Postgres." },
  ]);
  // No tool calls were re-executed; the returned history has no new tool message.
  assertEquals(messages, [...history, {
    role: "user",
    contents: "Postgres.",
  }, modelMessage("Got it.")]);
});

Deno.test("agent - a run ending without finish_turn returns normally with no successful finish result", async () => {
  const model = new StubModel([[modelMessage("Hi there.")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    finishTurn: true,
  });

  const messages = await assistant.run("Hi");
  const last = messages.at(-1);
  assertEquals(last?.role, "model");
  // No tool message at all — the absence of a successful finish result is
  // how callers detect the non-terminal outcome.
  assertEquals(messages.some((m) => m.role === "tool"), false);
});

// --- unknown fields round-trip ------------------------------------------

Deno.test("agent - unknown fields on prior messages survive unchanged in the returned history", async () => {
  const history: Message[] = [
    {
      role: "user",
      contents: "Hi",
      // deno-lint-ignore no-explicit-any
      unknownFuture: { foo: 1 } as any,
    } as Message,
    modelMessage("Hello."),
  ];
  const model = new StubModel([[modelMessage("Hi again.")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
  });

  const messages = await assistant.run("Bye", history);

  assertEquals(
    // deno-lint-ignore no-explicit-any
    (messages[0] as any).unknownFuture,
    { foo: 1 },
  );
});

// --- maxConcurrency ------------------------------------------------------

function slowCallsMessage(count: number): Message {
  const toolCalls = Array.from({ length: count }, (_, i) => ({
    id: `call-${i + 1}`,
    name: "slow",
    props: { target: String(i) } as unknown as JSONSchema,
  }));
  return {
    role: "model",
    contents: toolCalls.map((toolCall) => ({ toolCall })),
    toolCalls,
  };
}

function outputsOf(message: Message): unknown[] {
  if (message.role !== "tool") throw new Error("expected a tool message");
  return message.contents.map((content) => {
    if (!("toolResult" in content)) {
      throw new Error("expected a tool result content");
    }
    return content.toolResult.result.output;
  });
}

Deno.test("agent - maxConcurrency bounds overlapping tool executions", async () => {
  const model = new StubModel([
    [slowCallsMessage(5)],
    [modelMessage("All done.")],
  ]);
  let active = 0;
  let maxActive = 0;
  const slow = tool({
    name: "slow",
    description: "Slow down.",
    input: object({ target: string() }),
    fn: async ({ target }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) =>
        setTimeout(resolve, 20 + Number(target) * 10)
      );
      active -= 1;
      return `done:${target}`;
    },
  });

  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [slow],
    maxConcurrency: 2,
  });

  const messages = await assistant.run("Go");

  assertEquals(maxActive, 2);
  assertEquals(outputsOf(messages.at(-2) as ToolMessage), [
    "done:0",
    "done:1",
    "done:2",
    "done:3",
    "done:4",
  ]);
  assertEquals(messages.at(-1), modelMessage("All done."));
});

Deno.test("agent - tool batches stay unbounded without maxConcurrency", async () => {
  const model = new StubModel([
    [slowCallsMessage(3)],
    [modelMessage("All done.")],
  ]);
  let active = 0;
  let maxActive = 0;
  const slow = tool({
    name: "slow",
    description: "Slow down.",
    input: object({ target: string() }),
    fn: async ({ target }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return `done:${target}`;
    },
  });

  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [slow],
  });

  const messages = await assistant.run("Go");

  assertEquals(maxActive, 3);
  assertEquals(outputsOf(messages.at(-2) as ToolMessage), [
    "done:0",
    "done:1",
    "done:2",
  ]);
});

Deno.test("agent - per-run maxConcurrency overrides the agent-level cap", async () => {
  const model = new StubModel([
    [slowCallsMessage(3)],
    [modelMessage("All done.")],
  ]);
  let active = 0;
  let maxActive = 0;
  const slow = tool({
    name: "slow",
    description: "Slow down.",
    input: object({ target: string() }),
    fn: async ({ target }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return `done:${target}`;
    },
  });

  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [slow],
    maxConcurrency: 5,
  });

  const messages = await assistant.run("Go", [], { maxConcurrency: 1 });

  assertEquals(maxActive, 1);
  assertEquals(outputsOf(messages.at(-2) as ToolMessage), [
    "done:0",
    "done:1",
    "done:2",
  ]);
});

Deno.test("agent - duplicate finish_turn batches honor maxConcurrency", async () => {
  const slowCalls = Array.from({ length: 3 }, (_, i) => ({
    id: `call-${i + 1}`,
    name: "slow",
    props: { target: String(i) } as unknown as JSONSchema,
  }));
  const finishCalls = [
    finishTurnCall("call-4", "question", "A?"),
    finishTurnCall("call-5", "completion", "B."),
  ];
  const model = new StubModel([
    [{
      role: "model",
      contents: [
        ...slowCalls.map((toolCall) => ({ toolCall })),
        ...finishCalls,
      ],
      toolCalls: [...slowCalls, ...finishCalls.map((call) => call.toolCall)],
    }],
    [modelMessage("Recovered.")],
  ]);
  let active = 0;
  let maxActive = 0;
  const slow = tool({
    name: "slow",
    description: "Slow down.",
    input: object({ target: string() }),
    fn: async ({ target }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return `done:${target}`;
    },
  });

  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [slow],
    finishTurn: true,
    maxConcurrency: 2,
  });

  const messages = await assistant.run("Hi");

  assertEquals(maxActive, 2);
  const firstTool = messages.at(-2) as ToolMessage;
  assertEquals(resultOf(firstTool, 0).toolResult.result.output, "done:0");
  assertEquals(resultOf(firstTool, 1).toolResult.result.output, "done:1");
  assertEquals(resultOf(firstTool, 2).toolResult.result.output, "done:2");
  const duplicateError =
    "Issue exactly one finish_turn call per turn; multiple finish_turn calls in a single response are not allowed.";
  assertEquals(resultOf(firstTool, 3).toolResult.result.error, duplicateError);
  assertEquals(resultOf(firstTool, 4).toolResult.result.error, duplicateError);
  // The duplicate batch is non-terminal: the model gets another request.
  assertEquals(model.calls.length, 2);
});

Deno.test("agent - invalid maxConcurrency fails construction", () => {
  const model = new StubModel([]);
  assertThrows(
    () =>
      agent({
        model,
        modelId: "stub",
        systemPrompt: "Be helpful.",
        maxConcurrency: 0,
      }),
    TypeError,
    "maxConcurrency must be a positive integer",
  );
});

Deno.test("agent - invalid per-run maxConcurrency rejects before any model call", async () => {
  const model = new StubModel([[modelMessage("Hi")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
  });

  await assertRejects(
    () => assistant.run("Hi", [], { maxConcurrency: 1.5 }),
    TypeError,
    "maxConcurrency must be a positive integer",
  );
  assertEquals(model.calls.length, 0);
});

// --- maxModelCalls -------------------------------------------------------

/** Model whose every response is produced by `respond`, recording the
 * generate arguments — lets tests loop forever or hang on demand. */
class FnModel implements BaseModel<string> {
  calls: { messages: Message[]; signal?: AbortSignal }[] = [];
  #respond: (call: number) => Promise<Message[]> | Message[];

  constructor(respond: (call: number) => Promise<Message[]> | Message[]) {
    this.#respond = respond;
  }

  async generate(args: unknown): Promise<ModelResult<string>> {
    const { messages, signal } = args as {
      messages: Message[];
      signal?: AbortSignal;
    };
    this.calls.push({ messages, signal });
    return {
      modelId: "stub",
      messages: await this.#respond(this.calls.length),
    };
  }

  stream(): Promise<AsyncGenerator<ModelResult>> {
    return Promise.reject(new Error("Not implemented"));
  }
}

function toolCallMessage(name: string, id = "call-1"): Message {
  const toolCall = { id, name, props: {} as unknown as JSONSchema };
  return { role: "model", contents: [{ toolCall }], toolCalls: [toolCall] };
}

const noop = tool({
  name: "noop",
  description: "Does nothing.",
  input: object({}),
  fn: () => "ok",
});

function loopingAgent(
  model: FnModel,
  options: { maxModelCalls?: number } = {},
) {
  return agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [noop],
    ...options,
  });
}

Deno.test("agent - maxModelCalls stops a run that never stops calling tools", async () => {
  const model = new FnModel(() => [toolCallMessage("noop")]);

  await assertRejects(
    () => loopingAgent(model, { maxModelCalls: 3 }).run("Loop"),
    Error,
    'Agent run exceeded maxModelCalls (3) without finishing; last tool called: "noop"',
  );
  assertEquals(model.calls.length, 3);
});

Deno.test("agent - maxModelCalls defaults to DEFAULT_MAX_MODEL_CALLS", async () => {
  const model = new FnModel(() => [toolCallMessage("noop")]);

  await assertRejects(
    () => loopingAgent(model).run("Loop"),
    Error,
    `maxModelCalls (${DEFAULT_MAX_MODEL_CALLS})`,
  );
  assertEquals(model.calls.length, DEFAULT_MAX_MODEL_CALLS);
});

Deno.test("agent - maxModelCalls Infinity disables the cap", async () => {
  const total = DEFAULT_MAX_MODEL_CALLS + 20;
  const model = new FnModel((call) =>
    call < total ? [toolCallMessage("noop")] : [modelMessage("Done.")]
  );

  const messages = await loopingAgent(model, { maxModelCalls: Infinity })
    .run("Loop");

  assertEquals(model.calls.length, total);
  assertEquals(messages.at(-1), modelMessage("Done."));
});

Deno.test("agent - an agent-level maxModelCalls above the default applies", async () => {
  const model = new FnModel(() => [toolCallMessage("noop")]);
  const cap = DEFAULT_MAX_MODEL_CALLS + 5;

  await assertRejects(
    () => loopingAgent(model, { maxModelCalls: cap }).run("Loop"),
    Error,
    `maxModelCalls (${cap})`,
  );
  assertEquals(model.calls.length, cap);
});

Deno.test("agent - the smaller of agent and per-run maxModelCalls applies", async () => {
  const lowerPerRun = new FnModel(() => [toolCallMessage("noop")]);
  await assertRejects(
    () =>
      loopingAgent(lowerPerRun, { maxModelCalls: 5 }).run("Loop", [], {
        maxModelCalls: 2,
      }),
    Error,
    "maxModelCalls (2)",
  );
  assertEquals(lowerPerRun.calls.length, 2);

  const higherPerRun = new FnModel(() => [toolCallMessage("noop")]);
  await assertRejects(
    () =>
      loopingAgent(higherPerRun, { maxModelCalls: 2 }).run("Loop", [], {
        maxModelCalls: Infinity,
      }),
    Error,
    "maxModelCalls (2)",
  );
  assertEquals(higherPerRun.calls.length, 2);
});

Deno.test("agent - a run finishing exactly at maxModelCalls succeeds", async () => {
  const model = new FnModel((call) =>
    call < 3 ? [toolCallMessage("noop")] : [modelMessage("Done.")]
  );

  const messages = await loopingAgent(model, { maxModelCalls: 3 }).run("Go");

  assertEquals(model.calls.length, 3);
  assertEquals(messages.at(-1), modelMessage("Done."));
});

Deno.test("agent - invalid maxModelCalls fails construction and runs", async () => {
  for (const maxModelCalls of [0, -1, 1.5, NaN, -Infinity]) {
    assertThrows(
      () => loopingAgent(new FnModel(() => []), { maxModelCalls }),
      TypeError,
      "maxModelCalls must be a positive integer or Infinity",
    );
  }

  const model = new FnModel(() => [modelMessage("Hi")]);
  await assertRejects(
    () => loopingAgent(model).run("Hi", [], { maxModelCalls: 0 }),
    TypeError,
    "maxModelCalls must be a positive integer or Infinity",
  );
  assertEquals(model.calls.length, 0);
});

// --- run cancellation ----------------------------------------------------

Deno.test("agent - an already-aborted signal rejects before any model call", async () => {
  const model = new FnModel(() => [modelMessage("Hi")]);
  const emitted: Message[] = [];
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);

  const error = await assertRejects(() =>
    loopingAgent(model).run("Hi", [], {
      signal: controller.signal,
      onMessage: (message) => {
        emitted.push(message);
      },
    })
  );

  assertStrictEquals(error, reason);
  assertEquals(model.calls.length, 0);
  assertEquals(emitted, []);
});

Deno.test("agent - aborting rejects with an AbortError when no reason is given", async () => {
  const controller = new AbortController();
  controller.abort();

  const error = await assertRejects(() =>
    loopingAgent(new FnModel(() => [])).run("Hi", [], {
      signal: controller.signal,
    })
  );

  assertEquals((error as DOMException).name, "AbortError");
});

Deno.test("agent - the run signal is passed to the model adapter", async () => {
  const model = new FnModel(() => [modelMessage("Hi")]);
  const controller = new AbortController();

  await loopingAgent(model).run("Hi", [], { signal: controller.signal });

  assertStrictEquals(model.calls[0].signal, controller.signal);
});

Deno.test("agent - aborting during a model call rejects without waiting for the adapter", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  // An adapter that ignores the signal and never settles on its own.
  const model = new FnModel(() => {
    controller.abort(reason);
    return new Promise<Message[]>(() => {});
  });

  const error = await assertRejects(() =>
    loopingAgent(model).run("Hi", [], { signal: controller.signal })
  );

  assertStrictEquals(error, reason);
  assertEquals(model.calls.length, 1);
});

Deno.test("agent - aborting during a tool batch aborts the tools and makes no further model call", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  const toolSignals: AbortSignal[] = [];
  const blocking = tool({
    name: "blocking",
    description: "Waits until aborted.",
    input: object({}),
    fn: (_props, { signal }) => {
      toolSignals.push(signal);
      controller.abort(reason);
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason))
      );
    },
  });
  const model = new FnModel(() => [toolCallMessage("blocking")]);
  const emitted: Message[] = [];

  const error = await assertRejects(() =>
    agent({
      model,
      modelId: "stub",
      systemPrompt: "Be helpful.",
      tools: [blocking],
    }).run("Hi", [], {
      signal: controller.signal,
      onMessage: (message) => {
        emitted.push(message);
      },
    })
  );

  assertStrictEquals(error, reason);
  assertEquals(toolSignals.length, 1);
  assertEquals(toolSignals[0].aborted, true);
  assertEquals(model.calls.length, 1);
  // The tool results of the aborted batch are still emitted, so a caller
  // resuming from emitted messages has no dangling tool call.
  assertEquals(emitted.at(-1)?.role, "tool");
});

Deno.test("agent - duplicate finish_turn batches forward the run signal to sibling tools", async () => {
  const controller = new AbortController();
  const received: AbortSignal[] = [];
  const probe = tool({
    name: "probe",
    description: "Records its signal.",
    input: object({}),
    fn: (_props, { signal }) => {
      received.push(signal);
      return "ok";
    },
  });
  const probeCall = { id: "call-3", name: "probe", props: {} as JSONSchema };
  const model = new FnModel((call) =>
    call === 1
      ? [{
        role: "model",
        contents: [
          finishTurnCall("call-1", "completion", "A."),
          finishTurnCall("call-2", "completion", "B."),
          { toolCall: probeCall },
        ],
        toolCalls: [
          finishTurnCall("call-1", "completion", "A.").toolCall,
          finishTurnCall("call-2", "completion", "B.").toolCall,
          probeCall,
        ],
      }]
      : [modelMessage("Done.")]
  );

  await agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [probe],
    finishTurn: true,
  }).run("Hi", [], { signal: controller.signal });

  assertEquals(received.length, 1);
  controller.abort();
  assertEquals(received[0].aborted, true);
});

Deno.test("agent - aborting while the final message is delivered rejects the run", async () => {
  for (const finishTurn of [false, true]) {
    const controller = new AbortController();
    const reason = new Error("stop");
    const model = new FnModel(() =>
      finishTurn
        ? [finishTurnModelMessage(finishTurnCall("call-1", "completion", "Done."))]
        : [modelMessage("Done.")]
    );
    const finalRole = finishTurn ? "tool" : "model";

    const error = await assertRejects(() =>
      agent({
        model,
        modelId: "stub",
        systemPrompt: "Be helpful.",
        finishTurn,
      }).run("Hi", [], {
        signal: controller.signal,
        onMessage: (message) => {
          if (message.role === finalRole) controller.abort(reason);
        },
      })
    );

    assertStrictEquals(error, reason);
    assertEquals(model.calls.length, 1);
  }
});
