import { expect, test } from "vite-plus/test";
import {
  BlockedReason,
  type Content,
  FinishReason,
  type GenerateContentResponse,
} from "@google/genai";
import { object, string } from "@huuma/validate";
import { tool } from "../../src/tools/mod.ts";
import { genAIContentsFrom, googleToolsFrom, googleUsageFrom, modelMessagesFrom } from "./mod.ts";
import type { Message } from "../../src/mod.ts";

function responseFrom(partial: Partial<GenerateContentResponse>): GenerateContentResponse {
  return partial as GenerateContentResponse;
}

test("googleToolsFrom converts tools to function declarations", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: object({ query: string() }),
    fn: () => "result",
  });

  expect(googleToolsFrom([testTool]) as unknown).toStrictEqual([
    {
      functionDeclarations: [
        {
          name: "test_tool",
          description: "A test tool",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      ],
    },
  ]);
});

test("googleToolsFrom reuses the tool's cached JSON Schema", () => {
  const testTool = tool({
    name: "test_tool",
    description: "A test tool",
    input: object({ query: string() }),
    fn: () => "result",
  });

  const [first] = googleToolsFrom([testTool]);
  const [second] = googleToolsFrom([testTool]);
  // Gemini's Tool type is a union; the function-declaration branch carries
  // the parameters schema.
  const firstParameters = (first as { functionDeclarations?: [{ parameters?: object }] })
    .functionDeclarations?.[0]?.parameters;
  const secondParameters = (second as { functionDeclarations?: [{ parameters?: object }] })
    .functionDeclarations?.[0]?.parameters;
  expect(firstParameters === secondParameters).toBe(true);
  expect(firstParameters === (testTool.jsonSchema as object)).toBe(true);
});

test("genAIContentsFrom maps user and model roles through", () => {
  const messages: Message[] = [
    { role: "user", contents: "Hello!" },
    { role: "model", contents: [{ text: "Hi there." }], toolCalls: [] },
  ];

  const contents = genAIContentsFrom(messages) as Content[];

  expect(contents).toStrictEqual([
    { role: "user", parts: [{ text: "Hello!" }] },
    { role: "model", parts: [{ text: "Hi there." }] },
  ]);
});

test("genAIContentsFrom sends system messages as user content", () => {
  const messages: Message[] = [{ role: "system", contents: "Be concise." }];

  const contents = genAIContentsFrom(messages) as Content[];

  expect(contents).toStrictEqual([{ role: "user", parts: [{ text: "Be concise." }] }]);
});

test("genAIContentsFrom maps file data to inlineData parts", () => {
  const messages: Message[] = [
    {
      role: "user",
      contents: [
        { text: "What is in this image?" },
        { file: { mimeType: "image/png", data: "aGVsbG8=" } },
      ],
    },
  ];

  const contents = genAIContentsFrom(messages) as Content[];

  expect(contents).toStrictEqual([
    {
      role: "user",
      parts: [
        { text: "What is in this image?" },
        { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
      ],
    },
  ]);
});

test("genAIContentsFrom maps file URLs to fileData parts", () => {
  const messages: Message[] = [
    {
      role: "user",
      contents: [
        {
          file: { mimeType: "application/pdf", url: "https://example.com/a.pdf" },
        },
      ],
    },
  ];

  const contents = genAIContentsFrom(messages) as Content[];

  expect(contents).toStrictEqual([
    {
      role: "user",
      parts: [
        {
          fileData: { fileUri: "https://example.com/a.pdf", mimeType: "application/pdf" },
        },
      ],
    },
  ]);
});

test("genAIContentsFrom passes video data through without filtering", () => {
  const messages: Message[] = [
    {
      role: "user",
      contents: [{ file: { mimeType: "video/mp4", data: "aGVsbG8=" } }],
    },
  ];

  const contents = genAIContentsFrom(messages) as Content[];

  expect(contents).toStrictEqual([
    {
      role: "user",
      parts: [{ inlineData: { mimeType: "video/mp4", data: "aGVsbG8=" } }],
    },
  ]);
});

test("genAIContentsFrom throws when a file sets both data and url", () => {
  const messages: Message[] = [
    {
      role: "user",
      contents: [
        {
          file: {
            mimeType: "image/png",
            data: "aGVsbG8=",
            url: "https://example.com/a.png",
          },
        },
      ],
    },
  ];

  expect(() => genAIContentsFrom(messages)).toThrow(RangeError);
  expect(() => genAIContentsFrom(messages)).toThrow("exactly one of data or url");
});

test("genAIContentsFrom maps tool messages to user functionResponse parts", () => {
  const messages: Message[] = [
    {
      role: "tool",
      contents: [
        {
          toolResult: {
            id: "call-1",
            name: "lookup",
            result: { output: "found" },
          },
        },
      ],
    },
  ];

  const contents = genAIContentsFrom(messages) as Content[];

  expect(contents[0]).toStrictEqual({
    role: "user",
    parts: [
      {
        functionResponse: {
          id: "call-1",
          name: "lookup",
          response: { output: "found" },
        },
      },
    ],
  });
});

test("genAIContentsFrom maps tool result file data to inlineData parts", () => {
  const messages: Message[] = [
    {
      role: "tool",
      contents: [
        {
          toolResult: {
            id: "call-1",
            name: "screenshot",
            result: { output: "captured" },
            files: [{ file: { mimeType: "image/png", data: "aGVsbG8=" } }],
          },
        },
      ],
    },
  ];

  const contents = genAIContentsFrom(messages) as Content[];

  expect(contents[0]).toStrictEqual({
    role: "user",
    parts: [
      {
        functionResponse: {
          id: "call-1",
          name: "screenshot",
          response: { output: "captured" },
          parts: [{ inlineData: { mimeType: "image/png", data: "aGVsbG8=" } }],
        },
      },
    ],
  });
});

test("genAIContentsFrom maps tool result file URLs to fileData parts", () => {
  const messages: Message[] = [
    {
      role: "tool",
      contents: [
        {
          toolResult: {
            id: "call-1",
            name: "screenshot",
            result: { output: "captured" },
            files: [
              {
                file: { mimeType: "image/png", url: "https://example.com/a.png" },
              },
            ],
          },
        },
      ],
    },
  ];

  const contents = genAIContentsFrom(messages) as Content[];

  expect(contents[0]).toStrictEqual({
    role: "user",
    parts: [
      {
        functionResponse: {
          id: "call-1",
          name: "screenshot",
          response: { output: "captured" },
          parts: [
            {
              fileData: {
                fileUri: "https://example.com/a.png",
                mimeType: "image/png",
              },
            },
          ],
        },
      },
    ],
  });
});

test("genAIContentsFrom throws on tool result files with both data and url", () => {
  const messages: Message[] = [
    {
      role: "tool",
      contents: [
        {
          toolResult: {
            id: "call-1",
            name: "screenshot",
            result: { output: "captured" },
            files: [
              {
                file: {
                  mimeType: "image/png",
                  data: "aGVsbG8=",
                  url: "https://example.com/a.png",
                },
              },
            ],
          },
        },
      ],
    },
  ];

  expect(() => genAIContentsFrom(messages)).toThrow(RangeError);
  expect(() => genAIContentsFrom(messages)).toThrow("exactly one of data or url");
});

test("modelMessagesFrom keeps thinking out of contents", () => {
  const [message] = modelMessagesFrom(
    responseFrom({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "Let me think. ", thought: true },
              { text: "Still thinking.", thought: true },
              { text: "The answer is 42." },
            ],
          },
          finishReason: FinishReason.STOP,
        },
      ],
    }),
  );

  expect(message.thinking).toStrictEqual("Let me think. Still thinking.");
  expect(message.contents).toStrictEqual([{ text: "The answer is 42." }]);
});

test("thought signatures round-trip onto their own parts", () => {
  const messages = modelMessagesFrom(
    responseFrom({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: { id: "call-1", name: "first", args: {} },
                thoughtSignature: "sig-1",
              },
              {
                functionCall: { id: "call-2", name: "second", args: {} },
                thoughtSignature: "sig-2",
              },
            ],
          },
          finishReason: FinishReason.STOP,
        },
      ],
    }),
  );

  const contents = genAIContentsFrom(messages) as Content[];

  expect(contents[0].parts).toStrictEqual([
    {
      thoughtSignature: "sig-1",
      functionCall: { id: "call-1", name: "first", args: {} },
    },
    {
      thoughtSignature: "sig-2",
      functionCall: { id: "call-2", name: "second", args: {} },
    },
  ]);
});

test("thought signatures on thought parts carry over to the next part", () => {
  const messages = modelMessagesFrom(
    responseFrom({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "Thinking.", thought: true, thoughtSignature: "sig-text" },
              { text: "The answer is 42." },
            ],
          },
          finishReason: FinishReason.STOP,
        },
      ],
    }),
  );

  const contents = genAIContentsFrom(messages) as Content[];

  expect(contents[0].parts).toStrictEqual([
    { thoughtSignature: "sig-text", text: "The answer is 42." },
  ]);
});

test("modelMessagesFrom throws when the prompt is blocked", () => {
  const response = responseFrom({
    promptFeedback: { blockReason: BlockedReason.SAFETY },
  });

  expect(() => modelMessagesFrom(response)).toThrow(Error);
  expect(() => modelMessagesFrom(response)).toThrow("block reason: SAFETY");
});

test("modelMessagesFrom throws on empty candidate with non-stop finish reason", () => {
  const response = responseFrom({
    candidates: [{ finishReason: FinishReason.MAX_TOKENS }],
  });

  expect(() => modelMessagesFrom(response)).toThrow(Error);
  expect(() => modelMessagesFrom(response)).toThrow("finish reason: MAX_TOKENS");
});

test("modelMessagesFrom returns no messages for an empty stop candidate", () => {
  const messages = modelMessagesFrom(
    responseFrom({
      candidates: [{ finishReason: FinishReason.STOP }],
    }),
  );

  expect(messages).toStrictEqual([]);
});

test("googleUsageFrom maps usage metadata to normalized usage", () => {
  expect(
    googleUsageFrom({
      promptTokenCount: 9,
      candidatesTokenCount: 12,
      totalTokenCount: 30,
      cachedContentTokenCount: 4,
      thoughtsTokenCount: 9,
    }),
  ).toStrictEqual({
    inputTokens: 9,
    outputTokens: 12,
    totalTokens: 30,
    cacheReadInputTokens: 4,
    thinkingTokens: 9,
  });
});

test("googleUsageFrom only maps reported fields", () => {
  expect(googleUsageFrom({ promptTokenCount: 9, totalTokenCount: 9 })).toStrictEqual({
    inputTokens: 9,
    totalTokens: 9,
  });
});

test("googleUsageFrom returns undefined without usage metadata", () => {
  expect(googleUsageFrom(undefined)).toStrictEqual(undefined);
  expect(googleUsageFrom({})).toStrictEqual(undefined);
});
