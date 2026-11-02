import {
  ApplicationBoundaryError,
  requireApplicationPermission,
  type AuthorizedApplicationPrincipal,
} from "@com-pyvue/agent-execution-application-host";
import {
  assignRoleRequestSchema,
  assignRoleResponseSchema,
  defineRoleRequestSchema,
  defineRoleResponseSchema,
  pageQuerySchema,
  revokeRoleResponseSchema,
  roleAssignmentListQuerySchema,
  roleAssignmentListResponseSchema,
  roleDetailResponseSchema,
  roleListResponseSchema,
  type AssignRoleRequestDto,
  type AssignRoleResponseDto,
  type DefineRoleRequestDto,
  type DefineRoleResponseDto,
  type PageQueryDto,
  type RevokeRoleResponseDto,
  type RoleAssignmentListQueryDto,
  type RoleAssignmentListResponseDto,
  type RoleDetailResponseDto,
  type RoleListResponseDto,
} from "@com-pyvue/agent-execution-role-contract";
import {
  RoleAssignmentService,
  RoleAssignmentTargetNotFoundError,
  RoleDefinitionConflictError,
  defineRole,
  type RoleAssignmentStore,
  type RoleStore,
  type UserStore,
} from "@com-pyvue/agent-execution-core";

export class RoleApplicationService {
  readonly #assignmentService: RoleAssignmentService;

  constructor(
    private readonly users: Pick<UserStore, "get">,
    private readonly roles: RoleStore,
    private readonly assignments: RoleAssignmentStore,
  ) {
    this.#assignmentService = new RoleAssignmentService(users, roles, assignments);
  }

  async define(
    principal: AuthorizedApplicationPrincipal,
    input: DefineRoleRequestDto,
  ): Promise<DefineRoleResponseDto> {
    requireRoleAdministration(principal);
    const request = defineRoleRequestSchema.parse(input);
    try {
      return defineRoleResponseSchema.parse({ role: await defineRole(this.roles, request) });
    } catch (error) {
      if (error instanceof RoleDefinitionConflictError) {
        throw new ApplicationBoundaryError("conflict", 409, error.message);
      }
      throw error;
    }
  }

  async listRoles(
    principal: AuthorizedApplicationPrincipal,
    input: PageQueryDto,
  ): Promise<RoleListResponseDto> {
    requireRoleAdministration(principal);
    const page = await this.roles.list(pageQuerySchema.parse(input));
    return roleListResponseSchema.parse({
      items: page.items,
      pagination: page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
    });
  }

  async getRole(
    principal: AuthorizedApplicationPrincipal,
    roleId: string,
  ): Promise<RoleDetailResponseDto> {
    requireRoleAdministration(principal);
    const role = await this.roles.get(roleId);
    if (!role) throw new ApplicationBoundaryError("not-found", 404, `Role ${roleId} does not exist.`);
    return roleDetailResponseSchema.parse({ role });
  }

  async listAssignments(
    principal: AuthorizedApplicationPrincipal,
    input: RoleAssignmentListQueryDto,
  ): Promise<RoleAssignmentListResponseDto> {
    requireRoleAdministration(principal);
    const page = await this.assignments.list(roleAssignmentListQuerySchema.parse(input));
    return roleAssignmentListResponseSchema.parse({
      items: page.items,
      pagination: page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
    });
  }

  async assign(
    principal: AuthorizedApplicationPrincipal,
    input: AssignRoleRequestDto,
  ): Promise<AssignRoleResponseDto> {
    requireRoleAdministration(principal);
    const assignment = assignRoleRequestSchema.parse(input);
    try {
      await this.#assignmentService.assign(assignment.userId, assignment.roleId);
    } catch (error) {
      if (error instanceof RoleAssignmentTargetNotFoundError) {
        throw new ApplicationBoundaryError("not-found", 404, error.message);
      }
      throw error;
    }
    return assignRoleResponseSchema.parse({ assignment });
  }

  async revoke(
    principal: AuthorizedApplicationPrincipal,
    userId: string,
    roleId: string,
  ): Promise<RevokeRoleResponseDto> {
    requireRoleAdministration(principal);
    if (userId === principal.user.userId) {
      throw new ApplicationBoundaryError("conflict", 409, "The current authenticated user cannot revoke its own role assignments.");
    }
    const assignment = assignRoleRequestSchema.parse({ userId, roleId });
    const revoked = await this.assignments.isAssigned(userId, roleId);
    await this.#assignmentService.revoke(userId, roleId);
    return revokeRoleResponseSchema.parse({ assignment, revoked });
  }
}

function requireRoleAdministration(principal: AuthorizedApplicationPrincipal): void {
  requireApplicationPermission(principal, "roles:admin");
}
