import { assertEquals, assertRejects } from "@std/assert";
import { agent } from "@/agent/mod.ts";
import type {
  BaseModel,
  JSONSchema,
  Message,
  ModelResult,
  ModelUsage,
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
