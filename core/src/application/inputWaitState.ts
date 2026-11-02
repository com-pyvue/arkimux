import type { InputRequestV1 } from "./inputWait.ts";
import { inputWaitJsonSnapshot, validateInputRequestV1 } from "./inputWait.ts";
import { record, canonicalTimestamp, safeIdentifier } from "./recordValidation.ts";
import { assertExactKeys } from "../domain/validation.ts";
import { validateRunStateProjection, validateRunStateV5, type RunStatusProjection, type RunStateV5 } from "./runState.ts";

export type InputRequestStatusV1 = "pending" | "submitted" | "cancelled" | "expired";
/** Read projection only, not the conditional storage/response receipt contract. */
export interface InputRequestStateV1 {
  readonly schemaVersion: 1;
  readonly request: InputRequestV1;
  readonly revision: number;
  readonly status: InputRequestStatusV1;
  readonly updatedAt: string;
}
export type RunStatusProjectionV2 = { readonly schemaVersion: 2 } & (RunStatusProjection | {
  readonly kind: "status";
  readonly status: "waiting_for_input" | "resume_queued";
  readonly updatedAt: string;
  readonly requestId: string;
  readonly expiresAt: string;
  readonly activeComputeMs: number;
});
/** Additive state version; original manifest and heartbeat schemas are unchanged. */
export interface RunStateV6 extends Omit<RunStateV5, "status"> {
  readonly schemaVersion: 6;
  readonly status?: RunStatusProjectionV2;
}

export function validateInputRequestStateV1(value: unknown): InputRequestStateV1 {
  const state = record(inputWaitJsonSnapshot(value), "Input request state");
  assertExactKeys(state, ["schemaVersion", "request", "revision", "status", "updatedAt"], "Input request state");
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || (state.revision as number) < 1 ||
    !["pending", "submitted", "cancelled", "expired"].includes(state.status as string)) throw new Error("Input request state version, revision or status is invalid.");
  const request = validateInputRequestV1(state.request);
  canonicalTimestamp(state.updatedAt, "Input request state update");
  const updated = Date.parse(state.updatedAt), expiry = Date.parse(request.expiresAt);
  if (updated < Date.parse(request.createdAt) || (state.status === "submitted" && updated >= expiry) ||
    (state.status === "expired" && updated < expiry)) throw new Error("Input request transition time is invalid.");
  return { ...state, request } as unknown as InputRequestStateV1;
}

export function validateRunStatusProjectionV2(value: unknown): RunStatusProjectionV2 {
  const state = record(inputWaitJsonSnapshot(value), "Run status V2");
  if (state.schemaVersion !== 2) throw new Error("Run status schema version must be 2.");
  if (state.status === "waiting_for_input" || state.status === "resume_queued") {
    assertExactKeys(state, ["schemaVersion", "kind", "status", "updatedAt", "requestId", "expiresAt", "activeComputeMs"], "Run input-wait status");
    if (state.kind !== "status" || !Number.isSafeInteger(state.activeComputeMs) || (state.activeComputeMs as number) < 0) throw new Error("Run input-wait status or spent compute is invalid.");
    safeIdentifier(state.requestId, "Run input request ID");
    canonicalTimestamp(state.updatedAt, "Run status update"); canonicalTimestamp(state.expiresAt, "Input expiry");
    // A queued accepted answer may resume after its submission deadline.
    return structuredClone(state) as unknown as RunStatusProjectionV2;
  }
  const { schemaVersion: _, ...legacy } = state;
  const projection = validateRunStateProjection(legacy);
  if (projection.kind !== "status") throw new Error("Run status V2 cannot contain a heartbeat.");
  return { schemaVersion: 2, ...projection };
}

export function validateRunStateV6(value: unknown): RunStateV6 {
  const state = record(inputWaitJsonSnapshot(value), "Run state V6");
  assertExactKeys(state, ["schemaVersion", "manifest"], "Run state V6", ["schemaVersion", "manifest", "status", "heartbeat"]);
  if (state.schemaVersion !== 6) throw new Error("Run state schema version must be 6.");
  const { schemaVersion: _, status, ...legacy } = state;
  const { status: _legacyStatus, ...base } = validateRunStateV5(legacy);
  return { schemaVersion: 6, ...base, ...(status === undefined ? {} : { status: validateRunStatusProjectionV2(status) }) };
}
