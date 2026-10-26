import { expect, test } from "vite-plus/test";
import { decision, step, workflow, WorkflowStatus } from "./mod.ts";

test("workflow runs chained steps sequentially", async () => {
  const double = step((n: number) => n * 2);
  const increment = step((n: number) => n + 1);
  double.next(increment);

  const w = workflow({ name: "math", state: 5, start: double });

  expect(w.status).toStrictEqual(WorkflowStatus.CREATED);
  expect(await w.start()).toStrictEqual(11);
  expect(w.status).toStrictEqual(WorkflowStatus.COMPLETED);
  expect(w.stepsCount).toStrictEqual(2);
});

test("workflow sets status to FAILED and rethrows on step error", async () => {
  const boom = step((_: number): number => {
    throw new Error("boom");
  });
  const w = workflow({ name: "failing", state: 1, start: boom });

  const error = await w.start().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("boom");
  expect(w.status).toStrictEqual(WorkflowStatus.FAILED);
});

test("workflow cannot be started while running", async () => {
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
  const error = await w.start().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("currently running");
  release();
  expect(await first).toStrictEqual(1);
});

test("next throws when step already has a next", () => {
  const a = step((n: number) => n);
  a.next(step((n: number) => n));
  expect(() => a.next(step((n: number) => n))).toThrow(Error);
  expect(() => a.next(step((n: number) => n))).toThrow("already has a next");
});

test("workflow enforces maxSteps", async () => {
  const a = step((n: number) => n + 1);
  const b = step((n: number) => n + 1);
  const c = step((n: number) => n + 1);
  a.next(b);
  b.next(c);

  const w = workflow({ name: "limited", state: 0, maxSteps: 2, start: a });

  const error = await w.start().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("Maximum number of steps");
  expect(w.status).toStrictEqual(WorkflowStatus.FAILED);
  expect(w.stepsCount).toStrictEqual(2);
});

test("start state argument overrides configured state", async () => {
  const double = step((n: number) => n * 2);
  const w = workflow({ name: "override", state: 5, start: double });

  expect(await w.start(10)).toStrictEqual(20);
});

test("workflow accepts falsy configured state", async () => {
  const increment = step((n: number) => n + 1);
  const w = workflow({ name: "falsy-state", state: 0, start: increment });

  expect(await w.start()).toStrictEqual(1);
});

test("workflow accepts falsy start state argument", async () => {
  const increment = step((n: number) => n + 1);
  const w = workflow({ name: "falsy-arg", start: increment });

  expect(await w.start(0)).toStrictEqual(1);
});

test("start rejects when no state is available", async () => {
  const increment = step((n: number) => n + 1);
  const w = workflow({ name: "no-state", start: increment });

  const error = await w.start().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("State must be present");
});

test("stepsCount resets between runs", async () => {
  const increment = step((n: number) => n + 1);
  const w = workflow({ name: "rerun", state: 1, start: increment });

  await w.start();
  expect(w.stepsCount).toStrictEqual(1);
  await w.start();
  expect(w.stepsCount).toStrictEqual(1);
});

test("decision executes the matching branch", async () => {
  const evenPath = step((n: number) => n * 2);
  const oddPath = step((n: number) => n + 1);
  const d = decision({
    condition: (n: number) => n % 2 === 0,
    then: evenPath,
    else: oddPath,
  });

  const even = workflow({ name: "even", state: 4, start: d });
  expect(await even.start()).toStrictEqual(8);

  const odd = workflow({ name: "odd", state: 3, start: d });
  expect(await odd.start()).toStrictEqual(4);
});

test("decision counts toward stepsCount", async () => {
  const d = decision({
    condition: (n: number) => n > 0,
    then: step((n: number) => n * 2),
    else: step((n: number) => n),
  });
  const w = workflow({ name: "decision-count", state: 2, start: d });

  await w.start();
  expect(w.stepsCount).toStrictEqual(2);
});

test("next returns the attached callable for fluent chaining", async () => {
  const a = step((n: number) => n + 1);
  const b = step((n: number) => n * 2);
  const c = step((n: number) => n - 3);

  expect(a.next(b)).toStrictEqual(b);
  b.next(c);

  const w = workflow({ name: "fluent", state: 1, start: a });
  expect(await w.start()).toStrictEqual(1);
});
