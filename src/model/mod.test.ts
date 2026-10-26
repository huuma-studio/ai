import { expect, test } from "vite-plus/test";
import { sumModelUsage } from "./mod.ts";

test("sumModelUsage sums all reported fields", () => {
  expect(
    sumModelUsage(
      {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadInputTokens: 2,
        cacheWriteInputTokens: 1,
        thinkingTokens: 3,
      },
      {
        inputTokens: 20,
        outputTokens: 7,
        totalTokens: 27,
        cacheReadInputTokens: 4,
        cacheWriteInputTokens: 2,
        thinkingTokens: 5,
      },
    ),
  ).toStrictEqual({
    inputTokens: 30,
    outputTokens: 12,
    totalTokens: 42,
    cacheReadInputTokens: 6,
    cacheWriteInputTokens: 3,
    thinkingTokens: 8,
  });
});

test("sumModelUsage keeps unreported fields absent", () => {
  expect(
    sumModelUsage({ inputTokens: 10, totalTokens: 10 }, { outputTokens: 5, totalTokens: 5 }),
  ).toStrictEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
});

test("sumModelUsage skips undefined entries", () => {
  expect(sumModelUsage(undefined, { inputTokens: 10 }, undefined)).toStrictEqual({
    inputTokens: 10,
  });
});

test("sumModelUsage returns undefined without any usage", () => {
  expect(sumModelUsage()).toStrictEqual(undefined);
  expect(sumModelUsage(undefined, undefined)).toStrictEqual(undefined);
});

test("sumModelUsage treats empty usage objects as no usage", () => {
  expect(sumModelUsage({})).toStrictEqual(undefined);
  expect(sumModelUsage({}, undefined, {})).toStrictEqual(undefined);
  expect(sumModelUsage({}, { inputTokens: 10 })).toStrictEqual({ inputTokens: 10 });
});

test("sumModelUsage does not mutate its inputs", () => {
  const first = { inputTokens: 10 };
  const second = { inputTokens: 20 };

  sumModelUsage(first, second);

  expect(first).toStrictEqual({ inputTokens: 10 });
  expect(second).toStrictEqual({ inputTokens: 20 });
});
