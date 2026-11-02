/** Internal storage contract; not an engine plugin or public REST payload. */
import { z } from "zod";
import { readExternalErrorDiagnostic } from "./externalError.ts";
import { activeComputeSchema } from "./activeCompute.ts";
import { validateRunRef, type RunRef } from "../domain/runIdentity.ts";
import { validateRunManifestV3 } from "../domain/runManifest.ts";
import { validateWorkflowInvocationV1 } from "./durableWorkflowInvocation.ts";
import { runConfigurationContentHash } from "./runConfiguration.ts";
import { hashJson, type JsonValue } from "./durableWorkflow.ts";
import { inputWaitJsonSnapshot, validateInputRequestV1, validateInputResponseShapeV1, type InputRequestV1, type InputResponseV1 } from "./inputWait.ts";
import { validateRetainedGraphInputV1 } from "./retainedGraphInput.ts";

export const retainedId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/).refine(value => !["constructor", "prototype", "__proto__"].includes(value));
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const json = z.unknown().transform(value => inputWaitJsonSnapshot(value));
export const retainedExternalDiagnosticSchema = z.unknown().transform((value, context) => {
  const diagnostic = readExternalErrorDiagnostic(value);
  if (!diagnostic) { context.addIssue({ code: "custom", message: "Invalid external diagnostic." }); return z.NEVER; }
  return diagnostic;
});
export const executableBindingSchema = z.strictObject({
  id: retainedId, buildSha256: digest, workflow: json, invocation: json,
  runConfiguration: json, executionProfile: json, nonSecretEnvironment: z.record(z.string(), z.string()),
  effectSecretNames: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).refine(values => new Set(values).size === values.length).optional(),
  credentialReferences: z.array(retainedId), hostRequirements: z.record(z.string(), z.string()),
  runManifest: z.unknown().transform(validateRunManifestV3).optional(),
});
export type ExecutableBindingV1 = z.infer<typeof executableBindingSchema>;
export const ownerSchema = z.strictObject({ attemptId: retainedId, fence: z.number().int().positive().safe(), pid: z.number().int().positive().safe() });
export type RetainedOwnerV1 = z.infer<typeof ownerSchema>;
export const receiptSchema = z.strictObject({ schemaVersion: z.literal(1), submissionId: retainedId, requestId: retainedId,
  acceptedAt: time, acceptedBodySha256: digest, resumeCommandId: retainedId, responderId: retainedId });
export type InputSubmissionReceiptV1 = z.infer<typeof receiptSchema>;
const requestSchema = z.strictObject({ definition: z.unknown().transform(validateInputRequestV1), optionsSha256: digest,
  status: z.enum(["pending", "submitted", "cancelled", "expired"]), revision: z.number().int().positive().safe(), updatedAt: time,
  response: z.unknown().optional(), submissionId: retainedId.optional() });
const commandSchema = z.strictObject({ id: retainedId, requestId: retainedId, state: z.enum(["pending", "claimed", "done"]), owner: ownerSchema.optional() });
const controlSchema = z.strictObject({ schemaVersion: z.literal(1), runRef: z.unknown().transform(validateRunRef),
  binding: executableBindingSchema, revision: z.number().int().positive().safe(), fence: z.number().int().nonnegative().safe(),
  status: z.enum(["running", "waiting_for_input", "resume_queued", "complete", "failed", "cancelled"]),
  owner: ownerSchema.nullable(), requests: z.record(retainedId, requestSchema), receipts: z.record(retainedId, receiptSchema),
  commands: z.record(retainedId, commandSchema), updatedAt: time, retainedDataDeleted: z.boolean(),
  graphInput: z.unknown().transform(validateRetainedGraphInputV1).optional(),
  compute: activeComputeSchema.optional(),
  failure: z.strictObject({ code: retainedId, message: z.string(), externalDiagnostic: retainedExternalDiagnosticSchema.optional() }).optional(),
  output: json.optional(),
});
export type RetainedRunControlV1 = z.infer<typeof controlSchema>;
export const terminalRun = (state: RetainedRunControlV1): boolean => ["complete", "failed", "cancelled"].includes(state.status);
export const sameOwner = (a: RetainedOwnerV1 | null | undefined, b: RetainedOwnerV1): boolean => !!a && a.attemptId === b.attemptId && a.fence === b.fence && a.pid === b.pid;
export const runKey = (runRef: RunRef): string => hashJson(validateRunRef(runRef) as unknown as JsonValue);
export const requestKey = (runRef: RunRef, stepId: string): string => `input-${hashJson({ run: runKey(runRef), step: retainedId.parse(stepId) })}`;

export function validateRetainedRunControl(value: unknown): RetainedRunControlV1 {
  const state = controlSchema.parse(inputWaitJsonSnapshot(value));
  if (state.failure?.externalDiagnostic && state.failure.message !== state.failure.externalDiagnostic.message) throw new Error("Run external diagnostic differs from its failure message.");
  if (state.output !== undefined && state.status !== "complete") throw new Error("Only a completed Run can retain a result.");
  if (state.owner && state.owner.fence !== state.fence) throw new Error("Run owner fence differs.");
  if (state.compute) {
    const active = state.compute.active;
    if (!!active !== !!state.owner || (active && (active.attemptId !== state.owner!.attemptId || active.fence !== state.owner!.fence))) throw new Error("Compute owner differs.");
    if (active && (state.compute.spentMs >= state.compute.limits.totalMs ||
      Date.parse(active.deadlineAt) - Date.parse(active.startedAt) !== Math.min(state.compute.limits.attemptMs, state.compute.limits.totalMs - state.compute.spentMs) + (active.diagnostic?.excludedPauseMs ?? 0))) throw new Error("Compute deadline is invalid.");
    if (!!active?.diagnostic !== !!(active && state.compute.diagnosticOnly)) throw new Error("Diagnostic accounting mode differs.");
    if (state.compute.diagnosticOnly && state.compute.excludedPauseMs === undefined) throw new Error("Diagnostic pause total is missing.");
    if (!state.compute.diagnosticOnly && (state.compute.excludedPauseMs !== undefined || state.compute.lastAttempt?.excludedPauseMs !== undefined || state.compute.lastAttempt?.wallElapsedMs !== undefined)) throw new Error("Ordinary execution cannot exclude pause time.");
    if (state.compute.lastAttempt?.wallElapsedMs !== undefined && state.compute.lastAttempt.wallElapsedMs !== state.compute.lastAttempt.elapsedMs + (state.compute.lastAttempt.excludedPauseMs ?? 0)) throw new Error("Diagnostic settlement counters differ.");
    if (state.compute.lastAttempt && state.compute.lastAttempt.elapsedMs > state.compute.spentMs) throw new Error("Spent compute does not include its last attempt.");
    if (state.compute.certainty === "uncertain" && !terminalRun(state)) throw new Error("Uncertain accounting must stop automatic execution.");
  }
  if (state.retainedDataDeleted && (!terminalRun(state) || state.owner)) throw new Error("Live Run data cannot be deleted.");
  if (state.retainedDataDeleted) {
    if (Object.keys(state.requests).length || Object.keys(state.commands).length || state.binding.invocation !== null
      || state.binding.runConfiguration !== null || state.binding.executionProfile !== null
      || Object.keys(state.binding.nonSecretEnvironment).length || state.binding.credentialReferences.length
      || (state.binding.effectSecretNames?.length ?? 0)
      || state.graphInput !== undefined || state.output !== undefined) throw new Error("Deleted control data must contain only its tombstone and receipts.");
    return state;
  }
  const graphPending = state.graphInput?.requestState?.status === "pending" ? 1 : 0;
  if (state.graphInput) {
    const invocation = state.graphInput.invocation;
    if (hashJson(inputWaitJsonSnapshot(state.binding.invocation)) !== hashJson(invocation as unknown as JsonValue)
      || invocation.runRef.executionId !== state.runRef.executionId
      || invocation.executableBindingId !== state.binding.id || invocation.buildSha256 !== state.binding.buildSha256
      || hashJson(inputWaitJsonSnapshot(invocation.workflow)) !== hashJson(inputWaitJsonSnapshot(state.binding.workflow))) {
      throw new Error("Retained graph input differs from its executable binding.");
    }
    if (state.graphInput.requestState?.status === "pending" && state.status !== "waiting_for_input") {
      throw new Error("Pending graph input requires a waiting Run.");
    }
  }
  if (state.binding.runManifest) {
    const manifest = state.binding.runManifest, invocation = state.graphInput?.invocation ?? validateWorkflowInvocationV1(state.binding.invocation);
    const equal = (a: unknown, b: unknown) => hashJson(inputWaitJsonSnapshot(a)) === hashJson(inputWaitJsonSnapshot(b));
    if (!equal(manifest.runRef, state.runRef) || !equal(invocation.runRef, state.runRef)
      || !equal(manifest.workflow, invocation.workflow) || !equal(manifest.workflow, state.binding.workflow)
      || !equal(manifest.runConfiguration, invocation.runConfiguration) || manifest.createdAt !== invocation.createdAt
      || runConfigurationContentHash(state.binding.runConfiguration) !== manifest.runConfiguration.contentHash) throw new Error("Published retained Run identity differs from its binding.");
    if (state.status === "complete" && state.output === undefined) throw new Error("Published retained Run requires saved output at completion.");
  }
  let pending = 0;
  for (const [id, request] of Object.entries(state.requests)) {
    if (id !== request.definition.requestId || id !== requestKey(state.runRef, request.definition.stepId) ||
      request.definition.executableBindingId !== state.binding.id) throw new Error("Stored input request binding differs.");
    const at = Date.parse(request.updatedAt), expires = Date.parse(request.definition.expiresAt);
    if (at < Date.parse(request.definition.createdAt) || (request.status === "expired" && at < expires)) throw new Error("Stored request time differs.");
    if (request.status === "pending") pending++;
    if (request.status === "submitted") {
      const receipt = request.submissionId && state.receipts[request.submissionId];
      if (!receipt || receipt.requestId !== id || at >= expires || receipt.acceptedAt !== request.updatedAt) throw new Error("Submitted request has no matching receipt.");
      request.response = validateInputResponseShapeV1(request.definition.form, request.response);
    } else if (request.response !== undefined || request.submissionId !== undefined) throw new Error("Unsubmitted request has response data.");
  }
  if (pending + graphPending > 1 || (terminalRun(state) && pending + graphPending)
    || (state.status === "waiting_for_input" && pending + graphPending !== 1)) {
    throw new Error("Run has inconsistent pending requests.");
  }
  for (const [id, receipt] of Object.entries(state.receipts)) {
    const request = state.requests[receipt.requestId], command = state.commands[receipt.resumeCommandId];
    if (id !== receipt.submissionId || request?.submissionId !== id || !command || command.requestId !== receipt.requestId) throw new Error("Receipt is missing its request or resume intent.");
  }
  for (const [id, command] of Object.entries(state.commands)) {
    const expectedId = `resume-${hashJson({ run: runKey(state.runRef), requestId: command.requestId })}`;
    if (id !== command.id || id !== expectedId || state.requests[command.requestId]?.status !== "submitted") throw new Error("Resume intent has no accepted response.");
    if ((command.state === "claimed") !== !!command.owner || (command.owner && !sameOwner(state.owner, command.owner))) throw new Error("Resume command ownership differs.");
  }
  return state;
}

export class InputControlConflict extends Error {
  constructor(readonly code: "not-found" | "binding-mismatch" | "stale-owner" | "stale-revision" | "submission-reused" | "upload-reused" | "request-closed" | "run-closed" | "owner-active" | "missing-build") { super(code); }
}
export interface StoredInputSubmissionV1 { submissionId: string; expectedRevision: number; response: InputResponseV1 }
export interface InputControlStoreV1 {
  read(runRef: RunRef): Promise<RetainedRunControlV1 | undefined>;
  submit(runRef: RunRef, requestId: string, body: StoredInputSubmissionV1, responderId: string,
    validate: (request: InputRequestV1, response: InputResponseV1) => Promise<InputResponseV1>): Promise<InputSubmissionReceiptV1>;
}
