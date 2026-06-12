import { assertEquals, assertRejects } from "@std/assert";
import { agent } from "@/agent/mod.ts";
import type {
  BaseModel,
  JSONSchema,
  Message,
  ModelResult,
} from "@/agent/mod.ts";
import { tool } from "@/tools/mod.ts";
import { object, string } from "@huuma/validate";

class StubModel implements BaseModel<string> {
  calls: { messages: Message[]; system?: string }[] = [];
  #responses: Message[][];

  constructor(responses: Message[][]) {
    this.#responses = responses;
  }

  generate(args: unknown): Promise<ModelResult<string>> {
    const { messages, system } = args as {
      messages: Message[];
      system?: string;
    };
    this.calls.push({ messages, system });

    const messagesToReturn = this.#responses.shift();
    if (!messagesToReturn) {
      return Promise.reject(new Error("No scripted response left"));
    }
    return Promise.resolve({ modelId: "stub", messages: messagesToReturn });
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
