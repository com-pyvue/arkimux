import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  NewUser,
  Page,
  UserListQuery,
  UserStore,
} from "../../application/platformStore.ts";
import { UserRegistrationConflictError } from "../../application/userAdministration.ts";
import { assertSafeIdentifier } from "../../domain/identifiers.ts";
import {
  validateExternalIdentity,
  validateUser,
  type User,
  type UserStatus,
} from "../../domain/user.ts";
import { isRecord } from "../../domain/validation.ts";
import { readJson, replaceJson, writeJsonExclusive } from "./filePlatformStoreSupport.ts";
import { pageByKey } from "./filePagination.ts";

export { UserRegistrationConflictError } from "../../application/userAdministration.ts";

export class FileUserStore implements UserStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async register(input: NewUser): Promise<User> {
    const user = validateNewUser(input);
    const identityPath = this.identityPath(user.identity.providerId, user.identity.subjectId);
    const claimed = await writeJsonExclusive(identityPath, { userId: user.userId });
    if (!claimed) {
      const mappedUserId = validateIdentityBinding(await readJson(identityPath));
      if (mappedUserId !== user.userId) {
        throw new UserRegistrationConflictError(
          `External identity is already bound to user ${mappedUserId}.`,
        );
      }
      const existing = await this.get(mappedUserId);
      if (existing) return assertSameRegistration(existing, user);
    }

    const created = await writeJsonExclusive(this.userPath(user.userId), user);
    if (created) return user;
    const existing = await this.get(user.userId);
    if (!existing) throw new Error(`User ${user.userId} could not be read after a concurrent registration.`);
    try {
      return assertSameRegistration(existing, user);
    } catch (error) {
      if (claimed) await fs.rm(identityPath, { force: true });
      throw error;
    }
  }

  async get(userId: string): Promise<User | undefined> {
    assertSafeIdentifier(userId, "User ID");
    const value = await readJson(this.userPath(userId));
    return value === undefined ? undefined : validateUser(value);
  }

  async findByIdentity(providerId: string, subjectId: string): Promise<User | undefined> {
    const identity = validateExternalIdentity({ providerId, subjectId });
    const value = await readJson(this.identityPath(identity.providerId, identity.subjectId));
    if (value === undefined) return undefined;
    return this.get(validateIdentityBinding(value));
  }

  async setStatus(userId: string, status: UserStatus): Promise<void> {
    if (status !== "active" && status !== "disabled") throw new Error("User status must be active or disabled.");
    const existing = await this.get(userId);
    if (!existing) throw new Error(`User ${userId} does not exist.`);
    await replaceJson(this.userPath(userId), { ...existing, status });
  }

  async list(query: UserListQuery = {}): Promise<Page<User>> {
    const users = await readJsonDirectory(path.join(this.root, "users"), validateUser);
    return pageByKey(
      query.status === undefined ? users : users.filter((user) => user.status === query.status),
      (user) => user.userId,
      query,
    );
  }

  private userPath(userId: string): string {
    return path.join(this.root, "users", `${userId}.json`);
  }

  private identityPath(providerId: string, subjectId: string): string {
    const digest = createHash("sha256").update(`${providerId}\0${subjectId}`).digest("hex");
    return path.join(this.root, "identities", `${digest}.json`);
  }
}

async function readJsonDirectory<T>(directory: string, validate: (value: unknown) => T): Promise<T[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    const value = await readJson(path.join(directory, name));
    if (value === undefined) throw new Error(`User record disappeared while listing: ${name}.`);
    return validate(value);
  }));
}

function validateNewUser(input: NewUser): User {
  return validateUser({
    schemaVersion: 1,
    userId: input.userId,
    status: "active",
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    identity: input.identity,
    registeredAt: input.registeredAt,
  });
}

function validateIdentityBinding(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !("userId" in value)) {
    throw new Error("User identity binding must contain exactly userId.");
  }
  assertSafeIdentifier(value.userId, "User identity binding.userId");
  return value.userId;
}

function assertSameRegistration(existing: User, requested: User): User {
  const comparableExisting = { ...existing, status: "active" as const };
  if (JSON.stringify(comparableExisting) !== JSON.stringify(requested)) {
    throw new UserRegistrationConflictError(`User ${requested.userId} already exists with different registration data.`);
  }
  return existing;
}
