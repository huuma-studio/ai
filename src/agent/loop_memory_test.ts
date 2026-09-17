/**
 * Memory regression tests for the agent loop.
 *
 * `Agent.run` drives model rounds with a plain iterative loop, reuses a
 * single tools snapshot for the whole run, and lets each round's
 * superseded message array become garbage immediately. These tests
 * guard those properties behaviorally:
 *
 * - Snapshot reclamation: every message array handed to the model is
 *   registered in a FinalizationRegistry. A healthy run has reclaimed
 *   the overwhelming majority of them by the time it ends. An
 *   implementation that pins per-iteration snapshots — an accidental
 *   accumulator, or an engine whose suspended async frames retain the
 *   arrays passed through them — collects almost none and fails.
 *   Finalizers are only promised to run "eventually", so this
 *   assertion never fails on delayed collection: it is gated on a
 *   control group of known-dead arrays that die interleaved with the
 *   run's snapshots — one registered per round and dropped by the
 *   next, so both are reclaimed by the same collections. Delivered
 *   control callbacks prove the finalizer pipeline works for exactly
 *   the kind of object this assertion measures; undelivered control
 *   callbacks mean the measurement stalled, and the assertion is
 *   skipped for that run. When the suite runs with
 *   `--v8-flags=--expose-gc`, explicit collections make the
 *   measurement fully deterministic.
 * - Bounded heap growth: settled `heapUsed` readings at 50-round
 *   milestones must grow linearly in the message count. Readings taken
 *   without `--expose-gc` are only mostly accurate: V8 reclaims
 *   large-object pages lazily, so an occasional milestone reading still
 *   counts tens of MB of not-yet-swept pressure garbage (spikes of
 *   +30-45 MB were observed on otherwise clean runs). The median over
 *   the per-milestone deltas absorbs those outliers while still
 *   failing when retention grows per round or per round squared.
 * - One tools snapshot per run: every model request of a run receives
 *   the same `tools` array instance. The pre-rewrite loop called
 *   `Tools.all()` inside the model-call closure, allocating a fresh
 *   array on every round.
 *
 * Measured on this repository's V8 build: restoring the recursive Step
 * chain leaves the two memory signals indistinguishable from the
 * iterative loop — suspended async frames do not retain the arrays
 * passed through them (registers not needed after resumption are
 * dropped), so the chain holds only its frame objects and promise
 * links, which is O(rounds) and well under a MB at 400 rounds. The
 * tools-snapshot assertion is therefore the deterministic detector for
 * a restored chain, and the memory assertions guard the retention
 * properties themselves on engines where suspended frames do pin
 * their state (the behavior the rewrite removed).
 *
 * @module
 */
import { assert, assertEquals } from "@std/assert";
import { agent } from "@/agent/mod.ts";
import type {
  BaseModel,
  Message,
  ModelResult,
} from "@/agent/mod.ts";
import { tool } from "@/tools/mod.ts";
import { object } from "@huuma/validate";

const MEGABYTE = 1024 * 1024;

/** Model rounds that request a tool call before the final plain reply. */
const ROUNDS = 400;
/** Filler model messages returned per round to grow the conversation. */
const FILLERS_PER_ROUND = 50;
/** Rounds between settled-heap samples. */
const MILESTONE_EVERY = 50;
/** Share of snapshot arrays that must be reclaimed by the end of a run. */
const RECLAIMED_RATIO = 0.75;
/** Median per-milestone heap growth allowed over the whole run. */
const MEDIAN_DELTA_LIMIT = 4 * MEGABYTE;
/** Catastrophic fuse: total settled-heap growth allowed over the run. */
const TOTAL_GROWTH_LIMIT = 128 * MEGABYTE;

/**
 * Best-effort settled `heapUsed` reading without `--v8-flags=--expose-gc`.
 *
 * The standard `deno test` task cannot pass V8 flags, so collections
 * are driven by allocation pressure: half-megabyte pointer chunks are
 * allocated and immediately dropped. Each chunk is larger than V8's
 * regular-object limit, so the pressure accumulates in old-space
 * large-object pages that only major collections reclaim — the heap
 * must eventually run one. The loop exits as soon as a reading falls
 * 4 MB below the peak seen so far: that much reclaimed memory can
 * only come from a major collection, and the reading right after it
 * is close to the live heap.
 *
 * The reading is only mostly accurate: sweeping frees large-object
 * pages lazily, so the exit can fire while some pressure garbage is
 * still accounted (observed spikes: +30-45 MB). Consumers must be
 * robust to an occasional outlier — see the module note on the median
 * over milestone deltas. The returned `min` bounds the pathological
 * case of a collector that never triggers within the pressure budget.
 */
function settleHeap(): number {
  let peak = Deno.memoryUsage().heapUsed;
  let min = peak;
  for (let i = 0; i < 600; i++) {
    // ~0.5 MB of pointers: above V8's large-object threshold, so the
    // chunk bypasses the young generation and forces old-space growth.
    const chunk: unknown[] = new Array(128_000);
    chunk.fill({ chunk: i });
    if (chunk.length === 0) throw new Error("unreachable");
    const current = Deno.memoryUsage().heapUsed;
    if (current > peak) peak = current;
    if (current < min) min = current;
    if (peak - current >= 4 * MEGABYTE) return current;
  }
  return min;
}

const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const collected = new Set<number>();
const registry = new FinalizationRegistry((round: number) => {
  collected.add(round);
});

// Control group: one small array registered per round alongside the
// run's snapshot and dropped when the next round replaces it, so
// controls die exactly when the run's snapshots die and are reclaimed
// by the same collections. Their delivered callbacks prove the
// finalizer pipeline works for exactly the kind of object the
// reclamation assertion measures.
const controlCollected = new Set<number>();
const controlRegistry = new FinalizationRegistry((round: number) => {
  controlCollected.add(round);
});
// Slot for the current round's control array. The binding is
// deliberately write-only: its element is replaced each round, which
// drops the previous round's control alongside its snapshot.
const controlSlot: unknown[] = [];

/**
 * Deterministic fake model: every round up to {@linkcode ROUNDS} returns
 * {@linkcode FILLERS_PER_ROUND} filler messages plus a model message
 * requesting one `echo` call, so each round grows the conversation by
 * 52 messages and exercises the full generate → tool → finish check
 * cycle. The round after the last one returns a plain reply so the run
 * terminates normally.
 *
 * The generate arguments are deliberately not retained beyond the
 * registry's weak reference to the message array: storing the per-round
 * arrays here would make the test measure its own retention instead of
 * the agent loop's.
 */
class LoopModel implements BaseModel<string> {
  calls = 0;
  readonly samples: number[] = [];

  async generate(args: unknown): Promise<ModelResult<string>> {
    const { messages } = args as { messages: Message[] };
    registry.register(messages, this.calls);
    this.calls += 1;
    const round = this.calls;
    // Register this round's control array and drop the previous one:
    // the control dies exactly when the run's snapshot does, so both
    // are reclaimed by the same collections.
    const control: unknown[] = [round];
    controlRegistry.register(control, round);
    controlSlot[0] = control;
    if (round % MILESTONE_EVERY === 0 && round <= ROUNDS) {
      // Finalization callbacks are delivered on event-loop turns; the
      // yields let them flush before and after the settle pressure.
      await yieldToEventLoop();
      this.samples.push(settleHeap());
      await yieldToEventLoop();
    }
    if (round > ROUNDS) {
      return {
        modelId: "loop",
        messages: [{
          role: "model",
          contents: [{ text: "done" }],
          toolCalls: [],
        }],
      };
    }
    const roundMessages: Message[] = Array.from(
      { length: FILLERS_PER_ROUND },
      (_, i): Message => ({
        role: "model",
        contents: [{ text: `filler ${round} ${i}` }],
        toolCalls: [],
      }),
    );
    roundMessages.push({
      role: "model",
      contents: [
        { toolCall: { id: `call-${round}`, name: "echo", props: {} } },
      ],
      toolCalls: [{ id: `call-${round}`, name: "echo", props: {} }],
    });
    return { modelId: "loop", messages: roundMessages };
  }

  stream(): Promise<AsyncGenerator<ModelResult>> {
    return Promise.reject(new Error("Not implemented"));
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

const echo = tool({
  name: "echo",
  description: "Return a fixed result.",
  input: object({}),
  fn: () => "ok",
});

Deno.test("agent - long runs reclaim snapshots and hold memory linear in message count", async () => {
  const model = new LoopModel();
  const assistant = agent({
    model,
    modelId: "loop",
    systemPrompt: "Be helpful.",
    tools: [echo],
  });

  // When a model-call cap lands (spec #58), raise it here so this run
  // is not limited by it.
  const messages = await assistant.run("Drive the loop.");

  // Drop the final control array; every earlier control died during
  // the run alongside the snapshots it tracks.
  controlSlot[0] = undefined;

  assertEquals(model.calls, ROUNDS + 1);
  assertEquals(
    messages.length,
    1 + ROUNDS * (FILLERS_PER_ROUND + 2) + 1,
  );

  const { samples } = model;
  const deltas = samples.slice(1).map((sample, index) => ({
    from: Math.round((index + 1) * MILESTONE_EVERY),
    to: Math.round((index + 2) * MILESTONE_EVERY),
    bytes: sample - samples[index],
  }));

  // Linear retention: the live conversation (~21k small messages) sits
  // in the single current array, so the typical milestone growth stays
  // a few MB (measured median: ~1.8 MB). The median tolerates the
  // occasional settle outlier (see module note); retention that grows
  // per round or per round squared pushes the median past the limit.
  const medianDelta = median(deltas.map((d) => d.bytes));
  assert(
    medianDelta <= MEDIAN_DELTA_LIMIT,
    `median per-milestone heap growth was ${
      (medianDelta / MEGABYTE).toFixed(1)
    } MB (expected linear, at most ${
      MEDIAN_DELTA_LIMIT / MEGABYTE
    } MB): ${JSON.stringify(deltas)}`,
  );

  // Catastrophic fuse for leaks too gross for milestone medians to
  // express cleanly (measured iterative worst case: ~56 MB with a
  // settle outlier; retention of the old chain's snapshot arrays on
  // engines that pin frame state adds tens of MB by round 400).
  const totalGrowth = samples[samples.length - 1] - samples[0];
  assert(
    totalGrowth <= TOTAL_GROWTH_LIMIT,
    `total heap growth over ${ROUNDS} rounds was ${
      (totalGrowth / MEGABYTE).toFixed(1)
    } MB (limit ${TOTAL_GROWTH_LIMIT / MEGABYTE} MB): ${JSON.stringify(deltas)}`,
  );

  // Drain finalization callbacks. Each iteration forces at least one
  // major collection — explicit GC when the suite runs with
  // `--v8-flags=--expose-gc`, otherwise the same allocation pressure
  // `settleHeap` uses — then yields so callbacks flush, and repeats
  // until both reclaimed counts stop growing. Per-iteration collections
  // matter because garbage that dies late in the run (the final
  // snapshots and the final control array) otherwise sits uncollected.
  const gc = (globalThis as { gc?: () => void }).gc;
  let previousRun = -1;
  let previousControl = -1;
  let stable = 0;
  for (let i = 0; i < 50 && stable < 5; i++) {
    if (gc) {
      gc();
    } else {
      settleHeap();
    }
    await yieldToEventLoop();
    const settled = collected.size === previousRun &&
      controlCollected.size === previousControl;
    stable = settled ? stable + 1 : 0;
    previousRun = collected.size;
    previousControl = controlCollected.size;
  }

  // Gate on the control group: finalizers are only promised to run
  // "eventually", so delayed collection must not fail correct code.
  // The controls die interleaved with the run's snapshots, so if not
  // one of them was delivered, the pipeline that would deliver the
  // snapshots stalled too — nothing was measured; skip this run.
  if (controlCollected.size === 0) {
    console.warn(
      "[agent loop memory test] finalizer delivery stalled during the drain; " +
        "skipping the reclamation assertion this run " +
        "(see the module docs in loop_memory_test.ts)",
    );
    return;
  }

  // The run itself must not retain superseded snapshots: nearly every
  // array handed to the model is garbage by the next round. The slack
  // absorbs the last rounds' arrays (still live at the end) and
  // callback-delivery jitter; a real retention bug collects almost
  // none and fails by a wide margin.
  const reclaimed = collected.size;
  assert(
    reclaimed >= Math.floor(ROUNDS * RECLAIMED_RATIO),
    `only ${reclaimed} of ${ROUNDS} snapshot arrays were reclaimed by the end of the run (control group: ${controlCollected.size} delivered)`,
  );
});

Deno.test("agent - model requests share one tools snapshot per run", async () => {
  const toolsInstances = new Set<unknown>();

  class ToolfulModel implements BaseModel<string> {
    calls = 0;

    generate(args: unknown): Promise<ModelResult<string>> {
      toolsInstances.add((args as { tools: unknown }).tools);
      this.calls += 1;
      if (this.calls > 3) {
        return Promise.resolve({
          modelId: "tools",
          messages: [{
            role: "model",
            contents: [{ text: "done" }],
            toolCalls: [],
          }],
        });
      }
      return Promise.resolve({
        modelId: "tools",
        messages: [{
          role: "model",
          contents: [{
            toolCall: {
              id: `call-${this.calls}`,
              name: "echo",
              props: {},
            },
          }],
          toolCalls: [{
            id: `call-${this.calls}`,
            name: "echo",
            props: {},
          }],
        }],
      });
    }

    stream(): Promise<AsyncGenerator<ModelResult>> {
      return Promise.reject(new Error("Not implemented"));
    }
  }

  const assistant = agent({
    model: new ToolfulModel(),
    modelId: "tools",
    systemPrompt: "Be helpful.",
    tools: [echo],
  });

  await assistant.run("Reuse the snapshot.");

  assertEquals(toolsInstances.size, 1);
});