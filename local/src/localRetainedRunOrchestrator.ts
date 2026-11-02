/** Internal Run orchestration. No HTTP types, response envelopes or server ownership. */
import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { validateTrustedRunCommand } from "../../core/src/application/trustedRunCommand.ts";
import { validateWorkflowInvocationV1 } from "../../core/src/application/durableWorkflowInvocation.ts";
import { validateRetainedGraphInputV1, type RetainedGraphInputV1 } from "../../core/src/application/retainedGraphInput.ts";
import { activeComputeLimitsSchema } from "../../core/src/application/activeCompute.ts";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import { inputWaitJsonSnapshot, validateInputResponseShapeV1 } from "../../core/src/application/inputWait.ts";
import { executableBindingSchema, runKey, type ExecutableBindingV1, type RetainedRunControlV1 } from "../../core/src/application/retainedExecution.ts";
import type { RunStatusProjection } from "../../core/src/application/runState.ts";
import { validateRunRef, type RunRef } from "../../core/src/domain/runIdentity.ts";
import { FileRunStateV3Store } from "../../core/src/infrastructure/storage/fileRunStateV3Store.ts";
import { FileRunArtifactStore } from "../../core/src/infrastructure/storage/fileRunArtifactStore.ts";
import { FilePublishedResultStore, PublishedResultAlreadyExistsError } from "../../core/src/infrastructure/storage/filePublishedResultStore.ts";
import { InputSubmissionValidationError, type FileRetainedExecutionStoreV1, type InputFileUploadV1,
  type InputFileUploadReceiptV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { reserveLocalRetainedRun, validateLocalRetainedGraphBoundary, RetainedRunAdmissionError } from "./localRetainedRunAdmission.ts";
import { LocalRetainedWorkflowRunnerV1 } from "./localRetainedWorkflowRunner.ts";
import { resolveLocalExecutionDataPaths } from "./localStorePaths.ts";
import { publishRetainedPerformance } from "./localRetainedPerformance.ts";
import { validateLocalRetainedInput, RetainedInputValidationError } from "./localRetainedInputValidator.ts";
import { InputControlConflict } from "../../core/src/application/retainedExecution.ts";
import { observeFrameworkError, type FrameworkErrorObserver } from "../../core/src/application/frameworkErrors.ts";

import type { RunActor } from "../../core/src/domain/runActor.ts";
import type { WorkflowIdentity } from "../../core/src/domain/workflowIdentity.ts";
import type { ResolvedRunConfiguration } from "../../core/src/application/runConfiguration.ts";
import type { InputSubmissionReceiptV1, StoredInputSubmissionV1 } from "../../core/src/application/retainedExecution.ts";

const same = (a: unknown, b: unknown) => hashJson(inputWaitJsonSnapshot(a)) === hashJson(inputWaitJsonSnapshot(b));
const profileSchema = z.object({ maxScratchBytes: z.number().int().positive().safe(), computeLimits: activeComputeLimitsSchema });

export interface RetainedRunReservation {
  actor: RunActor;
  workflow: WorkflowIdentity;
  input: unknown;
  resolvedConfiguration: ResolvedRunConfiguration<{ configurationId: string; workflow: WorkflowIdentity; [key: string]: unknown }>;
  requestedExecutionId?: string;
}
export interface PreparedGraphRetainedBinding {
  binding: ExecutableBindingV1;
  graphInput: RetainedGraphInputV1;
  admittedInput: unknown;
}
export type PreparedRetainedBinding = ExecutableBindingV1 | PreparedGraphRetainedBinding;

export class RetainedInputError extends Error {
  constructor(readonly code: "invalid-response" | "validation-unavailable" | "input-unavailable", message: string,
    readonly fieldErrors?: { field: string; message: string }[]) { super(message); }
}

export class LocalRetainedRunOrchestrator {
  async listInputRequests(ref: RunRef) {
    const expired = await this.options.store.expireGraphInput(ref).catch(error => {
      if (!(error instanceof InputControlConflict && error.code === "not-found")) throw error;
      return false;
    });
    if (expired) await this.refresh(ref);
    const state = await this.options.store.read(ref);
    if (!state || state.retainedDataDeleted) return [];
    const scalar = Object.values(state.requests).map(request => ({
      definition: request.definition, status: request.status, revision: request.revision, updatedAt: request.updatedAt,
      ...(request.response === undefined ? {} : { response: request.response }),
      ...(request.submissionId ? { receipt: state.receipts[request.submissionId] } : {}),
    }));
    const graph = state.graphInput?.requestState;
    if (!graph) return scalar;
    const invocation = state.graphInput!.invocation;
    return [...scalar, { kind: "graph-entry" as const, schemaVersion: 1 as const,
      requestId: graph.request.requestId, status: graph.status, revision: graph.revision, updatedAt: graph.updatedAt,
      entry: invocation.entryPlan.entry, planSha256: invocation.entryPlan.planSha256,
      requirements: invocation.entryPlan.requirements, createdAt: graph.request.createdAt, expiresAt: graph.request.expiresAt,
      ...(state.graphInput!.accepted ? { accepted: { acceptanceId: state.graphInput!.accepted.acceptanceId,
        acceptedAt: state.graphInput!.accepted.acceptedAt, acceptedBodySha256: state.graphInput!.accepted.acceptedBodySha256 } } : {}) }];
  }

  uploadInputFile(ref: RunRef, requestId: string, body: InputFileUploadV1,
    options: { signal?: AbortSignal } = {}): Promise<InputFileUploadReceiptV1> {
    return this.#admit(() => this.options.store.uploadInputFile(ref, requestId, body), options.signal);
  }

  submitInput(ref: RunRef, requestId: string, body: Omit<StoredInputSubmissionV1, "response"> & { response: unknown },
    responderId: string, options: { signal?: AbortSignal } = {}): Promise<InputSubmissionReceiptV1 | { kind: "graph-entry"; accepted: {
      schemaVersion: 1; acceptanceId: string; requestId: string; acceptedAt: string; acceptedBodySha256: string;
    } }> {
    return this.#admit(async signal => {
      try {
        const control = await this.options.store.read(ref);
        if (!control) throw new InputControlConflict("not-found");
        if (control.graphInput?.requestState?.request.requestId === requestId) {
          const accepted = await this.options.store.submitGraphInputValidated(ref, {
            acceptanceId: body.submissionId, expectedRevision: body.expectedRevision, boundary: body.response,
          }, (graphInput, boundary) => validateLocalRetainedGraphBoundary(this.options.store, {
            binding: control.binding, graphInput, boundary, workerPath: this.options.workerPath, signal,
          }));
          this.#dispatchAnswer(ref);
          return { kind: "graph-entry", accepted: { schemaVersion: 1, acceptanceId: accepted.acceptanceId,
            requestId: accepted.source === "deferred-submission" ? accepted.requestId : requestId,
            acceptedAt: accepted.acceptedAt, acceptedBodySha256: accepted.acceptedBodySha256 } };
        }
        const receipt = await this.options.store.submit(ref, requestId, body as StoredInputSubmissionV1, responderId,
          async (request, raw) => {
            let response;
            try { response = await validateLocalRetainedInput({ projectRoot: this.options.projectRoot, executionDataRoot: this.options.executionDataRoot, store: this.options.store,
              control, requestId, response: raw, signal, workerPath: this.options.workerPath }); }
            catch (error) {
              if (error instanceof RetainedInputValidationError && error.code === "invalid-response") throw invalidAnswer("$form", "The retained form rejected this answer.");
              throw new RetainedInputError("validation-unavailable", "The retained form could not be validated. Retry after restoring its runtime.");
            }
            try { return validateInputResponseShapeV1(request.form, response); }
            catch { throw invalidAnswer("$form", "The retained form returned an invalid answer."); }
          });
        // The committed receipt remains authoritative even if dispatch needs recovery.
        this.#dispatchAnswer(ref);
        return receipt;
      } catch (error) {
        if (error instanceof RetainedInputError || error instanceof InputControlConflict) throw error;
        if (error instanceof RetainedRunAdmissionError) {
          if (error.code === "invalid-input") throw invalidAnswer("$form", "The graph entry rejected this input.");
          throw new RetainedInputError("validation-unavailable", "The retained graph entry could not be validated. Retry after restoring its runtime.");
        }
        if (error instanceof InputSubmissionValidationError) throw invalidAnswer(error.field, "This field does not match the saved form.");
        throw new RetainedInputError("input-unavailable", "The input request could not be processed. Retry with the same submission ID.");
      }
    }, options.signal);
  }
  readonly #active = new Map<string, { controller: AbortController; work: Promise<void> }>();
  readonly #projections = new Map<string, Promise<void>>();
  readonly #admissions = new Map<AbortController, Promise<unknown>>();
  readonly #dispatches = new Map<string, Promise<void>>();
  readonly #requestedDispatches = new Set<string>();
  #closed = false;
  /** Local reload gate: suspended Runs have no active compute/admission here. */
  isIdle(): boolean {
    return !this.#active.size && !this.#admissions.size && !this.#dispatches.size
      && !this.#requestedDispatches.size && !this.#projections.size;
  }
  constructor(readonly options: { projectRoot: string; executionDataRoot?: string; store: FileRetainedExecutionStoreV1;
    onFrameworkError?: FrameworkErrorObserver;
    runner: LocalRetainedWorkflowRunnerV1; workerPath?: string; hostRequirements: Record<string, string>;
    onFirstValidTypedResult?(event: { elapsedMs: number }): Promise<void>;
    onRunSettled?(event: { executionId: string; status: "complete" | "failed" | "cancelled"; elapsedMs: number }): Promise<void> }) {
    if (options.runner.options.store !== options.store || path.resolve(options.runner.options.projectRoot) !== path.resolve(options.projectRoot)
      || resolveLocalExecutionDataPaths(options.projectRoot, options.executionDataRoot).root
        !== resolveLocalExecutionDataPaths(options.runner.options.projectRoot, options.runner.options.executionDataRoot).root) {
      throw new Error("Retained Run service and worker must use the same project, execution data root and store.");
    }
  }

  /** Trusted application admission; caller owns authentication, authorization and
   * configuration resolution. Preparation remains inside the tracked admission
   * lifetime so shutdown cannot release storage while a build is being admitted. */
  reserve(request: RetainedRunReservation, options: {
    workflow: WorkflowIdentity; agentSlotIds: readonly string[];
    prepareBinding(request: RetainedRunReservation): Promise<PreparedRetainedBinding>;
    signal?: AbortSignal;
  }): Promise<RunRef> {
    const fixed = structuredClone(request);
    return this.#admit(async signal => {
      const prepared = await options.prepareBinding(structuredClone(fixed));
      const graphPrepared = isPreparedGraphBinding(prepared);
      const binding = executableBindingSchema.parse(inputWaitJsonSnapshot(graphPrepared ? prepared.binding : prepared));
      const graphInput = graphPrepared ? validateRetainedGraphInputV1(prepared.graphInput) : undefined;
      const invocation = graphInput?.invocation ?? validateWorkflowInvocationV1(binding.invocation), manifest = binding.runManifest;
      profileSchema.parse(binding.executionProfile);
      if (!manifest || !same(manifest.actor, fixed.actor) || !same(manifest.workflow, fixed.workflow)
        || !same(manifest.workflow, options.workflow) || !(graphPrepared ? same(prepared.admittedInput, fixed.input) : same((invocation as ReturnType<typeof validateWorkflowInvocationV1>).input, fixed.input))
        || !same(binding.runConfiguration, fixed.resolvedConfiguration.configuration)
        || manifest.runConfiguration.contentHash !== fixed.resolvedConfiguration.contentHash
        || (fixed.requestedExecutionId && manifest.runRef.executionId !== fixed.requestedExecutionId)) {
        throw new Error("Retained admission does not match the authorized Run request.");
      }
      if (graphInput) {
        await this.#state(manifest.runRef).reserve();
        await this.options.store.createRun(manifest.runRef, binding, { state: graphInput });
      } else {
        await reserveLocalRetainedRun(this.options.store, { runRef: manifest.runRef, binding,
          agentSlotIds: options.agentSlotIds, workerPath: this.options.workerPath, signal,
          beforeReserve: () => this.#state(manifest.runRef).reserve() });
      }
      await this.refresh(manifest.runRef);
      return manifest.runRef;
    }, options.signal);
  }

  async dispatch(value: unknown): Promise<void> {
    const command = validateTrustedRunCommand(value, inputWaitJsonSnapshot);
    const stored = await this.options.store.read(command.runRef), manifest = stored?.binding.runManifest;
    if (!stored || !manifest || !same(command.actor, manifest.actor) || !same(command.workflow, manifest.workflow)
      || !same(command.runConfiguration, manifest.runConfiguration)
      || !same(command.input, stored.graphInput ? graphInvocationRequest(stored.graphInput) : validateWorkflowInvocationV1(stored.binding.invocation).input)) {
      throw new Error("Dispatch does not match the admitted Run.");
    }
    await this.execute(command.runRef);
  }

  /** Dispatch a durable initial/resume intent; duplicate dispatch joins the attempt. */
  execute(value: RunRef): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Retained Run service is closed."));
    const ref = validateRunRef(structuredClone(value)), key = runKey(ref), active = this.#active.get(key);
    if (active) return active.work;
    const controller = new AbortController();
    const work = (async () => {
      const state = await this.options.store.read(ref);
      if (!state?.binding.runManifest || state.retainedDataDeleted) throw new Error("Published retained Run is unavailable.");
      if (!state.owner && (state.status === "running" || state.status === "resume_queued")) {
        const profile = profileSchema.parse(state.binding.executionProfile);
        let again: boolean;
        do {
          const outcome = await this.options.runner.execute(ref, profile.computeLimits, this.options.hostRequirements, controller.signal, () => this.refresh(ref));
          await this.refresh(ref);
          const current = await this.options.store.read(ref);
          again = outcome.status === "suspended" && current?.status === "resume_queued" && !current.owner && !controller.signal.aborted;
        } while (again);
      }
      // Read canonical state, not the worker's earlier suspension message: an
      // answer may already have queued resume while that worker was stopping.
      await this.refresh(ref);
    })().catch(async error => { await observeFrameworkError(this.options.onFrameworkError, error, "background"); throw error; })
      .finally(() => this.#active.delete(key));
    this.#active.set(key, { controller, work });
    return work;
  }

  /** Reconcile ownership and projections only; opening a diagnostic session must not execute it. */
  reconcile(): Promise<void> {
    return this.#admit(async () => {
      await this.options.store.recover();
      for (const state of await this.options.store.listRuns()) {
        if (state.binding.runManifest && !state.retainedDataDeleted) await this.refresh(state.runRef);
      }
    });
  }

  /** Repair public reads/results before dispatching saved intents. No registry lookup. */
  async recover(): Promise<void> {
    await this.reconcile();
    for (const state of await this.options.store.listRuns()) {
      if (state.binding.runManifest && !state.retainedDataDeleted) await this.execute(state.runRef);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const controller of this.#admissions.keys()) controller.abort();
    await Promise.allSettled([...this.#admissions.values()]);
    for (const { controller } of this.#active.values()) controller.abort();
    await Promise.allSettled([...this.#active.values()].map(({ work }) => work));
    await Promise.allSettled([...this.#dispatches.values()]);
    await Promise.allSettled([...this.#projections.values()]);
    // The caller owns the shared store and closes it after the service.
  }

  async cancel(value: RunRef): Promise<void> {
    const ref = validateRunRef(structuredClone(value)), key = runKey(ref);
    const active = this.#active.get(key);
    await this.options.store.cancel(ref);
    active?.controller.abort();
    await active?.work.catch(() => {});
    await this.refresh(ref);
  }

  #dispatchAnswer(ref: RunRef): void {
    const key = runKey(ref);
    if (this.#closed) return;
    this.#requestedDispatches.add(key);
    if (this.#dispatches.has(key)) return;
    const work = (async () => {
      do {
        this.#requestedDispatches.delete(key);
        await this.refresh(ref);
        await this.execute(ref);
        // A joined old attempt may already have made its final resume check.
        // Recheck only after its promise clears the active-attempt entry.
        const current = await this.options.store.read(ref);
        if (current?.status === "resume_queued" && !current.owner) this.#requestedDispatches.add(key);
      } while (!this.#closed && this.#requestedDispatches.has(key));
    })().catch(async error => {
      await observeFrameworkError(this.options.onFrameworkError, error, "background");
      // The committed intent remains recoverable; do not leak provider data.
      if (!this.#closed) console.error("Retained input was accepted, but dispatch failed. Retry the same submission or restart the Local server.");
    }).finally(() => {
      this.#dispatches.delete(key);
      if (this.#requestedDispatches.has(key)) this.#dispatchAnswer(ref);
    });
    this.#dispatches.set(key, work);
  }

  #admit<T>(operation: (signal: AbortSignal) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Retained Run service is closed."));
    const controller = new AbortController();
    const abort = () => controller.abort();
    externalSignal?.addEventListener("abort", abort, { once: true });
    if (externalSignal?.aborted) abort();
    const work = Promise.resolve().then(() => operation(controller.signal)).finally(() => {
      externalSignal?.removeEventListener("abort", abort);
      this.#admissions.delete(controller);
    });
    this.#admissions.set(controller, work);
    return work;
  }

  refresh(value: RunRef): Promise<void> {
    const ref = validateRunRef(structuredClone(value)), key = runKey(ref);
    const work = (this.#projections.get(key) ?? Promise.resolve()).catch(() => {}).then(() => this.#publish(ref))
      .catch(async error => { await observeFrameworkError(this.options.onFrameworkError, error, "storage"); throw error; });
    this.#projections.set(key, work);
    void work.finally(() => { if (this.#projections.get(key) === work) this.#projections.delete(key); }).catch(() => {});
    return work;
  }

  #root(ref: RunRef): string { return path.join(resolveLocalExecutionDataPaths(this.options.projectRoot, this.options.executionDataRoot).runs, ref.executionId); }
  #state(ref: RunRef): FileRunStateV3Store {
    return new FileRunStateV3Store({ root: path.join(this.#root(ref), "state"), runRef: ref,
      reservationRoot: resolveLocalExecutionDataPaths(this.options.projectRoot, this.options.executionDataRoot).reservations });
  }

  async #publish(ref: RunRef): Promise<void> {
    const control = await this.options.store.read(ref), manifest = control?.binding.runManifest;
    if (!control || !manifest || control.retainedDataDeleted) throw new Error("Published retained Run is unavailable.");
    const graphInput = control.graphInput && validateRetainedGraphInputV1(control.graphInput);
    const invocation = graphInput?.invocation ?? validateWorkflowInvocationV1(control.binding.invocation), state = this.#state(ref);
    const existing = await state.get();
    if (existing && !same(existing.manifest, manifest)) throw new Error("Public Run identity differs from retained Run.");
    if (!existing) await state.create(manifest);
    const artifacts = new FileRunArtifactStore(this.#root(ref));
    await artifacts.scope("state").writeJson("run-config.resolved.json", control.binding.runConfiguration);
    if (!graphInput || graphInput.accepted) {
      // This artifact is the public starting input. Correction reuses it to
      // submit a new Run, so graph Runs need the complete supplied envelope,
      // not only the internal entry values consumed by the graph worker.
      // A historical deferred request stays in retained state for replay; once
      // accepted, its correction starts from the accepted values instead.
      await artifacts.scope("artifacts").writeJson("input.json", graphInput
        ? graphCorrectionInput(graphInput)
        : (invocation as ReturnType<typeof validateWorkflowInvocationV1>).input);
    }
    if (control.status === "complete") {
      if (control.output === undefined) throw new Error("Completed retained Run has no saved output.");
      const envelope = { envelopeSchemaVersion: 1 as const, resultKind: invocation.resultKind, runRef: ref, payload: control.output };
      const results = new FilePublishedResultStore({ root: this.#root(ref), resultId: ({ resultKind }) => `${resultKind}.json` });
      try { await results.publish(envelope); }
      catch (error) {
        if (!(error instanceof PublishedResultAlreadyExistsError)) throw error;
        const saved = JSON.parse(await readFile(path.join(this.#root(ref), `${invocation.resultKind}.json`), "utf8"));
        if (!same(saved, envelope)) throw new Error("Published output differs from the completed retained Run.");
      }
      await this.options.onFirstValidTypedResult?.({
        elapsedMs: Math.max(0, Date.now() - new Date(manifest.createdAt).getTime()),
      }).catch(error => observeFrameworkError(this.options.onFrameworkError, error, "telemetry"));
    }
    await publishRetainedPerformance(this.options.projectRoot, control, this.options.executionDataRoot);
    // Never mark complete until its durable output and performance are available.
    await state.update(projectRetainedRunStatus(control));
    if (control.status === "complete" || control.status === "failed" || control.status === "cancelled") {
      await this.options.onRunSettled?.({ executionId: ref.executionId, status: control.status,
        elapsedMs: Math.max(0, Date.now() - new Date(manifest.createdAt).getTime()),
      }).catch(error => observeFrameworkError(this.options.onFrameworkError, error, "telemetry"));
    }
  }
}

function isPreparedGraphBinding(value: PreparedRetainedBinding): value is PreparedGraphRetainedBinding {
  return typeof value === "object" && value !== null && Object.hasOwn(value, "graphInput");
}

function graphInvocationRequest(graphInputValue: RetainedGraphInputV1) {
  const graphInput = validateRetainedGraphInputV1(graphInputValue), invocation = graphInput.invocation;
  const entry = graphInvocationEntry(graphInput);
  return invocation.acquisition === "deferred"
    ? { schemaVersion: 1 as const, acquisition: "deferred" as const, entry, wait: invocation.wait }
    : { schemaVersion: 1 as const, acquisition: "supplied" as const, entry, values: graphInput.accepted!.boundary.values };
}

function graphCorrectionInput(graphInputValue: RetainedGraphInputV1) {
  const graphInput = validateRetainedGraphInputV1(graphInputValue);
  if (!graphInput.accepted) throw new Error("A graph Run needs accepted input before it can be corrected.");
  return { schemaVersion: 1 as const, acquisition: "supplied" as const, entry: graphInvocationEntry(graphInput),
    values: graphInput.accepted.boundary.values };
}

function graphInvocationEntry(graphInput: ReturnType<typeof validateRetainedGraphInputV1>) {
  const invocation = graphInput.invocation;
  return invocation.entryPlan.entryKind === "default"
    ? { kind: "default" as const }
    : { kind: "selected" as const, address: invocation.entryPlan.entry };
}

function invalidAnswer(field: string, message: string): RetainedInputError {
  return new RetainedInputError("invalid-response", "The answer was not accepted.", [{ field, message }]);
}

export function projectRetainedRunStatus(state: RetainedRunControlV1): RunStatusProjection {
  const base = { kind: "status" as const, updatedAt: state.updatedAt };
  if (state.status === "waiting_for_input" || state.status === "resume_queued") {
    if (state.graphInput?.requestState) {
      const request = state.graphInput.requestState.request;
      return { ...base, status: state.status, requestId: request.requestId, expiresAt: request.expiresAt,
        activeComputeMs: state.compute?.spentMs ?? 0 };
    }
    const request = state.status === "waiting_for_input"
      ? Object.values(state.requests).find(request => request.status === "pending")
      : state.requests[Object.values(state.commands).find(command => command.state !== "done")?.requestId ?? ""];
    if (!request) throw new Error("Waiting Run has no corresponding input request.");
    return { ...base, status: state.status, requestId: request.definition.requestId, expiresAt: request.definition.expiresAt,
      activeComputeMs: state.compute?.spentMs ?? 0 };
  }
  if (state.status === "cancelled") return { ...base, status: "cancelled" };
  if (state.status === "failed") return { ...base, status: "failed", message: state.failure?.message ?? "The retained attempt failed." };
  return { ...base, status: state.status };
}
