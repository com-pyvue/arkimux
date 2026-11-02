import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { activeComputeLimitsSchema, diagnosticMonotonicNow, RetainedAttemptReadinessError, type ReadinessFailureV1, type ActiveComputeLimitsV1, type AccountedOutcomeV1 } from "../../core/src/application/activeCompute.ts";
import { hashJson, immutableJson, type JsonValue } from "../../core/src/application/durableWorkflow.ts";
import type { DurableWorkflowEngineOutcomeV3 } from "../../core/src/application/durableInputWait.ts";
import { inputWaitJsonSnapshot, validateInputRequestV1 } from "../../core/src/application/inputWait.ts";
import { getExternalErrorDiagnostic, type ExternalErrorDiagnostic } from "../../core/src/application/externalError.ts";
import { sameOwner, terminalRun, type RetainedOwnerV1, type RetainedRunControlV1 } from "../../core/src/application/retainedExecution.ts";
import { validateRunRef, type RunRef } from "../../core/src/domain/runIdentity.ts";
import type { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { DiagnosticExecutionClockV2, type DiagnosticActivityV2, type DiagnosticClockSnapshotV2 } from "./diagnosticExecutionClock.ts";
import { observeFrameworkError, type FrameworkErrorObserver } from "../../core/src/application/frameworkErrors.ts";

export type RetainedAttemptResultV2 = DurableWorkflowEngineOutcomeV3<JsonValue>;
export interface RetainedAttemptContextV2 {
  readonly schemaVersion: 2;
  readonly runRef: RunRef;
  readonly owner: RetainedOwnerV1;
  readonly deadlineAt: string;
  readonly workDeadlineAt: string;
  readonly signal: AbortSignal;
  readonly diagnosticClock?: {
    readonly clockPath: string;
    observePause(input: DiagnosticActivityV2 & { pauseId: string }): Promise<void>;
    resume(pauseId: string): Promise<void>;
    setActivity(input: DiagnosticActivityV2): Promise<void>;
    snapshot(): DiagnosticClockSnapshotV2;
  };
}
/** The engine adapter owns its worker and all provider subprocesses. stop() must
 * resolve only after they exit and their heartbeat/lease work has stopped. It is
 * idempotent, including when completion rejects. It must not run another step. */
export interface RetainedAttemptWorkerV2 {
  readonly completion: Promise<RetainedAttemptResultV2>;
  stop(): Promise<void>;
}
export type RetainedHostOutcomeV2 =
  | (RetainedAttemptResultV2 & { readonly schemaVersion: 2; readonly spentMs: number })
  | { readonly schemaVersion: 2; readonly status: "failed" | "cancelled"; readonly code: string; readonly message: string; readonly externalDiagnostic?: ExternalErrorDiagnostic };

/** Internal V2 boundary. No change to ExecutionHostV1 or the Local V1 routes.
 * LJ2-032 supplies the retained workflow engine adapter, including replay.
 * prepare resolves credentials and validates pinned code before start creates
 * any worker. It must not start processes; start must return its handle synchronously.
 */
export class LocalRetainedExecutionHostV2 {
  readonly #store: FileRetainedExecutionStoreV1;
  readonly #monotonic: () => number;
  readonly #injectedMonotonic: boolean;
  readonly #onFrameworkError?: FrameworkErrorObserver;
  constructor(store: FileRetainedExecutionStoreV1, options: { monotonicNow?: () => number; onFrameworkError?: FrameworkErrorObserver } = {}) {
    this.#store = store; this.#monotonic = options.monotonicNow ?? (() => performance.now());
    this.#injectedMonotonic = options.monotonicNow !== undefined;
    this.#onFrameworkError = options.onFrameworkError;
  }

  async execute(input: {
    runRef: RunRef; limits: ActiveComputeLimitsV1; hostRequirements: Record<string, string>;
    signal?: AbortSignal;
    /** Only the explicitly authorized V2 diagnostic coordinator enables this. */
    diagnostic?: boolean;
    prepare(context: RetainedAttemptContextV2): Promise<{ start(): RetainedAttemptWorkerV2 }>;
  }): Promise<RetainedHostOutcomeV2> {
    const ref = validateRunRef(structuredClone(input.runRef)), limits = activeComputeLimitsSchema.parse(input.limits);
    let owner: RetainedOwnerV1;
    try { owner = await this.#store.claim(ref, `attempt-${randomUUID()}`, input.hostRequirements, limits, input.diagnostic === true); }
    catch (error) {
      await observeFrameworkError(this.#onFrameworkError, error, "storage");
      const state = await this.#store.read(ref);
      return this.#failure(state, "attempt-not-started", "Cannot start this attempt. Check ownership, remaining allowance, and the retained build's host requirements; current project code will not be substituted.");
    }
    const monotonicNow = input.diagnostic && !this.#injectedMonotonic ? diagnosticMonotonicNow : this.#monotonic;
    const start = monotonicNow();
    const controller = new AbortController();
    let worker: RetainedAttemptWorkerV2 | undefined, result: RetainedAttemptResultV2 | undefined;
    let readinessFailure: ReadinessFailureV1 | undefined;
    let externalDiagnostic: ExternalErrorDiagnostic | undefined;
    let reason: AccountedOutcomeV1 = "failed", workTimer: ReturnType<typeof setTimeout> | undefined;
    let finalizationTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined, polling: Promise<void> | undefined;
    let clock: DiagnosticExecutionClockV2 | undefined, workActive = true;
    const elapsedNow = () => clock ? clock.elapsedMs() : monotonicNow() - start;
    const abort = (why: AccountedOutcomeV1) => { if (!controller.signal.aborted) { reason = why; controller.abort(why); } };
    const cancel = () => abort("cancelled");
    input.signal?.addEventListener("abort", cancel, { once: true });
    let resolveAbort!: () => void;
    const aborted = new Promise<void>(resolve => { resolveAbort = resolve; });
    controller.signal.addEventListener("abort", resolveAbort, { once: true });
    try {
      const state = (await this.#store.read(ref))!;
      const originalDeadlineAt = state.compute!.active!.deadlineAt;
      const workMs = Math.min(limits.attemptMs, limits.totalMs - state.compute!.spentMs) - limits.finalizationReserveMs;
      // Timers are monotonic; calendar changes must not create more allowance.
      const armDeadline = () => {
        if (workTimer) clearTimeout(workTimer);
        workTimer = undefined;
        if (!workActive || controller.signal.aborted) return;
        let remaining: number;
        try { remaining = workMs - elapsedNow(); } catch { abort("accounting_uncertain"); return; }
        if (remaining <= 0) abort("deadline_exceeded");
        else if (clock?.paused) return;
        else workTimer = setTimeout(armDeadline, Math.min(remaining, 2_147_483_647));
      };
      if (input.diagnostic) clock = new DiagnosticExecutionClockV2({ monotonicNow, startedAt: start,
        limitMs: limits.totalMs, priorSpentMs: state.compute!.spentMs, priorExcludedPauseMs: state.compute!.excludedPauseMs ?? 0,
        persist: (revision, record) => this.#store.recordDiagnosticClock(ref, owner, revision, record),
        changed: armDeadline, failed: () => abort("accounting_uncertain") });
      if (clock) await clock.setActivity({ activeCount: 0, activityKnown: false });
      const deadline = () => {
        if (!clock) return originalDeadlineAt;
        const excluded = clock.snapshot().excludedPauseMs;
        if (excluded === null) throw new Error("Diagnostic deadline accounting is uncertain.");
        return new Date(Date.parse(originalDeadlineAt) + excluded - (state.compute!.excludedPauseMs ?? 0)).toISOString();
      };
      const diagnosticClock = clock ? Object.freeze({ clockPath: this.#store.diagnosticClockPath(ref),
        observePause: (value: DiagnosticActivityV2 & { pauseId: string }) => clock!.observePause(value),
        resume: (pauseId: string) => clock!.resume(pauseId), setActivity: (value: DiagnosticActivityV2) => clock!.setActivity(value),
        snapshot: () => clock!.snapshot() }) : undefined;
      const context: RetainedAttemptContextV2 = Object.freeze({ schemaVersion: 2, runRef: Object.freeze(ref), owner: Object.freeze(owner),
        get deadlineAt() { return deadline(); }, get workDeadlineAt() { return new Date(Date.parse(deadline()) - limits.finalizationReserveMs).toISOString(); },
        signal: controller.signal, ...(diagnosticClock ? { diagnosticClock } : {}) });
      armDeadline();
      if (input.signal?.aborted) cancel();
      const poll = () => {
        if (polling) return;
        polling = this.#store.read(ref).then(current => {
          if (!current || !sameOwner(current.owner, owner)) abort("accounting_uncertain");
          else if (terminalRun(current)) abort(current.status === "cancelled" ? "cancelled" : "failed");
        }).catch(async error => { abort("accounting_uncertain"); await observeFrameworkError(this.#onFrameworkError, error, "storage"); }).finally(() => { polling = undefined; });
      };
      pollTimer = setInterval(poll, 100);
      if (controller.signal.aborted) throw new Error("Attempt cancelled before preparation.");
      // Preparation is bounded by the same abort signal. It must not create a
      // worker after abort; only this host calls start after awaiting preparation.
      const prepared = await Promise.race([input.prepare(context), aborted.then(() => { throw new Error("Preparation interrupted."); })]);
      const ready = await this.#store.read(ref);
      if (!ready || !sameOwner(ready.owner, owner)) abort("accounting_uncertain");
      else if (terminalRun(ready)) abort(ready.status === "cancelled" ? "cancelled" : "failed");
      // A synchronous preparation can delay the timer callback. Check the clock
      // before starting provider work even when the abort event has not run yet.
      if (elapsedNow() >= workMs) abort("deadline_exceeded");
      if (controller.signal.aborted) throw new Error("Attempt cancelled before worker start.");
      worker = prepared.start();
      // Cancellation stops ordinary work, but the retained worker owns graph
      // cleanup records. Give it the first half of the reserved finalization
      // window; keep the other half for owned teardown and settlement.
      const finalizationExpired = aborted.then(() => new Promise<never>((_resolve, reject) => {
        if (reason !== "cancelled" && reason !== "deadline_exceeded") {
          reject(new Error("Attempt authority was lost."));
          return;
        }
        finalizationTimer = setTimeout(() => reject(new Error("Attempt finalization reserve expired.")),
          Math.floor(limits.finalizationReserveMs / 2));
      }));
      result = await Promise.race([worker.completion, finalizationExpired]);
      if (elapsedNow() >= workMs) abort("deadline_exceeded");
      if (result.status === "completed") {
        result = { status: "completed", output: immutableJson(inputWaitJsonSnapshot(result.output), "Workflow output") };
        reason = "completed";
      } else if (result.status === "suspended") {
        const definition = validateInputRequestV1(result.request);
        const current = await this.#store.read(ref), request = current?.requests[definition.requestId];
        if (!request || hashJson(inputWaitJsonSnapshot(request.definition)) !== hashJson(inputWaitJsonSnapshot(definition)) || !["pending", "submitted"].includes(request.status)) throw new Error("Suspension requires a saved input request.");
        result = { status: "suspended", request: immutableJson(definition as unknown as JsonValue, "Input request") as unknown as typeof result.request };
        reason = "suspended";
      } else throw new Error("Unknown worker outcome.");
    } catch (error) {
      if (!controller.signal.aborted) await observeFrameworkError(this.#onFrameworkError, error, "worker");
      if (!controller.signal.aborted) reason = "failed";
      if (!worker && error instanceof RetainedAttemptReadinessError) readinessFailure = error.code;
      externalDiagnostic = getExternalErrorDiagnostic(error);
    }
    finally {
      workActive = false;
      if (workTimer) clearTimeout(workTimer);
      if (finalizationTimer) clearTimeout(finalizationTimer);
      if (pollTimer) clearInterval(pollTimer);
      controller.signal.removeEventListener("abort", resolveAbort);
      await polling;
    }
    // No release or queued resume before physical teardown completes. Cleanup
    // time counts. A rejected teardown leaves ownership pinned, not reusable.
    let teardownTimer: ReturnType<typeof setTimeout> | undefined;
    // This only resumes charging. Never continue a paused workflow for cleanup.
    let clockFinishTimer: ReturnType<typeof setTimeout> | undefined, diagnosticCleanupUncertain = false;
    try {
      if (clock) await Promise.race([clock.finish(), new Promise<never>((_resolve, reject) => {
        clockFinishTimer = setTimeout(() => reject(new Error("Diagnostic clock cleanup could not be confirmed.")), Math.max(1, limits.finalizationReserveMs));
      })]);
    } catch (error) { diagnosticCleanupUncertain = true; abort("accounting_uncertain"); await observeFrameworkError(this.#onFrameworkError, error, "resource-cleanup"); }
    finally { if (clockFinishTimer) clearTimeout(clockFinishTimer); }
    try {
      const accounting = (await this.#store.read(ref))!.compute!;
      const cleanupLimit = Math.min(limits.attemptMs, accounting.limits.totalMs - accounting.spentMs);
      await Promise.race([worker?.stop(), new Promise<never>((_resolve, reject) => {
        const arm = () => {
          let charged: number;
          try { charged = elapsedNow(); } catch { charged = monotonicNow() - start; }
          const remaining = cleanupLimit - charged;
          if (remaining <= 0) reject(new Error("Worker teardown deadline reached."));
          else teardownTimer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
        };
        arm();
      })]);
    }
    catch (error) {
      await observeFrameworkError(this.#onFrameworkError, error, "resource-cleanup");
      await this.#store.blockUncertainAttempt(ref, owner);
      return this.#failure(await this.#store.read(ref), "compute-accounting-uncertain", "Worker teardown could not be confirmed.");
    }
    finally {
      if (teardownTimer) clearTimeout(teardownTimer);
      input.signal?.removeEventListener("abort", cancel);
    }
    if (controller.signal.aborted) reason = controller.signal.reason as AccountedOutcomeV1;
    if (diagnosticCleanupUncertain) {
      await this.#store.blockUncertainAttempt(ref, owner);
      return this.#failure(await this.#store.read(ref), "compute-accounting-uncertain", "Diagnostic clock cleanup could not be confirmed.");
    }
    let elapsed: number, diagnosticSettlement: ReturnType<DiagnosticExecutionClockV2["settlement"]> | undefined;
    try { diagnosticSettlement = clock?.settlement(); elapsed = diagnosticSettlement?.elapsedMs ?? elapsedNow(); }
    catch (error) {
      await observeFrameworkError(this.#onFrameworkError, error, "storage");
      await this.#store.blockUncertainAttempt(ref, owner);
      return this.#failure(await this.#store.read(ref), "compute-accounting-uncertain", "Diagnostic pause accounting could not be reconciled.");
    }
    if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isSafeInteger(Math.ceil(elapsed))) {
      reason = "accounting_uncertain";
    }
    let state: RetainedRunControlV1;
    try {
      state = await this.#store.settleAttempt(ref, owner, { elapsedMs: reason === "accounting_uncertain" ? 0 : Math.ceil(elapsed), outcome: reason,
        ...(diagnosticSettlement ? { diagnostic: { wallElapsedMs: diagnosticSettlement.wallElapsedMs, excludedPauseMs: diagnosticSettlement.excludedPauseMs } } : {}),
        ...(readinessFailure ? { readinessFailure } : {}),
        ...(reason === "failed" && externalDiagnostic ? { externalDiagnostic } : {}),
        ...(reason === "completed" && result?.status === "completed" ? { output: inputWaitJsonSnapshot(result.output) } : {}),
        ...(reason === "suspended" && result?.status === "suspended" ? { requestId: result.request.requestId } : {}) });
    } catch (error) {
      await observeFrameworkError(this.#onFrameworkError, error, "storage");
      // A failed durable settlement is never reported as success. Recovery will
      // leave an unaccounted dead owner blocked instead of minting a new budget.
      await this.#store.blockUncertainAttempt(ref, owner);
      return this.#failure(await this.#store.read(ref), "compute-accounting-uncertain", "Attempt settlement could not be confirmed.");
    }
    if (state.status === "failed" || state.status === "cancelled") return this.#failure(state, "attempt-failed", "The attempt stopped before completion. Check credentials and retained runtime compatibility.");
    if (!result) return this.#failure(state, "attempt-failed", "No workflow outcome was produced.");
    return { schemaVersion: 2, ...result, spentMs: state.compute!.spentMs };
  }

  #failure(state: RetainedRunControlV1 | undefined, code: string, message: string): RetainedHostOutcomeV2 {
    if (state?.status === "cancelled") return { schemaVersion: 2, status: "cancelled", code: "attempt-cancelled", message: "The Run was cancelled." };
    return { schemaVersion: 2, status: "failed", code: state?.failure?.code ?? code, message: state?.failure?.message ?? message,
      ...(state?.failure?.externalDiagnostic ? { externalDiagnostic: state.failure.externalDiagnostic } : {}) };
  }
}
