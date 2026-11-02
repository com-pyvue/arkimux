// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { cleanup, screen, within } from "@testing-library/react";
import { renderWithToaster as render } from "./renderWithToaster.tsx";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RoleApiClient } from "../../apps/packages/role/contract/src/index.ts";
import { RoleFeature } from "../../apps/packages/role/react/src/index.ts";

afterEach(cleanup);

describe("Role React feature", () => {
  it("defines an immutable role and reports definition conflicts", async () => {
    renderWithQueries(<RoleFeature client={clientForApi()} />);
    expect(await screen.findByRole("table", { name: "Execution platform roles" })).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Role ID"), "observer-v1");
    await userEvent.type(screen.getByLabelText("Permissions"), "runs:read-own, runs:read-own workflow:fixture:start");
    await userEvent.click(screen.getByRole("button", { name: "Define role" }));
    expect(await screen.findByText("observer-v1", { selector: "strong" })).toBeTruthy();
    expect(await screen.findByText("runs:read-own, workflow:fixture:start")).toBeTruthy();

    await userEvent.clear(screen.getByLabelText("Permissions"));
    await userEvent.type(screen.getByLabelText("Permissions"), "runs:read-all");
    await userEvent.click(screen.getByRole("button", { name: "Define role" }));
    expect((await screen.findByRole("alert")).textContent).toContain("immutable");
  });

  it("assigns, filters, and revokes roles", async () => {
    renderWithQueries(<RoleFeature client={clientForApi()} />);
    await screen.findByRole("table", { name: "Role assignments" });
    await userEvent.type(screen.getByLabelText("Assignment user ID"), "user-b");
    await userEvent.type(screen.getByLabelText("Assignment role ID"), "reader-v1");
    await userEvent.click(screen.getByRole("button", { name: "Assign role" }));
    expect(await screen.findByText("Assigned reader-v1 to user-b.")).toBeTruthy();
    const assignmentTable = screen.getByRole("table", { name: "Role assignments" });
    expect(within(assignmentTable).getByText("user-b")).toBeTruthy();
    await userEvent.click(within(assignmentTable).getAllByRole("button", { name: "Revoke" }).at(-1)!);
    await expectElementToDisappear(() => within(assignmentTable).queryByText("user-b"));
  });
});

function renderWithQueries(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

function clientForApi(): RoleApiClient {
  const state = {
    roles: [{ schemaVersion: 1 as const, roleId: "reader-v1", permissions: ["runs:read-own"] }],
    assignments: [{ userId: "user-a", roleId: "reader-v1" }],
  };
  return new RoleApiClient({
    baseUrl: "http://roles.test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/roles" && (init?.method ?? "GET") === "GET") {
        return json({ items: state.roles, pagination: {} });
      }
      if (url.pathname === "/api/v1/roles" && init?.method === "POST") {
        const request = JSON.parse(String(init.body)) as { roleId: string; permissions: string[] };
        const existing = state.roles.find(({ roleId }) => roleId === request.roleId);
        const permissions = [...new Set(request.permissions)].sort();
        if (existing && JSON.stringify(existing.permissions) !== JSON.stringify(permissions)) {
          return json({ error: { code: "conflict", message: `Role ${request.roleId} is immutable.` } }, 409);
        }
        const role = existing ?? { schemaVersion: 1 as const, roleId: request.roleId, permissions };
        if (!existing) state.roles.push(role);
        return json({ role });
      }
      if (url.pathname === "/api/v1/role-assignments" && (init?.method ?? "GET") === "GET") {
        const items = state.assignments.filter((assignment) => (
          (!url.searchParams.get("userId") || assignment.userId === url.searchParams.get("userId"))
          && (!url.searchParams.get("roleId") || assignment.roleId === url.searchParams.get("roleId"))
        ));
        return json({ items, pagination: {} });
      }
      if (url.pathname === "/api/v1/role-assignments" && init?.method === "POST") {
        const assignment = JSON.parse(String(init.body)) as { userId: string; roleId: string };
        if (!state.assignments.some((candidate) => candidate.userId === assignment.userId && candidate.roleId === assignment.roleId)) {
          state.assignments.push(assignment);
        }
        return json({ assignment });
      }
      const revokeMatch = /^\/api\/v1\/role-assignments\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (revokeMatch && init?.method === "DELETE") {
        const assignment = { userId: decodeURIComponent(revokeMatch[1]!), roleId: decodeURIComponent(revokeMatch[2]!) };
        const index = state.assignments.findIndex((candidate) => candidate.userId === assignment.userId && candidate.roleId === assignment.roleId);
        const revoked = index >= 0;
        if (revoked) state.assignments.splice(index, 1);
        return json({ assignment, revoked });
      }
      return json({ error: { code: "not-found", message: `No fixture for ${url.pathname}.` } }, 404);
    },
  });
}

async function expectElementToDisappear(query: () => Element | null): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (query() === null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(query()).toBeNull();
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
