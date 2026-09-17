/**
 * Lightweight workflow primitives for composing sequential and branching async
 * operations.
 *
 * @example
 * ```typescript
 * import { step, workflow } from "jsr:@huuma/ai/workflow";
 *
 * const double = step((n: number) => n * 2);
 * const increment = step((n: number) => n + 1);
 * double.next(increment);
 *
 * const w = workflow({
 *   name: "math",
 *   state: 5,
 *   start: double,
 * });
 *
 * const result = await w.start(); // 11
 * ```
 *
 * @module
 */
/** Options used to create a workflow. */
export interface WorkflowOptions<T> {
  /** Workflow name for diagnostics and display. */
  name: string;
  /** Optional workflow description. */
  description?: string;
  /** Initial workflow state. */
  state?: T;
  /** First callable to execute. */
  start: Callable<T>;
  /** Maximum number of steps to run. The workflow fails once exceeded. */
  maxSteps?: number;
}

/** Current workflow execution status. */
export enum WorkflowStatus {
  /** Workflow has been created but not started. */
  CREATED = "Created",
  /** Workflow is currently executing. */
  RUNNING = "Running",
  /** Workflow completed successfully. */
  COMPLETED = "Completed",
  /** Workflow failed with an error. */
  FAILED = "Failed",
}

/** Unit that can be executed by a workflow. */
export interface Callable<T> {
  /** Execute the unit with the current state and step counter. */
  call: (state: T, count: () => void) => Promise<T>;
}

/**
 * Stateful workflow runner.
 *
 * The runner starts the configured callable and follows `.next()` links
 * and {@linkcode Decision} branches recursively until the chain
 * completes. Because the chain recurses through suspended async frames,
 * a cyclic chain retains one frame set — and its state snapshot — per
 * cycle taken: prefer an explicit loop over a `Step` cycle for long or
 * unbounded iteration counts (see {@linkcode Step.call}).
 */
export class Workflow<T> {
  #name: string;
  #description?: string;
  #status: WorkflowStatus = WorkflowStatus.CREATED;
  #start: Callable<T>;
  #state?: T;
  #stepsCount = 0;
  #maxSteps?: number;

  /** Create a workflow instance. */
  constructor(
    { name, description, start, state, maxSteps }: WorkflowOptions<T>,
  ) {
    this.#name = name;
    this.#description = description;
    this.#start = start;
    this.#state = state;
    this.#maxSteps = maxSteps;
  }

  /** Current execution status. */
  get status(): WorkflowStatus {
    return this.#status;
  }

  /** Number of executed steps. */
  get stepsCount(): number {
    return this.#stepsCount;
  }

  /** Start the workflow with the configured or supplied state.
   *
   * @param state Optional override for the initial workflow state.
   * @returns The final state after the workflow completes.
   */
  async start(state?: T): Promise<T> {
    const initialState = state ?? this.#state;
    if (initialState === undefined) {
      throw new Error("State must be present");
    }
    return await this.#call(initialState);
  }

  async #call(state: T): Promise<T> {
    if (this.#status === WorkflowStatus.RUNNING) {
      throw new Error("Workflow is currently running. Wait until finished.");
    }
    this.#status = WorkflowStatus.RUNNING;
    this.#stepsCount = 0;
    try {
      const result = await this.#start.call(state, () => {
        if (this.#maxSteps !== undefined && this.#stepsCount >= this.#maxSteps) {
          throw new Error("Maximum number of steps exceeded");
        }
        this.#stepsCount++;
      });
      this.#status = WorkflowStatus.COMPLETED;
      return result;
    } catch (e) {
      this.#status = WorkflowStatus.FAILED;
      throw e;
    }
  }
}

/** Create a workflow.
 *
 * @param options Workflow configuration including name, initial state, and starting step.
 * @returns A {@link Workflow} instance.
 */
export function workflow<T>(options: WorkflowOptions<T>): Workflow<T> {
  return new Workflow(options);
}

/** Workflow step that can optionally point to a next callable. */
export class Step<T> implements Callable<T> {
  #fn: (state: T) => Promise<T> | T;
  #next?: Callable<T>;

  /** Create a step from a state transformation function. */
  constructor(fn: (state: T) => Promise<T> | T) {
    this.#fn = fn;
  }

  /**
   * Execute this step and any configured next callable.
   *
   * Chained steps recurse: each `call` awaits the next callable's
   * `call`, so every earlier step's async frame stays suspended —
   * holding its `state` argument and locals — until the entire chain
   * resolves. A linear chain of n steps therefore keeps n frames alive
   * for the whole run. A cyclic chain (where a later `next` link or
   * {@linkcode Decision} branch points back to an earlier step)
   * additionally suspends a fresh frame set on every cycle taken,
   * retaining one frame set — and with it that iteration's state
   * snapshot — per iteration: memory grows linearly with the number of
   * iterations even when each step's state is small, and the
   * ever-deepening promise chain adds per-link resumption overhead on
   * every iteration. Drive long or unbounded cycles with an explicit
   * loop that calls steps directly instead of a `Step` cycle.
   */
  async call(state: T, count: () => void): Promise<T> {
    count();
    const _state = await this.#fn(state);
    if (this.#next) {
      return this.#next.call(_state, count);
    }
    return _state;
  }
  /** Attach the next callable in the workflow chain.
   *
   * @returns The attached callable, enabling fluent chaining like `a.next(b).next(c)`.
   */
  next<C extends Callable<T>>(callable: C): C {
    if (this.#next) {
      throw new Error("Step already has a next step");
    }
    this.#next = callable;
    return callable;
  }
}

/** Create a workflow step from a state transformation function.
 *
 * Steps compose chains through `.next()`. Chains execute recursively;
 * long or unbounded cycles should be driven by an explicit loop
 * instead — see {@linkcode Step.call} for the memory characteristics.
 *
 * @param fn State transformation to execute.
 * @returns A {@link Step} that can be chained with `.next()`.
 */
export function step<T>(fn: (state: T) => Promise<T> | T): Step<T> {
  return new Step(fn);
}

/** Branching workflow callable. */
export class Decision<T> implements Callable<T> {
  #condition: (state: T) => Promise<boolean> | boolean;
  #then: Callable<T>;
  #else: Callable<T>;
  /** Create a decision with condition, then branch, and else branch. */
  constructor(
    { condition, then: then, else: _else }: {
      /** Predicate used to choose a branch. */
      condition: (state: T) => Promise<boolean> | boolean;
      /** Branch executed when the condition is true. */
      then: Callable<T>;
      /** Branch executed when the condition is false. */
      else: Callable<T>;
    },
  ) {
    this.#condition = condition;
    this.#then = then;
    this.#else = _else;
  }
  /**
   * Evaluate the condition and execute the matching branch.
   *
   * Like {@linkcode Step.call}, a decision suspends its frame until the
   * chosen branch (and everything it calls) completes. A branch that
   * points back to an earlier step creates a cycle, which retains one
   * suspended frame set — and its state snapshot — per iteration; see
   * {@linkcode Step.call} for why long or unbounded cycles should be
   * driven with an explicit loop instead.
   */
  async call(state: T, count: () => void): Promise<T> {
    count();
    if (await this.#condition(state)) {
      return this.#then.call(state, count);
    }
    return this.#else.call(state, count);
  }
}

/** Create a branching workflow decision.
 *
 * @param options Condition predicate and two branches to choose from.
 * @returns A {@link Decision} callable.
 */
export function decision<T>(options: {
  condition: (state: T) => Promise<boolean> | boolean;
  then: Callable<T>;
  else: Callable<T>;
}): Decision<T> {
  return new Decision(options);
}
