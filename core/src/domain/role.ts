import { assertSafeIdentifier } from "./identifiers.ts";
import { normalizePermissions, type Permission } from "./permission.ts";
import { assertExactKeys, isRecord } from "./validation.ts";

export interface Role {
  schemaVersion: 1;
  roleId: string;
  permissions: Permission[];
}

export function validateRole(value: unknown): Role {
  if (!isRecord(value)) throw new Error("Role must be an object.");
  assertExactKeys(value, ["schemaVersion", "roleId", "permissions"], "Role");
  if (value.schemaVersion !== 1) throw new Error("Role.schemaVersion must be 1.");
  assertSafeIdentifier(value.roleId, "Role.roleId");
  return {
    schemaVersion: 1,
    roleId: value.roleId,
    permissions: normalizePermissions(value.permissions),
  };
}
