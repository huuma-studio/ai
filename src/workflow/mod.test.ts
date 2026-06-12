import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { decision, step, workflow, WorkflowStatus } from "@/workflow/mod.ts";

Deno.test("workflow runs chained steps sequentially", async () => {
  const double = step((n: number) => n * 2);
  const increment = step((n: number) => n + 1);
  double.next(increment);

  const w = workflow({ name: "math", state: 5, start: double });

  assertEquals(w.status, WorkflowStatus.CREATED);
  assertEquals(await w.start(), 11);
  assertEquals(w.status, WorkflowStatus.COMPLETED);
  assertEquals(w.stepsCount, 2);
});

Deno.test("workflow sets status to FAILED and rethrows on step error", async () => {
  const boom = step((_: number): number => {
    throw new Error("boom");
  });
  const w = workflow({ name: "failing", state: 1, start: boom });

  await assertRejects(() => w.start(), Error, "boom");
  assertEquals(w.status, WorkflowStatus.FAILED);
});

Deno.test("workflow cannot be started while running", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const wait = step(async (n: number) => {
    await gate;
    return n;
  });
  const w = workflow({ name: "running", state: 1, start: wait });

  const first = w.start();
  await assertRejects(() => w.start(), Error, "currently running");
  release();
  assertEquals(await first, 1);
});

Deno.test("next throws when step already has a next", () => {
  const a = step((n: number) => n);
  a.next(step((n: number) => n));
  assertThrows(
    () => a.next(step((n: number) => n)),
    Error,
    "already has a next",
  );
});

Deno.test("workflow enforces maxSteps", async () => {
  const a = step((n: number) => n + 1);
  const b = step((n: number) => n + 1);
  const c = step((n: number) => n + 1);
  a.next(b);
  b.next(c);

  const w = workflow({ name: "limited", state: 0, maxSteps: 2, start: a });

  await assertRejects(() => w.start(), Error, "Maximum number of steps");
  assertEquals(w.status, WorkflowStatus.FAILED);
  assertEquals(w.stepsCount, 2);
});

Deno.test("start state argument overrides configured state", async () => {
  const double = step((n: number) => n * 2);
  const w = workflow({ name: "override", state: 5, start: double });

  assertEquals(await w.start(10), 20);
});

Deno.test("workflow accepts falsy configured state", async () => {
  const increment = step((n: number) => n + 1);
  const w = workflow({ name: "falsy-state", state: 0, start: increment });

  assertEquals(await w.start(), 1);
});

Deno.test("workflow accepts falsy start state argument", async () => {
  const increment = step((n: number) => n + 1);
  const w = workflow({ name: "falsy-arg", start: increment });

  assertEquals(await w.start(0), 1);
});

Deno.test("start rejects when no state is available", async () => {
  const increment = step((n: number) => n + 1);
  const w = workflow({ name: "no-state", start: increment });

  await assertRejects(() => w.start(), Error, "State must be present");
});

Deno.test("stepsCount resets between runs", async () => {
  const increment = step((n: number) => n + 1);
  const w = workflow({ name: "rerun", state: 1, start: increment });

  await w.start();
  assertEquals(w.stepsCount, 1);
  await w.start();
  assertEquals(w.stepsCount, 1);
});

Deno.test("decision executes the matching branch", async () => {
  const evenPath = step((n: number) => n * 2);
  const oddPath = step((n: number) => n + 1);
  const d = decision({
    condition: (n: number) => n % 2 === 0,
    then: evenPath,
    else: oddPath,
  });

  const even = workflow({ name: "even", state: 4, start: d });
  assertEquals(await even.start(), 8);

  const odd = workflow({ name: "odd", state: 3, start: d });
  assertEquals(await odd.start(), 4);
});

Deno.test("decision counts toward stepsCount", async () => {
  const d = decision({
    condition: (n: number) => n > 0,
    then: step((n: number) => n * 2),
    else: step((n: number) => n),
  });
  const w = workflow({ name: "decision-count", state: 2, start: d });

  await w.start();
  assertEquals(w.stepsCount, 2);
});

Deno.test("next returns the attached callable for fluent chaining", async () => {
  const a = step((n: number) => n + 1);
  const b = step((n: number) => n * 2);
  const c = step((n: number) => n - 3);

  assertEquals(a.next(b), b);
  b.next(c);

  const w = workflow({ name: "fluent", state: 1, start: a });
  assertEquals(await w.start(), 1);
});
