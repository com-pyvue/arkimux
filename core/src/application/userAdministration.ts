import { randomUUID } from "node:crypto";
import type { NewUser, UserStore } from "./platformStore.ts";
import { assertSafeIdentifier } from "../domain/identifiers.ts";
import { validateExternalIdentity, type ExternalIdentity, type User } from "../domain/user.ts";

export interface RegisterUserInput {
  requestedUserId?: string;
  displayName?: string;
  identity: ExternalIdentity;
}

export class UserRegistrationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserRegistrationConflictError";
  }
}

export class UserRegistrationService {
  constructor(
    private readonly users: UserStore,
    private readonly now: () => Date = () => new Date(),
    private readonly generateUserId: () => string = () => `user-${randomUUID()}`,
  ) {}

  async register(input: RegisterUserInput): Promise<User> {
    const identity = validateExternalIdentity(input.identity);
    if (input.requestedUserId !== undefined) {
      assertSafeIdentifier(input.requestedUserId, "Requested user ID");
    }
    const existing = await this.users.findByIdentity(identity.providerId, identity.subjectId);
    if (existing) {
      if (input.requestedUserId !== undefined && input.requestedUserId !== existing.userId) {
        throw new UserRegistrationConflictError(
          `External identity is already registered as user ${existing.userId}.`,
        );
      }
      return existing;
    }
    const userId = input.requestedUserId ?? this.generateUserId();
    assertSafeIdentifier(userId, "Generated user ID");
    const registration: NewUser = {
      userId,
      ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
      identity,
      registeredAt: this.now().toISOString(),
    };
    return this.users.register(registration);
  }

  async setStatus(userId: string, status: "active" | "disabled"): Promise<void> {
    await this.users.setStatus(userId, status);
  }
}
