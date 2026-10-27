import { expect, test } from "vite-plus/test";
import { abortable } from "./abortable.ts";

/** Collects every item of an async iterable (`Array.fromAsync` is not in
 * the configured TypeScript lib). */
async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function* source<T>(items: T[], closed: { value: boolean }) {
  try {
    for (const item of items) yield item;
  } finally {
    closed.value = true;
  }
}

test("abortable - yields everything when the signal never aborts", async () => {
  const closed = { value: false };
  const results = await collect(abortable(source([1, 2, 3], closed), new AbortController().signal));
  expect(results).toStrictEqual([1, 2, 3]);
  expect(closed.value).toBe(true);
});

test("abortable - passes the stream through without a signal", async () => {
  const closed = { value: false };
  expect(await collect(abortable(source([1, 2], closed)))).toStrictEqual([1, 2]);
});

test("abortable - delivers nothing after an abort between buffered results", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  const closed = { value: false };
  const stream = abortable(source(["a", "b", "c"], closed), controller.signal);

  expect((await stream.next()).value).toBe("a");
  controller.abort(reason);

  const error = await stream.next().then(
    () => expect.fail("expected the stream to reject"),
    (e: unknown) => e,
  );
  expect(error).toBe(reason);
  expect(closed.value).toBe(true);
  expect(await stream.next()).toStrictEqual({ done: true, value: undefined });
});

test("abortable - a source that ends quietly after an abort still throws", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  // Mimics SDKs that swallow the abort and simply end iteration.
  async function* quiet() {
    yield "a";
    controller.abort(reason);
  }
  const stream = abortable(quiet(), controller.signal);

  expect((await stream.next()).value).toBe("a");
  const error = await stream.next().then(
    () => expect.fail("expected the stream to reject"),
    (e: unknown) => e,
  );
  expect(error).toBe(reason);
});
