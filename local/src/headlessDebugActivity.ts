import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { writeFileSync, renameSync, readFileSync, lstatSync } from "node:fs";
import type { RetainedOwnerV1 } from "../../core/src/application/retainedExecution.ts";

/** Private worker telemetry, never a claim to recognize arbitrary native I/O.
 * Async resources created by workflow code outside registered operations keep
 * the diagnostic clock charged until Node reports their physical destruction. */
export function createHeadlessDebugActivity(file: string, owner: RetainedOwnerV1) {
  const context = new AsyncLocalStorage<boolean>();
  const external = new Set<number>();
  let managed = 0, revision = 0, failed = false;
  const save = () => {
    if (failed) return;
    try {
      writeFileSync(`${file}.pending`, JSON.stringify({ attemptId: owner.attemptId, fence: owner.fence,
        revision: ++revision, activeCount: managed, activityKnown: external.size === 0 }), { mode: 0o600 });
      renameSync(`${file}.pending`, file);
    } catch { failed = true; throw new Error("Diagnostic activity recording failed."); }
  };
  save();
  const hook = createHook({
    init(id, type) {
      if (context.getStore() !== true || ["PROMISE", "TickObject", "Microtask"].includes(type)) return;
      external.add(id); save();
    },
    destroy(id) { if (external.delete(id)) save(); },
  });
  hook.enable();
  return {
    workflow<T>(work: () => T): T { return context.run(true, work); },
    infrastructure<T>(work: () => T): T { return context.run(false, work); },
    async operation<T>(work: () => T | Promise<T>): Promise<T> {
      managed++; save();
      try { return await context.run(true, work); }
      finally { managed--; save(); }
    },
    close() { hook.disable(); context.disable(); },
  };
}

/** Read only our owned worker's activity file. Missing/invalid data is unknown. */
export function readHeadlessDebugActivity(file: string, owner: RetainedOwnerV1): { activeCount: number; activityKnown: boolean } {
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error("Invalid activity record.");
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value.attemptId !== owner.attemptId || value.fence !== owner.fence || !Number.isSafeInteger(value.activeCount)
      || value.activeCount < 0 || typeof value.activityKnown !== "boolean") throw new Error("Foreign activity record.");
    return { activeCount: value.activeCount, activityKnown: value.activityKnown };
  } catch { return { activeCount: 0, activityKnown: false }; }
}
