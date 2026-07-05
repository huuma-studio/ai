import { assertEquals, assertThrows } from "@std/assert";
import { flattenResult } from "@/tools/mcp/content.ts";

Deno.test("flattenResult - joins text blocks with newlines", () => {
  assertEquals(
    flattenResult({
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    }),
    "one\ntwo",
  );
});

Deno.test("flattenResult - structuredContent wins over text blocks", () => {
  assertEquals(
    flattenResult({
      content: [{ type: "text", text: "duplicate rendering" }],
      structuredContent: { sum: 3 },
    }),
    JSON.stringify({ sum: 3 }),
  );
});

Deno.test("flattenResult - non-text blocks degrade to placeholders", () => {
  assertEquals(
    flattenResult({
      content: [
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "audio", data: "aGk=", mimeType: "audio/wav" },
        { type: "resource_link", uri: "file:///a.txt" },
        { type: "resource", resource: { uri: "file:///b.txt" } },
        { type: "text", text: "caption" },
      ],
    }),
    "[image image/png]\n[audio audio/wav]\n[resource file:///a.txt]\n" +
      "[resource file:///b.txt]\ncaption",
  );
});

Deno.test("flattenResult - isError throws with joined text", () => {
  assertThrows(
    () =>
      flattenResult({
        content: [{ type: "text", text: "boom" }],
        isError: true,
      }),
    Error,
    "boom",
  );
});

Deno.test("flattenResult - isError without text uses a fallback message", () => {
  assertThrows(
    () => flattenResult({ content: [], isError: true }),
    Error,
    "MCP tool call failed",
  );
});

Deno.test("flattenResult - empty content flattens to empty string", () => {
  assertEquals(flattenResult({ content: [] }), "");
  assertEquals(flattenResult({}), "");
});
