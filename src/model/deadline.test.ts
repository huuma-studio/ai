import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { deadlineFrom } from "./deadline.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("deadline - neither signal nor timeout leaves the request uncancelled", () => {
  const deadline = deadlineFrom({});
  assertStrictEquals(deadline.signal, undefined);
  // Disarming a deadline that was never armed must be safe.
  deadline.clear();
});

Deno.test("deadline - the caller's signal and reason reach the combined signal", () => {
  const caller = new AbortController();
  const deadline = deadlineFrom({ signal: caller.signal });
  assert(deadline.signal);
  // Without a timeout the caller's own signal passes through untouched.
  assertStrictEquals(deadline.signal, caller.signal);
  assertEquals(deadline.signal.aborted, false);

  const reason = new Error("stop");
  caller.abort(reason);

  assertEquals(deadline.signal.aborted, true);
  assertStrictEquals(deadline.signal.reason, reason);
});

Deno.test("deadline - expiry aborts the combined signal with a TimeoutError", async () => {
  const caller = new AbortController();
  const deadline = deadlineFrom({ signal: caller.signal, timeout: 20 });

  await sleep(60);

  assertEquals(deadline.signal?.aborted, true);
  const reason = deadline.signal?.reason;
  assertInstanceOf(reason, DOMException);
  assertEquals(reason.name, "TimeoutError");
  assertEquals(reason.message, "The model call timed out");
  // The deadline is the call's own: the caller's signal stays unaborting.
  assertEquals(caller.signal.aborted, false);
});

Deno.test("deadline - a caller abort wins over a pending deadline", () => {
  const caller = new AbortController();
  const reason = new Error("stop");
  caller.abort(reason);

  const deadline = deadlineFrom({ signal: caller.signal, timeout: 20 });

  assertStrictEquals(deadline.signal?.reason, reason);
});

Deno.test("deadline - clear() disarms the deadline before it fires", async () => {
  const deadline = deadlineFrom({ timeout: 20 });
  deadline.clear();

  await sleep(60);

  assertEquals(deadline.signal?.aborted, false);
  deadline.clear();
});

Deno.test("deadline - a timeout of 0 expires immediately", () => {
  const deadline = deadlineFrom({ timeout: 0 });
  assertEquals(deadline.signal?.aborted, true);
  const reason = deadline.signal?.reason;
  assertInstanceOf(reason, DOMException);
  assertEquals(reason.name, "TimeoutError");
  assertEquals(reason.message, "The model call timed out");
});

Deno.test("deadline - invalid timeouts throw TypeError", () => {
  for (const timeout of [-1, -Infinity, NaN, Infinity]) {
    assertThrows(
      () => deadlineFrom({ timeout }),
      TypeError,
      "Model timeout must be a finite, non-negative number",
    );
  }
});

Deno.test("deadline - errorFrom() swaps an SDK abort error for the signal's reason", async () => {
  const deadline = deadlineFrom({ timeout: 20 });
  const sdkError = new Error("Request was aborted.");
  assertStrictEquals(deadline.errorFrom(sdkError), sdkError);

  await sleep(60);

  const error = deadline.errorFrom(sdkError);
  assertInstanceOf(error, DOMException);
  assertEquals(error.name, "TimeoutError");
});

Deno.test("deadline - errorFrom() keeps the caller's reason when the caller aborts first", () => {
  const caller = new AbortController();
  const deadline = deadlineFrom({ signal: caller.signal, timeout: 10_000 });
  const reason = new Error("stop");
  caller.abort(reason);

  assertStrictEquals(deadline.errorFrom(new Error("SDK abort")), reason);
  deadline.clear();
});

Deno.test("deadline - guard() ends a failing stream with the deadline's reason and disarms it", async () => {
  const deadline = deadlineFrom({ timeout: 20 });
  async function* stalls() {
    yield 1;
    await sleep(60);
    throw new Error("Request was aborted.");
  }

  const stream = deadline.guard(stalls());
  assertEquals(await stream.next(), { value: 1, done: false });
  const error = await stream.next().catch((error) => error);

  assertInstanceOf(error, DOMException);
  assertEquals(error.name, "TimeoutError");
});

Deno.test("deadline - guard() disarms the deadline when the stream is closed early", async () => {
  const deadline = deadlineFrom({ timeout: 20 });
  async function* endless() {
    while (true) yield 1;
  }

  const stream = deadline.guard(endless());
  await stream.next();
  await stream.return(undefined);
  await sleep(60);

  assertEquals(deadline.signal?.aborted, false);
});
