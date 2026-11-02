import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentOperationBindingV1,
  AgentOperationRefV1,
  AgentOperationStoreV1,
  AgentOperationV1,
  ClaimTokenV1,
  ClaimedStepTransitionV1,
  DurableExecutionEventSinkV1,
  EffectDefinitionBindingV1,
  EffectOperationRefV1,
  EffectOperationStoreV1,
  EffectOperationV1,
  ExecutionEventV1,
  RegisterStepOperationRequestV1,
  RetryTerminalRequestV1,
  RetryAdmissionV1,
  StepCheckpointStoreV2,
  StepCheckpointV1,
  StepClaimRequestV1,
  StepClaimResultV1,
  TerminalRecordV1,
} from "../../application/durableExecution.ts";
import {
  DurableRecordConflictError,
  sameAgentBinding,
  sameEffectBinding,
  sameStepBinding,
} from "../../application/durableExecution.ts";
import type {
  CompletedStepV1,
  DeepReadonly,
  JsonValue,
  StepDetailsRefV1,
  StepPerformanceV1,
  StepRefV1,
} from "../../application/durableWorkflow.ts";
import { assertDurableIdentifier, assertJsonValue } from "../../application/durableWorkflow.ts";
import { validateRunRef } from "../../domain/runIdentity.ts";
import { assertExactKeys } from "../../domain/validation.ts";
import { syncDirectory } from "./localFileAuthority.ts";
import { readExternalErrorDiagnostic, type ExternalErrorDiagnostic, type FailureRetryabilityV1 } from "../../application/externalError.ts";

export interface FileDurableExecutionStoreOptions { readonly root: string }

abstract class AtomicJsonStore {
  readonly root: string;
  readonly #writes = new Map<string, Promise<void>>();

  constructor(root: string) { this.root = path.resolve(root); }

  protected async readJson<T>(file: string, validate: (value: unknown) => T): Promise<T | undefined> {
    try {
      return validate(JSON.parse(await fs.readFile(file, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  protected async mutate<T>(file: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.#writes.get(file) ?? Promise.resolve();
    let resolveWrite!: () => void;
    const current = new Promise<void>((resolve) => { resolveWrite = resolve; });
    const queued = previous.then(() => current);
    this.#writes.set(file, queued);
    await previous;
    try { return await mutation(); } finally {
      resolveWrite();
      if (this.#writes.get(file) === queued) this.#writes.delete(file);
    }
  }

  protected async replace(file: string, value: unknown): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, serialize(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  protected async create(file: string, value: unknown): Promise<boolean> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      // A worker may be killed at any await. Publish a fully written inode,
      // never an empty/partial final record that recovery could read as JSON.
      await fs.writeFile(temporary, serialize(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
      const handle = await fs.open(temporary, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      try { await fs.link(temporary, file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
      await syncDirectory(path.dirname(file));
      return true;
    } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
  }
}

export class FileStepCheckpointStoreV2 extends AtomicJsonStore implements StepCheckpointStoreV2 {
  constructor(options: FileDurableExecutionStoreOptions) { super(path.join(options.root, "steps")); }

  async read<Input extends JsonValue, Output extends JsonValue>(ref: StepRefV1): Promise<StepCheckpointV1<Input, Output> | undefined> {
    return this.readJson(this.file(ref), validateStepCheckpoint) as Promise<StepCheckpointV1<Input, Output> | undefined>;
  }

  async claim<Input extends JsonValue, Output extends JsonValue>(request: StepClaimRequestV1): Promise<StepClaimResultV1<Input, Output>> {
    validateStepRef(request.ref);
    const file = this.file(request.ref);
    return this.mutate(file, async () => {
      let stored = await this.read<Input, Output>(request.ref);
      if (!stored) {
        if (request.expectedRevision !== 0) throw conflict("New step claim expected revision must be 0.");
        const activeClaim = claimToken(request, 1, 1);
        const created: StepCheckpointV1<Input, Output> = {
          schemaVersion: 1,
          ref: request.ref,
          binding: request.binding,
          state: "RUNNING",
          revision: 1,
          attemptCount: 1,
          activeClaim,
          effectOperationIds: [],
          agentOperationIds: [],
          updatedAt: request.claimedAt,
        };
        if (!await this.create(file, created)) stored = await this.read<Input, Output>(request.ref);
        else return { kind: "claimed", checkpoint: created, claimToken: activeClaim };
      }
      if (!stored) throw conflict("Step checkpoint disappeared during claim.");
      if (!sameStepBinding(stored.binding, request.binding)) {
        return { kind: "incompatible", reasonCode: stored.binding.inputSha256 === request.binding.inputSha256 ? "definition_mismatch" : "input_mismatch" };
      }
      if (stored.state === "COMPLETED") return { kind: "completed", completed: stored.completed! };
      if (["FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(stored.state)) return { kind: "terminal", checkpoint: stored };
      if (stored.activeClaim?.attemptId === request.attemptId && stored.activeClaim.fence === request.fence) {
        return { kind: "busy", checkpoint: stored };
      }
      if (stored.revision !== request.expectedRevision) throw conflict("Step claim revision changed.");
      const revision = stored.revision + 1;
      const activeClaim = claimToken(request, stored.attemptCount + 1, revision);
      const claimed: StepCheckpointV1<Input, Output> = {
        ...stored,
        state: "RUNNING",
        revision,
        attemptCount: stored.attemptCount + 1,
        activeClaim,
        updatedAt: request.claimedAt,
      };
      await this.replace(file, claimed);
      return { kind: "claimed", checkpoint: claimed, claimToken: activeClaim };
    });
  }

  async registerOperation(request: RegisterStepOperationRequestV1): Promise<void> {
    assertDurableIdentifier(request.operationId, "Operation ID");
    const file = this.file(request.ref);
    await this.mutate(file, async () => {
      const stored = required(await this.read(request.ref), "Step checkpoint does not exist.");
      assertActiveClaim(stored.activeClaim, request.claimToken);
      if (stored.state !== "RUNNING") throw conflict("Operations can be registered only on a running step.");
      const own = request.kind === "agent" ? stored.agentOperationIds : stored.effectOperationIds;
      const other = request.kind === "agent" ? stored.effectOperationIds : stored.agentOperationIds;
      if (other.includes(request.operationId)) throw conflict("Operation ID is already registered with another kind.");
      if (own.includes(request.operationId)) return;
      await this.replace(file, {
        ...stored,
        revision: stored.revision + 1,
        ...(request.kind === "agent"
          ? { agentOperationIds: [...stored.agentOperationIds, request.operationId] }
          : { effectOperationIds: [...stored.effectOperationIds, request.operationId] }),
        updatedAt: request.at,
      });
    });
  }

  async complete<Input extends JsonValue, Output extends JsonValue>(request: ClaimedStepTransitionV1 & { readonly completed: CompletedStepV1<Input, Output> }): Promise<CompletedStepV1<Input, Output>> {
    await this.transition(request, "COMPLETED", { completed: request.completed });
    return request.completed;
  }
  async fail(request: ClaimedStepTransitionV1 & { readonly code: string; readonly message: string; readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void> { await this.transition(request, "FAILED", { terminal: terminal(request) }); }
  async cancel(request: ClaimedStepTransitionV1 & { readonly code: "cancelled" | "deadline_exceeded" | "host_terminated" }): Promise<void> { await this.transition(request, "CANCELLED", { terminal: terminal(request) }); }
  async markOutcomeUnknown(request: ClaimedStepTransitionV1 & { readonly code: string; readonly message: string; readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void> { await this.transition(request, "OUTCOME_UNKNOWN", { terminal: terminal(request) }); }

  async reopenForRetry<Input extends JsonValue, Output extends JsonValue>(request: RetryTerminalRequestV1<StepRefV1>): Promise<StepCheckpointV1<Input, Output>> {
    validateRetryRequest(request);
    const file = this.file(request.ref);
    return this.mutate(file, async () => {
      const stored = required(await this.read<Input, Output>(request.ref), "Step checkpoint does not exist.");
      if (stored.retryAdmissions?.some(admission => admission.retryId === request.retryId)) return stored;
      if (stored.state !== "FAILED" || stored.terminal?.retryability !== "retryable") {
        throw conflict("Only an explicitly retryable failed step can reopen.");
      }
      assertRetryExpectation(stored, request);
      const reopened: StepCheckpointV1<Input, Output> = {
        ...stored, state: "PENDING", revision: stored.revision + 1, activeClaim: undefined, terminal: undefined,
        retryAdmissions: [...(stored.retryAdmissions ?? []), retryAdmission(request, stored.attemptCount)], updatedAt: request.at,
      };
      await this.replace(file, reopened);
      return reopened;
    });
  }

  private async transition(request: ClaimedStepTransitionV1, state: StepCheckpointV1["state"], addition: object): Promise<void> {
    const file = this.file(request.ref);
    await this.mutate(file, async () => {
      const stored = required(await this.read(request.ref), "Step checkpoint does not exist.");
      assertActiveClaim(stored.activeClaim, request.claimToken);
      if (stored.state !== "RUNNING") throw conflict("Only a running step can transition.");
      await this.replace(file, { ...stored, ...addition, state, revision: stored.revision + 1, activeClaim: undefined, updatedAt: request.at });
    });
  }

  private file(ref: StepRefV1): string { validateStepRef(ref); return path.join(this.root, `${fileSegment(ref.stepId)}.json`); }
}

abstract class FileOperationStore<RecordType extends { readonly ref: { readonly operationId: string }; readonly revision: number;
  readonly attemptCount: number; readonly state: string; readonly activeClaim?: ClaimTokenV1;
  readonly terminal?: TerminalRecordV1; readonly retryAdmissions?: readonly RetryAdmissionV1[]; readonly updatedAt: string }> extends AtomicJsonStore {
  protected file(operationId: string): string { assertDurableIdentifier(operationId, "Operation ID"); return path.join(this.root, `${fileSegment(operationId)}.json`); }
  protected async transition(ref: { readonly operationId: string }, token: ClaimTokenV1, state: string, at: string, addition: object): Promise<void> {
    const file = this.file(ref.operationId);
    await this.mutate(file, async () => {
      const stored = required(await this.readRecord(file), "Operation record does not exist.");
      assertActiveClaim(stored.activeClaim, token);
      if (stored.state !== "PENDING" && stored.state !== "DISPATCHED") throw conflict("Operation is already terminal.");
      await this.replace(file, {
        ...stored,
        ...addition,
        state,
        revision: stored.revision + 1,
        activeClaim: state === "DISPATCHED" ? token : undefined,
        updatedAt: at,
      });
    });
  }
  protected abstract readRecord(file: string): Promise<RecordType | undefined>;
  protected async reopenForRetry(request: RetryTerminalRequestV1<{ readonly operationId: string }>): Promise<RecordType> {
    validateRetryRequest(request);
    const file = this.file(request.ref.operationId);
    return this.mutate(file, async () => {
      const stored = required(await this.readRecord(file), "Operation record does not exist.");
      const retryAdmissions = stored.retryAdmissions;
      if (retryAdmissions?.some(admission => admission.retryId === request.retryId)) return stored;
      const terminalRecord = stored.terminal;
      if (stored.state !== "FAILED" || terminalRecord?.retryability !== "retryable") {
        throw conflict("Only an explicitly retryable failed operation can reopen.");
      }
      assertRetryExpectation(stored, request);
      const revision = stored.revision + 1;
      const reopened = {
        ...stored, state: "PENDING", revision, attemptCount: stored.attemptCount + 1,
        activeClaim: { attemptId: request.attemptId, attemptNumber: stored.attemptCount + 1,
          fence: request.fence, expectedRevision: revision }, terminal: undefined,
        retryAdmissions: [...(retryAdmissions ?? []), retryAdmission(request, stored.attemptCount)],
        updatedAt: request.at,
      } as unknown as RecordType;
      await this.replace(file, reopened);
      return reopened;
    });
  }
}

export class FileEffectOperationStoreV1 extends FileOperationStore<EffectOperationV1> implements EffectOperationStoreV1 {
  constructor(options: FileDurableExecutionStoreOptions) { super(path.join(options.root, "effects")); }
  async read<Output extends JsonValue>(ref: EffectOperationRefV1): Promise<EffectOperationV1<Output> | undefined> { return this.readJson(this.file(ref.operationId), validateEffectOperation) as Promise<EffectOperationV1<Output> | undefined>; }
  protected readRecord(file: string): Promise<EffectOperationV1 | undefined> { return this.readJson(file, validateEffectOperation); }
  async claim<Output extends JsonValue>(request: { readonly ref: EffectOperationRefV1; readonly definitionVersion: string; readonly definitionSha256: string; readonly inputSha256: string; readonly safety: import("../../application/durableWorkflow.ts").EffectSafetyClassV1; readonly adapterConformanceRecorded: boolean; readonly attemptId: string; readonly fence: number; readonly expectedRevision: number; readonly claimedAt: string }): Promise<EffectOperationV1<Output>> {
    const file = this.file(request.ref.operationId);
    return this.mutate(file, async () => {
      const stored = await this.read<Output>(request.ref);
      const binding: EffectDefinitionBindingV1 = {
        definitionVersion: request.definitionVersion,
        definitionSha256: request.definitionSha256,
        inputSha256: request.inputSha256,
        safety: request.safety,
      };
      if (stored && !sameEffectBinding(stored, binding)) throw conflict("Effect operation binding changed.");
      if (stored && (stored.state === "COMPLETED" || ["FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(stored.state))) return stored;
      if (stored?.state === "PENDING" && stored.activeClaim?.attemptId === request.attemptId && stored.activeClaim.fence === request.fence) return stored;
      if (stored && stored.revision !== request.expectedRevision) throw conflict("Effect operation revision changed.");
      const revision = (stored?.revision ?? 0) + 1;
      const claimed: EffectOperationV1<Output> = {
        schemaVersion: 1,
        ref: request.ref,
        ...binding,
        state: stored?.state === "DISPATCHED" ? "DISPATCHED" : "PENDING",
        revision,
        attemptCount: (stored?.attemptCount ?? 0) + 1,
        adapterConformanceRecorded: request.adapterConformanceRecorded,
        activeClaim: { attemptId: request.attemptId, attemptNumber: (stored?.attemptCount ?? 0) + 1, fence: request.fence, expectedRevision: revision },
        ...(stored?.retryAdmissions ? { retryAdmissions: stored.retryAdmissions } : {}),
        updatedAt: request.claimedAt,
      };
      await (stored ? this.replace(file, claimed) : this.create(file, claimed));
      return claimed;
    });
  }
  async markDispatched(request: { readonly ref: EffectOperationRefV1; readonly claimToken: ClaimTokenV1; readonly at: string }): Promise<void> { await this.transition(request.ref, request.claimToken, "DISPATCHED", request.at, { activeClaim: request.claimToken }); }
  async complete<Output extends JsonValue>(request: { readonly ref: EffectOperationRefV1; readonly claimToken: ClaimTokenV1; readonly output: DeepReadonly<Output>; readonly at: string }): Promise<DeepReadonly<Output>> { assertJsonValue(request.output); await this.transition(request.ref, request.claimToken, "COMPLETED", request.at, { output: request.output }); return request.output; }
  async fail(request: { readonly ref: EffectOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: string; readonly message: string; readonly at: string; readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void> { await this.transition(request.ref, request.claimToken, "FAILED", request.at, { terminal: terminal(request) }); }
  async cancel(request: { readonly ref: EffectOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: "cancelled" | "deadline_exceeded" | "host_terminated"; readonly at: string }): Promise<void> { await this.transition(request.ref, request.claimToken, "CANCELLED", request.at, { terminal: terminal(request) }); }
  async markOutcomeUnknown(request: { readonly ref: EffectOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: string; readonly message: string; readonly at: string; readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void> { await this.transition(request.ref, request.claimToken, "OUTCOME_UNKNOWN", request.at, { terminal: terminal(request) }); }
  async reopenForRetry<Output extends JsonValue>(request: RetryTerminalRequestV1<EffectOperationRefV1>): Promise<EffectOperationV1<Output>> {
    const stored = await this.read<Output>(request.ref);
    if (stored?.safety !== "read") throw conflict("Only failed read effects can reopen automatically.");
    return super.reopenForRetry(request) as Promise<EffectOperationV1<Output>>;
  }
}

export class FileAgentOperationStoreV1 extends FileOperationStore<AgentOperationV1> implements AgentOperationStoreV1 {
  constructor(options: FileDurableExecutionStoreOptions) { super(path.join(options.root, "agents")); }
  async read<Output extends JsonValue>(ref: AgentOperationRefV1): Promise<AgentOperationV1<Output> | undefined> { return this.readJson(this.file(ref.operationId), validateAgentOperation) as Promise<AgentOperationV1<Output> | undefined>; }
  protected readRecord(file: string): Promise<AgentOperationV1 | undefined> { return this.readJson(file, validateAgentOperation); }
  async claim<Output extends JsonValue>(request: { readonly ref: AgentOperationRefV1; readonly binding: AgentOperationBindingV1; readonly attemptId: string; readonly fence: number; readonly expectedRevision: number; readonly claimedAt: string }): Promise<AgentOperationV1<Output>> {
    const file = this.file(request.ref.operationId);
    return this.mutate(file, async () => {
      const stored = await this.read<Output>(request.ref);
      if (stored && !sameAgentBinding(stored.binding, request.binding)) throw conflict("Agent operation binding changed.");
      if (stored && (stored.state === "COMPLETED" || ["FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(stored.state))) return stored;
      if (stored?.state === "PENDING" && stored.activeClaim?.attemptId === request.attemptId && stored.activeClaim.fence === request.fence) return stored;
      if (stored && stored.revision !== request.expectedRevision) throw conflict("Agent operation revision changed.");
      const revision = (stored?.revision ?? 0) + 1;
      const claimed: AgentOperationV1<Output> = {
        schemaVersion: 1,
        ref: request.ref,
        binding: request.binding,
        state: stored?.state === "DISPATCHED" ? "DISPATCHED" : "PENDING",
        revision,
        attemptCount: (stored?.attemptCount ?? 0) + 1,
        activeClaim: { attemptId: request.attemptId, attemptNumber: (stored?.attemptCount ?? 0) + 1, fence: request.fence, expectedRevision: revision },
        ...(stored?.retryAdmissions ? { retryAdmissions: stored.retryAdmissions } : {}),
        updatedAt: request.claimedAt,
      };
      await (stored ? this.replace(file, claimed) : this.create(file, claimed));
      return claimed;
    });
  }
  async markDispatched(request: { readonly ref: AgentOperationRefV1; readonly claimToken: ClaimTokenV1; readonly at: string }): Promise<void> { await this.transition(request.ref, request.claimToken, "DISPATCHED", request.at, { activeClaim: request.claimToken }); }
  async complete<Output extends JsonValue>(request: { readonly ref: AgentOperationRefV1; readonly claimToken: ClaimTokenV1; readonly output: DeepReadonly<Output>; readonly performance: StepPerformanceV1; readonly artifacts: readonly import("../../application/durableWorkflow.ts").ArtifactRefV1[]; readonly detailsRef?: StepDetailsRefV1; readonly at: string }): Promise<DeepReadonly<Output>> { assertJsonValue(request.output); await this.transition(request.ref, request.claimToken, "COMPLETED", request.at, { output: request.output, performance: request.performance, artifacts: request.artifacts, ...(request.detailsRef ? { detailsRef: request.detailsRef } : {}) }); return request.output; }
  async fail(request: { readonly ref: AgentOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: string; readonly message: string; readonly at: string; readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void> { await this.transition(request.ref, request.claimToken, "FAILED", request.at, { terminal: terminal(request) }); }
  async cancel(request: { readonly ref: AgentOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: "cancelled" | "deadline_exceeded" | "host_terminated"; readonly at: string }): Promise<void> { await this.transition(request.ref, request.claimToken, "CANCELLED", request.at, { terminal: terminal(request) }); }
  async markOutcomeUnknown(request: { readonly ref: AgentOperationRefV1; readonly claimToken: ClaimTokenV1; readonly code: string; readonly message: string; readonly at: string; readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): Promise<void> { await this.transition(request.ref, request.claimToken, "OUTCOME_UNKNOWN", request.at, { terminal: terminal(request) }); }
  async reopenForRetry<Output extends JsonValue>(request: RetryTerminalRequestV1<AgentOperationRefV1>): Promise<AgentOperationV1<Output>> {
    return super.reopenForRetry(request) as Promise<AgentOperationV1<Output>>;
  }
}

export class FileDurableExecutionEventSinkV1 extends AtomicJsonStore implements DurableExecutionEventSinkV1 {
  constructor(options: FileDurableExecutionStoreOptions) { super(path.join(options.root, "events")); }
  async emit(event: Omit<ExecutionEventV1, "sequence">): Promise<void> {
    const lock = path.join(this.root, ".sequence");
    await this.mutate(lock, async () => {
      await fs.mkdir(this.root, { recursive: true });
      const names = (await fs.readdir(this.root)).filter((name) => /^\d{12}\.json$/u.test(name)).sort();
      const sequence = names.length === 0 ? 0 : Number.parseInt(names.at(-1)!, 10) + 1;
      const created = await this.create(path.join(this.root, `${String(sequence).padStart(12, "0")}.json`), { ...event, sequence });
      if (!created) throw conflict(`Execution event sequence ${sequence} already exists.`);
    });
  }
}

function validateStepCheckpoint(value: unknown): StepCheckpointV1 {
  const record = object(value, "Step checkpoint");
  const common = ["schemaVersion", "ref", "binding", "state", "revision", "attemptCount", "effectOperationIds", "agentOperationIds", "updatedAt"];
  assertExactKeys(record, common, "Step checkpoint", [...common, "activeClaim", "completed", "terminal", "retryAdmissions"]);
  if (record.schemaVersion !== 1) throw new Error("Step checkpoint schemaVersion must be 1.");
  validateStepRef(record.ref);
  validateStepBinding(record.binding);
  if (!["PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(String(record.state))) throw new Error("Step checkpoint state is unsupported.");
  integer(record.revision, "Step checkpoint revision");
  integer(record.attemptCount, "Step checkpoint attemptCount");
  if (record.activeClaim !== undefined) validateClaimToken(record.activeClaim);
  if ((record.state === "RUNNING") !== (record.activeClaim !== undefined)) throw new Error("Only running steps have active claims.");
  if ((record.state === "COMPLETED") !== (record.completed !== undefined)) throw new Error("Only completed steps have completion records.");
  if (["FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(String(record.state)) !== (record.terminal !== undefined)) throw new Error("Terminal step shape is invalid.");
  validateOperationIds(record.effectOperationIds, "Step effect operation IDs");
  validateOperationIds(record.agentOperationIds, "Step agent operation IDs");
  if (record.completed !== undefined) validateCompletedStep(record.completed);
  if (record.terminal !== undefined) validateTerminal(record.terminal);
  if (record.retryAdmissions !== undefined) validateRetryAdmissions(record.retryAdmissions);
  timestamp(record.updatedAt, "Step checkpoint updatedAt");
  return structuredClone(record) as unknown as StepCheckpointV1;
}
function validateEffectOperation(value: unknown): EffectOperationV1 {
  const record = validateOperation(value, "Effect operation", ["definitionVersion", "definitionSha256", "inputSha256", "safety", "adapterConformanceRecorded"]);
  nonEmptyString(record.definitionVersion, "Effect operation definitionVersion");
  sha256(record.definitionSha256, "Effect operation definitionSha256");
  sha256(record.inputSha256, "Effect operation inputSha256");
  if (!["read", "idempotent-write", "reconcilable-write", "unsafe-write"].includes(String(record.safety))) throw new Error("Effect operation safety is unsupported.");
  if (typeof record.adapterConformanceRecorded !== "boolean") throw new Error("Effect operation adapterConformanceRecorded must be boolean.");
  return structuredClone(record) as unknown as EffectOperationV1;
}
function validateAgentOperation(value: unknown): AgentOperationV1 {
  const record = validateOperation(value, "Agent operation", ["binding"], ["performance", "artifacts", "detailsRef"]);
  const binding = object(record.binding, "Agent operation binding");
  assertExactKeys(binding, ["sourceOperationId", "slotId", "providerId", "authProviderId", "configurationSha256", "inputSha256"], "Agent operation binding", ["sourceOperationId", "slotId", "providerId", "authProviderId", "model", "configurationSha256", "inputSha256"]);
  for (const [key, label] of [["sourceOperationId", "source operation ID"], ["slotId", "slot ID"], ["providerId", "provider ID"], ["authProviderId", "auth provider ID"]] as const) assertDurableIdentifier(String(binding[key]), `Agent operation ${label}`);
  if (binding.model !== undefined) nonEmptyString(binding.model, "Agent operation model");
  sha256(binding.configurationSha256, "Agent operation configurationSha256");
  sha256(binding.inputSha256, "Agent operation inputSha256");
  if (record.performance !== undefined) validatePerformance(record.performance);
  if (record.artifacts !== undefined) validateArtifacts(record.artifacts);
  if (record.detailsRef !== undefined) validateDetailsRef(record.detailsRef);
  return structuredClone(record) as unknown as AgentOperationV1;
}
function validateOperation(value: unknown, label: string, requiredBinding: readonly string[], optionalCompleted: readonly string[] = []): Record<string, unknown> {
  const record = object(value, label);
  const common = ["schemaVersion", "ref", "state", "revision", "attemptCount", "updatedAt", ...requiredBinding];
  assertExactKeys(record, common, label, [...common, "activeClaim", "output", "terminal", "retryAdmissions", ...optionalCompleted]);
  if (record.schemaVersion !== 1) throw new Error(`${label} schemaVersion must be 1.`);
  const ref = object(record.ref, `${label} ref`);
  assertExactKeys(ref, ["runRef", "operationId"], `${label} ref`);
  validateRunRef(ref.runRef);
  assertDurableIdentifier(String(ref.operationId), `${label} operation ID`);
  integer(record.revision, `${label} revision`);
  integer(record.attemptCount, `${label} attemptCount`);
  if (record.activeClaim !== undefined) validateClaimToken(record.activeClaim);
  const state = String(record.state);
  if (!["PENDING", "DISPATCHED", "COMPLETED", "FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(state)) throw new Error(`${label} state is unsupported.`);
  if (["PENDING", "DISPATCHED"].includes(state) !== (record.activeClaim !== undefined)) throw new Error(`${label} active claim shape is invalid.`);
  if ((state === "COMPLETED") !== (record.output !== undefined)) throw new Error(`${label} output shape is invalid.`);
  if (["FAILED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(state) !== (record.terminal !== undefined)) throw new Error(`${label} terminal shape is invalid.`);
  if (record.output !== undefined) assertJsonValue(record.output, `${label} output`);
  if (record.terminal !== undefined) validateTerminal(record.terminal);
  if (record.retryAdmissions !== undefined) validateRetryAdmissions(record.retryAdmissions);
  timestamp(record.updatedAt, `${label} updatedAt`);
  return record;
}
function validateStepRef(value: unknown): asserts value is StepRefV1 {
  const ref = object(value, "Step ref");
  assertExactKeys(ref, ["runRef", "stepId"], "Step ref");
  validateRunRef(ref.runRef);
  assertDurableIdentifier(String(ref.stepId), "Step ID");
}
function validateStepBinding(value: unknown): void {
  const binding = object(value, "Step binding");
  assertExactKeys(binding, ["workflowContractVersion", "stepDefinitionVersion", "stepDefinitionSha256", "inputSha256"], "Step binding");
  assertDurableIdentifier(String(binding.workflowContractVersion), "Workflow contract version");
  assertDurableIdentifier(String(binding.stepDefinitionVersion), "Step definition version");
  sha256(binding.stepDefinitionSha256, "Step definition SHA-256");
  sha256(binding.inputSha256, "Step input SHA-256");
}
function validateClaimToken(value: unknown): void {
  const token = object(value, "Claim token");
  assertExactKeys(token, ["attemptId", "attemptNumber", "fence", "expectedRevision"], "Claim token");
  assertDurableIdentifier(String(token.attemptId), "Attempt ID");
  integer(token.attemptNumber, "Claim attempt number");
  integer(token.fence, "Claim fence");
  integer(token.expectedRevision, "Claim expected revision");
}
function validateCompletedStep(value: unknown): void {
  const completed = object(value, "Completed step");
  const required = ["schemaVersion", "ref", "binding", "input", "output", "execution", "performance", "artifacts"];
  assertExactKeys(completed, required, "Completed step", [...required, "detailsRef"]);
  if (completed.schemaVersion !== 1) throw new Error("Completed step schemaVersion must be 1.");
  validateStepRef(completed.ref);
  validateStepBinding(completed.binding);
  assertJsonValue(completed.input, "Completed step input");
  assertJsonValue(completed.output, "Completed step output");
  const execution = object(completed.execution, "Completed step execution");
  assertExactKeys(execution, ["status", "attemptCount", "startedAt", "completedAt", "elapsedMs"], "Completed step execution");
  if (execution.status !== "completed") throw new Error("Completed step execution status must be completed.");
  integer(execution.attemptCount, "Completed step attemptCount");
  timestamp(execution.startedAt, "Completed step startedAt");
  timestamp(execution.completedAt, "Completed step completedAt");
  integer(execution.elapsedMs, "Completed step elapsedMs");
  validatePerformance(completed.performance);
  validateArtifacts(completed.artifacts);
  if (completed.detailsRef !== undefined) validateDetailsRef(completed.detailsRef);
}
function validatePerformance(value: unknown): void {
  const performance = object(value, "Step performance");
  assertExactKeys(performance, ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens"], "Step performance");
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens"] as const) {
    const metric = object(performance[key], `Step performance ${key}`);
    if (metric.availability === "reported") {
      assertExactKeys(metric, ["availability", "value"], `Step performance ${key}`);
      integer(metric.value, `Step performance ${key} value`);
    } else {
      assertExactKeys(metric, ["availability", "reason"], `Step performance ${key}`);
      if (metric.availability !== "unavailable" || !["provider_not_reported", "not_applicable", "operation_failed_before_usage"].includes(String(metric.reason))) throw new Error(`Step performance ${key} unavailable reason is unsupported.`);
    }
  }
}
function validateArtifacts(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("Artifacts must be an array.");
  for (const item of value) {
    const artifact = object(item, "Artifact reference");
    assertExactKeys(artifact, ["schemaVersion", "artifactId", "mediaType", "byteLength", "sha256"], "Artifact reference");
    if (artifact.schemaVersion !== 1) throw new Error("Artifact reference schemaVersion must be 1.");
    assertDurableIdentifier(String(artifact.artifactId), "Artifact ID");
    nonEmptyString(artifact.mediaType, "Artifact media type");
    integer(artifact.byteLength, "Artifact byteLength");
    sha256(artifact.sha256, "Artifact SHA-256");
  }
}
function validateDetailsRef(value: unknown): void {
  const details = object(value, "Step details reference");
  assertExactKeys(details, ["schemaVersion", "detailsId"], "Step details reference");
  if (details.schemaVersion !== 1) throw new Error("Step details reference schemaVersion must be 1.");
  assertDurableIdentifier(String(details.detailsId), "Step details ID");
}
function validateTerminal(value: unknown): void {
  const terminalRecord = object(value, "Terminal record");
  assertExactKeys(terminalRecord, ["code", "message", "at"], "Terminal record", ["code", "message", "at", "retryability", "externalDiagnostic"]);
  if (terminalRecord.externalDiagnostic !== undefined) {
    const diagnostic = readExternalErrorDiagnostic(terminalRecord.externalDiagnostic);
    if (!diagnostic || diagnostic.message !== terminalRecord.message) throw new Error("Terminal external diagnostic is invalid.");
    terminalRecord.externalDiagnostic = diagnostic;
  }
  if (terminalRecord.retryability !== undefined
    && !["retryable", "not-retryable", "unknown"].includes(String(terminalRecord.retryability))) {
    throw new Error("Terminal retryability is invalid.");
  }
  assertDurableIdentifier(String(terminalRecord.code), "Terminal code");
  nonEmptyString(terminalRecord.message, "Terminal message");
  timestamp(terminalRecord.at, "Terminal timestamp");
}
function validateRetryAdmissions(value: unknown): void {
  if (!Array.isArray(value)) throw new Error("Retry admissions must be an array.");
  const ids = new Set<string>();
  for (const entry of value) {
    const admission = object(entry, "Retry admission");
    assertExactKeys(admission, ["retryId", "policyId", "fromAttempt", "admittedAt"], "Retry admission");
    assertDurableIdentifier(String(admission.retryId), "Retry ID");
    assertDurableIdentifier(String(admission.policyId), "Retry policy ID");
    if (!Number.isSafeInteger(admission.fromAttempt) || Number(admission.fromAttempt) <= 0) throw new Error("Retry fromAttempt must be positive.");
    timestamp(admission.admittedAt, "Retry admittedAt");
    if (ids.has(String(admission.retryId))) throw new Error("Retry admission IDs must be unique.");
    ids.add(String(admission.retryId));
  }
}
function validateOperationIds(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array.`);
  for (const operationId of value) assertDurableIdentifier(operationId, label);
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates.`);
}
function assertActiveClaim(actual: ClaimTokenV1 | undefined, expected: ClaimTokenV1): void {
  if (!actual || actual.attemptId !== expected.attemptId || actual.attemptNumber !== expected.attemptNumber || actual.fence !== expected.fence) throw conflict("Claim token is stale.");
}
function claimToken(request: StepClaimRequestV1, attemptNumber: number, expectedRevision: number): ClaimTokenV1 { return { attemptId: request.attemptId, attemptNumber, fence: request.fence, expectedRevision }; }
function terminal(request: { readonly code: string; readonly message?: string; readonly at: string;
  readonly retryability?: FailureRetryabilityV1; readonly externalDiagnostic?: ExternalErrorDiagnostic }): TerminalRecordV1 {
  const externalDiagnostic = readExternalErrorDiagnostic(request.externalDiagnostic);
  if (request.externalDiagnostic !== undefined && !externalDiagnostic) throw new Error("Terminal external diagnostic is invalid.");
  return { code: request.code, message: externalDiagnostic?.message ?? request.message ?? request.code, at: request.at,
    ...(request.retryability === undefined ? {} : { retryability: request.retryability }),
    ...(externalDiagnostic ? { externalDiagnostic } : {}) };
}
function validateRetryRequest(request: RetryTerminalRequestV1<{ readonly operationId?: string } | StepRefV1>): void {
  assertDurableIdentifier(request.retryId, "Retry ID");
  assertDurableIdentifier(request.policyId, "Retry policy ID");
  assertDurableIdentifier(request.attemptId, "Attempt ID");
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision <= 0) throw new Error("Retry expected revision must be positive.");
  if (!Number.isSafeInteger(request.expectedAttemptCount) || request.expectedAttemptCount <= 0) throw new Error("Retry expected attempt count must be positive.");
  if (!Number.isSafeInteger(request.fence) || request.fence <= 0) throw new Error("Retry fence must be positive.");
  timestamp(request.at, "Retry timestamp");
}
function assertRetryExpectation(stored: { readonly revision: number; readonly attemptCount: number }, request: { readonly expectedRevision: number; readonly expectedAttemptCount: number }): void {
  if (stored.revision !== request.expectedRevision || stored.attemptCount !== request.expectedAttemptCount) {
    throw conflict("Retry expectation changed.");
  }
}
function retryAdmission(request: { readonly retryId: string; readonly policyId: string; readonly at: string }, fromAttempt: number): RetryAdmissionV1 {
  return { retryId: request.retryId, policyId: request.policyId, fromAttempt, admittedAt: request.at };
}
function object(value: unknown, label: string): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object.`); return value as Record<string, unknown>; }
function integer(value: unknown, label: string): void { if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer.`); }
function nonEmptyString(value: unknown, label: string): void { if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`); }
function sha256(value: unknown, label: string): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`); }
function timestamp(value: unknown, label: string): void { if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be a timestamp.`); }
function required<T>(value: T | undefined, message: string): T { if (value === undefined) throw conflict(message); return value; }
function conflict(message: string): DurableRecordConflictError { return new DurableRecordConflictError(message); }
function serialize(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }
function fileSegment(value: string): string { return encodeURIComponent(value); }
