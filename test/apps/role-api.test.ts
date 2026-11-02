import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AuthorizedApplicationPrincipal } from "../../apps/packages/application-host/src/index.ts";
import {
  createRoleRouter,
  RoleApplicationService,
} from "../../apps/packages/role/api/src/index.ts";
import { RoleApiClient } from "../../apps/packages/role/contract/src/index.ts";
import {
  FileRoleAssignmentStore,
  FileRoleStore,
  FileUserStore,
} from "@com-pyvue/agent-execution-core";

const registeredAt = "2026-08-05T12:00:00.000Z";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "role-api-"));
  const users = new FileUserStore(root);
  const roles = new FileRoleStore(root);
  const assignments = new FileRoleAssignmentStore(root);
  for (const userId of ["admin", "user-a", "user-b"]) {
    await users.register({
      userId,
      identity: { providerId: "fixture", subjectId: userId },
      registeredAt,
    });
  }
  const router = createRoleRouter({
    service: new RoleApplicationService(users, roles, assignments),
    authenticate: async (request) => request.headers.get("x-principal") === "admin"
      ? principal("admin", ["roles:admin"])
      : principal("reader", ["runs:read-own"]),
  });
  const client = (admin = true) => new RoleApiClient({
    baseUrl: "http://roles.test",
    requestInit: () => ({ headers: admin ? { "x-principal": "admin" } : {} }),
    fetch: (input, init) => router.request(input, init),
  });
  return { roles, assignments, router, client };
}

describe("Role API administration", () => {
  it("requires roles:admin for every role and assignment operation", async () => {
    const test = await fixture();
    const reader = test.client(false);
    await expect(reader.listRoles()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(reader.listAssignments()).rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(reader.defineRole({ roleId: "reader-v1", permissions: ["runs:read-own"] }))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
    await expect(reader.assignRole({ userId: "user-a", roleId: "reader-v1" }))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("defines normalized immutable roles idempotently and paginates them", async () => {
    const test = await fixture();
    const admin = test.client();
    const first = await admin.defineRole({
      roleId: "reader-v1",
      permissions: ["workflow:fixture:start", "runs:read-own", "runs:read-own"],
    });
    expect(first.role.permissions).toEqual(["runs:read-own", "workflow:fixture:start"]);
    await expect(admin.defineRole({
      roleId: "reader-v1",
      permissions: ["runs:read-own", "workflow:fixture:start"],
    })).resolves.toEqual(first);
    await expect(admin.defineRole({ roleId: "reader-v1", permissions: ["runs:read-all"] }))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
    await admin.defineRole({ roleId: "runner-v1", permissions: ["workflow:fixture:start"] });
    const firstPage = await admin.listRoles({ pageSize: 1 });
    expect(firstPage.items.map(({ roleId }) => roleId)).toEqual(["reader-v1"]);
    expect(firstPage.pagination.nextCursor).toBe("reader-v1");
    await expect(admin.listRoles({ pageSize: 1, cursor: firstPage.pagination.nextCursor }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ roleId: "runner-v1" })] });
    await expect(admin.getRole("missing-v1")).rejects.toMatchObject({ status: 404, code: "not-found" });
  });

  it("assigns existing targets idempotently, filters assignments, and revokes idempotently", async () => {
    const test = await fixture();
    const admin = test.client();
    await admin.defineRole({ roleId: "reader-v1", permissions: ["runs:read-own"] });
    await expect(admin.assignRole({ userId: "missing-user", roleId: "reader-v1" }))
      .rejects.toMatchObject({ status: 404, code: "not-found" });
    await expect(admin.assignRole({ userId: "user-a", roleId: "missing-role" }))
      .rejects.toMatchObject({ status: 404, code: "not-found" });
    await admin.assignRole({ userId: "user-a", roleId: "reader-v1" });
    await expect(admin.assignRole({ userId: "user-a", roleId: "reader-v1" })).resolves.toMatchObject({
      assignment: { userId: "user-a", roleId: "reader-v1" },
    });
    await admin.assignRole({ userId: "user-b", roleId: "reader-v1" });
    await expect(admin.listAssignments({ userId: "user-a" })).resolves.toMatchObject({
      items: [{ userId: "user-a", roleId: "reader-v1" }],
    });
    await expect(admin.revokeRole("user-a", "reader-v1")).resolves.toMatchObject({ revoked: true });
    await expect(admin.revokeRole("user-a", "reader-v1")).resolves.toMatchObject({ revoked: false });
  });

  it("does not let the authenticated administrator revoke its own assignment", async () => {
    const test = await fixture();
    const admin = test.client();
    await admin.defineRole({ roleId: "admin-v1", permissions: ["roles:admin"] });
    await test.assignments.assign("admin", "admin-v1");
    await expect(admin.revokeRole("admin", "admin-v1"))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(await test.assignments.isAssigned("admin", "admin-v1")).toBe(true);
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
