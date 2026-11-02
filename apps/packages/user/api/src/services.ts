import {
  ApplicationBoundaryError,
  requireApplicationPermission,
  type AuthenticatedIdentity,
  type AuthorizedApplicationPrincipal,
} from "@com-pyvue/agent-execution-application-host";
import {
  registerCurrentUserRequestSchema,
  registerCurrentUserResponseSchema,
  setUserStatusRequestSchema,
  setUserStatusResponseSchema,
  userDetailResponseSchema,
  userListQuerySchema,
  userListResponseSchema,
  type RegisterCurrentUserRequestDto,
  type RegisterCurrentUserResponseDto,
  type SetUserStatusRequestDto,
  type SetUserStatusResponseDto,
  type UserDetailResponseDto,
  type UserListQueryDto,
  type UserListResponseDto,
} from "@com-pyvue/agent-execution-user-contract";
import {
  UserRegistrationConflictError,
  UserRegistrationService,
  type UserStore,
} from "@com-pyvue/agent-execution-core";

export class UserApplicationService {
  readonly #registration: UserRegistrationService;

  constructor(private readonly users: UserStore) {
    this.#registration = new UserRegistrationService(users);
  }

  async registerCurrent(
    identity: AuthenticatedIdentity,
    input: RegisterCurrentUserRequestDto,
  ): Promise<RegisterCurrentUserResponseDto> {
    const request = registerCurrentUserRequestSchema.parse(input);
    try {
      const user = await this.#registration.register({
        ...request,
        identity,
      });
      return registerCurrentUserResponseSchema.parse({ user });
    } catch (error) {
      if (error instanceof UserRegistrationConflictError) {
        throw new ApplicationBoundaryError("conflict", 409, error.message);
      }
      throw error;
    }
  }

  async list(
    principal: AuthorizedApplicationPrincipal,
    input: UserListQueryDto,
  ): Promise<UserListResponseDto> {
    requireUserAdministration(principal);
    const query = userListQuerySchema.parse(input);
    const page = await this.users.list(query);
    return userListResponseSchema.parse({
      items: page.items,
      pagination: page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
    });
  }

  async get(
    principal: AuthorizedApplicationPrincipal,
    userId: string,
  ): Promise<UserDetailResponseDto> {
    requireUserAdministration(principal);
    const user = await this.users.get(userId);
    if (!user) throw new ApplicationBoundaryError("not-found", 404, `User ${userId} does not exist.`);
    return userDetailResponseSchema.parse({ user });
  }

  async setStatus(
    principal: AuthorizedApplicationPrincipal,
    userId: string,
    input: SetUserStatusRequestDto,
  ): Promise<SetUserStatusResponseDto> {
    requireUserAdministration(principal);
    const request = setUserStatusRequestSchema.parse(input);
    if (userId === principal.user.userId && request.status === "disabled") {
      throw new ApplicationBoundaryError("conflict", 409, "The current authenticated user cannot disable itself.");
    }
    if (!await this.users.get(userId)) {
      throw new ApplicationBoundaryError("not-found", 404, `User ${userId} does not exist.`);
    }
    await this.users.setStatus(userId, request.status);
    const user = await this.users.get(userId);
    if (!user) throw new Error(`User ${userId} disappeared after its status changed.`);
    return setUserStatusResponseSchema.parse({ user });
  }
}

function requireUserAdministration(principal: AuthorizedApplicationPrincipal): void {
  requireApplicationPermission(principal, "users:admin");
}
