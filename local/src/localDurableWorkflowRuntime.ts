import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getExternalErrorDiagnostic, getFailureRetryability, publicErrorMessage, readExternalErrorDiagnostic,
  readFailureRetryability, type ExternalErrorDiagnostic, type FailureRetryabilityV1 } from "../../core/src/application/externalError.ts";
import {
  FileAgentOperationStoreV1,
  FileDurableExecutionEventSinkV1,
  FileEffectOperationStoreV1,
  FileStepCheckpointStoreV2,
} from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";
import { FileWorkflowInvocationStoreV1 } from "../../core/src/infrastructure/storage/fileWorkflowInvocationStore.ts";
import type {
  DurableExecutionStorageV2,
  ExecutionStorageV2,
  ExecutionStorageV3,
  ExecutionAttemptV1,
  ExecutionHostContextV1,
  ExecutionHostOutcomeV1,
  ExecutionHostV1,
} from "../../core/src/application/durableExecution.ts";
import {
  assertInvocationMatchesDefinition,
  type DurableRunConfigurationResolverV1,
  type DurableWorkflowDefinitionResolverV1,
  type ResolvedInterruptedWorkflowV1,
  type WorkflowInvocationStoreV1,
} from "../../core/src/application/durableWorkflowInvocation.ts";
import type { DeepReadonly, JsonValue } from "../../core/src/application/durableWorkflow.ts";
import { assertDurableIdentifier, immutableJson } from "../../core/src/application/durableWorkflow.ts";
import { validateRunRef, type RunRef } from "../../core/src/domain/runIdentity.ts";
import { validateRunStateProjection, type RunLifecycleStatus } from "../../core/src/application/runState.ts";
import { resolveLocalExecutionDataPaths, resolveLocalFileStorePaths } from "./localStorePaths.ts";

export interface LocalDurableExecutionPaths {
  readonly root: string;
  readonly invocation: string;
  readonly attempts: string;
  readonly scratch: string;
}

export function resolveLocalDurableExecutionPaths(repositoryRoot: string, runRef: RunRef, executionDataRoot?: string): LocalDurableExecutionPaths {
  assertDurableIdentifier(runRef.executionId, "Execution ID");
  const runRoot = path.join(resolveLocalExecutionDataPaths(repositoryRoot, executionDataRoot).runs, runRef.executionId);
  const root = path.join(runRoot, "durable");
  return { root, invocation: path.join(root, "invocation.json"), attempts: path.join(root, "attempts"), scratch: path.join(root, "scratch") };
}

export function createLocalWorkflowInvocationStore(
  repositoryRoot: string,
  runRef: RunRef,
): WorkflowInvocationStoreV1 {
  return new FileWorkflowInvocationStoreV1({ root: resolveLocalDurableExecutionPaths(repositoryRoot, runRef).root });
}

export function createLocalDurableExecutionStorage(
  repositoryRoot: string,
  runRef: RunRef,
): DurableExecutionStorageV2 & { readonly root: string } {
  const { root } = resolveLocalDurableExecutionPaths(repositoryRoot, runRef);
  return {
    root,
    steps: new FileStepCheckpointStoreV2({ root }),
    agents: new FileAgentOperationStoreV1({ root }),
    effects: new FileEffectOperationStoreV1({ root }),
    events: new FileDurableExecutionEventSinkV1({ root }),
  };
}

export function composeLocalExecutionStorageV2<
  RunStateStore,
  RunPerformanceStore,
  RunArtifactStore,
  PublishedResultStore,
>(
  repositoryRoot: string,
  runRef: RunRef,
  existing: {
    readonly runState: RunStateStore;
    readonly performance: RunPerformanceStore;
    readonly artifacts: RunArtifactStore;
    readonly results: PublishedResultStore;
  },
): ExecutionStorageV2<RunStateStore, DurableExecutionStorageV2["events"], RunPerformanceStore, RunArtifactStore, PublishedResultStore> & { readonly root: string } {
  return {
    schemaVersion: 1,
    ...createLocalDurableExecutionStorage(repositoryRoot, runRef),
    ...existing,
  };
}

export function composeLocalExecutionStorageV3<
  RunStateStore,
  RunPerformanceStore,
  RunArtifactStore,
  PublishedResultStore,
>(
  repositoryRoot: string,
  runRef: RunRef,
  existing: {
    readonly runState: RunStateStore;
    readonly performance: RunPerformanceStore;
    readonly artifacts: RunArtifactStore;
    readonly results: PublishedResultStore;
  },
): ExecutionStorageV3<RunStateStore, DurableExecutionStorageV2["events"], RunPerformanceStore, RunArtifactStore, PublishedResultStore> & { readonly root: string } {
  return {
    ...composeLocalExecutionStorageV2(repositoryRoot, runRef, existing),
    invocations: createLocalWorkflowInvocationStore(repositoryRoot, runRef),
  };
}

export interface LocalExecutionAttemptRecordV1 extends ExecutionAttemptV1 {
  readonly state: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "OUTCOME_UNKNOWN";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly terminal?: { readonly code: string; readonly message: string; readonly retryability?: FailureRetryabilityV1;
    readonly externalDiagnostic?: ExternalErrorDiagnostic };
}

export interface LocalWholeRunExecutionHostOptions {
  readonly repositoryRoot: string;
  readonly heartbeat?: (attempt: ExecutionAttemptV1) => Promise<void>;
  readonly now?: () => Date;
}

export class LocalWholeRunExecutionHostV1 implements ExecutionHostV1 {
  readonly #repositoryRoot: string;
  readonly #heartbeat: (attempt: ExecutionAttemptV1) => Promise<void>;
  readonly #now: () => Date;
  readonly #active = new Map<string, { readonly controller: AbortController; reason?: "cancelled" | "deadline_exceeded" | "host_terminated" }>();

  constructor(options: LocalWholeRunExecutionHostOptions) {
    this.#repositoryRoot = path.resolve(options.repositoryRoot);
    this.#heartbeat = options.heartbeat ?? (async () => undefined);
    this.#now = options.now ?? (() => new Date());
  }

  async nextAttempt(runRef: RunRef, options: {
    readonly maxDurationMs: number;
    readonly finalizationReserveMs: number;
    readonly maxScratchBytes: number;
  }): Promise<ExecutionAttemptV1> {
    positive(options.maxDurationMs, "Maximum duration");
    positive(options.maxScratchBytes, "Maximum scratch bytes");
    if (!Number.isInteger(options.finalizationReserveMs) || options.finalizationReserveMs < 0 || options.finalizationReserveMs >= options.maxDurationMs) {
      throw new Error("Finalization reserve must be a non-negative integer smaller than maximum duration.");
    }
    const paths = resolveLocalDurableExecutionPaths(this.#repositoryRoot, runRef);
    await fs.mkdir(paths.attempts, { recursive: true });
    const records = await this.listAttempts(runRef);
    const fence = records.reduce((maximum, record) => Math.max(maximum, record.fence), 0) + 1;
    const attemptId = `attempt-${fence}-${randomUUID()}`;
    return {
      schemaVersion: 1,
      runRef,
      attemptId,
      fence,
      deadlineAt: new Date(this.#now().getTime() + options.maxDurationMs).toISOString(),
      finalizationReserveMs: options.finalizationReserveMs,
      scratchDirectory: path.join(paths.scratch, attemptId),
      limits: { maxDurationMs: options.maxDurationMs, maxScratchBytes: options.maxScratchBytes },
    };
  }

  async executeAttempt<Output extends JsonValue>(
    attempt: ExecutionAttemptV1,
    executeWorkflow: (context: ExecutionHostContextV1) => Promise<DeepReadonly<Output>>,
  ): Promise<ExecutionHostOutcomeV1<Output>> {
    this.#validateAttempt(attempt);
    const paths = resolveLocalDurableExecutionPaths(this.#repositoryRoot, attempt.runRef);
    const recordPath = path.join(paths.attempts, `${attempt.attemptId}.json`);
    const startedAt = this.#now().toISOString();
    const record: LocalExecutionAttemptRecordV1 = { ...attempt, state: "RUNNING", startedAt, updatedAt: startedAt };
    await createRecord(recordPath, record);
    await fs.mkdir(attempt.scratchDirectory, { recursive: true, mode: 0o700 });
    const cancellationPath = path.join(paths.root, "cancellation.json");
    const existingCancellation = await readJson(cancellationPath, validateCancellationRecord);
    const controller = new AbortController();
    const active: { controller: AbortController; reason?: "cancelled" | "deadline_exceeded" | "host_terminated" } = { controller };
    this.#active.set(attempt.runRef.executionId, active);
    let deadlineTimer: NodeJS.Timeout | undefined;
    try {
      if (existingCancellation) active.reason = existingCancellation.reason;
      if (active.reason) controller.abort(active.reason);
      const remaining = Date.parse(attempt.deadlineAt) - this.#now().getTime();
      if (remaining <= 0) { active.reason = "deadline_exceeded"; controller.abort(active.reason); }
      else deadlineTimer = setTimeout(() => { active.reason = "deadline_exceeded"; controller.abort(active.reason); }, remaining);
      const cancellation = {
        get aborted() { return controller.signal.aborted; },
        get reason() { return active.reason; },
      };
      if (cancellation.aborted) return await this.#finish(recordPath, record, "CANCELLED", { status: "cancelled", reason: active.reason! }, active.reason!, "Workflow attempt was cancelled before execution.");
      const output = immutableJson(await executeWorkflow({ ...attempt, cancellation, heartbeat: () => this.#heartbeat(attempt) }) as Output, "Workflow output");
      return await this.#finish(recordPath, record, "COMPLETED", { status: "completed", output });
    } catch (error) {
      const message = publicErrorMessage(error, "The workflow attempt failed. Inspect its runtime diagnostics before retrying.");
      const diagnostic = getExternalErrorDiagnostic(error);
      const details = { retryability: getFailureRetryability(error), ...(diagnostic ? { externalDiagnostic: diagnostic } : {}) };
      if (active.reason) return await this.#finish(recordPath, record, "CANCELLED", { status: "cancelled", reason: active.reason }, active.reason, "The workflow attempt was cancelled.");
      if (isOutcomeUnknown(error)) return await this.#finish(recordPath, record, "OUTCOME_UNKNOWN", { status: "outcome_unknown", code: "outcome_unknown", message, ...details }, "outcome_unknown", message);
      return await this.#finish(recordPath, record, "FAILED", { status: "failed", code: "workflow_failed", message, ...details }, "workflow_failed", message);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.#active.delete(attempt.runRef.executionId);
      await fs.rm(attempt.scratchDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async cancel(runRef: RunRef, reason: "cancelled" | "deadline_exceeded" | "host_terminated"): Promise<void> {
    const paths = resolveLocalDurableExecutionPaths(this.#repositoryRoot, runRef);
    await replaceRecord(path.join(paths.root, "cancellation.json"), { schemaVersion: 1, runRef, reason, at: this.#now().toISOString() });
    const active = this.#active.get(runRef.executionId);
    if (active) { active.reason = reason; active.controller.abort(reason); }
  }

  async listAttempts(runRef: RunRef): Promise<LocalExecutionAttemptRecordV1[]> {
    const { attempts } = resolveLocalDurableExecutionPaths(this.#repositoryRoot, runRef);
    try {
      const records = await Promise.all((await fs.readdir(attempts)).filter((name) => name.endsWith(".json")).map((name) => readJson(path.join(attempts, name), validateLocalAttemptRecord)));
      return records.filter((record): record is LocalExecutionAttemptRecordV1 => record !== undefined).sort((left, right) => left.fence - right.fence);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async #finish<Output extends JsonValue>(recordPath: string, record: LocalExecutionAttemptRecordV1, state: LocalExecutionAttemptRecordV1["state"], outcome: ExecutionHostOutcomeV1<Output>, code?: string, message?: string): Promise<ExecutionHostOutcomeV1<Output>> {
    const externalDiagnostic = getExternalErrorDiagnostic(outcome);
    await replaceRecord(recordPath, { ...record, state, updatedAt: this.#now().toISOString(), ...(code ? { terminal: { code, message: message ?? code,
      ...(outcome.status === "failed" || outcome.status === "outcome_unknown" ? { retryability: outcome.retryability ?? "unknown" } : {}),
      ...(externalDiagnostic ? { externalDiagnostic } : {}) } } : {}) });
    return outcome;
  }

  #validateAttempt(attempt: ExecutionAttemptV1): void {
    if (attempt.schemaVersion !== 1) throw new Error("Execution attempt schemaVersion must be 1.");
    assertDurableIdentifier(attempt.attemptId, "Attempt ID");
    positive(attempt.fence, "Attempt fence");
    const paths = resolveLocalDurableExecutionPaths(this.#repositoryRoot, attempt.runRef);
    const expectedScratch = path.join(paths.scratch, attempt.attemptId);
    if (path.resolve(attempt.scratchDirectory) !== expectedScratch) throw new Error("Execution scratch directory must be host-owned under the Local durable boundary.");
  }
}

export async function listInterruptedLocalRuns(repositoryRoot: string): Promise<RunRef[]> {
  const runsRoot = resolveLocalFileStorePaths(repositoryRoot).runs;
  try {
    const runIds = await fs.readdir(runsRoot);
    const interrupted: RunRef[] = [];
    for (const executionId of runIds) {
      if (executionId.startsWith(".")) continue;
      try {
        assertDurableIdentifier(executionId, "Execution ID");
        const runRef = { executionId };
        const paths = resolveLocalDurableExecutionPaths(repositoryRoot, runRef);
        const status = await readRunLifecycleStatus(path.join(runsRoot, executionId, "state", "run-status.json"));
        // Input-wait recovery belongs to the retained runtime, not the legacy
        // whole-Run host. Its current status records still need validation.
        if (status === "complete" || status === "failed" || status === "cancelled"
          || status === "waiting_for_input" || status === "resume_queued") continue;
        const hasInvocation = await fileExists(paths.invocation);
        let records: LocalExecutionAttemptRecordV1[] = [];
        try {
          records = (await Promise.all((await fs.readdir(paths.attempts))
            .filter((name) => name.endsWith(".json"))
            .map((name) => readJson(path.join(paths.attempts, name), validateLocalAttemptRecord))))
            .filter((record): record is LocalExecutionAttemptRecordV1 => record !== undefined)
            .sort((left, right) => left.fence - right.fence);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (status === "running" || hasInvocation || records.at(-1)?.state === "RUNNING") interrupted.push(runRef);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return interrupted.sort((left, right) => left.executionId.localeCompare(right.executionId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readRunLifecycleStatus(file: string): Promise<RunLifecycleStatus | undefined> {
  const stored = await readJson(file, (value) => object(value, "Run status"));
  if (!stored) return undefined;
  if (Object.hasOwn(stored, "kind")) throw new Error("Stored Run status must not declare a projection kind.");
  const projection = validateRunStateProjection({ ...stored, kind: "status" });
  return projection.status;
}

async function fileExists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** Loads and resumes each Run whose latest durable host attempt was interrupted. */
export async function resumeInterruptedLocalRuns(
  repositoryRoot: string,
  resume: (runRef: RunRef) => Promise<void>,
): Promise<readonly RunRef[]> {
  const interrupted = await listInterruptedLocalRuns(repositoryRoot);
  for (const runRef of interrupted) await resume(runRef);
  return interrupted;
}

export interface LocalInterruptedWorkflowRecoveryOptionsV1<ResolvedConfiguration> {
  readonly repositoryRoot: string;
  readonly definitions: DurableWorkflowDefinitionResolverV1;
  readonly runConfigurations: DurableRunConfigurationResolverV1<ResolvedConfiguration>;
  readonly resume: (resolved: ResolvedInterruptedWorkflowV1<ResolvedConfiguration>) => Promise<void>;
}

/** Reconstructs interrupted calls from immutable invocation data, definitions, and Run Configurations. */
export class LocalInterruptedWorkflowRecoveryCoordinatorV1<ResolvedConfiguration> {
  readonly #repositoryRoot: string;
  readonly #definitions: DurableWorkflowDefinitionResolverV1;
  readonly #runConfigurations: DurableRunConfigurationResolverV1<ResolvedConfiguration>;
  readonly #resume: (resolved: ResolvedInterruptedWorkflowV1<ResolvedConfiguration>) => Promise<void>;

  constructor(options: LocalInterruptedWorkflowRecoveryOptionsV1<ResolvedConfiguration>) {
    this.#repositoryRoot = path.resolve(options.repositoryRoot);
    this.#definitions = options.definitions;
    this.#runConfigurations = options.runConfigurations;
    this.#resume = options.resume;
  }

  async resumeAll(): Promise<readonly RunRef[]> {
    return resumeInterruptedLocalRuns(this.#repositoryRoot, async (runRef) => {
      const invocation = await createLocalWorkflowInvocationStore(this.#repositoryRoot, runRef).read(runRef);
      if (!invocation) throw new Error(`Interrupted Run ${runRef.executionId} has no durable workflow invocation.`);
      const definition = this.#definitions.resolve(invocation.workflow, invocation.workflowContractVersion);
      if (!definition) throw new Error(`Workflow definition ${invocation.workflow.kind}@${invocation.workflow.version} (${invocation.workflowContractVersion}) is unavailable.`);
      assertInvocationMatchesDefinition(invocation, definition);
      definition.input.parse(invocation.input);
      const runConfiguration = await this.#runConfigurations.resolve(invocation.workflow, invocation.runConfiguration);
      if (!runConfiguration) throw new Error(`Run Configuration ${invocation.runConfiguration.configurationId} (${invocation.runConfiguration.contentHash}) is unavailable.`);
      await this.#resume({ invocation, definition, runConfiguration });
    });
  }
}

async function createRecord(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serialize(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
}
async function replaceRecord(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, serialize(value), { encoding: "utf8", flag: "wx", mode: 0o600 }); await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
}
async function readJson<T>(file: string, validate: (value: unknown) => T): Promise<T | undefined> {
  try { return validate(JSON.parse(await fs.readFile(file, "utf8")) as unknown); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function validateLocalAttemptRecord(value: unknown): LocalExecutionAttemptRecordV1 {
  const record = object(value, "Local execution attempt");
  const required = ["schemaVersion", "runRef", "attemptId", "fence", "deadlineAt", "finalizationReserveMs", "scratchDirectory", "limits", "state", "startedAt", "updatedAt"];
  exactKeys(record, required, "Local execution attempt", [...required, "terminal"]);
  if (record.schemaVersion !== 1) throw new Error("Local execution attempt schemaVersion must be 1.");
  validateRunRef(record.runRef);
  assertDurableIdentifier(String(record.attemptId), "Attempt ID");
  positive(Number(record.fence), "Attempt fence");
  if (!["RUNNING", "COMPLETED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(String(record.state))) throw new Error("Local execution attempt state is unsupported.");
  if (typeof record.startedAt !== "string" || typeof record.updatedAt !== "string" || Number.isNaN(Date.parse(record.startedAt)) || Number.isNaN(Date.parse(record.updatedAt))) throw new Error("Local execution attempt timestamps are invalid.");
  if (typeof record.deadlineAt !== "string" || Number.isNaN(Date.parse(record.deadlineAt))) throw new Error("Local execution attempt deadline is invalid.");
  if (typeof record.scratchDirectory !== "string") throw new Error("Local execution attempt scratch directory is invalid.");
  const limits = object(record.limits, "Local execution attempt limits");
  exactKeys(limits, ["maxDurationMs", "maxScratchBytes"], "Local execution attempt limits");
  positive(Number(limits.maxDurationMs), "Local execution attempt maximum duration");
  positive(Number(limits.maxScratchBytes), "Local execution attempt maximum scratch bytes");
  if (!Number.isInteger(record.finalizationReserveMs) || Number(record.finalizationReserveMs) < 0 || Number(record.finalizationReserveMs) >= Number(limits.maxDurationMs)) throw new Error("Local execution attempt finalization reserve is invalid.");
  const terminal = record.terminal === undefined ? undefined : object(record.terminal, "Local execution attempt terminal");
  if (["FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(String(record.state)) !== (terminal !== undefined)) throw new Error("Local execution attempt terminal shape is invalid.");
  if (terminal) {
    exactKeys(terminal, ["code", "message"], "Local execution attempt terminal", ["code", "message", "retryability", "externalDiagnostic"]);
    if (terminal.retryability !== undefined) {
      const retryability = readFailureRetryability(terminal.retryability);
      if (retryability === "unknown" && terminal.retryability !== "unknown") throw new Error("Local execution attempt retryability is invalid.");
      terminal.retryability = retryability;
    }
    if (terminal.externalDiagnostic !== undefined) {
      const diagnostic = readExternalErrorDiagnostic(terminal.externalDiagnostic);
      if (!diagnostic || diagnostic.message !== terminal.message) throw new Error("Local execution attempt external diagnostic is invalid.");
      terminal.externalDiagnostic = diagnostic;
    }
    assertDurableIdentifier(String(terminal.code), "Local execution attempt terminal code");
    if (typeof terminal.message !== "string" || terminal.message.length === 0) throw new Error("Local execution attempt terminal message is invalid.");
  }
  return structuredClone(record) as unknown as LocalExecutionAttemptRecordV1;
}
function validateCancellationRecord(value: unknown): { readonly reason: "cancelled" | "deadline_exceeded" | "host_terminated" } {
  const record = object(value, "Local cancellation");
  exactKeys(record, ["schemaVersion", "runRef", "reason", "at"], "Local cancellation");
  if (record.schemaVersion !== 1 || !["cancelled", "deadline_exceeded", "host_terminated"].includes(String(record.reason))) throw new Error("Local cancellation record is invalid.");
  validateRunRef(record.runRef);
  if (typeof record.at !== "string" || Number.isNaN(Date.parse(record.at))) throw new Error("Local cancellation timestamp is invalid.");
  return { reason: record.reason as "cancelled" | "deadline_exceeded" | "host_terminated" };
}
function object(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Record<string, unknown>; }
function exactKeys(value: Record<string, unknown>, required: readonly string[], label: string, allowed = required): void {
  for (const key of required) if (!(key in value)) throw new Error(`${label}.${key} is required.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}.${key} is not allowed.`);
}
function positive(value: number, label: string): void { if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`); }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function isOutcomeUnknown(error: unknown): boolean { return error instanceof Error && (error.name === "DurableOutcomeUnknownError" || "code" in error && (error as { code?: unknown }).code === "outcome_unknown"); }
