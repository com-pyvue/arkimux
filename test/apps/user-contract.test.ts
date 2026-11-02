import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UserApiClient,
  registerCurrentUserRequestSchema,
  userListResponseSchema,
} from "../../apps/packages/user/contract/src/index.ts";

afterEach(() => vi.unstubAllGlobals());

describe("User transport contract", () => {
  it("does not accept identity, role, or credential material from registration clients", () => {
    for (const forbidden of [
      { identity: { providerId: "local-cli", subjectId: "supplied" } },
      { roleId: "admin" },
      { password: "secret" },
      { token: "secret" },
    ]) {
      expect(() => registerCurrentUserRequestSchema.parse({ requestedUserId: "operator", ...forbidden })).toThrow();
    }
    expect(() => userListResponseSchema.parse({ items: [], pagination: {}, physicalRoot: "/tmp/users" })).toThrow();
  });

  it("serializes bounded list filters and validates responses", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/api/v1/users");
      expect(url.searchParams.get("status")).toBe("active");
      expect(url.searchParams.get("pageSize")).toBe("25");
      return json({ items: [], pagination: { nextCursor: "25" } });
    });
    const client = new UserApiClient({ baseUrl: "https://users.example/", fetch });
    await expect(client.listUsers({ status: "active", pageSize: 25 })).resolves.toEqual({
      items: [],
      pagination: { nextCursor: "25" },
    });
  });

  it("binds browser fetch and exposes validated conflicts", async () => {
    let receiver: unknown;
    vi.stubGlobal("fetch", function browserFetch(this: unknown) {
      receiver = this;
      return Promise.resolve(json({ items: [], pagination: {} }));
    });
    await new UserApiClient({ baseUrl: "https://users.example" }).listUsers();
    expect(receiver).toBe(globalThis);

    const rejected = new UserApiClient({
      baseUrl: "https://users.example",
      fetch: async () => json({ error: { code: "conflict", message: "Identity is already registered." } }, 409),
    });
    await expect(rejected.registerCurrentUser({ requestedUserId: "other" })).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
