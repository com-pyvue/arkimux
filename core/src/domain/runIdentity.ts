import { assertSafeIdentifier } from "./identifiers.ts";
import { assertExactKeys, isRecord } from "./validation.ts";
import { validateRunActor, type RunActor } from "./runActor.ts";

export interface RunRef {
  executionId: string;
}

export interface RunTargetRef {
  kind: string;
  identity: Record<string, string>;
}

export type RunAttribution =
  | {
      kind: "authenticated";
      actor: RunActor;
    }
  | {
      kind: "legacy-unattributed";
    };

export interface LegacyRunIdentityV1<TCommit> {
  runId: string;
  commit: TCommit;
}

export function validateRunRef(value: unknown): RunRef {
  if (!isRecord(value)) throw new Error("Run reference must be an object.");
  assertExactKeys(value, ["executionId"], "Run reference");
  assertSafeIdentifier(value.executionId, "Run reference.executionId");
  return { executionId: value.executionId };
}

export function validateRunAttribution(value: unknown): RunAttribution {
  if (!isRecord(value)) throw new Error("Run attribution must be an object.");
  if (value.kind === "legacy-unattributed") {
    assertExactKeys(value, ["kind"], "Run attribution");
    return { kind: "legacy-unattributed" };
  }
  if (value.kind === "authenticated") {
    assertExactKeys(value, ["kind", "actor"], "Run attribution");
    return { kind: "authenticated", actor: validateRunActor(value.actor) };
  }
  throw new Error("Run attribution.kind must be authenticated or legacy-unattributed.");
}

export function validateRunTargetRef(value: unknown): RunTargetRef {
  if (!isRecord(value)) throw new Error("Run target must be an object.");
  assertExactKeys(value, ["kind", "identity"], "Run target");
  assertSafeIdentifier(value.kind, "Run target.kind");
  if (!isRecord(value.identity) || Object.keys(value.identity).length === 0) {
    throw new Error("Run target.identity must be a non-empty object.");
  }
  const identity = Object.fromEntries(Object.entries(value.identity).map(([key, item]) => {
    assertSafeIdentifier(key, "Run target.identity key");
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`Run target.identity.${key} must be a non-empty string.`);
    }
    return [key, item];
  }));
  return { kind: value.kind, identity };
}
