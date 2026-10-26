import { expect, test } from "vite-plus/test";
import { deadlineFrom } from "./deadline.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("deadline - neither signal nor timeout leaves the request uncancelled", () => {
  const deadline = deadlineFrom({});
  expect(deadline.signal).toBe(undefined);
  // Disarming a deadline that was never armed must be safe.
  deadline.clear();
});

test("deadline - the caller's signal and reason reach the combined signal", () => {
  const caller = new AbortController();
  const deadline = deadlineFrom({ signal: caller.signal });
  if (!deadline.signal) return expect.fail("expected a combined signal");
  // Without a timeout the caller's own signal passes through untouched.
  expect(deadline.signal).toBe(caller.signal);
  expect(deadline.signal.aborted).toBe(false);

  const reason = new Error("stop");
  caller.abort(reason);

  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.signal.reason).toBe(reason);
});

test("deadline - expiry aborts the combined signal with a TimeoutError", async () => {
  const caller = new AbortController();
  const deadline = deadlineFrom({ signal: caller.signal, timeout: 20 });

  await sleep(60);

  expect(deadline.signal?.aborted).toBe(true);
  const reason = deadline.signal?.reason;
  expect(reason).toBeInstanceOf(DOMException);
  expect(reason.name).toBe("TimeoutError");
  expect(reason.message).toBe("The model call timed out");
  // The deadline is the call's own: the caller's signal stays unaborting.
  expect(caller.signal.aborted).toBe(false);
});

test("deadline - a caller abort wins over a pending deadline", () => {
  const caller = new AbortController();
  const reason = new Error("stop");
  caller.abort(reason);

  const deadline = deadlineFrom({ signal: caller.signal, timeout: 20 });

  expect(deadline.signal?.reason).toBe(reason);
});

test("deadline - clear() disarms the deadline before it fires", async () => {
  const deadline = deadlineFrom({ timeout: 20 });
  deadline.clear();

  await sleep(60);

  expect(deadline.signal?.aborted).toBe(false);
  deadline.clear();
});

test("deadline - a timeout of 0 expires immediately", () => {
  const deadline = deadlineFrom({ timeout: 0 });
  expect(deadline.signal?.aborted).toBe(true);
  const reason = deadline.signal?.reason;
  expect(reason).toBeInstanceOf(DOMException);
  expect(reason.name).toBe("TimeoutError");
  expect(reason.message).toBe("The model call timed out");
});

test("deadline - invalid timeouts throw TypeError", () => {
  for (const timeout of [-1, -Infinity, NaN, Infinity]) {
    expect(() => deadlineFrom({ timeout })).toThrow(TypeError);
    expect(() => deadlineFrom({ timeout })).toThrow(
      "Model timeout must be a finite, non-negative number",
    );
  }
});

test("deadline - errorFrom() swaps an SDK abort error for the signal's reason", async () => {
  const deadline = deadlineFrom({ timeout: 20 });
  const sdkError = new Error("Request was aborted.");
  expect(deadline.errorFrom(sdkError)).toBe(sdkError);

  await sleep(60);

  const error = deadline.errorFrom(sdkError);
  expect(error).toBeInstanceOf(DOMException);
  expect((error as DOMException).name).toBe("TimeoutError");
});

test("deadline - errorFrom() keeps the caller's reason when the caller aborts first", () => {
  const caller = new AbortController();
  const deadline = deadlineFrom({ signal: caller.signal, timeout: 10_000 });
  const reason = new Error("stop");
  caller.abort(reason);

  expect(deadline.errorFrom(new Error("SDK abort"))).toBe(reason);
  deadline.clear();
});

test("deadline - guard() ends a failing stream with the deadline's reason and disarms it", async () => {
  const deadline = deadlineFrom({ timeout: 20 });
  async function* stalls() {
    yield 1;
    await sleep(60);
    throw new Error("Request was aborted.");
  }

  const stream = deadline.guard(stalls());
  expect(await stream.next()).toStrictEqual({ value: 1, done: false });
  const error = await stream.next().catch((error) => error);

  expect(error).toBeInstanceOf(DOMException);
  expect(error.name).toBe("TimeoutError");
});

test("deadline - guard() disarms the deadline when the stream is closed early", async () => {
  const deadline = deadlineFrom({ timeout: 20 });
  async function* endless() {
    while (true) yield 1;
  }

  const stream = deadline.guard(endless());
  await stream.next();
  await stream.return(undefined);
  await sleep(60);

  expect(deadline.signal?.aborted).toBe(false);
});
