import { createHash } from "node:crypto";
import type { AgentExecutionMetrics } from "./agentProvider.ts";
import type { RunRef } from "../domain/runIdentity.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type DeepReadonly<T> = T extends JsonPrimitive
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : { readonly [Key in keyof T]: DeepReadonly<T[Key]> };

export interface ValueValidatorV1<T extends JsonValue> { readonly parse: (value: unknown) => T }
export interface CancellationV1 {
  readonly aborted: boolean;
  readonly reason?: "cancelled" | "deadline_exceeded" | "host_terminated";
}
export interface RunExecutionContextV1 {
  readonly runRef: RunRef;
  readonly deadlineAt: string;
  readonly finalizationReserveMs: number;
  readonly cancellation: CancellationV1;
}
export interface ArtifactRefV1 {
  readonly schemaVersion: 1;
  readonly artifactId: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface StepDetailsRefV1 { readonly schemaVersion: 1; readonly detailsId: string }
export type UsageUnavailableReasonV1 = "provider_not_reported" | "not_applicable" | "operation_failed_before_usage";
export type UsageMetricV1 =
  | { readonly availability: "reported"; readonly value: number }
  | { readonly availability: "unavailable"; readonly reason: UsageUnavailableReasonV1 };
export interface StepPerformanceV1 {
  readonly inputTokens: UsageMetricV1;
  readonly cachedInputTokens: UsageMetricV1;
  readonly outputTokens: UsageMetricV1;
  readonly reasoningTokens: UsageMetricV1;
}
export interface StepRefV1 { readonly runRef: RunRef; readonly stepId: string }
export interface StepDefinitionBindingV1 {
  readonly workflowContractVersion: string;
  readonly stepDefinitionVersion: string;
  readonly stepDefinitionSha256: string;
  readonly inputSha256: string;
}
export interface CompletedStepV1<Input extends JsonValue, Output extends JsonValue> {
  readonly schemaVersion: 1;
  readonly ref: StepRefV1;
  readonly binding: StepDefinitionBindingV1;
  readonly input: DeepReadonly<Input>;
  readonly output: DeepReadonly<Output>;
  readonly execution: {
    readonly status: "completed";
    readonly attemptCount: number;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly elapsedMs: number;
  };
  readonly performance: StepPerformanceV1;
  readonly artifacts: readonly ArtifactRefV1[];
  readonly detailsRef?: StepDetailsRefV1;
}
export interface AgentSlotOperationV1<Output extends JsonValue> {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly slotId: string;
  readonly output: ValueValidatorV1<Output>;
}
export interface AgentSlotOperationsV1 {
  invoke<Input extends JsonValue, Output extends JsonValue>(
    operation: AgentSlotOperationV1<Output>,
    input: DeepReadonly<Input>,
  ): Promise<DeepReadonly<Output>>;
}
export type EffectSafetyClassV1 = "read" | "idempotent-write" | "reconcilable-write" | "unsafe-write";
export interface EffectExecutionContextV1 {
  readonly stableOperationId: string;
  readonly deadlineAt: string;
  readonly cancellation: CancellationV1;
}
export type EffectReconciliationV1<Output extends JsonValue> =
  | { readonly outcome: "completed"; readonly output: DeepReadonly<Output> }
  | { readonly outcome: "not-found" }
  | { readonly outcome: "unknown"; readonly reasonCode: string };
interface EffectContractBaseV1<Input extends JsonValue, Output extends JsonValue> {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly definitionVersion: string;
  readonly input: ValueValidatorV1<Input>;
  readonly output: ValueValidatorV1<Output>;
}
export type EffectContractV1<Input extends JsonValue, Output extends JsonValue> =
  EffectContractBaseV1<Input, Output> & (
    { readonly safety: "read" | "idempotent-write" | "unsafe-write" }
    | { readonly safety: "reconcilable-write" }
  );
export type EffectAdapterV1<Input extends JsonValue, Output extends JsonValue> =
  EffectContractBaseV1<Input, Output> & ({
    readonly safety: "read" | "idempotent-write" | "unsafe-write";
    execute(context: EffectExecutionContextV1, input: DeepReadonly<Input>): Promise<Output>;
  } | {
    readonly safety: "reconcilable-write";
    execute(context: EffectExecutionContextV1, input: DeepReadonly<Input>): Promise<Output>;
    reconcile(context: EffectExecutionContextV1, input: DeepReadonly<Input>): Promise<EffectReconciliationV1<Output>>;
  });
/** @deprecated Workflow code should use EffectContractV1. Implementations belong to host-owned EffectAdapterV1 values. */
export type EffectDefinitionV1<Input extends JsonValue, Output extends JsonValue> = EffectAdapterV1<Input, Output>;

export function defineEffectContract<Input extends JsonValue, Output extends JsonValue>(
  contract: EffectContractV1<Input, Output>,
): Readonly<EffectContractV1<Input, Output>> {
  assertIdentifier(contract.operationId, "Effect operation ID");
  assertIdentifier(contract.definitionVersion, "Effect definition version");
  if (contract.schemaVersion !== 1 || !["read", "idempotent-write", "reconcilable-write", "unsafe-write"].includes(contract.safety)) {
    throw new Error("Effect contracts require schemaVersion 1 and a supported safety class.");
  }
  if (typeof contract.input?.parse !== "function" || typeof contract.output?.parse !== "function") {
    throw new Error("Effect contracts require input and output validators.");
  }
  return Object.freeze({ ...contract });
}

export function defineEffectAdapter<Input extends JsonValue, Output extends JsonValue>(
  contract: EffectContractV1<Input, Output>,
  implementation: {
    execute(context: EffectExecutionContextV1, input: DeepReadonly<Input>): Promise<Output>;
    reconcile?(context: EffectExecutionContextV1, input: DeepReadonly<Input>): Promise<EffectReconciliationV1<Output>>;
  },
): Readonly<EffectAdapterV1<Input, Output>> {
  const checked = defineEffectContract(contract);
  if (typeof implementation.execute !== "function"
    || (checked.safety === "reconcilable-write" && typeof implementation.reconcile !== "function")) {
    throw new Error("Effect adapters require execute and reconcilable effects also require reconcile.");
  }
  // Copy only executable callbacks from the implementation. Runtime callers
  // cannot override the checked operation identity, validators or safety class
  // by attaching extra properties to an untyped implementation object.
  return Object.freeze(checked.safety === "reconcilable-write"
    ? { ...checked, execute: implementation.execute, reconcile: implementation.reconcile! }
    : { ...checked, execute: implementation.execute }) as Readonly<EffectAdapterV1<Input, Output>>;
}
export interface EffectOperationsV1 {
  run<Input extends JsonValue, Output extends JsonValue>(
    effect: EffectContractV1<Input, Output>,
    input: DeepReadonly<Input>,
  ): Promise<DeepReadonly<Output>>;
}
export interface StepExecutionContextV1 extends RunExecutionContextV1 {
  readonly agents: AgentSlotOperationsV1;
  readonly effects: EffectOperationsV1;
}
export interface StepDefinitionV1<Input extends JsonValue, Output extends JsonValue, Id extends string = string> {
  readonly schemaVersion: 1;
  readonly id: Id;
  readonly definitionVersion: string;
  readonly input: ValueValidatorV1<Input>;
  readonly output: ValueValidatorV1<Output>;
  execute(context: StepExecutionContextV1, input: DeepReadonly<Input>): Promise<Output>;
}
export function defineStep<Input extends JsonValue, Output extends JsonValue, const Id extends string>(
  definition: StepDefinitionV1<Input, Output, Id>,
): Readonly<StepDefinitionV1<Input, Output, Id>> {
  assertIdentifier(definition.id, "Step definition ID");
  assertIdentifier(definition.definitionVersion, "Step definition version");
  if (definition.schemaVersion !== 1) throw new Error("Step definition schemaVersion must be 1.");
  if (typeof definition.input?.parse !== "function" || typeof definition.output?.parse !== "function") {
    throw new Error("Step definitions require input and output validators.");
  }
  if (typeof definition.execute !== "function") throw new Error("Step definitions require an execute callback.");
  return Object.freeze({ ...definition });
}
export interface WorkflowStepOperationsV1 {
  run<Input extends JsonValue, Output extends JsonValue, Id extends string>(
    step: StepDefinitionV1<Input, Output, Id>,
    input: DeepReadonly<Input>,
  ): Promise<CompletedStepV1<Input, Output>>;
}
export interface WorkflowExecutionContextV1 extends RunExecutionContextV1 { readonly steps: WorkflowStepOperationsV1 }

export interface DurableAgentOperationResultV1<Output extends JsonValue> {
  readonly output: Output;
  readonly metrics?: AgentExecutionMetrics;
  readonly artifacts?: readonly ArtifactRefV1[];
  readonly detailsRef?: StepDetailsRefV1;
}
export interface DurableAgentBindingV1 {
  readonly providerId: string;
  readonly authProviderId: string;
  readonly model?: string;
  readonly configurationSha256: string;
}
export interface DurableAgentOperationExecutorV1 {
  resolve<Output extends JsonValue>(operation: AgentSlotOperationV1<Output>): DurableAgentBindingV1;
  invoke<Input extends JsonValue, Output extends JsonValue>(request: {
    readonly stableOperationId: string;
    readonly runRef: RunRef;
    readonly stepId: string;
    readonly operation: AgentSlotOperationV1<Output>;
    readonly input: DeepReadonly<Input>;
    readonly deadlineAt: string;
    readonly cancellation: CancellationV1;
  }): Promise<DurableAgentOperationResultV1<Output>>;
}

export function assertJsonValue(value: unknown, location = "Value"): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${location} must contain only finite JSON numbers.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${location}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${location} must use plain JSON objects.`);
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) throw new Error(`${location}.${key} must not be undefined.`);
      assertJsonValue(item, `${location}.${key}`);
    }
    return;
  }
  throw new Error(`${location} must be a JSON value.`);
}

export function immutableJson<T extends JsonValue>(value: T, location = "Value"): DeepReadonly<T> {
  assertJsonValue(value, location);
  return deepFreeze(structuredClone(value)) as DeepReadonly<T>;
}

export function hashJson(value: unknown): string {
  assertJsonValue(value);
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function stepDefinitionHash(definition: Pick<StepDefinitionV1<JsonValue, JsonValue>, "schemaVersion" | "id" | "definitionVersion">): string {
  return hashJson({ schemaVersion: definition.schemaVersion, id: definition.id, definitionVersion: definition.definitionVersion });
}

export function normalizedStepPerformance(metrics: readonly AgentExecutionMetrics[]): StepPerformanceV1 {
  const usage = metrics.map((value) => value.usage);
  return {
    inputTokens: normalizedMetric(usage.map((value) => value?.inputTokens)),
    cachedInputTokens: normalizedMetric(usage.map((value) => value?.cachedInputTokens)),
    outputTokens: normalizedMetric(usage.map((value) => value?.outputTokens)),
    reasoningTokens: normalizedMetric(usage.map((value) => value?.reasoningOutputTokens)),
  };
}

function normalizedMetric(values: readonly (number | undefined)[]): UsageMetricV1 {
  const reported = values.filter((value): value is number => value !== undefined);
  return reported.length === 0
    ? { availability: "unavailable", reason: "provider_not_reported" }
    : { availability: "reported", value: reported.reduce((sum, value) => sum + value, 0) };
}
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function deepFreeze(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
export function assertDurableIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/u.test(value)) throw new Error(`${label} must be a safe identifier.`);
}
const assertIdentifier = assertDurableIdentifier;
