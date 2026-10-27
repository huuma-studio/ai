/**
 * Child processes for the tools that run commands, on `node:child_process`.
 *
 * @module
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:os";
import { Readable } from "node:stream";

/** Options for {@link spawnProcess}. */
export interface SpawnOptions {
  /** Variables added to the inherited parent environment. */
  env?: Record<string, string>;
  /** Kills the process when aborted. */
  signal?: AbortSignal;
}

/** A running process with piped output and closed stdin. */
export interface ChildProcess {
  /** The process's standard output. */
  stdout: ReadableStream<Uint8Array>;
  /** The process's standard error. */
  stderr: ReadableStream<Uint8Array>;
  /** Settles once the process has exited and its pipes have closed. A
   * process killed by a signal reports `128 + signal number`. */
  status: Promise<{ code: number }>;
  /** Sends SIGTERM; does nothing if the process has exited. */
  kill(): void;
}

/** Runs `command` without a shell, stdin closed and both outputs piped.
 *
 * @param command Executable to run.
 * @param args Arguments passed verbatim.
 * @param options Environment additions and cancellation.
 * @returns The running process, once it has started.
 * @throws When the process cannot be started, e.g. a missing executable,
 * or when `signal` is already aborted.
 */
export async function spawnProcess(
  command: string,
  args: string[],
  { env, signal }: SpawnOptions = {},
): Promise<ChildProcess> {
  signal?.throwIfAborted();
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    signal,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Spawn failures and aborts arrive as "error" events: a spawn failure
  // rejects below; an abort kills the child, which "close" then reports.
  const status = new Promise<{ code: number }>((resolve) => {
    child.once("close", (code, killSignal) => {
      resolve({
        code: code ?? 128 + (killSignal ? constants.signals[killSignal] : 0),
      });
    });
  });
  const started = once(child, "spawn");
  child.on("error", () => {});
  await started;

  return {
    stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
    status,
    kill: () => {
      child.kill();
    },
  };
}
