import {
  validatePermission,
  type Permission,
  type Role,
  type RoleAssignmentReader,
  type RoleReader,
  type RunCatalogEntry,
  type RunCatalogQuery,
  type RunCatalogStore,
  type RunRef,
  type User,
  type UserStore,
} from "@com-pyvue/agent-execution-core";
import type { ApplicationAuthenticationProvider, AuthenticatedIdentity } from "./adapters.ts";
import { getExternalErrorDiagnostic } from "@com-pyvue/agent-execution-core/internal/application/externalError.ts";

export type ApplicationErrorCode =
  | "authentication-required"
  | "forbidden"
  | "not-found"
  | "conflict"
  | "dispatch-rejected"
  | "provider-unavailable"
  | "invalid-request"
  | "configuration-error"
  | "internal-error";

export class ApplicationBoundaryError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 500 | 503,
    message: string,
  ) {
    super(message);
    this.name = "ApplicationBoundaryError";
  }
}

export interface AuthorizedApplicationPrincipal {
  user: User;
  roles: Role[];
  permissions: Permission[];
}

export async function authenticateExternalIdentity<TRequest>(
  request: TRequest,
  authentication: ApplicationAuthenticationProvider<TRequest>,
): Promise<AuthenticatedIdentity> {
  try {
    return await authentication.authenticate(request);
  } catch (error) {
    throw new ApplicationBoundaryError("authentication-required", 401, (error as Error).message);
  }
}

export async function authenticateApplicationRequest<TRequest>(
  request: TRequest,
  authentication: ApplicationAuthenticationProvider<TRequest>,
  stores: {
    users: Pick<UserStore, "findByIdentity">;
    roles: RoleReader;
    assignments: RoleAssignmentReader;
  },
): Promise<AuthorizedApplicationPrincipal> {
  const identity = await authenticateExternalIdentity(request, authentication);
  const user = await stores.users.findByIdentity(identity.providerId, identity.subjectId);
  if (!user) throw new ApplicationBoundaryError("authentication-required", 401, "Authenticated identity is not registered.");
  if (user.status !== "active") throw new ApplicationBoundaryError("forbidden", 403, `User ${user.userId} is disabled.`);

  const assignments = await collectAssignments(stores.assignments, user.userId);
  const roles = await Promise.all(assignments.map(async ({ roleId }) => {
    const role = await stores.roles.get(roleId);
    if (!role) throw new ApplicationBoundaryError("configuration-error", 500, `Assigned role ${roleId} does not exist.`);
    return role;
  }));
  const permissions = [...new Set(roles.flatMap((role) => role.permissions).map((permission) => (
    validatePermission(permission)
  )))].sort((left, right) => left.localeCompare(right));
  return { user, roles: roles.sort((left, right) => left.roleId.localeCompare(right.roleId)), permissions };
}

export function requireApplicationPermission(
  principal: AuthorizedApplicationPrincipal,
  permission: Permission,
): void {
  validatePermission(permission);
  if (!principal.permissions.includes(permission)) {
    throw new ApplicationBoundaryError("forbidden", 403, `Permission ${permission} is required.`);
  }
}

export function scopeRunCatalogQuery(
  principal: AuthorizedApplicationPrincipal,
  query: RunCatalogQuery,
): RunCatalogQuery {
  if (principal.permissions.includes("runs:read-all")) return { ...query };
  requireApplicationPermission(principal, "runs:read-own");
  if (query.userId !== undefined && query.userId !== principal.user.userId) {
    throw new ApplicationBoundaryError("forbidden", 403, "Cross-user run access requires runs:read-all.");
  }
  return { ...query, userId: principal.user.userId };
}

export async function authorizeRunRef(
  principal: AuthorizedApplicationPrincipal,
  catalog: RunCatalogStore,
  runRef: RunRef,
): Promise<RunCatalogEntry> {
  const entry = await catalog.get(runRef);
  if (!entry) throw new ApplicationBoundaryError("not-found", 404, `Run ${runRef.executionId} does not exist.`);
  if (!principal.permissions.includes("runs:read-all")) {
    if (entry.actor.userId !== principal.user.userId) {
      throw new ApplicationBoundaryError("forbidden", 403, "Cross-user run access requires runs:read-all.");
    }
    requireApplicationPermission(principal, "runs:read-own");
  }
  return entry;
}

export async function openAuthorizedRunStore<TStore>(
  principal: AuthorizedApplicationPrincipal,
  catalog: RunCatalogStore,
  runRef: RunRef,
  open: (authorizedRunRef: RunRef) => Promise<TStore>,
): Promise<TStore> {
  const entry = await authorizeRunRef(principal, catalog, runRef);
  return open(entry.runRef);
}

export function toApplicationBoundaryError(error: unknown): ApplicationBoundaryError {
  if (error instanceof ApplicationBoundaryError) return error;
  const diagnostic = getExternalErrorDiagnostic(error);
  if (diagnostic) return new ApplicationBoundaryError(diagnostic.code ?? "provider-unavailable", 503, diagnostic.message);
  return new ApplicationBoundaryError("internal-error", 500, "The request could not be completed. Please try again.");
}

async function collectAssignments(
  assignments: RoleAssignmentReader,
  userId: string,
) {
  const result: { userId: string; roleId: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await assignments.list({ userId, pageSize: 100, ...(cursor === undefined ? {} : { cursor }) });
    result.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return result;
}
