import { readFileSync } from "node:fs";
import { diagnosticClockRecordSchema, diagnosticMonotonicNow, type DiagnosticClockRecordV2 } from "../../core/src/application/activeCompute.ts";
import { sameOwner, validateRetainedRunControl, type RetainedOwnerV1 } from "../../core/src/application/retainedExecution.ts";

export interface DiagnosticActivityV2 { activeCount: number; activityKnown: boolean }
export interface DiagnosticClockSnapshotV2 {
  limitMs: number; spentMs: number | null; remainingMs: number | null; excludedPauseMs: number | null;
  wallElapsedMs: number | null; clock: "running" | "paused" | "uncertain";
  reason: "executing" | "debug_pause" | "external_work" | "unknown_activity";
  pauseId: string | null; activeCount: number; activityKnown: boolean; revision: number;
}

/** The controller owns this clock, outside the inspector-paused worker. Every
 * transition is fenced durably before control can return to the caller. */
export class DiagnosticExecutionClockV2 {
  readonly #now: () => number;
  readonly #start: number;
  readonly #limit: number;
  readonly #priorSpent: number;
  readonly #priorExcluded: number;
  readonly #persist: (expectedRevision: number, record: DiagnosticClockRecordV2) => Promise<void>;
  readonly #changed: () => void;
  readonly #failed: () => void;
  #last: number;
  #excluded = 0;
  #pausedAt: number | null = null;
  #pauseId: string | null = null;
  #activity: DiagnosticActivityV2 = { activeCount: 0, activityKnown: false };
  #revision = 0;
  #uncertain = false;
  #closing = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: {
    monotonicNow: () => number; startedAt: number; limitMs: number; priorSpentMs: number; priorExcludedPauseMs: number;
    persist(expectedRevision: number, record: DiagnosticClockRecordV2): Promise<void>;
    changed(): void; failed(): void;
  }) {
    this.#now = options.monotonicNow; this.#start = Math.floor(options.startedAt); this.#last = this.#start;
    this.#limit = options.limitMs; this.#priorSpent = options.priorSpentMs; this.#priorExcluded = options.priorExcludedPauseMs;
    this.#persist = options.persist; this.#changed = options.changed; this.#failed = options.failed;
  }

  #sample(): number {
    const value = Math.floor(this.#now());
    if (!Number.isFinite(value) || value < this.#last || !Number.isSafeInteger(Math.ceil(value - this.#start))) {
      this.#uncertain = true; this.#failed(); throw new Error("Diagnostic clock accounting is uncertain.");
    }
    this.#last = value; return value;
  }
  #excludedAt(at: number): number { return this.#excluded + (this.#pausedAt === null ? 0 : at - this.#pausedAt); }
  elapsedMs(): number {
    if (this.#uncertain) throw new Error("Diagnostic clock accounting is uncertain.");
    const at = this.#sample(); return at - this.#start - this.#excludedAt(at);
  }
  get paused(): boolean { return !this.#uncertain && this.#pausedAt !== null; }
  snapshot(): DiagnosticClockSnapshotV2 {
    let at: number | undefined;
    try { if (!this.#uncertain) at = this.#sample(); } catch { /* Report unknown, never zero. */ }
    const known = at !== undefined && !this.#uncertain;
    const excluded = known ? Math.floor(this.#excludedAt(at!)) : null;
    const wall = known ? Math.ceil(at! - this.#start) : null;
    const spent = known ? this.#priorSpent + wall! - excluded! : null;
    return { limitMs: this.#limit, spentMs: spent, remainingMs: spent === null ? null : Math.max(0, this.#limit - spent),
      excludedPauseMs: excluded === null ? null : this.#priorExcluded + excluded, wallElapsedMs: wall,
      clock: !known ? "uncertain" : this.paused ? "paused" : "running",
      reason: this.#activity.activeCount > 0 ? "external_work" : !this.#activity.activityKnown ? "unknown_activity" : this.paused ? "debug_pause" : "executing",
      pauseId: this.#pauseId, ...this.#activity, revision: this.#revision };
  }

  observePause(input: DiagnosticActivityV2 & { pauseId: string }): Promise<void> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(input.pauseId)) return Promise.reject(new Error("Invalid diagnostic pause identity."));
    return this.#transition(() => {
      if (this.#pauseId !== null && this.#pauseId !== input.pauseId) throw new Error("A different diagnostic pause is active.");
      this.#setActivity(input); this.#pauseId = input.pauseId;
    });
  }
  setActivity(activity: DiagnosticActivityV2): Promise<void> {
    return this.#transition(() => this.#setActivity(activity));
  }
  #setActivity(activity: DiagnosticActivityV2): void {
    if (!Number.isSafeInteger(activity.activeCount) || activity.activeCount < 0 || typeof activity.activityKnown !== "boolean") throw new Error("Invalid diagnostic activity state.");
    this.#activity = { activeCount: activity.activeCount, activityKnown: activity.activityKnown };
  }
  resume(pauseId: string): Promise<void> {
    return this.#transition(() => {
      if (this.#pauseId !== pauseId) throw new Error("Stale diagnostic pause identity.");
      this.#pauseId = null;
    });
  }
  /** Charges teardown, even when the user cancels a quiet paused worker. It
   * changes accounting only: it never resumes workflow execution. */
  finish(): Promise<void> {
    this.#closing = true;
    return this.#transition(() => { this.#pauseId = null; }, true);
  }
  settlement(): { elapsedMs: number; wallElapsedMs: number; excludedPauseMs: number } {
    if (!this.#closing || this.paused || this.#uncertain) throw new Error("Diagnostic clock is not reconciled for settlement.");
    const at = this.#sample(), wallElapsedMs = Math.ceil(at - this.#start), excludedPauseMs = Math.floor(this.#excluded);
    return { elapsedMs: wallElapsedMs - excludedPauseMs, wallElapsedMs, excludedPauseMs };
  }
  #transition(change: () => void, allowClosing = false): Promise<void> {
    if (this.#closing && !allowClosing) return Promise.reject(new Error("Diagnostic clock is closing."));
    const next = this.#queue.then(async () => {
      if (this.#uncertain) throw new Error("Diagnostic clock accounting is uncertain.");
      const at = this.#sample();
      // Do not close an existing excluded interval when rejecting stale input.
      change();
      if (this.#pausedAt !== null) this.#excluded += at - this.#pausedAt;
      this.#pausedAt = this.#pauseId && this.#activity.activityKnown && this.#activity.activeCount === 0 ? at : null;
      const wallMs = Math.ceil(at - this.#start), excludedPauseMs = Math.floor(this.#excluded);
      const record = diagnosticClockRecordSchema.parse({ schemaVersion: 2, revision: this.#revision + 1,
        clock: this.paused ? "paused" : "running", pauseId: this.#pauseId, ...this.#activity,
        wallMs, excludedPauseMs, chargedMs: wallMs - excludedPauseMs, sampledAtMonotonicMs: at });
      this.#changed();
      try { await this.#persist(this.#revision, record); this.#revision = record.revision; }
      catch { this.#uncertain = true; this.#failed(); throw new Error("Diagnostic clock persistence is uncertain."); }
    });
    this.#queue = next.catch(() => {}); return next;
  }
}

/** Called synchronously by an owned worker after every debugger resume. Reading
 * the same retained record avoids waiting for IPC while the worker is paused. */
export function readDiagnosticClock(clockPath: string, owner: RetainedOwnerV1): { deadlineAt: string; remainingMs: number; record: DiagnosticClockRecordV2 } {
  const state = validateRetainedRunControl(JSON.parse(readFileSync(clockPath, "utf8")));
  const active = state.compute?.active, record = active?.diagnostic;
  if (!sameOwner(state.owner, owner) || !state.compute?.diagnosticOnly || state.compute.certainty !== "known" ||
    !active || !record || record.clock !== "running") throw new Error("Diagnostic worker clock is unavailable or not running.");
  const sinceSample = diagnosticMonotonicNow() - record.sampledAtMonotonicMs;
  if (sinceSample < 0 || !Number.isSafeInteger(sinceSample)) throw new Error("Diagnostic monotonic sample is uncertain.");
  const allowance = Math.min(state.compute.limits.attemptMs, state.compute.limits.totalMs - state.compute.spentMs);
  return { deadlineAt: active.deadlineAt, remainingMs: Math.max(0, allowance - record.chargedMs - sinceSample), record };
}
