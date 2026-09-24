import { assertEquals, assertRejects, assertStrictEquals } from "@std/assert";
import { abortable } from "@/model/abortable.ts";

async function* source<T>(items: T[], closed: { value: boolean }) {
  try {
    for (const item of items) yield item;
  } finally {
    closed.value = true;
  }
}

Deno.test("abortable - yields everything when the signal never aborts", async () => {
  const closed = { value: false };
  const results = await Array.fromAsync(
    abortable(source([1, 2, 3], closed), new AbortController().signal),
  );
  assertEquals(results, [1, 2, 3]);
  assertEquals(closed.value, true);
});

Deno.test("abortable - passes the stream through without a signal", async () => {
  const closed = { value: false };
  assertEquals(await Array.fromAsync(abortable(source([1, 2], closed))), [
    1,
    2,
  ]);
});

Deno.test("abortable - delivers nothing after an abort between buffered results", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  const closed = { value: false };
  const stream = abortable(source(["a", "b", "c"], closed), controller.signal);

  assertEquals((await stream.next()).value, "a");
  controller.abort(reason);

  const error = await assertRejects(() => stream.next());
  assertStrictEquals(error, reason);
  assertEquals(closed.value, true);
  assertEquals(await stream.next(), { done: true, value: undefined });
});

Deno.test("abortable - a source that ends quietly after an abort still throws", async () => {
  const controller = new AbortController();
  const reason = new Error("stop");
  // Mimics SDKs that swallow the abort and simply end iteration.
  async function* quiet() {
    yield "a";
    controller.abort(reason);
  }
  const stream = abortable(quiet(), controller.signal);

  assertEquals((await stream.next()).value, "a");
  const error = await assertRejects(() => stream.next());
  assertStrictEquals(error, reason);
});
