import { assertSafeIdentifier } from "./identifiers.ts";
import { assertExactKeys, isRecord } from "./validation.ts";

export interface RunActor {
  userId: string;
  roleId: string;
}

export function validateRunActor(value: unknown): RunActor {
  if (!isRecord(value)) throw new Error("Run actor must be an object.");
  assertExactKeys(value, ["userId", "roleId"], "Run actor");
  assertSafeIdentifier(value.userId, "Run actor.userId");
  assertSafeIdentifier(value.roleId, "Run actor.roleId");
  return { userId: value.userId, roleId: value.roleId };
}
