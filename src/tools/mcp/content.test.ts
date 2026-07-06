import { assert, assertEquals, assertThrows } from "@std/assert";
import { flattenResult } from "@/tools/mcp/content.ts";
import { ToolOutput } from "@/tools/mod.ts";

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

Deno.test("flattenResult - image and audio blocks become files, in order", () => {
  const result = flattenResult({
    content: [
      { type: "image", data: "aW1n", mimeType: "image/png" },
      { type: "text", text: "caption" },
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
    ],
  });

  assert(result instanceof ToolOutput);
  assertEquals(result.output, "caption");
  assertEquals(result.files, [
    { file: { mimeType: "image/png", data: "aW1n" } },
    { file: { mimeType: "audio/wav", data: "YXVkaW8=" } },
  ]);
});

Deno.test("flattenResult - media-only content yields empty output with files", () => {
  const result = flattenResult({
    content: [{ type: "image", data: "aW1n", mimeType: "image/jpeg" }],
  });

  assert(result instanceof ToolOutput);
  assertEquals(result.output, "");
  assertEquals(result.files, [
    { file: { mimeType: "image/jpeg", data: "aW1n" } },
  ]);
});

Deno.test("flattenResult - structuredContent and files combine", () => {
  const result = flattenResult({
    content: [
      { type: "text", text: "duplicate rendering" },
      { type: "image", data: "aW1n", mimeType: "image/png" },
    ],
    structuredContent: { ok: true },
  });

  assert(result instanceof ToolOutput);
  assertEquals(result.output, JSON.stringify({ ok: true }));
  assertEquals(result.files, [
    { file: { mimeType: "image/png", data: "aW1n" } },
  ]);
});

Deno.test("flattenResult - resource blocks degrade to placeholders", () => {
  assertEquals(
    flattenResult({
      content: [
        { type: "resource_link", uri: "file:///a.txt" },
        { type: "resource", resource: { uri: "file:///b.txt" } },
        { type: "text", text: "caption" },
      ],
    }),
    "[resource file:///a.txt]\n[resource file:///b.txt]\ncaption",
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

Deno.test("flattenResult - isError with media still throws text-only", () => {
  // callTool's rejection path has no files channel (ADR 0004, resolved
  // question 1), so media on errored results is not forwarded.
  assertThrows(
    () =>
      flattenResult({
        content: [
          { type: "image", data: "aW1n", mimeType: "image/png" },
          { type: "text", text: "boom" },
        ],
        isError: true,
      }),
    Error,
    "boom",
  );
});

Deno.test("flattenResult - empty content flattens to empty string", () => {
  assertEquals(flattenResult({ content: [] }), "");
  assertEquals(flattenResult({}), "");
});
