// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { cleanup, screen } from "@testing-library/react";
import { renderWithToaster as render } from "./renderWithToaster.tsx";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserApiClient } from "../../apps/packages/user/contract/src/index.ts";
import { UserFeature } from "../../apps/packages/user/react/src/index.ts";

const timestamp = "2026-08-05T12:00:00.000Z";

afterEach(cleanup);

describe("User React feature", () => {
  it("registers the current server identity without identity inputs", async () => {
    renderWithQueries(<UserFeature client={clientForApi()} />);
    expect(screen.queryByLabelText(/provider/i)).toBeNull();
    expect(screen.queryByLabelText(/subject/i)).toBeNull();
    await userEvent.type(screen.getByLabelText("Requested user ID"), "current-user");
    await userEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(await screen.findByText("current-user", { selector: "strong" })).toBeTruthy();
  });

  it("shows conflicts and administers status through server-backed mutations", async () => {
    const state = { users: [user("user-a", "active"), user("user-b", "disabled")] };
    renderWithQueries(<UserFeature client={clientForApi(state)} />);
    expect(await screen.findByRole("table", { name: "Execution platform users" })).toBeTruthy();
    expect(screen.getByText("user-a")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    expect(await screen.findAllByText("disabled")).toHaveLength(2);

    await userEvent.type(screen.getByLabelText("Requested user ID"), "conflicting-user");
    await userEvent.click(screen.getByRole("button", { name: "Register" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Identity is already registered");
  });
});

function renderWithQueries(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
}

function clientForApi(state = { users: [user("user-a", "active"), user("user-b", "disabled")] }): UserApiClient {
  return new UserApiClient({
    baseUrl: "http://users.test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/users" && (init?.method ?? "GET") === "GET") {
        return json({ items: state.users, pagination: {} });
      }
      if (url.pathname === "/api/v1/users/me/registration") {
        const request = JSON.parse(String(init?.body)) as { requestedUserId?: string };
        if (request.requestedUserId === "conflicting-user") {
          return json({ error: { code: "conflict", message: "Identity is already registered." } }, 409);
        }
        return json({ user: user(request.requestedUserId ?? "generated-user", "active") });
      }
      const statusMatch = /^\/api\/v1\/users\/([^/]+)\/status$/.exec(url.pathname);
      if (statusMatch) {
        const request = JSON.parse(String(init?.body)) as { status: "active" | "disabled" };
        state.users = state.users.map((candidate) => candidate.userId === statusMatch[1]
          ? { ...candidate, status: request.status }
          : candidate);
        return json({ user: state.users.find(({ userId }) => userId === statusMatch[1]) });
      }
      return json({ error: { code: "not-found", message: `No fixture for ${url.pathname}.` } }, 404);
    },
  });
}

function user(userId: string, status: "active" | "disabled") {
  return {
    schemaVersion: 1 as const,
    userId,
    status,
    identity: { providerId: "local-cli", subjectId: `${userId}-subject` },
    registeredAt: timestamp,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
