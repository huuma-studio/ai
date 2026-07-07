import { assert, assertEquals, assertRejects } from "@std/assert";
import { mcp } from "@/tools/mcp/mcp.ts";

const FIXTURE = new URL("./testdata/server.ts", import.meta.url).pathname;

// Guards the Deno node-compat path (child process spawn, stdio framing) —
// the SDK's least-tested surface under Deno. Deno's sanitizers fail this
// test if the child process leaks past close().
Deno.test("mcp - stdio round-trip against a child-process server", async () => {
  const fixture = await mcp({
    name: "fixture",
    transport: {
      command: Deno.execPath(),
      args: ["run", "--allow-read", "--allow-env", FIXTURE],
    },
  });

  try {
    const names = fixture.tools().map((tool) => tool.name);
    assert(names.includes("fixture_add"), `add missing in ${names}`);
    assert(names.includes("fixture_echo_json"), `echo_json missing`);
    assert(names.includes("fixture_fail"), `fail missing`);

    const add = fixture.tools().find((tool) => tool.name === "fixture_add");
    assertEquals(await add?.call({ a: 1, b: 2 }), "3");
  } finally {
    await fixture.close();
  }
});

// A process that speaks JSON-RPC but rejects the MCP handshake: the child
// is already running when connect() fails, so connect() must close the
// transport — the sanitizers fail this test if the child leaks.
const NOT_AN_MCP_SERVER = `
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  for await (const chunk of Deno.stdin.readable) {
    for (const line of decoder.decode(chunk).split("\\n")) {
      if (!line.trim()) continue;
      const { id } = JSON.parse(line);
      if (id === undefined) continue;
      await Deno.stdout.write(encoder.encode(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "not an MCP server" },
      }) + "\\n"));
    }
  }
`;

Deno.test("mcp - stdio child is cleaned up when the handshake fails", async () => {
  await assertRejects(() =>
    mcp({
      name: "broken",
      transport: {
        command: Deno.execPath(),
        args: ["eval", NOT_AN_MCP_SERVER],
      },
    })
  );
});
