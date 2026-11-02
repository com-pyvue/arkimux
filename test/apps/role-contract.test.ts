import { describe, expect, it, vi } from "vitest";
import {
  RoleApiClient,
  defineRoleRequestSchema,
  roleAssignmentListResponseSchema,
} from "../../apps/packages/role/contract/src/index.ts";

describe("Role transport contract", () => {
  it("rejects mutable and physical-storage fields", () => {
    expect(() => defineRoleRequestSchema.parse({
      roleId: "reader-v1",
      permissions: ["runs:read-own"],
      replace: true,
    })).toThrow();
    expect(() => roleAssignmentListResponseSchema.parse({
      items: [],
      pagination: {},
      physicalRoot: "/tmp/assignments",
    })).toThrow();
  });

  it("serializes role-assignment filters and validates the response", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/role-assignments");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        userId: "user-a",
        roleId: "reader-v1",
        pageSize: "25",
        cursor: "user-0/reader-v1",
      });
      return json({
        items: [{ userId: "user-a", roleId: "reader-v1" }],
        pagination: {},
      });
    });
    const client = new RoleApiClient({ baseUrl: "https://roles.example/", fetch });
    await expect(client.listAssignments({
      userId: "user-a",
      roleId: "reader-v1",
      pageSize: 25,
      cursor: "user-0/reader-v1",
    })).resolves.toMatchObject({ items: [{ userId: "user-a", roleId: "reader-v1" }] });
  });

  it("binds browser fetch and exposes validated conflicts", async () => {
    let receiver: unknown;
    vi.stubGlobal("fetch", function browserFetch(this: unknown) {
      receiver = this;
      return Promise.resolve(json({ items: [], pagination: {} }));
    });
    await new RoleApiClient({ baseUrl: "https://roles.example" }).listRoles();
    expect(receiver).toBe(globalThis);
    vi.unstubAllGlobals();

    const rejected = new RoleApiClient({
      baseUrl: "https://roles.example",
      fetch: async () => json({ error: { code: "conflict", message: "Role is immutable." } }, 409),
    });
    await expect(rejected.defineRole({ roleId: "reader-v1", permissions: ["runs:read-own"] }))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
