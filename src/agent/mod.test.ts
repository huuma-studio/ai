import { expect, test } from "vite-plus/test";
import { agent, DEFAULT_MAX_MODEL_CALLS, FINISH_TURN_TOOL } from "./mod.ts";
import type {
  BaseModel,
  JSONSchema,
  Message,
  ModelResult,
  ModelUsage,
  ToolMessage,
  ToolResultContent,
} from "./mod.ts";
import { tool } from "../tools/mod.ts";
import { object, string } from "@huuma/validate";

type ScriptedResponse = Message[] | { messages: Message[]; usage?: ModelUsage };

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

test("agent - run sends the prompt and returns the conversation", async () => {
  const model = new StubModel([[modelMessage("Hello!")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
  });

  const messages = await assistant.run("Hi");

  expect(messages).toStrictEqual([{ role: "user", contents: "Hi" }, modelMessage("Hello!")]);
  expect(model.calls[0].system).toStrictEqual("Be helpful.");
  expect(model.calls[0].messages).toStrictEqual([{ role: "user", contents: "Hi" }]);
});

test("agent - run passes text and file prompt parts through verbatim", async () => {
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

  expect(model.calls[0].messages).toStrictEqual([{ role: "user", contents: prompt }]);
  expect(messages).toStrictEqual([{ role: "user", contents: prompt }, modelMessage("A cat.")]);
});

test("agent - run continues from prior history", async () => {
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

  expect(model.calls[0].messages).toStrictEqual([
    ...history,
    { role: "user", contents: "Who created it?" },
  ]);
  expect(messages).toStrictEqual([
    ...history,
    { role: "user", contents: "Who created it?" },
    modelMessage("Ryan Dahl."),
  ]);
});

test("agent - run executes tool calls and feeds results back", async () => {
  const toolCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const model = new StubModel([
    [
      {
        role: "model",
        contents: [{ toolCall }],
        toolCalls: [toolCall],
      },
    ],
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

  expect(greetedWith).toStrictEqual(["Huuma"]);

  const toolMessage = messages.at(-2);
  expect(toolMessage?.role).toStrictEqual("tool");
  expect(messages.at(-1)).toStrictEqual(modelMessage("Greeted Huuma."));

  // the second model call sees the tool result
  expect(model.calls.length).toStrictEqual(2);
  expect(model.calls[1].messages.at(-1)?.role).toStrictEqual("tool");
});

test("agent - onMessage receives each emitted message in order", async () => {
  const toolCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const model = new StubModel([
    [
      {
        role: "model",
        contents: [{ toolCall }],
        toolCalls: [toolCall],
      },
    ],
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

  expect(emitted).toStrictEqual(messages);
  expect(emitted.map((message) => message.role)).toStrictEqual(["user", "model", "tool", "model"]);
});

test("agent - onMessage does not receive prior history", async () => {
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

  expect(emitted).toStrictEqual([
    { role: "user", contents: "Who created it?" },
    modelMessage("Ryan Dahl."),
  ]);
});

test("agent - per-run onMessage overrides the agent-level callback", async () => {
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

  expect(agentLevel).toStrictEqual([]);
  expect(runLevel).toStrictEqual(messages);
});

test("agent - per-run onMessage attributes messages of concurrent runs", async () => {
  const model = new StubModel([[modelMessage("First answer.")], [modelMessage("Second answer.")]]);

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

  expect(emittedA).toStrictEqual(messagesA);
  expect(emittedB).toStrictEqual(messagesB);
});

test("agent - onMessage errors warn but do not abort the run", async () => {
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

    expect(messages).toStrictEqual([{ role: "user", contents: "Hi" }, modelMessage("Hello!")]);
    // one warning per emitted message (user + model)
    expect(warnings.length).toStrictEqual(2);
    expect(warnings[0][0]).toStrictEqual("[Huuma Agent] onMessage callback failed:");
  } finally {
    console.warn = originalWarn;
  }
});

test("agent - onMessage receives accumulated usage across model calls", async () => {
  const toolCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const model = new StubModel([
    {
      messages: [
        {
          role: "model",
          contents: [{ toolCall }],
          toolCalls: [toolCall],
        },
      ],
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
  expect(reported).toStrictEqual([
    undefined,
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    { inputTokens: 30, outputTokens: 12, totalTokens: 42 },
  ]);
});

test("agent - onMessage usage stays undefined without model usage", async () => {
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

  expect(reported).toStrictEqual([undefined, undefined]);
});

test("agent - onMessage usage stays undefined for empty usage objects", async () => {
  const model = new StubModel([{ messages: [modelMessage("Hello!")], usage: {} }]);

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

  expect(reported).toStrictEqual([undefined, undefined]);
});

test("agent - onMessage usage snapshots are mutation-safe", async () => {
  const toolCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const model = new StubModel([
    {
      messages: [
        {
          role: "model",
          contents: [{ toolCall }],
          toolCalls: [toolCall],
        },
      ],
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

  expect(totals).toStrictEqual([undefined, 7, 7, 9]);
});

test("agent - run surfaces model errors", async () => {
  const model = new StubModel([]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
  });

  const error = await assistant.run("Hi").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("No scripted response left");
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

function finishTurnModelMessage(...calls: ReturnType<typeof finishTurnCall>[]): Message {
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

test("agent - onMessageError 'throw' rejects on prompt delivery and skips the model", async () => {
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

  const error = await assistant.run("Hi").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("consumer failure");
  expect(model.calls.length).toStrictEqual(0);
});

test("agent - onMessageError 'throw' rejects on model delivery and skips tool calls", async () => {
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

  const error = await assistant.run("Greet Huuma").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("consumer failure");
  // prompt was emitted, model message delivery threw, tool never ran
  expect(calls).toStrictEqual(2);
  expect(greetedWith).toStrictEqual([]);
});

test("agent - onMessageError 'throw' rejects on tool-result delivery and skips the next model request", async () => {
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

  const error = await assistant.run("Greet Huuma").catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("consumer failure");
  // prompt + model message + tool result emitted; tool ran; second model call never made
  expect(calls).toStrictEqual(3);
  expect(model.calls.length).toStrictEqual(1);
});

test("agent - per-run onMessageError overrides the agent-level policy", async () => {
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
    expect(messages).toStrictEqual([{ role: "user", contents: "Hi" }, modelMessage("Hi")]);
    expect(warnings.length).toStrictEqual(2);
  } finally {
    console.warn = originalWarn;
  }
});

test("agent - onMessageError defaults to 'warn' when unset at both levels", async () => {
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
    expect(warnings.length).toStrictEqual(2);
  } finally {
    console.warn = originalWarn;
  }
});

// --- finish_turn enablement --------------------------------------------

test("agent - finish_turn tool is absent by default", async () => {
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
  expect(seen).toStrictEqual([]);
});

test("agent - finish_turn tool is present when opted in", async () => {
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
  expect(seen).toStrictEqual([FINISH_TURN_TOOL]);
});

test("agent - consumer tool named finish_turn fails construction", () => {
  const model = new StubModel([]);
  const conflicting = tool({
    name: FINISH_TURN_TOOL,
    description: "mine",
    input: object({}),
    fn: () => "ok",
  });

  expect(() =>
    agent({
      model,
      modelId: "stub",
      systemPrompt: "Be helpful.",
      tools: [conflicting],
    }),
  ).toThrow(Error);
  expect(() =>
    agent({
      model,
      modelId: "stub",
      systemPrompt: "Be helpful.",
      tools: [conflicting],
    }),
  ).toThrow(FINISH_TURN_TOOL);
});

// --- finish_turn successful termination ---------------------------------

test("agent - a valid finish_turn emits model + tool messages and stops the run", async () => {
  const model = new StubModel([
    [finishTurnModelMessage(finishTurnCall("call-1", "question", "Which database should I use?"))],
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

  expect(emitted.map((m) => m.role)).toStrictEqual(["user", "model", "tool"]);
  const toolMessage = messages.at(-1) as ToolMessage;
  expect(toolMessage.contents).toStrictEqual([
    {
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
    },
  ]);
  // Only one model request was made; no follow-up after the tool result.
  expect(model.calls.length).toStrictEqual(1);
});

test("agent - finish_turn message is preserved verbatim, not trimmed", async () => {
  const model = new StubModel([
    [finishTurnModelMessage(finishTurnCall("call-1", "completion", "  done  \n"))],
  ]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    finishTurn: true,
  });

  const messages = await assistant.run("Hi");
  const toolMessage = messages.at(-1) as ToolMessage;
  expect(resultOf(toolMessage, 0).toolResult.result.output).toStrictEqual({
    outcome: "completion",
    message: "  done  \n",
  });
});

test("agent - finish_turn remains terminal when a sibling tool fails", async () => {
  const boomCall = {
    id: "call-1",
    name: "boom",
    props: {} as unknown as JSONSchema,
  };
  const finishCall = finishTurnCall("call-2", "completion", "Done.");
  const model = new StubModel([
    [
      {
        role: "model",
        contents: [{ toolCall: boomCall }, finishCall],
        toolCalls: [boomCall, finishCall.toolCall],
      },
    ],
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
  expect(toolMessage.contents.length).toStrictEqual(2);
  // Both calls received a result.
  expect(resultOf(toolMessage, 0).toolResult.result.error).toStrictEqual("boom");
  expect(resultOf(toolMessage, 1).toolResult.result.output).toStrictEqual({
    outcome: "completion",
    message: "Done.",
  });
  // The run stopped after the tool result despite the sibling failure.
  expect(model.calls.length).toStrictEqual(1);
});

test("agent - finish_turn beside a successful sibling tool still stops", async () => {
  const greetCall = {
    id: "call-1",
    name: "greet",
    props: { name: "Huuma" } as unknown as JSONSchema,
  };
  const finishCall = finishTurnCall("call-2", "completion", "Done.");
  const model = new StubModel([
    [
      {
        role: "model",
        contents: [{ toolCall: greetCall }, finishCall],
        toolCalls: [greetCall, finishCall.toolCall],
      },
    ],
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
  expect(greetedWith).toStrictEqual(["Huuma"]);
  expect(model.calls.length).toStrictEqual(1);
});

// --- finish_turn invalid and duplicate calls ----------------------------

test("agent - invalid finish_turn outcome yields an error result and a retry opportunity", async () => {
  const model = new StubModel([
    [finishTurnModelMessage(finishTurnCall("call-1", "wip", "huh?"))],
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
  expect(resultOf(firstTool, 0).toolResult.name).toStrictEqual(FINISH_TURN_TOOL);
  expect(typeof resultOf(firstTool, 0).toolResult.result.error).toStrictEqual("string");
  // The run did not stop — a second model request was made.
  expect(model.calls.length).toStrictEqual(2);
  expect(messages.at(-1)).toStrictEqual(modelMessage("Recovered."));
});

test("agent - blank finish_turn message yields an error result and a retry opportunity", async () => {
  const model = new StubModel([
    [finishTurnModelMessage(finishTurnCall("call-1", "question", "   \n\t "))],
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
  expect(resultOf(firstTool, 0).toolResult.result.error).toStrictEqual(
    "finish_turn message must contain at least one non-whitespace character",
  );
  expect(model.calls.length).toStrictEqual(2);
});

test("agent - duplicate finish_turn calls each receive a deterministic error and the run continues", async () => {
  const model = new StubModel([
    [
      finishTurnModelMessage(
        finishTurnCall("call-1", "question", "A?"),
        finishTurnCall("call-2", "completion", "B."),
      ),
    ],
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
  expect(firstTool.contents.length).toStrictEqual(2);
  expect(resultOf(firstTool, 0).toolResult.result.error).toStrictEqual(
    resultOf(firstTool, 1).toolResult.result.error,
  );
  expect(resultOf(firstTool, 0).toolResult.result.error).toStrictEqual(
    "Issue exactly one finish_turn call per turn; multiple finish_turn calls in a single response are not allowed.",
  );
  // Non-terminal: the model gets another request.
  expect(model.calls.length).toStrictEqual(2);
});

// --- history continuation with finish_turn ------------------------------

test("agent - history ending in a successful finish_turn result can be continued without a dangling tool call", async () => {
  const priorTool: Message = toolMessageOf({
    id: "call-1",
    name: FINISH_TURN_TOOL,
    result: {
      output: { outcome: "question", message: "Which database?" },
    },
  });
  const history: Message[] = [
    { role: "user", contents: "Set up a DB." },
    finishTurnModelMessage(finishTurnCall("call-1", "question", "Which database?")),
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
  expect(emitted).toStrictEqual([{ role: "user", contents: "Postgres." }, modelMessage("Got it.")]);
  expect(model.calls[0].messages).toStrictEqual([
    ...history,
    { role: "user", contents: "Postgres." },
  ]);
  // No tool calls were re-executed; the returned history has no new tool message.
  expect(messages).toStrictEqual([
    ...history,
    {
      role: "user",
      contents: "Postgres.",
    },
    modelMessage("Got it."),
  ]);
});

test("agent - a run ending without finish_turn returns normally with no successful finish result", async () => {
  const model = new StubModel([[modelMessage("Hi there.")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    finishTurn: true,
  });

  const messages = await assistant.run("Hi");
  const last = messages.at(-1);
  expect(last?.role).toStrictEqual("model");
  // No tool message at all — the absence of a successful finish result is
  // how callers detect the non-terminal outcome.
  expect(messages.some((m) => m.role === "tool")).toStrictEqual(false);
});

// --- unknown fields round-trip ------------------------------------------

test("agent - unknown fields on prior messages survive unchanged in the returned history", async () => {
  const history: Message[] = [
    {
      role: "user",
      contents: "Hi",
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

  expect((messages[0] as any).unknownFuture).toStrictEqual({ foo: 1 });
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

test("agent - maxConcurrency bounds overlapping tool executions", async () => {
  const model = new StubModel([[slowCallsMessage(5)], [modelMessage("All done.")]]);
  let active = 0;
  let maxActive = 0;
  const slow = tool({
    name: "slow",
    description: "Slow down.",
    input: object({ target: string() }),
    fn: async ({ target }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20 + Number(target) * 10));
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

  expect(maxActive).toStrictEqual(2);
  expect(outputsOf(messages.at(-2) as ToolMessage)).toStrictEqual([
    "done:0",
    "done:1",
    "done:2",
    "done:3",
    "done:4",
  ]);
  expect(messages.at(-1)).toStrictEqual(modelMessage("All done."));
});

test("agent - tool batches stay unbounded without maxConcurrency", async () => {
  const model = new StubModel([[slowCallsMessage(3)], [modelMessage("All done.")]]);
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

  expect(maxActive).toStrictEqual(3);
  expect(outputsOf(messages.at(-2) as ToolMessage)).toStrictEqual(["done:0", "done:1", "done:2"]);
});

test("agent - per-run maxConcurrency overrides the agent-level cap", async () => {
  const model = new StubModel([[slowCallsMessage(3)], [modelMessage("All done.")]]);
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

  expect(maxActive).toStrictEqual(1);
  expect(outputsOf(messages.at(-2) as ToolMessage)).toStrictEqual(["done:0", "done:1", "done:2"]);
});

test("agent - duplicate finish_turn batches honor maxConcurrency", async () => {
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
    [
      {
        role: "model",
        contents: [...slowCalls.map((toolCall) => ({ toolCall })), ...finishCalls],
        toolCalls: [...slowCalls, ...finishCalls.map((call) => call.toolCall)],
      },
    ],
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

  expect(maxActive).toStrictEqual(2);
  const firstTool = messages.at(-2) as ToolMessage;
  expect(resultOf(firstTool, 0).toolResult.result.output).toStrictEqual("done:0");
  expect(resultOf(firstTool, 1).toolResult.result.output).toStrictEqual("done:1");
  expect(resultOf(firstTool, 2).toolResult.result.output).toStrictEqual("done:2");
  const duplicateError =
    "Issue exactly one finish_turn call per turn; multiple finish_turn calls in a single response are not allowed.";
  expect(resultOf(firstTool, 3).toolResult.result.error).toStrictEqual(duplicateError);
  expect(resultOf(firstTool, 4).toolResult.result.error).toStrictEqual(duplicateError);
  // The duplicate batch is non-terminal: the model gets another request.
  expect(model.calls.length).toStrictEqual(2);
});

test("agent - invalid maxConcurrency fails construction", () => {
  const model = new StubModel([]);
  expect(() =>
    agent({
      model,
      modelId: "stub",
      systemPrompt: "Be helpful.",
      maxConcurrency: 0,
    }),
  ).toThrow(TypeError);
  expect(() =>
    agent({
      model,
      modelId: "stub",
      systemPrompt: "Be helpful.",
      maxConcurrency: 0,
    }),
  ).toThrow("maxConcurrency must be a positive integer");
});

test("agent - invalid per-run maxConcurrency rejects before any model call", async () => {
  const model = new StubModel([[modelMessage("Hi")]]);
  const assistant = agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
  });

  const error = await assistant.run("Hi", [], { maxConcurrency: 1.5 }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toContain("maxConcurrency must be a positive integer");
  expect(model.calls.length).toStrictEqual(0);
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
  options: { maxModelCalls?: number; modelTimeout?: number } = {},
) {
  return agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [noop],
    ...options,
  });
}

test("agent - maxModelCalls stops a run that never stops calling tools", async () => {
  const model = new FnModel(() => [toolCallMessage("noop")]);

  const error = await loopingAgent(model, { maxModelCalls: 3 })
    .run("Loop")
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(
    'Agent run exceeded maxModelCalls (3) without finishing; last tool called: "noop"',
  );
  expect(model.calls.length).toStrictEqual(3);
});

test("agent - maxModelCalls defaults to DEFAULT_MAX_MODEL_CALLS", async () => {
  const model = new FnModel(() => [toolCallMessage("noop")]);

  const error = await loopingAgent(model)
    .run("Loop")
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(`maxModelCalls (${DEFAULT_MAX_MODEL_CALLS})`);
  expect(model.calls.length).toStrictEqual(DEFAULT_MAX_MODEL_CALLS);
});

test("agent - maxModelCalls Infinity disables the cap", async () => {
  const total = DEFAULT_MAX_MODEL_CALLS + 20;
  const model = new FnModel((call) =>
    call < total ? [toolCallMessage("noop")] : [modelMessage("Done.")],
  );

  const messages = await loopingAgent(model, { maxModelCalls: Infinity }).run("Loop");

  expect(model.calls.length).toStrictEqual(total);
  expect(messages.at(-1)).toStrictEqual(modelMessage("Done."));
});

test("agent - an agent-level maxModelCalls above the default applies", async () => {
  const model = new FnModel(() => [toolCallMessage("noop")]);
  const cap = DEFAULT_MAX_MODEL_CALLS + 5;

  const error = await loopingAgent(model, { maxModelCalls: cap })
    .run("Loop")
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(`maxModelCalls (${cap})`);
  expect(model.calls.length).toStrictEqual(cap);
});

test("agent - the smaller of agent and per-run maxModelCalls applies", async () => {
  const lowerPerRun = new FnModel(() => [toolCallMessage("noop")]);
  const lowerError = await loopingAgent(lowerPerRun, { maxModelCalls: 5 })
    .run("Loop", [], {
      maxModelCalls: 2,
    })
    .catch((e: unknown) => e);
  expect(lowerError).toBeInstanceOf(Error);
  expect((lowerError as Error).message).toContain("maxModelCalls (2)");
  expect(lowerPerRun.calls.length).toStrictEqual(2);

  const higherPerRun = new FnModel(() => [toolCallMessage("noop")]);
  const higherError = await loopingAgent(higherPerRun, { maxModelCalls: 2 })
    .run("Loop", [], {
      maxModelCalls: Infinity,
    })
    .catch((e: unknown) => e);
  expect(higherError).toBeInstanceOf(Error);
  expect((higherError as Error).message).toContain("maxModelCalls (2)");
  expect(higherPerRun.calls.length).toStrictEqual(2);
});

test("agent - a run finishing exactly at maxModelCalls succeeds", async () => {
  const model = new FnModel((call) =>
    call < 3 ? [toolCallMessage("noop")] : [modelMessage("Done.")],
  );

  const messages = await loopingAgent(model, { maxModelCalls: 3 }).run("Go");

  expect(model.calls.length).toStrictEqual(3);
  expect(messages.at(-1)).toStrictEqual(modelMessage("Done."));
});

test("agent - invalid maxModelCalls fails construction and runs", async () => {
  for (const maxModelCalls of [0, -1, 1.5, NaN, -Infinity]) {
    expect(() => loopingAgent(new FnModel(() => []), { maxModelCalls })).toThrow(TypeError);
    expect(() => loopingAgent(new FnModel(() => []), { maxModelCalls })).toThrow(
      "maxModelCalls must be a positive integer or Infinity",
    );
  }

  const model = new FnModel(() => [modelMessage("Hi")]);
  const error = await loopingAgent(model)
    .run("Hi", [], { maxModelCalls: 0 })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toContain(
    "maxModelCalls must be a positive integer or Infinity",
  );
  expect(model.calls.length).toStrictEqual(0);
});

// --- run cancellation ----------------------------------------------------

test("agent - an already-aborted signal rejects before any model call", async () => {
  const model = new FnModel(() => [modelMessage("Hi")]);
  const emitted: Message[] = [];
  const controller = new AbortController();
  const reason = new Error("stop");
  controller.abort(reason);

  const error = await loopingAgent(model)
    .run("Hi", [], {
      signal: controller.signal,
      onMessage: (message) => {
        emitted.push(message);
      },
    })
    .catch((e: unknown) => e);

  expect(error).toBe(reason);
  expect(model.calls.length).toStrictEqual(0);
  expect(emitted).toStrictEqual([]);
});

test("agent - aborting rejects with an AbortError when no reason is given", async () => {
  const controller = new AbortController();
  controller.abort();

  const error = await loopingAgent(new FnModel(() => []))
    .run("Hi", [], {
      signal: controller.signal,
    })
    .catch((e: unknown) => e);

  expect((error as DOMException).name).toStrictEqual("AbortError");
});

test("agent - the run signal is passed to the model adapter", async () => {
  const model = new FnModel(() => [modelMessage("Hi")]);
  const controller = new AbortController();

  await loopingAgent(model).run("Hi", [], { signal: controller.signal });

  expect(model.calls[0].signal).toBe(controller.signal);
});

test("agent - aborting during a model call rejects without waiting for the adapter", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  // An adapter that ignores the signal and never settles on its own.
  const model = new FnModel(() => {
    controller.abort(reason);
    return new Promise<Message[]>(() => {});
  });

  const error = await loopingAgent(model)
    .run("Hi", [], { signal: controller.signal })
    .catch((e: unknown) => e);

  expect(error).toBe(reason);
  expect(model.calls.length).toStrictEqual(1);
});

test("agent - aborting during a tool batch aborts the tools and makes no further model call", async () => {
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
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
    },
  });
  const model = new FnModel(() => [toolCallMessage("blocking")]);
  const emitted: Message[] = [];

  const error = await agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [blocking],
  })
    .run("Hi", [], {
      signal: controller.signal,
      onMessage: (message) => {
        emitted.push(message);
      },
    })
    .catch((e: unknown) => e);

  expect(error).toBe(reason);
  expect(toolSignals.length).toStrictEqual(1);
  expect(toolSignals[0].aborted).toStrictEqual(true);
  expect(model.calls.length).toStrictEqual(1);
  // The tool results of the aborted batch are still emitted, so a caller
  // resuming from emitted messages has no dangling tool call.
  expect(emitted.at(-1)?.role).toStrictEqual("tool");
});

test("agent - duplicate finish_turn batches forward the run signal to sibling tools", async () => {
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
      ? [
          {
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
          },
        ]
      : [modelMessage("Done.")],
  );

  await agent({
    model,
    modelId: "stub",
    systemPrompt: "Be helpful.",
    tools: [probe],
    finishTurn: true,
  }).run("Hi", [], { signal: controller.signal });

  expect(received.length).toStrictEqual(1);
  controller.abort();
  expect(received[0].aborted).toStrictEqual(true);
});

test("agent - aborting while the final message is delivered rejects the run", async () => {
  for (const finishTurn of [false, true]) {
    const controller = new AbortController();
    const reason = new Error("stop");
    const model = new FnModel(() =>
      finishTurn
        ? [finishTurnModelMessage(finishTurnCall("call-1", "completion", "Done."))]
        : [modelMessage("Done.")],
    );
    const finalRole = finishTurn ? "tool" : "model";

    const error = await agent({
      model,
      modelId: "stub",
      systemPrompt: "Be helpful.",
      finishTurn,
    })
      .run("Hi", [], {
        signal: controller.signal,
        onMessage: (message) => {
          if (message.role === finalRole) controller.abort(reason);
        },
      })
      .catch((e: unknown) => e);

    expect(error).toBe(reason);
    expect(model.calls.length).toStrictEqual(1);
  }
});

// --- modelTimeout --------------------------------------------------------

test("agent - modelTimeout bounds a model call that never settles", async () => {
  // An adapter that ignores its options and never settles must still be
  // bounded by the run's deadline.
  const model = new FnModel(() => new Promise<Message[]>(() => {}));

  const error = await loopingAgent(model, { modelTimeout: 50 })
    .run("Hi")
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DOMException);

  expect((error as DOMException).name).toStrictEqual("TimeoutError");
  expect((error as DOMException).message).toStrictEqual("The model call timed out");
  expect(model.calls.length).toStrictEqual(1);
});

test("agent - modelTimeout aborts the signal of an adapter that honours only signal", async () => {
  // A custom adapter that ignores `timeout` must still see its request
  // cancelled when the deadline expires, not left running and billing
  // after the run has rejected.
  let adapterSignal: AbortSignal | undefined;
  const model = new FnModel(() => {
    adapterSignal = model.calls[0].signal;
    return new Promise<Message[]>((_, reject) => {
      adapterSignal?.addEventListener("abort", () => reject(new Error("request cancelled")), {
        once: true,
      });
    });
  });

  const error = await loopingAgent(model, { modelTimeout: 50 })
    .run("Hi")
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DOMException);

  expect((error as DOMException).name).toStrictEqual("TimeoutError");
  expect(adapterSignal).toBeDefined();
  expect(adapterSignal!.aborted).toStrictEqual(true);
  expect(adapterSignal!.reason).toBe(error);
});

test("agent - the caller's abort reason wins over a pending modelTimeout", async () => {
  const controller = new AbortController();
  const reason = new Error("managed turn deadline");
  const model = new FnModel(() => {
    controller.abort(reason);
    return new Promise<Message[]>(() => {});
  });

  const error = await loopingAgent(model, { modelTimeout: 10_000 })
    .run("Hi", [], {
      signal: controller.signal,
    })
    .catch((e: unknown) => e);

  expect(error).toBe(reason);
  expect(model.calls[0].signal?.reason).toBe(reason);
});

test("agent - no signal reaches the adapter without modelTimeout or a run signal", async () => {
  const model = new FnModel(() => [modelMessage("Hi")]);
  const received: unknown[] = [];
  const originalGenerate = model.generate.bind(model);
  model.generate = (args: unknown) => {
    const { signal, timeout } = args as {
      signal?: AbortSignal;
      timeout?: number;
    };
    received.push(signal, timeout);
    return originalGenerate(args);
  };

  await loopingAgent(model).run("Hi");

  expect(received).toStrictEqual([undefined, undefined]);
});

test("agent - the smaller of agent and per-run modelTimeout applies", async () => {
  const lowerPerRun = new FnModel(() => new Promise<Message[]>(() => {}));
  const lowerStartedAt = Date.now();
  const lowerError = await loopingAgent(lowerPerRun, { modelTimeout: 10_000 })
    .run("Hi", [], {
      modelTimeout: 50,
    })
    .catch((e: unknown) => e);
  expect(lowerError).toBeInstanceOf(DOMException);
  expect((lowerError as DOMException).name).toStrictEqual("TimeoutError");
  // The per-run value won: rejecting inside ten seconds proves the
  // agent-level deadline did not govern the call.
  expect(Date.now() - lowerStartedAt < 5_000).toBe(true);

  const higherPerRun = new FnModel(() => new Promise<Message[]>(() => {}));
  const higherStartedAt = Date.now();
  const higherError = await loopingAgent(higherPerRun, { modelTimeout: 50 })
    .run("Hi", [], {
      modelTimeout: 10_000,
    })
    .catch((e: unknown) => e);
  expect(higherError).toBeInstanceOf(DOMException);
  expect((higherError as DOMException).name).toStrictEqual("TimeoutError");
  // The per-run value cannot loosen the agent-level deadline.
  expect(Date.now() - higherStartedAt < 5_000).toBe(true);
});

test("agent - a modelTimeout of 0 expires immediately", async () => {
  const model = new FnModel(() => new Promise<Message[]>(() => {}));

  const error = await loopingAgent(model, { modelTimeout: 0 })
    .run("Hi")
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DOMException);

  expect((error as DOMException).name).toStrictEqual("TimeoutError");
  expect((error as DOMException).message).toStrictEqual("The model call timed out");
  expect(model.calls.length).toStrictEqual(1);
});

test("agent - invalid modelTimeout fails construction and runs", async () => {
  for (const modelTimeout of [-1, -Infinity, NaN, Infinity]) {
    expect(() => loopingAgent(new FnModel(() => []), { modelTimeout })).toThrow(TypeError);
    expect(() => loopingAgent(new FnModel(() => []), { modelTimeout })).toThrow(
      "modelTimeout must be a finite, non-negative number",
    );
  }

  const model = new FnModel(() => [modelMessage("Hi")]);
  const error = await loopingAgent(model)
    .run("Hi", [], { modelTimeout: -1 })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as Error).message).toContain("modelTimeout must be a finite, non-negative number");
  expect(model.calls.length).toStrictEqual(0);
});

test("agent - a model call within its deadline completes the run", async () => {
  const model = new FnModel(
    () =>
      new Promise<Message[]>((resolve) =>
        setTimeout(() => resolve([modelMessage("Slow but fine.")]), 50),
      ),
  );

  const messages = await loopingAgent(model, { modelTimeout: 10_000 }).run("Hi");

  expect(messages.at(-1)).toStrictEqual(modelMessage("Slow but fine."));
});
