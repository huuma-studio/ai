import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
// Dev-only SDK imports for the in-process server; publish excludes tests.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mcp, type McpTransport } from "@/tools/mcp/mcp.ts";
import { callTool, ToolOutput, tools } from "@/tools/mod.ts";
import { agent } from "@/agent/mod.ts";
import type {
  BaseModel,
  JSONSchema,
  Message,
  ModelResult,
} from "@/agent/mod.ts";

interface ToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

const ECHO_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" } },
  required: ["message"],
};

/**
 * In-process fixture: a real SDK server wired to the client through
 * InMemoryTransport, passed via the custom-transport escape hatch.
 * Returns the mutable tool list and a record of original names the
 * server was called with.
 */
async function connectFixture(
  options: { allowedTools?: string[] } = {},
) {
  const defs: ToolDef[] = [
    { name: "echo", inputSchema: ECHO_SCHEMA },
    {
      name: "add",
      description: "Add two numbers.",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      outputSchema: {
        type: "object",
        properties: { sum: { type: "number" } },
        required: ["sum"],
      },
    },
    { name: "fail", inputSchema: { type: "object", properties: {} } },
    { name: "picture", inputSchema: { type: "object", properties: {} } },
    {
      name:
        "a_tool_with_an_extremely_long_name_that_exceeds_the_provider_limit",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  const calledWith: string[] = [];

  const server = new Server(
    { name: "huuma-in-memory-fixture", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: defs }));
  server.setRequestHandler(
    CallToolRequestSchema,
    (
      request: {
        params: { name: string; arguments?: Record<string, unknown> };
      },
    ) => {
      const { name, arguments: args } = request.params;
      calledWith.push(name);

      switch (name) {
        case "echo":
          return {
            content: [{ type: "text", text: `echo: ${args?.message}` }],
          };
        case "add": {
          const sum = Number(args?.a) + Number(args?.b);
          return {
            content: [{ type: "text", text: `the sum is ${sum}` }],
            structuredContent: { sum },
          };
        }
        case "fail":
          return { content: [{ type: "text", text: "boom" }], isError: true };
        case "picture":
          return {
            content: [
              { type: "image", data: "aGk=", mimeType: "image/png" },
              { type: "text", text: "a tiny png" },
            ],
          };
        default:
          return { content: [{ type: "text", text: "ok" }] };
      }
    },
  );

  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  await server.connect(serverTransport);

  const connection = await mcp({
    name: "fixture",
    transport: clientTransport as McpTransport,
    ...options,
  });

  return { connection, defs, calledWith };
}

Deno.test("mcp - lists and wraps tools with prefixed names and verbatim schemas", async () => {
  const { connection } = await connectFixture();
  try {
    const names = connection.tools().map((tool) => tool.name);
    assert(names.includes("fixture_echo"), `echo missing in ${names}`);
    assert(names.includes("fixture_add"), `add missing in ${names}`);
    assertEquals(connection.tools().length, 5);

    const echo = connection.tools().find((tool) =>
      tool.name === "fixture_echo"
    );
    assertEquals(echo?.input.jsonSchema(), ECHO_SCHEMA as JSONSchema);
  } finally {
    await connection.close();
  }
});

Deno.test("mcp - calls the server with the original unprefixed name", async () => {
  const { connection, calledWith } = await connectFixture();
  try {
    const echo = connection.tools().find((tool) =>
      tool.name === "fixture_echo"
    );
    assertEquals(await echo?.call({ message: "hi" }), "echo: hi");
    assertEquals(calledWith, ["echo"]);
  } finally {
    await connection.close();
  }
});

Deno.test("mcp - prefers structuredContent over duplicate text", async () => {
  const { connection } = await connectFixture();
  try {
    const add = connection.tools().find((tool) => tool.name === "fixture_add");
    assertEquals(await add?.call({ a: 1, b: 2 }), JSON.stringify({ sum: 3 }));
  } finally {
    await connection.close();
  }
});

Deno.test("mcp - image blocks become files on the tool result", async () => {
  const { connection } = await connectFixture();
  try {
    const picture = connection.tools().find((tool) =>
      tool.name === "fixture_picture"
    );
    const output = await picture?.call({});
    assert(output instanceof ToolOutput);
    assertEquals(output.output, "a tiny png");
    assertEquals(output.files, [
      { file: { mimeType: "image/png", data: "aGk=" } },
    ]);

    // Through callTool, the wrapper unwraps into result.output + files.
    const toolCall = {
      id: "call-1",
      name: "fixture_picture",
      props: {} as unknown as JSONSchema,
    };
    const messages = await callTool(tools(connection.tools()))([
      { role: "model", contents: [{ toolCall }], toolCalls: [toolCall] },
    ]);
    const toolMessage = messages.at(-1);
    assert(toolMessage?.role === "tool");
    const content = toolMessage.contents[0];
    assert("toolResult" in content);
    assertEquals(content.toolResult.result.output, "a tiny png");
    assertEquals(content.toolResult.files, [
      { file: { mimeType: "image/png", data: "aGk=" } },
    ]);
  } finally {
    await connection.close();
  }
});

Deno.test("mcp - isError rejects and lands in the callTool error path", async () => {
  const { connection } = await connectFixture();
  try {
    const fail = connection.tools().find((tool) =>
      tool.name === "fixture_fail"
    );
    await assertRejects(() => fail!.call({}), Error, "boom");

    // Through callTool, the rejection becomes a model-visible tool error.
    const toolCall = {
      id: "call-1",
      name: "fixture_fail",
      props: {} as unknown as JSONSchema,
    };
    const messages = await callTool(tools(connection.tools()))([
      { role: "model", contents: [{ toolCall }], toolCalls: [toolCall] },
    ]);
    const toolMessage = messages.at(-1);
    assert(toolMessage?.role === "tool");
    const content = toolMessage.contents[0];
    assert("toolResult" in content);
    assertStringIncludes(String(content.toolResult.result.error), "boom");
  } finally {
    await connection.close();
  }
});

Deno.test("mcp - allowedTools filters by original name", async () => {
  const { connection } = await connectFixture({ allowedTools: ["echo"] });
  try {
    assertEquals(
      connection.tools().map((tool) => tool.name),
      ["fixture_echo"],
    );
  } finally {
    await connection.close();
  }
});

Deno.test("mcp - caps over-long combined names end-to-end", async () => {
  const { connection } = await connectFixture();
  try {
    const long = connection.tools().find((tool) =>
      tool.name.startsWith("fixture_a_tool_with_an_extremely_long")
    );
    assert(long, "long-named tool missing");
    assertEquals(long.name.length, 64);
    assertMatch(long.name, /^[a-zA-Z0-9_-]{1,64}$/);
  } finally {
    await connection.close();
  }
});

Deno.test("mcp - rejects an invalid server name before connecting", async () => {
  let started = false;
  const transport: McpTransport = {
    // deno-lint-ignore require-await
    start: async () => {
      started = true;
    },
    send: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };

  await assertRejects(
    () => mcp({ name: "bad name!", transport }),
    RangeError,
    "must match",
  );
  assertEquals(started, false);
});

Deno.test("mcp - refresh picks up new tools; prior arrays stay unchanged", async () => {
  const { connection, defs } = await connectFixture();
  try {
    const before = connection.tools();
    assertEquals(before.length, 5);

    defs.push({ name: "extra", inputSchema: { type: "object" } });
    const refreshed = await connection.refresh();

    assert(refreshed.some((tool) => tool.name === "fixture_extra"));
    assertEquals(before.length, 5);
    assertEquals(connection.tools().length, 6);
  } finally {
    await connection.close();
  }
});

Deno.test("mcp - colliding sanitized names throw instead of clobbering", async () => {
  const { connection, defs } = await connectFixture();
  try {
    // Both sanitize to "fixture_repo_search" — silent last-one-wins would
    // hide a tool from the model.
    defs.push(
      { name: "repo.search", inputSchema: { type: "object" } },
      { name: "repo_search", inputSchema: { type: "object" } },
    );
    const error = await assertRejects(() => connection.refresh(), Error);
    assertStringIncludes(error.message, "repo.search");
    assertStringIncludes(error.message, "repo_search");
    assertStringIncludes(error.message, "allowedTools");

    // The prior snapshot stays intact and usable.
    assertEquals(connection.tools().length, 5);
  } finally {
    await connection.close();
  }
});

Deno.test("mcp - agent end-to-end through Agent.run", async () => {
  const { connection, calledWith } = await connectFixture();
  try {
    const toolCall = {
      id: "call-1",
      name: "fixture_add",
      props: { a: 1, b: 2 } as unknown as JSONSchema,
    };
    const responses: Message[][] = [
      [{ role: "model", contents: [{ toolCall }], toolCalls: [toolCall] }],
      [{ role: "model", contents: [{ text: "The sum is 3." }], toolCalls: [] }],
    ];

    const model: BaseModel<string> = {
      generate(args: unknown): Promise<ModelResult<string>> {
        void args;
        const messages = responses.shift();
        return messages
          ? Promise.resolve({ modelId: "stub", messages })
          : Promise.reject(new Error("No scripted response left"));
      },
      stream(): Promise<AsyncGenerator<ModelResult<string>>> {
        return Promise.reject(new Error("Not implemented"));
      },
    };

    const assistant = agent({
      model,
      modelId: "stub",
      systemPrompt: "Use tools.",
      tools: connection.tools(),
    });

    const messages = await assistant.run("Add 1 and 2");

    assertEquals(calledWith, ["add"]);
    const toolMessage = messages.at(-2);
    assert(toolMessage?.role === "tool");
    const content = toolMessage.contents[0];
    assert("toolResult" in content);
    assertEquals(content.toolResult.result.output, JSON.stringify({ sum: 3 }));
    assertEquals(messages.at(-1)?.contents, [{ text: "The sum is 3." }]);
  } finally {
    await connection.close();
  }
});
