import type {
  RoleAssignmentStore,
  RoleReader,
  RoleStore,
  UserStore,
} from "./platformStore.ts";
import { assertSafeIdentifier } from "../domain/identifiers.ts";
import { normalizePermissions, type Permission } from "../domain/permission.ts";
import type { Role } from "../domain/role.ts";

export class RoleDefinitionConflictError extends Error {
  constructor(readonly roleId: string) {
    super(`Role ${roleId} already exists with different permissions.`);
    this.name = "RoleDefinitionConflictError";
  }
}

export class RoleAssignmentTargetNotFoundError extends Error {
  constructor(readonly target: "user" | "role", readonly targetId: string) {
    super(`${target === "user" ? "User" : "Role"} ${targetId} does not exist.`);
    this.name = "RoleAssignmentTargetNotFoundError";
  }
}

export async function defineRole(
  roles: RoleStore,
  input: { roleId: string; permissions: Permission[] },
): Promise<Role> {
  assertSafeIdentifier(input.roleId, "Role ID");
  const role: Role = {
    schemaVersion: 1,
    roleId: input.roleId,
    permissions: normalizePermissions(input.permissions),
  };
  await roles.create(role);
  return role;
}

export class RoleAssignmentService {
  constructor(
    private readonly users: Pick<UserStore, "get">,
    private readonly roles: RoleReader,
    private readonly assignments: RoleAssignmentStore,
  ) {}

  async assign(userId: string, roleId: string): Promise<void> {
    const user = await this.users.get(userId);
    if (!user) throw new RoleAssignmentTargetNotFoundError("user", userId);
    if (!await this.roles.get(roleId)) throw new RoleAssignmentTargetNotFoundError("role", roleId);
    await this.assignments.assign(userId, roleId);
  }

  async revoke(userId: string, roleId: string): Promise<void> {
    await this.assignments.revoke(userId, roleId);
  }
}
