import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ApplicationBoundaryError,
  type AuthorizedApplicationPrincipal,
} from "../../apps/packages/application-host/src/index.ts";
import {
  createUserRouter,
  UserApplicationService,
} from "../../apps/packages/user/api/src/index.ts";
import {
  UserApiClient,
} from "../../apps/packages/user/contract/src/index.ts";
import { FileUserStore } from "@com-pyvue/agent-execution-core";

const registeredAt = "2026-08-05T12:00:00.000Z";

async function fixture() {
  const store = new FileUserStore(await mkdtemp(path.join(os.tmpdir(), "user-api-")));
  const router = createUserRouter({
    service: new UserApplicationService(store),
    identify: async (request) => {
      const subjectId = request.headers.get("x-subject");
      if (!subjectId) throw new ApplicationBoundaryError("authentication-required", 401, "Subject is required.");
      return { providerId: "local-cli", subjectId };
    },
    authenticate: async (request) => request.headers.get("x-principal") === "admin"
      ? principal("admin", ["users:admin"])
      : principal("reader", ["runs:read-own"]),
  });
  const client = (subjectId: string, admin = false) => new UserApiClient({
    baseUrl: "http://users.test",
    requestInit: () => ({ headers: { "x-subject": subjectId, ...(admin ? { "x-principal": "admin" } : {}) } }),
    fetch: (input, init) => router.request(input, init),
  });
  return { store, router, client };
}

describe("User API registration", () => {
  it("registers the server-derived identity idempotently and reports identity conflicts", async () => {
    const test = await fixture();
    const subject = test.client("subject-a");
    const first = await subject.registerCurrentUser({ requestedUserId: "user-a", displayName: "User A" });
    const second = await subject.registerCurrentUser({ requestedUserId: "user-a", displayName: "Ignored on idempotent read" });
    expect(first.user).toMatchObject({
      userId: "user-a",
      identity: { providerId: "local-cli", subjectId: "subject-a" },
    });
    expect(second.user).toEqual(first.user);
    await expect(subject.registerCurrentUser({ requestedUserId: "other-user" })).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
    await expect(test.client("subject-b").registerCurrentUser({ requestedUserId: "user-a" }))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
  });

  it("rejects client-supplied identity fields", async () => {
    const test = await fixture();
    const response = await test.router.request("http://users.test/api/v1/users/me/registration", {
      method: "POST",
      headers: { "content-type": "application/json", "x-subject": "subject-a" },
      body: JSON.stringify({
        requestedUserId: "user-a",
        identity: { providerId: "attacker", subjectId: "attacker" },
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe("User API administration", () => {
  it("requires users:admin for lookup, listing, and status changes", async () => {
    const test = await fixture();
    await test.client("subject-a").registerCurrentUser({ requestedUserId: "user-a" });
    await expect(test.client("reader").listUsers()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    const admin = test.client("admin-subject", true);
    await expect(admin.getUser("user-a")).resolves.toMatchObject({ user: { userId: "user-a" } });
    await expect(admin.setUserStatus("user-a", { status: "disabled" })).resolves.toMatchObject({
      user: { userId: "user-a", status: "disabled" },
    });
    await expect(admin.setUserStatus("admin", { status: "disabled" })).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
    await expect(admin.getUser("missing-user")).rejects.toMatchObject({ status: 404, code: "not-found" });
  });

  it("paginates and filters users through the store cursor", async () => {
    const test = await fixture();
    for (const userId of ["user-a", "user-b", "user-c"]) {
      await test.client(`subject-${userId}`).registerCurrentUser({ requestedUserId: userId });
    }
    const admin = test.client("admin-subject", true);
    const first = await admin.listUsers({ pageSize: 2 });
    expect(first.items.map(({ userId }) => userId)).toEqual(["user-a", "user-b"]);
    expect(first.pagination.nextCursor).toBe("user-b");
    const second = await admin.listUsers({ pageSize: 2, cursor: first.pagination.nextCursor });
    expect(second.items.map(({ userId }) => userId)).toEqual(["user-c"]);
    await admin.setUserStatus("user-b", { status: "disabled" });
    expect((await admin.listUsers({ status: "disabled" })).items.map(({ userId }) => userId)).toEqual(["user-b"]);
  });
});

function principal(userId: string, permissions: string[]): AuthorizedApplicationPrincipal {
  return {
    user: {
      schemaVersion: 1,
      userId,
      status: "active",
      identity: { providerId: "fixture", subjectId: userId },
      registeredAt,
    },
    roles: [{ schemaVersion: 1, roleId: `${userId}-role`, permissions }],
    permissions,
  };
}
