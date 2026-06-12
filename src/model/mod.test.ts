import { assertEquals } from "@std/assert";
import { sumModelUsage } from "@/model/mod.ts";

Deno.test("sumModelUsage sums all reported fields", () => {
  assertEquals(
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
    {
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      cacheReadInputTokens: 6,
      cacheWriteInputTokens: 3,
      thinkingTokens: 8,
    },
  );
});

Deno.test("sumModelUsage keeps unreported fields absent", () => {
  assertEquals(
    sumModelUsage(
      { inputTokens: 10, totalTokens: 10 },
      { outputTokens: 5, totalTokens: 5 },
    ),
    { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  );
});

Deno.test("sumModelUsage skips undefined entries", () => {
  assertEquals(
    sumModelUsage(undefined, { inputTokens: 10 }, undefined),
    { inputTokens: 10 },
  );
});

Deno.test("sumModelUsage returns undefined without any usage", () => {
  assertEquals(sumModelUsage(), undefined);
  assertEquals(sumModelUsage(undefined, undefined), undefined);
});

Deno.test("sumModelUsage treats empty usage objects as no usage", () => {
  assertEquals(sumModelUsage({}), undefined);
  assertEquals(sumModelUsage({}, undefined, {}), undefined);
  assertEquals(sumModelUsage({}, { inputTokens: 10 }), { inputTokens: 10 });
});

Deno.test("sumModelUsage does not mutate its inputs", () => {
  const first = { inputTokens: 10 };
  const second = { inputTokens: 20 };

  sumModelUsage(first, second);

  assertEquals(first, { inputTokens: 10 });
  assertEquals(second, { inputTokens: 20 });
});
