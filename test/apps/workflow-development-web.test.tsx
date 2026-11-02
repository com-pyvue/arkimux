// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowDevelopmentWebApp } from "../../apps/packages/workflow-development-web/src/index.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("workflow development web composition", () => {
  it("keeps a submitted workflow in its own Runs tab when the URL selects it", async () => {
    window.history.replaceState({}, "", "/workflows/vendor-evaluation/1?tab=runs");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/ui-configuration")) return Response.json({ schemaVersion: 1, profile: "workflow-development", features: ["runs", "agent-authentication", "agent-templates", "workflows"] });
      if (url.pathname.endsWith("/agent-auth-providers/metadata")) return Response.json({ credentialPresets: [], authProviderPresets: [] });
      if (url.pathname === "/api/v1/workflows") return Response.json({ items: [{ workflow: { kind: "vendor-evaluation", version: 1 }, title: "vendor-evaluation", inputExample: {}, agentSlots: [], allowedRoleIds: ["local-developer"] }] });
      if (url.pathname.includes("/run-configurations") || url.pathname.endsWith("/runs") || url.pathname.endsWith("/runs/filter-options")) return Response.json({ items: [], pagination: {}, providers: [], models: [], numericFields: [] });
      return Response.json({ error: { code: "not-found", message: "Unexpected fixture request." } }, { status: 404 });
    }));

    render(<WorkflowDevelopmentWebApp apiBaseUrl="http://127.0.0.1:8787" resultPlugins={[]} />);

    expect(await screen.findByRole("heading", { name: "vendor-evaluation", level: 1 })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Runs" }).getAttribute("aria-selected")).toBe("true");
    expect(window.location.pathname).toBe("/workflows/vendor-evaluation/1");
    expect(window.location.search).toBe("?tab=runs");
  });

  it("opens the selected workflow's Run Configurations tab through the real app navigation", async () => {
    window.history.replaceState({}, "", "/connections");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname.endsWith("/ui-configuration")) return Response.json({ schemaVersion: 1, profile: "workflow-development", features: ["runs", "agent-authentication", "agent-templates", "workflows"] });
      if (url.pathname.endsWith("/agent-auth-providers/metadata")) return Response.json({ credentialPresets: [], authProviderPresets: [] });
      if (url.pathname.endsWith("/editor-metadata")) return Response.json({ executionProviders: [] });
      if (url.pathname === "/api/v1/workflows") return Response.json({ items: ["weather-advisor", "vendor-evaluation"].map(kind => ({ workflow: { kind, version: 1 }, title: kind, inputExample: {}, agentSlots: [], allowedRoleIds: ["local-developer"] })) });
      if (url.pathname.includes("/run-configurations") || url.pathname.includes("/agent-auth-providers") || url.pathname.includes("/agent-credentials") || url.pathname.includes("/agent-templates")) return Response.json({ items: [], pagination: {} });
      return Response.json({ error: { code: "not-found", message: "Unexpected fixture request." } }, { status: 404 });
    }));
    render(<WorkflowDevelopmentWebApp apiBaseUrl="http://127.0.0.1:8787" resultPlugins={[]} />);
    await userEvent.click(await screen.findByRole("link", { name: "Workflows" }));
    const vendorCard = (await screen.findByText("vendor-evaluation", { selector: "h2" })).parentElement!.parentElement!;
    await userEvent.click(within(vendorCard).getByRole("button", { name: "Open workflow" }));
    expect(await screen.findByRole("heading", { name: "vendor-evaluation", level: 1 })).toBeTruthy();
    expect(window.location.pathname).toBe("/workflows/vendor-evaluation/1");
    expect(screen.getByRole("tab", { name: "Run Configurations" }).getAttribute("aria-selected")).toBe("true");
    await screen.findByText("Create a Run Configuration before invoking this workflow.");
    expect(requests.some(request => request.includes("/workflows/vendor-evaluation/1/run-configurations"))).toBe(true);
    expect(requests.some(request => request.includes("/workflows/weather-advisor/1/run-configurations"))).toBe(false);
    await userEvent.click(screen.getByRole("link", { name: /Back to workflows/ }));
    expect(await screen.findByRole("heading", { name: "Workflows", level: 1 })).toBeTruthy();
    expect(requests.every(request => request.startsWith("GET "))).toBe(true);
  });

  it("loads the server-owned UI profile and opens Connections without a probe", async () => {
    window.history.replaceState({}, "", "/");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/api/v1/ui-configuration")) {
        return Response.json({
          schemaVersion: 1,
          profile: "workflow-development",
          features: ["runs", "agent-authentication", "agent-templates", "workflows"],
        });
      }
      if (url.includes("/api/v1/agent-auth-providers/metadata")) {
        return Response.json({ credentialPresets: [], authProviderPresets: [] });
      }
      if (url.includes("/api/v1/agent-auth-providers") || url.includes("/api/v1/agent-credentials")) {
        return Response.json({ items: [], pagination: {} });
      }
      return Response.json({ error: { code: "not-found", message: "Not found." } }, { status: 404 });
    }));

    render(<WorkflowDevelopmentWebApp
      apiBaseUrl="http://127.0.0.1:8787"
      resultPlugins={[]}
    />);

    expect(await screen.findByRole("navigation", { name: "Agent execution applications" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Runs" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Agent Templates" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connections" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Authentication" })).toBeNull();
    expect(screen.getByRole("link", { name: "Workflows" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Connections", level: 1 })).toBeTruthy();
    expect(await screen.findByText("No connections are available.")).toBeTruthy();
    expect(requests).toContain("GET http://127.0.0.1:8787/api/v1/ui-configuration");
    expect(requests.every((request) => request.startsWith("GET ") && !request.includes("/probe"))).toBe(true);
  });
});
