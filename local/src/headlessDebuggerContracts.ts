import { z } from "zod";
import { readExternalErrorDiagnostic, redactExternalSecrets } from "../../core/src/application/externalError.ts";
import type { JsonValue } from "../../core/src/application/durableWorkflow.ts";
import type { PlatformRunStatus } from "../../core/src/application/platformRunProjection.ts";
import { retainedId } from "../../core/src/application/retainedExecution.ts";
import type { ActiveComputeLimitsV1 } from "../../core/src/application/activeCompute.ts";

export type HeadlessProtocolVersion = 1 | 2;
export type HeadlessDebuggerRetry = "never" | "after_action" | "same_identity";
export const headlessDebuggerErrorCodes = [
  "invalid_request", "message_too_large", "unsupported_version", "unsupported_operation",
  "authorization_required", "project_invalid", "configuration_invalid", "connection_action_required",
  "not_found", "identity_conflict", "session_busy", "case_busy", "preparation_incomplete",
  "invalid_response", "stale_revision", "input_expired", "input_already_answered", "run_terminal",
  "evidence_too_large", "state_uncertain", "cleanup_unconfirmed", "storage_unavailable", "internal_error",
  "session_version_mismatch", "debugger_unavailable", "source_mapping_unavailable", "not_paused", "not_running",
  "stale_attempt", "stale_pause", "stale_handle", "stale_debugger_revision", "breakpoint_unbound",
  "inspection_unavailable", "control_conflict", "action_required",
  "unsupported_mock_dependency",
] as const;
export type HeadlessDebuggerErrorCode = typeof headlessDebuggerErrorCodes[number];
export const headlessDebuggerErrorCodeSchema = z.enum(headlessDebuggerErrorCodes);

export class HeadlessDebuggerError extends Error {
  readonly retry: HeadlessDebuggerRetry;
  constructor(readonly code: HeadlessDebuggerErrorCode, message: string, retry?: HeadlessDebuggerRetry) {
    super(message);
    this.name = "HeadlessDebuggerError";
    this.retry = retry ?? (["invalid_request", "message_too_large", "unsupported_version", "unsupported_operation"].includes(code)
      ? "never" : ["storage_unavailable", "internal_error"].includes(code) ? "same_identity" : "after_action");
  }
}

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Checks descriptors rather than invoking accessors, and permits repeated values but never cycles. */
export function isHeadlessJson(value: unknown): value is JsonValue {
  const ancestors = new Set<object>();
  const work: { value: unknown; leave?: boolean }[] = [{ value }];
  while (work.length) {
    const item = work.pop()!, current = item.value;
    if (item.leave) { ancestors.delete(current as object); continue; }
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") { if (!Number.isFinite(current)) return false; continue; }
    if (typeof current !== "object" || ancestors.has(current)) return false;
    const array = Array.isArray(current), prototype = Object.getPrototypeOf(current);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(current);
    if (keys.some(key => typeof key !== "string")) return false;
    if (array && keys.length !== current.length + 1) return false;
    ancestors.add(current); work.push({ value: current, leave: true });
    for (const key of keys as string[]) {
      if (array && key === "length") continue;
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
      if (!descriptor.enumerable || !("value" in descriptor)) return false;
      work.push({ value: descriptor.value });
    }
  }
  return true;
}

const json = z.custom<JsonValue>(isHeadlessJson, "Expected JSON-compatible data.");
export const headlessIdentifierSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const publishedRunStatuses = ["accepted", "running", "waiting_for_input", "resume_queued", "complete", "failed", "cancelled", "archived"] as const satisfies readonly PlatformRunStatus[];
// Keep the local schema exhaustive when the published status union changes.
const publishedStatusesAreExhaustive: Exclude<PlatformRunStatus, typeof publishedRunStatuses[number]> extends never ? true : never = true;
void publishedStatusesAreExhaustive;
export const headlessRunStatusSchema = z.enum(publishedRunStatuses);
export const headlessJsonPointerSchema = z.string().refine(pointer => pointer === "" || (pointer.startsWith("/") && !/~(?:[^01]|$)/.test(pointer)), "Invalid JSON pointer.");
export const headlessExpectationSchema = z.union([
  z.strictObject({ id: headlessIdentifierSchema, target: z.literal("run-status"), operator: z.literal("equals"), value: headlessRunStatusSchema }),
  z.strictObject({ id: headlessIdentifierSchema, target: z.literal("result"), pointer: headlessJsonPointerSchema, operator: z.literal("equals"), value: json }),
  z.strictObject({ id: headlessIdentifierSchema, target: z.literal("result"), pointer: headlessJsonPointerSchema, operator: z.literal("exists") }),
]);
export type HeadlessExpectation = z.infer<typeof headlessExpectationSchema>;

const caseSchema = z.strictObject({ caseId: headlessIdentifierSchema, input: json, expectations: z.array(headlessExpectationSchema) })
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.expectations.forEach((expectation, index) => {
      if (ids.has(expectation.id)) context.addIssue({ code: "custom", message: "Duplicate expectation ID.", path: ["expectations", index, "id"] });
      ids.add(expectation.id);
    });
  });
const mockOperationIdSchema = z.string().max(128).regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/);
const mockDelaySchema = z.number().int().nonnegative().max(60_000).optional();
const mockFixtureSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("result"), value: json, delayMs: mockDelaySchema }),
  z.strictObject({ kind: z.literal("error"), error: z.strictObject({ code: headlessIdentifierSchema, message: z.string().min(1).max(4096) }), delayMs: mockDelaySchema }),
]);
const caseV2Schema = z.strictObject({ caseId: headlessIdentifierSchema, input: json,
  mocks: z.record(mockOperationIdSchema, mockFixtureSchema), expectations: z.array(headlessExpectationSchema).default([]) })
  .superRefine((value, context) => {
    if (Object.keys(value.mocks).length > 100) context.addIssue({ code: "custom", message: "A debug case supports at most 100 mock operations.", path: ["mocks"] });
    const ids = new Set<string>();
    value.expectations.forEach((expectation, index) => {
      if (ids.has(expectation.id)) context.addIssue({ code: "custom", message: "Duplicate expectation ID.", path: ["expectations", index, "id"] });
      ids.add(expectation.id);
    });
  });
const executionBudgetSchema = z.number().int().safe().min(10);
const manifestFields = { sessionId: headlessIdentifierSchema,
  workflowId: z.string().min(1), configurationId: z.string().min(1), executionBudgetMs: executionBudgetSchema.optional(), cases: z.array(caseSchema).min(1) };
const uniqueCases = (value: { cases: { caseId: string }[] }, context: z.RefinementCtx) => {
  const ids = new Set<string>();
  value.cases.forEach((item, index) => {
    if (ids.has(item.caseId)) context.addIssue({ code: "custom", message: "Duplicate case ID.", path: ["cases", index, "caseId"] });
    ids.add(item.caseId);
  });
};
export const headlessManifestV1Schema = z.strictObject({ schemaVersion: z.literal(1), ...manifestFields }).superRefine(uniqueCases);
export const headlessManifestV2Schema = z.strictObject({ schemaVersion: z.literal(2), ...manifestFields, cases: z.array(caseV2Schema).min(1),
  debug: z.strictObject({ stopOnEntry: z.boolean() }) }).superRefine(uniqueCases);
export const headlessManifestSchema = z.discriminatedUnion("schemaVersion", [headlessManifestV1Schema, headlessManifestV2Schema]);
export type HeadlessManifest = z.infer<typeof headlessManifestSchema>;
export type HeadlessManifestV1 = Extract<HeadlessManifest, { schemaVersion: 1 }>;
export type HeadlessManifestV2 = Extract<HeadlessManifest, { schemaVersion: 2 }>;
const authorizationFields = { executeProjectCode: z.literal(true), allowProviderCharges: z.literal(true),
  allowExternalEffects: z.literal(true), discloseWorkflowData: z.literal(true), increaseExecutionBudget: z.literal(true).optional() };
export const headlessAuthorizationV1Schema = z.strictObject(authorizationFields);
export const headlessAuthorizationV2Schema = z.strictObject({ executeProjectCode: z.literal(true), discloseWorkflowData: z.literal(true),
  discloseLiveState: z.literal(true), allowSimulatedEvaluation: z.literal(true), increaseExecutionBudget: z.literal(true).optional() });
export const headlessAuthorizationSchema = z.union([headlessAuthorizationV1Schema, headlessAuthorizationV2Schema]);
export type HeadlessAuthorization = z.infer<typeof headlessAuthorizationSchema>;
export type HeadlessAuthorizationV1 = z.infer<typeof headlessAuthorizationV1Schema>;
export type HeadlessAuthorizationV2 = z.infer<typeof headlessAuthorizationV2Schema>;

const inputFileSchema = z.strictObject({ objectId: retainedId, mediaType: z.string().min(1), byteLength: z.number().int().nonnegative().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const inputResponseSchema = z.strictObject({ schemaVersion: z.literal(1),
  fields: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
  files: z.record(z.string(), z.array(inputFileSchema)) });
export const headlessMethodParamsSchemas = {
  "session.create": z.strictObject({ manifest: headlessManifestV1Schema, authorization: headlessAuthorizationV1Schema }),
  "session.open": z.strictObject({ sessionId: headlessIdentifierSchema }),
  "session.inspect": z.strictObject({}),
  "case.run": z.strictObject({ caseId: headlessIdentifierSchema }),
  "case.respond": z.strictObject({ caseId: headlessIdentifierSchema, requestId: retainedId, submissionId: retainedId,
    expectedRevision: z.number().int().positive().safe(), response: inputResponseSchema }),
  "case.cancel": z.strictObject({ caseId: headlessIdentifierSchema }),
  "evidence.read": z.strictObject({ caseId: headlessIdentifierSchema, evidenceId: retainedId,
    offset: z.number().int().nonnegative().safe(), limit: z.number().int().min(1).max(262144) }),
  "session.close": z.strictObject({}),
} as const;
const offsetSchema = z.number().int().nonnegative().safe();
const pageLimitSchema = z.number().int().min(1).max(100);
const sourcePageLimitSchema = z.number().int().min(1).max(262144);
const sourcePositionSchema = z.number().int().positive().safe();
const breakpointSchema = z.strictObject({ breakpointId: headlessIdentifierSchema, sourceId: headlessIdentifierSchema,
  line: sourcePositionSchema, column: sourcePositionSchema, condition: z.string().min(1).max(4096).optional(),
  logExpression: z.string().min(1).max(4096).optional() });
const boundedExpressionSchema = z.string().min(1).max(4096);
const variableNameSchema = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/);
export const headlessV2MethodParamsSchemas = {
  ...headlessMethodParamsSchemas,
  "session.create": z.strictObject({ manifest: headlessManifestV2Schema, authorization: headlessAuthorizationV2Schema }),
  "debug.sources": z.strictObject({ offset: offsetSchema, limit: pageLimitSchema }),
  "debug.source.read": z.strictObject({ sourceId: headlessIdentifierSchema, offset: offsetSchema, limit: sourcePageLimitSchema }),
  "debug.breakpoints.set": z.strictObject({ expectedDebuggerRevision: offsetSchema, breakpoints: z.array(breakpointSchema).max(100) })
    .superRefine((value, context) => {
      const ids = new Set<string>();
      value.breakpoints.forEach((breakpoint, index) => {
        if (ids.has(breakpoint.breakpointId)) context.addIssue({ code: "custom", message: "Duplicate breakpoint ID.", path: ["breakpoints", index, "breakpointId"] });
        ids.add(breakpoint.breakpointId);
      });
    }),
  "debug.inspect": z.strictObject({ caseId: headlessIdentifierSchema }),
  "debug.pause": z.strictObject({ caseId: headlessIdentifierSchema, attemptId: headlessIdentifierSchema, controlId: headlessIdentifierSchema }),
  "debug.continue": z.strictObject({ caseId: headlessIdentifierSchema, pauseId: headlessIdentifierSchema, controlId: headlessIdentifierSchema }),
  "debug.step": z.strictObject({ caseId: headlessIdentifierSchema, pauseId: headlessIdentifierSchema, controlId: headlessIdentifierSchema, kind: z.enum(["into", "over", "out"]) }),
  "debug.stack": z.strictObject({ caseId: headlessIdentifierSchema, pauseId: headlessIdentifierSchema, offset: offsetSchema, limit: pageLimitSchema }),
  "debug.scopes": z.strictObject({ caseId: headlessIdentifierSchema, pauseId: headlessIdentifierSchema, frameId: headlessIdentifierSchema }),
  "debug.properties": z.strictObject({ caseId: headlessIdentifierSchema, pauseId: headlessIdentifierSchema, objectId: headlessIdentifierSchema, offset: offsetSchema, limit: pageLimitSchema }),
  "debug.evaluate": z.strictObject({ caseId: headlessIdentifierSchema, pauseId: headlessIdentifierSchema, frameId: headlessIdentifierSchema,
    evaluationId: headlessIdentifierSchema, expression: boundedExpressionSchema }),
  "debug.variable.set": z.strictObject({ caseId: headlessIdentifierSchema, pauseId: headlessIdentifierSchema, frameId: headlessIdentifierSchema,
    controlId: headlessIdentifierSchema, name: variableNameSchema, expression: boundedExpressionSchema }),
} as const;
const requestBase = { schemaVersion: z.literal(1), id: z.string().min(1) };
export const headlessRequestV1Schema = z.discriminatedUnion("method", [
  z.strictObject({ ...requestBase, method: z.literal("session.create"), params: headlessMethodParamsSchemas["session.create"] }),
  z.strictObject({ ...requestBase, method: z.literal("session.open"), params: headlessMethodParamsSchemas["session.open"] }),
  z.strictObject({ ...requestBase, method: z.literal("session.inspect"), params: headlessMethodParamsSchemas["session.inspect"] }),
  z.strictObject({ ...requestBase, method: z.literal("case.run"), params: headlessMethodParamsSchemas["case.run"] }),
  z.strictObject({ ...requestBase, method: z.literal("case.respond"), params: headlessMethodParamsSchemas["case.respond"] }),
  z.strictObject({ ...requestBase, method: z.literal("case.cancel"), params: headlessMethodParamsSchemas["case.cancel"] }),
  z.strictObject({ ...requestBase, method: z.literal("evidence.read"), params: headlessMethodParamsSchemas["evidence.read"] }),
  z.strictObject({ ...requestBase, method: z.literal("session.close"), params: headlessMethodParamsSchemas["session.close"] }),
]);
const requestV2Base = { schemaVersion: z.literal(2), id: z.string().min(1) };
export const headlessRequestV2Schema = z.discriminatedUnion("method", [
  z.strictObject({ ...requestV2Base, method: z.literal("session.create"), params: headlessV2MethodParamsSchemas["session.create"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("session.open"), params: headlessV2MethodParamsSchemas["session.open"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("session.inspect"), params: headlessV2MethodParamsSchemas["session.inspect"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("case.run"), params: headlessV2MethodParamsSchemas["case.run"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("case.respond"), params: headlessV2MethodParamsSchemas["case.respond"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("case.cancel"), params: headlessV2MethodParamsSchemas["case.cancel"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("evidence.read"), params: headlessV2MethodParamsSchemas["evidence.read"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("session.close"), params: headlessV2MethodParamsSchemas["session.close"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.sources"), params: headlessV2MethodParamsSchemas["debug.sources"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.source.read"), params: headlessV2MethodParamsSchemas["debug.source.read"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.breakpoints.set"), params: headlessV2MethodParamsSchemas["debug.breakpoints.set"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.inspect"), params: headlessV2MethodParamsSchemas["debug.inspect"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.pause"), params: headlessV2MethodParamsSchemas["debug.pause"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.continue"), params: headlessV2MethodParamsSchemas["debug.continue"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.step"), params: headlessV2MethodParamsSchemas["debug.step"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.stack"), params: headlessV2MethodParamsSchemas["debug.stack"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.scopes"), params: headlessV2MethodParamsSchemas["debug.scopes"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.properties"), params: headlessV2MethodParamsSchemas["debug.properties"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.evaluate"), params: headlessV2MethodParamsSchemas["debug.evaluate"] }),
  z.strictObject({ ...requestV2Base, method: z.literal("debug.variable.set"), params: headlessV2MethodParamsSchemas["debug.variable.set"] }),
]);
export const headlessRequestSchema = z.union([headlessRequestV1Schema, headlessRequestV2Schema]);
export type HeadlessRequest = z.infer<typeof headlessRequestSchema>;

function checkedParse<T>(schema: z.ZodType<T>, value: unknown): T {
  if (!isHeadlessJson(value)) throw new HeadlessDebuggerError("invalid_request", "Request must contain only JSON-compatible data.");
  const result = schema.safeParse(value);
  if (!result.success) throw new HeadlessDebuggerError("invalid_request", "Request has unknown fields or invalid values. Check the selected debugger protocol contract.");
  // Inputs may be deeply nested but still fit the transport bound. Do not use a recursive clone.
  const wrapper: Record<string, JsonValue> = Object.create(null);
  const pending: { source: JsonValue; target: Record<string, JsonValue>; key: string }[] = [{ source: result.data as JsonValue, target: wrapper, key: "value" }];
  while (pending.length) {
    const { source, target, key } = pending.pop()!;
    if (source === null || typeof source !== "object") { target[key] = source; continue; }
    const output = (Array.isArray(source) ? [] : Object.create(null)) as Record<string, JsonValue>;
    target[key] = output;
    for (const [childKey, child] of Object.entries(source)) pending.push({ source: child, target: output, key: childKey });
  }
  return wrapper.value as T;
}
export function parseHeadlessManifest(value: unknown): HeadlessManifest { return checkedParse(headlessManifestSchema, value); }
export function parseHeadlessAuthorization(value: unknown, schemaVersion: HeadlessProtocolVersion = 1): HeadlessAuthorization {
  const message = schemaVersion === 2 ? "Project-code execution, workflow-data disclosure, live-state disclosure and simulated evaluation acknowledgements must be true." : "All four execution and disclosure acknowledgements must be true.";
  if (!value || typeof value !== "object" || !isHeadlessJson(value)) throw new HeadlessDebuggerError("authorization_required", message);
  const keys = schemaVersion === 2
    ? ["executeProjectCode", "discloseWorkflowData", "discloseLiveState", "allowSimulatedEvaluation"]
    : ["executeProjectCode", "allowProviderCharges", "allowExternalEffects", "discloseWorkflowData"];
  for (const key of keys) {
    if (!own(value, key) || (value as Record<string, unknown>)[key] !== true) throw new HeadlessDebuggerError("authorization_required", message);
  }
  return schemaVersion === 2
    ? checkedParse(headlessAuthorizationV2Schema, value)
    : checkedParse(headlessAuthorizationV1Schema, value);
}

/** Resolve once at session creation; callers retain these limits with each Run. */
export function resolveHeadlessExecutionBudget(defaultMs: number, manifest: HeadlessManifest, authorization: HeadlessAuthorization): ActiveComputeLimitsV1 {
  if (!executionBudgetSchema.safeParse(defaultMs).success) throw new HeadlessDebuggerError("configuration_invalid", "The workflow execution budget must be a safe integer of at least 10 milliseconds.");
  const totalMs = manifest.executionBudgetMs ?? defaultMs;
  if (!executionBudgetSchema.safeParse(totalMs).success) throw new HeadlessDebuggerError("invalid_request", "The diagnostic execution budget must be a safe integer of at least 10 milliseconds.");
  const permissions = parseHeadlessAuthorization(authorization, manifest.schemaVersion);
  if (totalMs > defaultMs && permissions.increaseExecutionBudget !== true) {
    throw new HeadlessDebuggerError("authorization_required", "Increasing the workflow execution budget requires explicit increaseExecutionBudget authorization for this session.");
  }
  return { totalMs, attemptMs: totalMs, finalizationReserveMs: Math.min(5_000, Math.floor(totalMs / 10)) };
}
export function parseHeadlessRequest(value: unknown): HeadlessRequest {
  if (!isHeadlessJson(value)) throw new HeadlessDebuggerError("invalid_request", "Request must contain only JSON-compatible data.");
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (own(value, "schemaVersion") && value.schemaVersion !== 1 && value.schemaVersion !== 2) throw new HeadlessDebuggerError("unsupported_version", "Debugger schemaVersion must equal 1 or 2.");
    if (value.method === "session.create" && value.params && typeof value.params === "object" && !Array.isArray(value.params)) {
      parseHeadlessAuthorization(value.params.authorization, value.schemaVersion === 2 ? 2 : 1);
    }
  }
  return checkedParse(headlessRequestSchema, value);
}

export type HeadlessComparison = "pending" | "pass" | "mismatch" | "not_checked" | "unavailable";
export interface HeadlessExpectationCheck { id: string; outcome: Exclude<HeadlessComparison, "not_checked">; reason: string | null }
export interface HeadlessComparisonResult { comparison: HeadlessComparison; checks: HeadlessExpectationCheck[] }

function pointerValue(value: JsonValue, pointer: string): { found: false } | { found: true; value: JsonValue } {
  if (pointer === "") return { found: true, value };
  let current: JsonValue = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !own(current, token)) return { found: false };
    if (Array.isArray(current) && !/^(0|[1-9][0-9]*)$/.test(token)) return { found: false };
    current = (current as Record<string, JsonValue>)[token]!;
  }
  return { found: true, value: current };
}
function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  const pairs: [JsonValue, JsonValue][] = [[left, right]];
  while (pairs.length) {
    const [a, b] = pairs.pop()!;
    if (a === b) continue;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!own(b, key)) return false;
      pairs.push([(a as Record<string, JsonValue>)[key]!, (b as Record<string, JsonValue>)[key]!]);
    }
  }
  return true;
}

export function compareExpectations(expectations: readonly HeadlessExpectation[], state: {
  terminal: boolean; runStatus: PlatformRunStatus | null; resultAvailable: boolean; resultPayload?: unknown; unavailable?: boolean;
}): HeadlessComparisonResult {
  const unavailable = state.unavailable || (state.resultAvailable && !isHeadlessJson(state.resultPayload));
  if (unavailable) return { comparison: "unavailable", checks: expectations.map(item => ({ id: item.id, outcome: "unavailable", reason: "Comparison evidence is unavailable." })) };
  if (!state.terminal) return { comparison: "pending", checks: expectations.map(item => ({ id: item.id, outcome: "pending", reason: null })) };
  if (!expectations.length) return { comparison: "not_checked", checks: [] };
  const checks: HeadlessExpectationCheck[] = expectations.map(expectation => {
    if (expectation.target === "run-status") {
      const matches = state.runStatus === expectation.value;
      return { id: expectation.id, outcome: matches ? "pass" : "mismatch", reason: matches ? null : "Run status does not equal the expected status." };
    }
    if (!state.resultAvailable) return { id: expectation.id, outcome: "mismatch", reason: "No validated result was published." };
    const actual = pointerValue(state.resultPayload as JsonValue, expectation.pointer);
    if (!actual.found) return { id: expectation.id, outcome: "mismatch", reason: "The JSON pointer does not identify a result value." };
    const matches = expectation.operator === "exists" || jsonEqual(actual.value, expectation.value);
    return { id: expectation.id, outcome: matches ? "pass" : "mismatch", reason: matches ? null : "Result value does not structurally equal the expected value." };
  });
  return { comparison: checks.every(check => check.outcome === "pass") ? "pass" : "mismatch", checks };
}

const secretKey = /(?:apikey(?:value)?|secret(?:key)?|privatekey|password|passwd|authorization|cookie|accesstoken|refreshtoken|sessiontoken|credentialvalue|clientsecret|awsaccesskeyid|awssecretaccesskey)$|^token$/;
const metadataPrivateKey = /^(?:env|environment|environmentvariables|stack|stacktrace|stdout|stderr|rawoutput|rawerror|binding)$/;
const redactedText = "[REDACTED]";

/** Sanitize an allowlisted evidence projection, never an internal control object. Payload mode retains business paths. */
export function sanitizeEvidence(value: unknown, options: { knownSecrets?: readonly string[]; payload?: boolean } = {}): { value: JsonValue; redacted: boolean } {
  if (!isHeadlessJson(value)) return { value: redactedText, redacted: true };
  const secrets = [...new Set((options.knownSecrets ?? []).filter(secret => secret.length > 0))].sort((a, b) => b.length - a.length);
  let redacted = false;
  const cleanString = (text: string): string => {
    let clean = text;
    for (const secret of secrets) clean = clean.split(secret).join(redactedText);
    clean = clean.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.:-]+/gi, redactedText)
      .replace(/\b(?:sk-(?:proj-|ant-)?|AKIA)[A-Za-z0-9_-]{12,}/g, redactedText);
    if (!options.payload) {
      clean = clean.replace(/(?:^|\n)\s*at\s+[^\n]+/g, "\n[STACK REDACTED]")
        .replace(/file:\/\/[^\s"'<>]+|\b[A-Za-z]:[\\/][^\s"'<>]+|(?:^|[\s(=:])\/(?:[^\s"'<>),;]+)(?=$|[\s),;])/g,
          match => `${/^[\s(=:]/.test(match) ? match[0] : ""}[PATH REDACTED]`);
    }
    if (clean !== text) redacted = true;
    return clean;
  };
  const wrapper: Record<string, JsonValue> = Object.create(null);
  const pending: { source: JsonValue; target: Record<string, JsonValue>; key: string }[] = [{ source: value, target: wrapper, key: "value" }];
  while (pending.length) {
    const { source, target, key } = pending.pop()!;
    // Provider adapters already select the diagnostic and remove resolved credentials.
    // Do not apply internal path/stack heuristics to their ordinary explanations.
    if (key === "externalDiagnostic") {
      const diagnostic = readExternalErrorDiagnostic(source);
      if (diagnostic) {
        const clean = { origin: diagnostic.origin, provider: redactExternalSecrets(diagnostic.provider, secrets),
          message: redactExternalSecrets(diagnostic.message, secrets),
          ...(diagnostic.code === undefined ? {} : { code: redactExternalSecrets(diagnostic.code, secrets) }),
          ...(diagnostic.httpStatus === undefined ? {} : { httpStatus: diagnostic.httpStatus }) };
        if (JSON.stringify(clean) !== JSON.stringify(diagnostic)) redacted = true;
        target[key] = clean; continue;
      }
    }
    if (typeof source === "string") { target[key] = cleanString(source); continue; }
    if (source === null || typeof source !== "object") { target[key] = source; continue; }
    const result = (Array.isArray(source) ? [] : Object.create(null)) as Record<string, JsonValue>;
    target[key] = result;
    for (const [childKey, child] of Object.entries(source)) {
      const keyName = childKey.replace(/[^a-z0-9]/gi, "").toLowerCase();
      const sanitizedKey = cleanString(childKey);
      if (secretKey.test(keyName) || (!options.payload && metadataPrivateKey.test(keyName))) { result[sanitizedKey] = redactedText; redacted = true; }
      else pending.push({ source: child, target: result, key: sanitizedKey });
    }
  }
  return { value: wrapper.value!, redacted };
}
