import { immutableJson, type DeepReadonly, type EffectAdapterV1, type JsonValue } from "../../core/src/application/durableWorkflow.ts";
import { constructionDescriptorSchema, type EffectAdapterFactoryContextV1 } from "../../core/src/application/retainedWorkflowConstruction.ts";
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import { credentialSecretValues, redactExternalSecrets, type ExternalErrorDiagnostic } from "../../core/src/application/externalError.ts";

export async function prepareRetainedEffectAdapters(options: {
  code: string;
  descriptor: unknown;
  environment: Readonly<Record<string, string>>;
  credentials: Readonly<Record<string, string>>;
  runConfiguration: DeepReadonly<JsonValue>;
}): Promise<Readonly<Record<string, EffectAdapterV1<JsonValue, JsonValue>>>> {
  const descriptor = constructionDescriptorSchema.parse(options.descriptor);
  if (descriptor.schemaVersion === 1) return Object.freeze({});
  const module = await import(`data:text/javascript;base64,${Buffer.from(options.code).toString("base64")}`) as Record<string, unknown>;
  const context: EffectAdapterFactoryContextV1 = Object.freeze({
    environment: Object.freeze({ ...options.environment }),
    credentials: Object.freeze({ ...options.credentials }),
    runConfiguration: immutableJson(inputWaitJsonSnapshot(options.runConfiguration)),
  });
  const adapters: Record<string, EffectAdapterV1<JsonValue, JsonValue>> = {};
  for (const exportName of descriptor.effectAdapters) {
    const factory = Object.hasOwn(module, exportName) && module[exportName];
    if (typeof factory !== "function") throw new Error("Retained effect adapter export must be a function.");
    const value = await factory(context) as unknown;
    const adapter = validateAdapter(value);
    if (Object.hasOwn(adapters, adapter.operationId)) throw new Error(`Duplicate retained effect adapter ${adapter.operationId}.`);
    adapters[adapter.operationId] = adapter;
  }
  return Object.freeze(adapters);
}

export function retainedEffectSecretValues(environment: Readonly<Record<string, string>>,
  credentials: Readonly<Record<string, string>>): string[] {
  return [...new Set([...Object.values(credentials), ...credentialSecretValues(environment)].filter(value => value.length > 0))];
}

export function assertRetainedEffectOutputSafe(value: unknown, secretValues: readonly string[]): void {
  const serialized = JSON.stringify(value);
  if (secretValues.some(secret => [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]
    .some(variant => variant.length > 0 && serialized.includes(variant)))) {
    throw new Error("Effect adapter output contained a host-owned secret.");
  }
}

export function assertRetainedEffectAdapterMatches(adapter: EffectAdapterV1<JsonValue, JsonValue>, request: {
  operationId: string;
  definitionVersion: string;
  safety: EffectAdapterV1<JsonValue, JsonValue>["safety"];
}): void {
  if (adapter.operationId !== request.operationId || adapter.definitionVersion !== request.definitionVersion
    || adapter.safety !== request.safety) {
    throw new Error(`Retained host adapter contract differs for effect ${request.operationId}.`);
  }
}

export function sanitizeRetainedEffectDiagnostic(diagnostic: ExternalErrorDiagnostic,
  secretValues: readonly string[]): ExternalErrorDiagnostic {
  return { ...diagnostic, message: redactExternalSecrets(diagnostic.message, secretValues),
    ...(diagnostic.code ? { code: redactExternalSecrets(diagnostic.code, secretValues) } : {}) };
}

function validateAdapter(value: unknown): EffectAdapterV1<JsonValue, JsonValue> {
  if (!value || typeof value !== "object") throw new Error("Retained effect adapter factory returned an invalid adapter.");
  const adapter = value as Partial<EffectAdapterV1<JsonValue, JsonValue>>;
  if (adapter.schemaVersion !== 1 || typeof adapter.operationId !== "string" || !adapter.operationId
    || typeof adapter.definitionVersion !== "string" || !adapter.definitionVersion
    || !["read", "idempotent-write", "reconcilable-write", "unsafe-write"].includes(adapter.safety ?? "")
    || typeof adapter.input?.parse !== "function" || typeof adapter.output?.parse !== "function"
    || typeof adapter.execute !== "function"
    || (adapter.safety === "reconcilable-write" && typeof adapter.reconcile !== "function")) {
    throw new Error("Retained effect adapter factory returned an invalid adapter.");
  }
  return Object.freeze(adapter) as EffectAdapterV1<JsonValue, JsonValue>;
}
