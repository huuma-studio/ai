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
  assertEquals(reason.message, "The operation was aborted due to timeout");
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
