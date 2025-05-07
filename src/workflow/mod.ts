interface WorkflowOptions<T> {
  name: string;
  description?: string;
  state?: T;
  start: Callable<T>;
  maxSteps?: number;
}

enum WorkflowStatus {
  CREATED = "Created",
  RUNNING = "Running",
  COMPLETED = "Completed",
  FAILED = "Failed",
}

interface Callable<T> {
  call: (state: T, count: () => void) => Promise<T>;
}

export class Workflow<T> {
  #name: string;
  #description?: string;
  #status: WorkflowStatus = WorkflowStatus.CREATED;
  #start: Callable<T>;
  #state?: T;
  #stepsCount = 0;

  constructor(
    { name, description, start, state }: WorkflowOptions<T>,
  ) {
    this.#name = name;
    this.#description = description;
    this.#start = start;
    this.#state = state;
  }

  get status(): WorkflowStatus {
    return this.#status;
  }

  get stepsCount(): number {
    return this.#stepsCount;
  }

  start(state?: T): Promise<T> {
    if (!this.#state && !state) {
      throw Error("State must be present");
    }
    return this.#call(this.#state || state!);
  }

  async #call(state: T): Promise<T> {
    if (this.#status === WorkflowStatus.RUNNING) {
      throw new Error("Workflow is currently running. Wait until finished.");
    }
    this.#status = WorkflowStatus.RUNNING;
    try {
      const result = await this.#start.call(state, () => {
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

export function workflow<T>(options: WorkflowOptions<T>): Workflow<T> {
  return new Workflow(options);
}

export class Step<T> implements Callable<T> {
  #fn: (state: T) => Promise<T> | T;
  #next?: Callable<T>;

  constructor(fn: (state: T) => Promise<T> | T) {
    this.#fn = fn;
  }

  async call(state: T, count: () => void): Promise<T> {
    count();
    const _state = await this.#fn(state);
    if (this.#next && typeof this.#next.call === "function") {
      return this.#next.call(_state, count);
    }
    return _state;
  }
  next(callable: Callable<T>): void {
    this.#next = callable;
  }
}

export function step<T>(fn: (state: T) => Promise<T> | T): Step<T> {
  return new Step(fn);
}

export class Decision<T> implements Callable<T> {
  #condition: (state: T) => Promise<boolean> | boolean;
  #then: Callable<T>;
  #else: Callable<T>;
  constructor(
    { condition, then: then, else: _else }: {
      condition: (state: T) => Promise<boolean> | boolean;
      then: Callable<T>;
      else: Callable<T>;
    },
  ) {
    this.#condition = condition;
    this.#then = then;
    this.#else = _else;
  }
  async call(state: T, count: () => void): Promise<T> {
    if (await this.#condition(state)) {
      return this.#then.call(state, count);
    }
    return this.#else.call(state, count);
  }
}

export function decision<T>(options: {
  condition: (state: T) => Promise<boolean> | boolean;
  then: Callable<T>;
  else: Callable<T>;
}): Decision<T> {
  return new Decision(options);
}
