import { assertEquals, assertRejects } from "@std/assert";
import { agent } from "@/agent/mod.ts";
import type {
  BaseModel,
  JSONSchema,
  Message,
  ModelResult,
  ModelUsage,
} from "@/agent/mod.ts";
import { subagent } from "@/tools/mod.ts";

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

function stubAgent(model: StubModel) {
  return agent({ model, modelId: "stub", systemPrompt: "Be helpful." });
}

Deno.test("subagent - delegates and returns the final text", async () => {
  const model = new StubModel([[modelMessage("Done.")]]);
  const delegate = subagent({
    name: "delegate",
    description: "Delegate a task.",
    agent: stubAgent(model),
  });

  assertEquals(await delegate.call({ prompt: "go" }), "Done.");
});

Deno.test("subagent - passes the prompt as the user message without history", async () => {
  const model = new StubModel([[modelMessage("Done.")]]);
  const delegate = subagent({
    name: "delegate",
    description: "Delegate a task.",
    agent: stubAgent(model),
  });

  await delegate.call({ prompt: "go" });

  assertEquals(model.calls[0].messages, [{ role: "user", contents: "go" }]);
});

Deno.test("subagent - returns empty string when no model message exists", async () => {
  const model = new StubModel([[]]);
  const delegate = subagent({
    name: "delegate",
    description: "Delegate a task.",
    agent: stubAgent(model),
  });

  assertEquals(await delegate.call({ prompt: "go" }), "");
});

Deno.test("subagent - joins multiple text parts with a newline", async () => {
  const model = new StubModel([[{
    role: "model",
    contents: [{ text: "One." }, { text: "Two." }],
    toolCalls: [],
  }]]);
  const delegate = subagent({
    name: "delegate",
    description: "Delegate a task.",
    agent: stubAgent(model),
  });

  assertEquals(await delegate.call({ prompt: "go" }), "One.\nTwo.");
});

Deno.test("subagent - ignores tool-call content in the final message", async () => {
  const toolCall = {
    id: "call-1",
    name: "noop",
    props: {} as unknown as JSONSchema,
  };
  const model = new StubModel([[{
    role: "model",
    contents: [{ toolCall }, { text: "Text only." }],
    toolCalls: [],
  }]]);
  const delegate = subagent({
    name: "delegate",
    description: "Delegate a task.",
    agent: stubAgent(model),
  });

  assertEquals(await delegate.call({ prompt: "go" }), "Text only.");
});

Deno.test("subagent - concurrent delegations run independently", async () => {
  const model = new StubModel([
    [modelMessage("Result A.")],
    [modelMessage("Result B.")],
  ]);
  const delegate = subagent({
    name: "delegate",
    description: "Delegate a task.",
    agent: stubAgent(model),
  });

  const results = await Promise.all([
    delegate.call({ prompt: "a" }),
    delegate.call({ prompt: "b" }),
  ]);

  // Concurrent runs consume the scripted responses in nondeterministic
  // order, so assert set equality: each response arrives exactly once.
  assertEquals(new Set(results), new Set(["Result A.", "Result B."]));
});

Deno.test("subagent - propagates sub-agent errors", async () => {
  const model = new StubModel([]);
  const delegate = subagent({
    name: "delegate",
    description: "Delegate a task.",
    agent: stubAgent(model),
  });

  await assertRejects(
    () => delegate.call({ prompt: "go" }),
    Error,
    "No scripted response left",
  );
});

Deno.test("subagent - aborting the tool call aborts the sub-agent run", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  let childSignal: AbortSignal | undefined;
  const hanging: BaseModel<string> = {
    generate(args: unknown) {
      childSignal = (args as { signal?: AbortSignal }).signal;
      controller.abort(reason);
      return new Promise(() => {});
    },
    stream: () => Promise.reject(new Error("Not implemented")),
  };
  const delegate = subagent({
    name: "delegate",
    description: "Delegate a task.",
    agent: agent({ model: hanging, modelId: "stub", systemPrompt: "" }),
  });

  const error = await assertRejects(() =>
    delegate.call({ prompt: "go" }, { signal: controller.signal })
  );

  assertEquals(error, reason);
  assertEquals(childSignal?.aborted, true);
});

Deno.test("subagent - a parent run abort reaches every in-flight sub-agent", async () => {
  const controller = new AbortController();
  const childSignals: AbortSignal[] = [];
  const hanging: BaseModel<string> = {
    generate(args: unknown) {
      childSignals.push((args as { signal: AbortSignal }).signal);
      if (childSignals.length === 2) controller.abort();
      return new Promise(() => {});
    },
    stream: () => Promise.reject(new Error("Not implemented")),
  };
  const delegate = subagent({
    name: "delegate",
    description: "Delegate a task.",
    agent: agent({ model: hanging, modelId: "stub", systemPrompt: "" }),
  });
  const calls = [
    { id: "a", name: "delegate", props: { prompt: "a" } as unknown as JSONSchema },
    { id: "b", name: "delegate", props: { prompt: "b" } as unknown as JSONSchema },
  ];
  const parent = agent({
    model: new StubModel([[{
      role: "model",
      contents: calls.map((toolCall) => ({ toolCall })),
      toolCalls: calls,
    }]]),
    modelId: "stub",
    systemPrompt: "",
    tools: [delegate],
  });

  const error = await assertRejects(() =>
    parent.run("go", [], { signal: controller.signal })
  );

  assertEquals((error as DOMException).name, "AbortError");
  assertEquals(childSignals.length, 2);
  assertEquals(childSignals.every((signal) => signal.aborted), true);
});
