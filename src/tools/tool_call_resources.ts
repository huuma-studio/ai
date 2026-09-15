export interface ToolCallResourceSnapshot {
  armedTimeouts: number;
  clearedTimeouts: number;
  addedAbortListeners: number;
  removedAbortListeners: number;
  activeTimeouts: number;
  activeAbortListeners: number;
}

const resources: ToolCallResourceSnapshot = {
  armedTimeouts: 0,
  clearedTimeouts: 0,
  addedAbortListeners: 0,
  removedAbortListeners: 0,
  activeTimeouts: 0,
  activeAbortListeners: 0,
};

export function toolCallResourceSnapshot(): ToolCallResourceSnapshot {
  return { ...resources };
}

export function armToolCallTimeout(
  callback: () => void,
  timeout: number,
): () => void {
  resources.armedTimeouts += 1;
  resources.activeTimeouts += 1;
  let active = true;
  let cleared = false;
  const timerId = setTimeout(() => {
    if (active) {
      active = false;
      resources.activeTimeouts -= 1;
    }
    callback();
  }, timeout);

  return () => {
    if (cleared) return;
    cleared = true;
    clearTimeout(timerId);
    resources.clearedTimeouts += 1;
    if (active) {
      active = false;
      resources.activeTimeouts -= 1;
    }
  };
}

export function addToolCallAbortListener(
  signal: AbortSignal,
  listener: () => void,
): () => void {
  signal.addEventListener("abort", listener, { once: true });
  resources.addedAbortListeners += 1;
  resources.activeAbortListeners += 1;
  let active = true;

  return () => {
    if (!active) return;
    signal.removeEventListener("abort", listener);
    active = false;
    resources.removedAbortListeners += 1;
    resources.activeAbortListeners -= 1;
  };
}
