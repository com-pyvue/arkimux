import type { ChildProcess } from "node:child_process";
import { promises as fs, type WriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { AgentExecutionCancelledError } from "../../application/agentExecutionFailure.ts";

export function assertAgentNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentExecutionCancelledError();
}

export class AgentProcessCleanupError extends Error {}
export class AgentResourceCleanupError extends AggregateError {}

/** Attempt every cleanup and do not report completion if any cleanup failed. */
export async function disposeAgentResources(disposers: Array<() => Promise<unknown> | undefined>): Promise<void> {
  const results = await Promise.allSettled(disposers.map(dispose => Promise.resolve().then(dispose)));
  const errors = results.filter(result => result.status === "rejected");
  if (errors.length) throw new AgentResourceCleanupError(errors.map(result => result.reason), "Agent resource cleanup failed.");
}

/** Inference owns a separate POSIX process group, never the host's group. Windows
 * retains direct-child termination; full Windows descendant supervision is not
 * claimed by this adapter and needs separate host evidence. */
// Defer the host read until provider execution. Importing public workflow helpers
// from bundled Core must not retain a module-level process access.
export function agentProcessDetached(): boolean { return process.platform !== "win32"; }

/** One lifetime for process timers, ordered heartbeat writes and output streams.
 * finish must be awaited from child close, including after a spawn error. */
export function agentProcessLifetime(options: {
  child: ChildProcess; signal?: AbortSignal; timeoutMs: number; heartbeatIntervalMs: number;
  heartbeatPath: string; heartbeat(status: string): unknown; streams: WriteStream[];
}) {
  const { child, signal } = options;
  let stopped = false, processClosed = false, timedOut = false, cancelled = false, error: Error | undefined;
  let closedInputError: Error | undefined;
  let writes = Promise.resolve(), escalation: ReturnType<typeof setTimeout> | undefined;
  const remember = (value: unknown) => { error ??= value instanceof Error ? value : new Error("Agent process cleanup failed."); };
  const kill = (kind: NodeJS.Signals) => {
    if (!child.pid || processClosed) return;
    try {
      if (agentProcessDetached()) process.kill(-child.pid, kind);
      else child.kill(kind);
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") remember(cause); }
  };
  const write = (status: string) => {
    const content = `${JSON.stringify(options.heartbeat(status), null, 2)}\n`;
    writes = writes.then(() => fs.writeFile(options.heartbeatPath, content, "utf8")).catch(cause => {
      remember(cause); kill("SIGKILL");
    });
  };
  const streamFinishes = options.streams.map(stream => finished(stream).catch(cause => { remember(cause); kill("SIGKILL"); }));
  const heartbeat = setInterval(() => write("running"), options.heartbeatIntervalMs);
  const timer = setTimeout(() => {
    timedOut = true;
    clearInterval(heartbeat);
    write("timed-out"); kill("SIGTERM");
    escalation = setTimeout(() => kill("SIGKILL"), 2_000);
  }, options.timeoutMs);
  const abort = () => {
    if (stopped) return;
    cancelled = true;
    clearTimeout(timer); clearInterval(heartbeat); clearTimeout(escalation);
    kill("SIGKILL");
  };
  child.once("error", remember);
  // The parent may exit while a child still holds stdout/stderr open. Terminate
  // remaining members on exit instead of waiting forever for close.
  const exit = () => { if (agentProcessDetached()) kill("SIGKILL"); };
  child.once("exit", exit);
  const stdinError = (cause: unknown) => {
    // A CLI can reject a request before reading its prompt. Let it finish and
    // flush its provider diagnostic instead of killing it or masking that error.
    if (cause instanceof Error && (cause as NodeJS.ErrnoException).code === "EPIPE") {
      closedInputError ??= cause;
      return;
    }
    remember(cause); kill("SIGKILL");
  };
  child.stdin?.on("error", stdinError);
  signal?.addEventListener("abort", abort, { once: true });
  write("running");
  if (signal?.aborted) abort();
  let finishing: Promise<void> | undefined;
  return {
    get timedOut() { return timedOut; },
    get cancelled() { return cancelled; },
    finish(exitCode: number | null): Promise<void> {
      return finishing ??= (async () => {
        stopped = true;
        processClosed = true;
        clearInterval(heartbeat); clearTimeout(timer); clearTimeout(escalation);
        signal?.removeEventListener("abort", abort); child.removeListener("exit", exit);
        child.stdin?.removeListener("error", stdinError);
        options.streams.forEach(stream => stream.end());
        await Promise.all(streamFinishes);
        // A successful process must not hide a failed prompt write. Failed,
        // cancelled and timed-out processes are interpreted by their runners.
        if (exitCode === 0 && !timedOut && !cancelled && closedInputError) remember(closedInputError);
        const status = timedOut ? "timed-out" : cancelled || error || exitCode !== 0 ? "failed" : "complete";
        write(status); await writes;
        if (error) throw new AgentProcessCleanupError("Agent process or artifact cleanup failed.", { cause: error });
      })();
    },
  };
}
