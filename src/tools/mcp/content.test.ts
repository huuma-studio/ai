import { expect, test } from "vite-plus/test";
import { flattenResult } from "./content.ts";
import { ToolOutput } from "../mod.ts";

test("flattenResult - joins text blocks with newlines", () => {
  expect(
    flattenResult({
      content: [
        { type: "text", text: "one" },
        { type: "text", text: "two" },
      ],
    }),
  ).toBe("one\ntwo");
});

test("flattenResult - structuredContent wins over text blocks", () => {
  expect(
    flattenResult({
      content: [{ type: "text", text: "duplicate rendering" }],
      structuredContent: { sum: 3 },
    }),
  ).toBe(JSON.stringify({ sum: 3 }));
});

test("flattenResult - image and audio blocks become files, in order", () => {
  const result = flattenResult({
    content: [
      { type: "image", data: "aW1n", mimeType: "image/png" },
      { type: "text", text: "caption" },
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
    ],
  });

  expect(result).toBeInstanceOf(ToolOutput);
  if (!(result instanceof ToolOutput)) return;
  expect(result.output).toStrictEqual("caption");
  expect(result.files).toStrictEqual([
    { file: { mimeType: "image/png", data: "aW1n" } },
    { file: { mimeType: "audio/wav", data: "YXVkaW8=" } },
  ]);
});

test("flattenResult - media-only content yields empty output with files", () => {
  const result = flattenResult({
    content: [{ type: "image", data: "aW1n", mimeType: "image/jpeg" }],
  });

  expect(result).toBeInstanceOf(ToolOutput);
  if (!(result instanceof ToolOutput)) return;
  expect(result.output).toStrictEqual("");
  expect(result.files).toStrictEqual([{ file: { mimeType: "image/jpeg", data: "aW1n" } }]);
});

test("flattenResult - structuredContent and files combine", () => {
  const result = flattenResult({
    content: [
      { type: "text", text: "duplicate rendering" },
      { type: "image", data: "aW1n", mimeType: "image/png" },
    ],
    structuredContent: { ok: true },
  });

  expect(result).toBeInstanceOf(ToolOutput);
  if (!(result instanceof ToolOutput)) return;
  expect(result.output).toStrictEqual(JSON.stringify({ ok: true }));
  expect(result.files).toStrictEqual([{ file: { mimeType: "image/png", data: "aW1n" } }]);
});

test("flattenResult - resource blocks degrade to placeholders", () => {
  expect(
    flattenResult({
      content: [
        { type: "resource_link", uri: "file:///a.txt" },
        { type: "resource", resource: { uri: "file:///b.txt" } },
        { type: "text", text: "caption" },
      ],
    }),
  ).toBe("[resource file:///a.txt]\n[resource file:///b.txt]\ncaption");
});

test("flattenResult - isError throws with joined text", () => {
  expect(() =>
    flattenResult({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    }),
  ).toThrow("boom");
});

test("flattenResult - isError without text uses a fallback message", () => {
  expect(() => flattenResult({ content: [], isError: true })).toThrow("MCP tool call failed");
});

test("flattenResult - isError without text falls back to structuredContent", () => {
  expect(() =>
    flattenResult({
      content: [],
      structuredContent: { code: 42, reason: "quota exceeded" },
      isError: true,
    }),
  ).toThrow(JSON.stringify({ code: 42, reason: "quota exceeded" }));
});

test("flattenResult - isError text blocks win over structuredContent", () => {
  expect(() =>
    flattenResult({
      content: [{ type: "text", text: "boom" }],
      structuredContent: { code: 42 },
      isError: true,
    }),
  ).toThrow("boom");
});

test("flattenResult - isError with media still throws text-only", () => {
  // callTool's rejection path has no files channel (ADR 0004, resolved
  // question 1), so media on errored results is not forwarded.
  expect(() =>
    flattenResult({
      content: [
        { type: "image", data: "aW1n", mimeType: "image/png" },
        { type: "text", text: "boom" },
      ],
      isError: true,
    }),
  ).toThrow("boom");
});

test("flattenResult - empty content flattens to empty string", () => {
  expect(flattenResult({ content: [] })).toBe("");
  expect(flattenResult({})).toBe("");
});
