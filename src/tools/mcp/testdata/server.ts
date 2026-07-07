/**
 * Minimal MCP stdio server used by mcp_stdio.test.ts.
 *
 * Dev-only fixture (excluded from publish via the testdata exclude);
 * deliberately not named *_test.ts so the test runner never executes it.
 * Uses the SDK's low-level Server so no schema library is needed.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  {
    name: "add",
    description: "Add two numbers.",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
  {
    name: "echo_json",
    description: "Echo a value as structured content.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
    outputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    },
  },
  {
    name: "fail",
    description: "Always fails.",
    inputSchema: { type: "object", properties: {} },
  },
];

const server = new Server(
  { name: "huuma-test-fixture", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(
  CallToolRequestSchema,
  (
    request: {
      params: { name: string; arguments?: Record<string, unknown> };
    },
  ) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "add": {
        const sum = Number(args?.a) + Number(args?.b);
        return { content: [{ type: "text", text: String(sum) }] };
      }
      case "echo_json":
        return {
          content: [{ type: "text", text: JSON.stringify(args) }],
          structuredContent: { value: args?.value },
        };
      case "fail":
        return {
          content: [{ type: "text", text: "boom" }],
          isError: true,
        };
      default:
        return { content: [{ type: "text", text: "ok" }] };
    }
  },
);

await server.connect(new StdioServerTransport());
