import { assertSafeIdentifier } from "./identifiers.ts";
import { assertExactKeys, isRecord } from "./validation.ts";

export type UserStatus = "active" | "disabled";

export interface ExternalIdentity {
  providerId: string;
  subjectId: string;
}

export interface User {
  schemaVersion: 1;
  userId: string;
  status: UserStatus;
  displayName?: string;
  identity: ExternalIdentity;
  registeredAt: string;
}

export function validateExternalIdentity(value: unknown): ExternalIdentity {
  if (!isRecord(value)) throw new Error("External identity must be an object.");
  assertExactKeys(value, ["providerId", "subjectId"], "External identity");
  assertSafeIdentifier(value.providerId, "External identity.providerId");
  if (
    typeof value.subjectId !== "string"
    || value.subjectId.length === 0
    || value.subjectId.length > 512
    || /[\u0000-\u001f\u007f]/.test(value.subjectId)
  ) {
    throw new Error("External identity.subjectId must be a non-empty bounded string without control characters.");
  }
  return { providerId: value.providerId, subjectId: value.subjectId };
}

export function validateUser(value: unknown): User {
  if (!isRecord(value)) throw new Error("User must be an object.");
  assertExactKeys(
    value,
    ["schemaVersion", "userId", "status", "identity", "registeredAt"],
    "User",
    ["schemaVersion", "userId", "status", "displayName", "identity", "registeredAt"],
  );
  if (value.schemaVersion !== 1) throw new Error("User.schemaVersion must be 1.");
  assertSafeIdentifier(value.userId, "User.userId");
  if (value.status !== "active" && value.status !== "disabled") {
    throw new Error("User.status must be active or disabled.");
  }
  if (
    value.displayName !== undefined
    && (typeof value.displayName !== "string" || value.displayName.trim().length === 0 || value.displayName.length > 256)
  ) {
    throw new Error("User.displayName must be a non-empty string no longer than 256 characters.");
  }
  if (typeof value.registeredAt !== "string" || !isCanonicalIsoTimestamp(value.registeredAt)) {
    throw new Error("User.registeredAt must be a canonical ISO-8601 timestamp.");
  }
  return {
    schemaVersion: 1,
    userId: value.userId,
    status: value.status,
    ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
    identity: validateExternalIdentity(value.identity),
    registeredAt: value.registeredAt,
  };
}

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
