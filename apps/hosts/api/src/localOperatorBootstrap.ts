import {
  RoleAssignmentService,
  UserRegistrationService,
  assertSafeIdentifier,
  defineRole,
  normalizePermissions,
  validateWorkflowIdentity,
  type Permission,
  type Role,
  type RoleAssignment,
  type RoleAssignmentStore,
  type RoleStore,
  type UserStore,
  type WorkflowIdentity,
} from "@com-pyvue/agent-execution-core";
import { CodedWorkflowRegistry } from "@com-pyvue/agent-execution-run-api";
import { composeLocalFilesystemAgentExecutionApplication } from "./localFilesystemHost.ts";
import { localPermissionPreset, localPermissionPresets, localRolePreset } from "./localRolePresets.ts";
import { parseLocalFilesystemRuntimePaths, value, values } from "./localFilesystemRuntime.ts";

export interface LocalWorkflowPermissionStores {
  users: Pick<UserStore, "get">;
  roles: RoleStore;
  roleAssignments: RoleAssignmentStore;
}

/** Safe to present at the Local boundary; the cause remains internal. */
export class LocalWorkflowPermissionTransitionError extends Error {
  constructor(readonly restartRequired: boolean, cause: unknown) {
    super(restartRequired
      ? "Local workflow permissions could not be restored. Restart the Local server before continuing."
      : "Local workflow permissions could not be updated. Previous workflows remain available.", { cause });
    this.name = "LocalWorkflowPermissionTransitionError";
  }
}

/**
 * Caller must gate authorization-sensitive requests until this operation completes.
 * Call before listening at startup too: the desired family replaces any assignments
 * left by an interrupted transition. This never creates, enables, or edits a user.
 */
export async function reconcileLocalWorkflowPermissions(
  stores: LocalWorkflowPermissionStores,
  workflows: readonly WorkflowIdentity[],
  afterAssignment?: (roleId: string) => Promise<void>,
): Promise<{ roleId: string }> {
  const userId = "local-developer";
  const roleFamily = "arkimux-workflow-developer";
  const permissions = normalizePermissions([
    ...localPermissionPresets["local-workflow-developer"].permissions,
    ...workflows.flatMap((workflow) => {
      const { kind } = validateWorkflowIdentity(workflow);
      return [`workflow:${kind}:start`, `workflow:${kind}:configure`];
    }),
  ]);
  let previous: RoleAssignment[];
  let roleId: string;
  try {
    if (!await stores.users.get(userId)) throw new Error("Local developer is not registered.");
    previous = await collectFamilyAssignments(stores.roleAssignments, userId, roleFamily);
    roleId = await resolveRoleFamily(stores.roles, roleFamily, permissions);
  } catch (error) {
    throw new LocalWorkflowPermissionTransitionError(false, error);
  }
  const service = new RoleAssignmentService(stores.users, stores.roles, stores.roleAssignments);
  try {
    await service.assign(userId, roleId);
    for (const assignment of previous) {
      if (assignment.roleId !== roleId) await service.revoke(userId, assignment.roleId);
    }
    const current = await collectFamilyAssignments(stores.roleAssignments, userId, roleFamily);
    if (current.length !== 1 || current[0]!.roleId !== roleId) {
      throw new Error("Local workflow role assignment did not match the selected generation.");
    }
    // The CLI process record is part of this private transition: old generated
    // run helpers must not keep a role whose assignment has just been revoked.
    await afterAssignment?.(roleId);
    return { roleId };
  } catch (error) {
    try {
      await restoreFamilyAssignments(stores.roleAssignments, service, userId, roleFamily, previous);
    } catch (restoreError) {
      throw new LocalWorkflowPermissionTransitionError(true, new AggregateError([error, restoreError]));
    }
    throw new LocalWorkflowPermissionTransitionError((error as { restartRequired?: boolean })?.restartRequired === true, error);
  }
}

async function restoreFamilyAssignments(
  store: RoleAssignmentStore,
  service: RoleAssignmentService,
  userId: string,
  roleFamily: string,
  previous: RoleAssignment[],
): Promise<void> {
  const current = await collectFamilyAssignments(store, userId, roleFamily);
  const expected = new Set(previous.map(({ roleId }) => roleId));
  const observed = new Set(current.map(({ roleId }) => roleId));
  // A storage adapter can throw after persisting a write. Try every restoration
  // and verify the resulting state instead of assuming an exception means no write.
  const failures: unknown[] = [];
  for (const roleId of expected) {
    if (!observed.has(roleId)) {
      try { await service.assign(userId, roleId); } catch (error) { failures.push(error); }
    }
  }
  for (const roleId of observed) {
    if (!expected.has(roleId)) {
      try { await service.revoke(userId, roleId); } catch (error) { failures.push(error); }
    }
  }
  const restored = await collectFamilyAssignments(store, userId, roleFamily);
  if (restored.length !== expected.size || restored.some(({ roleId }) => !expected.has(roleId))) {
    throw new AggregateError(failures, "Local workflow role assignments were not restored.");
  }
}

async function collectFamilyAssignments(
  store: RoleAssignmentStore,
  userId: string,
  roleFamily: string,
): Promise<RoleAssignment[]> {
  const assignments: RoleAssignment[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ userId, pageSize: 500, ...(cursor === undefined ? {} : { cursor }) });
    assignments.push(...page.items.filter(({ roleId }) => roleFamilyVersion(roleId, roleFamily) !== undefined));
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return assignments;
}

export async function bootstrapLocalOperator(
  args: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const runtime = parseLocalFilesystemRuntimePaths(args, cwd, import.meta.url, environment);
  const userId = value(args, "--user-id");
  const requestedRoleId = value(args, "--role-id");
  const roleFamily = value(args, "--role-family");
  const requestedPresetId = value(args, "--role-preset");
  if (!userId) throw new Error("--user-id is required.");
  if ((requestedRoleId === undefined) === (roleFamily === undefined)) {
    throw new Error("Exactly one of --role-id or --role-family is required.");
  }
  const requestedPermissions = values(args, "--permission");
  const requestedPreset = requestedPresetId === undefined
    ? undefined
    : localPermissionPreset(requestedPresetId);
  if (requestedPresetId !== undefined && requestedPreset === undefined) {
    throw new Error(`Unknown local role preset ${requestedPresetId}.`);
  }
  const preset = requestedPreset
    ?? (requestedRoleId === undefined ? undefined : localRolePreset(requestedRoleId));
  const permissions = normalizePermissions(preset ? [...preset.permissions, ...requestedPermissions] : (
    requestedPermissions.length === 0 ? ["runs:read-own"] : requestedPermissions
  ));
  const composed = await composeLocalFilesystemAgentExecutionApplication({
    ...runtime,
    workflows: new CodedWorkflowRegistry(),
    environment: {
      ...environment,
      AGENT_EXECUTION_LOCAL_SUBJECT: runtime.subjectId,
    },
  });
  const user = await new UserRegistrationService(composed.platformStores.users).register({
    requestedUserId: userId,
    ...(value(args, "--display-name") === undefined ? {} : { displayName: value(args, "--display-name") }),
    identity: { providerId: "local-cli", subjectId: runtime.subjectId },
  });
  const roleId = requestedRoleId ?? await resolveRoleFamily(
    composed.platformStores.roles,
    roleFamily!,
    permissions,
  );
  if (requestedRoleId !== undefined) {
    await defineRole(composed.platformStores.roles, { roleId, permissions });
  }
  const assignments = new RoleAssignmentService(
    composed.platformStores.users,
    composed.platformStores.roles,
    composed.platformStores.roleAssignments,
  );
  await assignments.assign(user.userId, roleId);
  if (roleFamily !== undefined) {
    await revokeSupersededFamilyAssignments(
      composed.platformStores.roleAssignments,
      assignments,
      user.userId,
      roleFamily,
      roleId,
    );
  }
  return `Local operator ${user.userId} registered and assigned role ${roleId}.`;
}

async function resolveRoleFamily(
  roles: RoleStore,
  roleFamily: string,
  permissions: Permission[],
): Promise<string> {
  assertSafeIdentifier(roleFamily, "Role family");
  const familyRoles = (await collectRoles(roles))
    .map((role) => ({ role, version: roleFamilyVersion(role.roleId, roleFamily) }))
    .filter((candidate): candidate is { role: Role; version: number } => candidate.version !== undefined)
    .sort((left, right) => right.version - left.version);
  const matching = familyRoles.find(({ role }) => samePermissions(role.permissions, permissions));
  if (matching) return matching.role.roleId;
  const nextVersion = (familyRoles[0]?.version ?? 0) + 1;
  const roleId = `${roleFamily}-v${nextVersion}`;
  await defineRole(roles, { roleId, permissions });
  return roleId;
}

async function revokeSupersededFamilyAssignments(
  store: RoleAssignmentStore,
  service: RoleAssignmentService,
  userId: string,
  roleFamily: string,
  selectedRoleId: string,
): Promise<void> {
  const assignments = await collectFamilyAssignments(store, userId, roleFamily);
  for (const assignment of assignments) {
    if (assignment.roleId !== selectedRoleId) {
      await service.revoke(userId, assignment.roleId);
    }
  }
}

async function collectRoles(roles: RoleStore): Promise<Role[]> {
  const result: Role[] = [];
  let cursor: string | undefined;
  do {
    const page = await roles.list({
      pageSize: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return result;
}

function roleFamilyVersion(roleId: string, roleFamily: string): number | undefined {
  const prefix = `${roleFamily}-v`;
  if (!roleId.startsWith(prefix)) return undefined;
  const version = Number(roleId.slice(prefix.length));
  return Number.isSafeInteger(version) && version >= 1 && String(version) === roleId.slice(prefix.length)
    ? version
    : undefined;
}

function samePermissions(left: Permission[], right: Permission[]): boolean {
  return left.length === right.length && left.every((permission, index) => permission === right[index]);
}
