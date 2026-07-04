import { assertEquals, assertThrows } from "@std/assert";
import {
  BlockedReason,
  type Content,
  FinishReason,
  type GenerateContentResponse,
} from "@google/genai";
import {
  genAIContentsFrom,
  googleUsageFrom,
  modelMessagesFrom,
} from "./mod.ts";
import type { Message } from "@/mod.ts";

function responseFrom(
  partial: Partial<GenerateContentResponse>,
): GenerateContentResponse {
  return partial as GenerateContentResponse;
}

Deno.test("genAIContentsFrom maps user and model roles through", () => {
  const messages: Message[] = [
    { role: "user", contents: "Hello!" },
    { role: "model", contents: [{ text: "Hi there." }], toolCalls: [] },
  ];

  const contents = genAIContentsFrom(messages) as Content[];

  assertEquals(contents, [
    { role: "user", parts: [{ text: "Hello!" }] },
    { role: "model", parts: [{ text: "Hi there." }] },
  ]);
});

Deno.test("genAIContentsFrom sends system messages as user content", () => {
  const messages: Message[] = [
    { role: "system", contents: "Be concise." },
  ];

  const contents = genAIContentsFrom(messages) as Content[];

  assertEquals(contents, [
    { role: "user", parts: [{ text: "Be concise." }] },
  ]);
});

Deno.test("genAIContentsFrom maps file data to inlineData parts", () => {
  const messages: Message[] = [{
    role: "user",
    contents: [
      { text: "What is in this image?" },
      { file: { mimeType: "image/png", data: "aGVsbG8=" } },
    ],
  }];

  const contents = genAIContentsFrom(messages) as Content[];

  assertEquals(contents, [{
    role: "user",
    parts: [
      { text: "What is in this image?" },
      { inlineData: { mimeType: "image/png", data: "aGVsbG8=" } },
    ],
  }]);
});

Deno.test("genAIContentsFrom maps file URLs to fileData parts", () => {
  const messages: Message[] = [{
    role: "user",
    contents: [{
      file: { mimeType: "application/pdf", url: "https://example.com/a.pdf" },
    }],
  }];

  const contents = genAIContentsFrom(messages) as Content[];

  assertEquals(contents, [{
    role: "user",
    parts: [{
      fileData: { fileUri: "https://example.com/a.pdf", mimeType: "application/pdf" },
    }],
  }]);
});

Deno.test("genAIContentsFrom passes video data through without filtering", () => {
  const messages: Message[] = [{
    role: "user",
    contents: [{ file: { mimeType: "video/mp4", data: "aGVsbG8=" } }],
  }];

  const contents = genAIContentsFrom(messages) as Content[];

  assertEquals(contents, [{
    role: "user",
    parts: [{ inlineData: { mimeType: "video/mp4", data: "aGVsbG8=" } }],
  }]);
});

Deno.test("genAIContentsFrom throws when a file sets both data and url", () => {
  const messages: Message[] = [{
    role: "user",
    contents: [{
      file: {
        mimeType: "image/png",
        data: "aGVsbG8=",
        url: "https://example.com/a.png",
      },
    }],
  }];

  assertThrows(
    () => genAIContentsFrom(messages),
    RangeError,
    "exactly one of data or url",
  );
});

Deno.test("genAIContentsFrom maps tool messages to user functionResponse parts", () => {
  const messages: Message[] = [
    {
      role: "tool",
      contents: [{
        toolResult: {
          id: "call-1",
          name: "lookup",
          result: { output: "found" },
        },
      }],
    },
  ];

  const contents = genAIContentsFrom(messages) as Content[];

  assertEquals(contents[0], {
    role: "user",
    parts: [{
      functionResponse: {
        id: "call-1",
        name: "lookup",
        response: { output: "found" },
      },
    }],
  });
});

Deno.test("modelMessagesFrom keeps thinking out of contents", () => {
  const [message] = modelMessagesFrom(responseFrom({
    candidates: [{
      content: {
        role: "model",
        parts: [
          { text: "Let me think. ", thought: true },
          { text: "Still thinking.", thought: true },
          { text: "The answer is 42." },
        ],
      },
      finishReason: FinishReason.STOP,
    }],
  }));

  assertEquals(message.thinking, "Let me think. Still thinking.");
  assertEquals(message.contents, [{ text: "The answer is 42." }]);
});

Deno.test("thought signatures round-trip onto their own parts", () => {
  const messages = modelMessagesFrom(responseFrom({
    candidates: [{
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
    }],
  }));

  const contents = genAIContentsFrom(messages) as Content[];

  assertEquals(contents[0].parts, [
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

Deno.test("thought signatures on thought parts carry over to the next part", () => {
  const messages = modelMessagesFrom(responseFrom({
    candidates: [{
      content: {
        role: "model",
        parts: [
          { text: "Thinking.", thought: true, thoughtSignature: "sig-text" },
          { text: "The answer is 42." },
        ],
      },
      finishReason: FinishReason.STOP,
    }],
  }));

  const contents = genAIContentsFrom(messages) as Content[];

  assertEquals(contents[0].parts, [
    { thoughtSignature: "sig-text", text: "The answer is 42." },
  ]);
});

Deno.test("modelMessagesFrom throws when the prompt is blocked", () => {
  const response = responseFrom({
    promptFeedback: { blockReason: BlockedReason.SAFETY },
  });

  assertThrows(
    () => modelMessagesFrom(response),
    Error,
    "block reason: SAFETY",
  );
});

Deno.test("modelMessagesFrom throws on empty candidate with non-stop finish reason", () => {
  const response = responseFrom({
    candidates: [{ finishReason: FinishReason.MAX_TOKENS }],
  });

  assertThrows(
    () => modelMessagesFrom(response),
    Error,
    "finish reason: MAX_TOKENS",
  );
});

Deno.test("modelMessagesFrom returns no messages for an empty stop candidate", () => {
  const messages = modelMessagesFrom(responseFrom({
    candidates: [{ finishReason: FinishReason.STOP }],
  }));

  assertEquals(messages, []);
});

Deno.test("googleUsageFrom maps usage metadata to normalized usage", () => {
  assertEquals(
    googleUsageFrom({
      promptTokenCount: 9,
      candidatesTokenCount: 12,
      totalTokenCount: 30,
      cachedContentTokenCount: 4,
      thoughtsTokenCount: 9,
    }),
    {
      inputTokens: 9,
      outputTokens: 12,
      totalTokens: 30,
      cacheReadInputTokens: 4,
      thinkingTokens: 9,
    },
  );
});

Deno.test("googleUsageFrom only maps reported fields", () => {
  assertEquals(
    googleUsageFrom({ promptTokenCount: 9, totalTokenCount: 9 }),
    { inputTokens: 9, totalTokens: 9 },
  );
});

Deno.test("googleUsageFrom returns undefined without usage metadata", () => {
  assertEquals(googleUsageFrom(undefined), undefined);
  assertEquals(googleUsageFrom({}), undefined);
});
