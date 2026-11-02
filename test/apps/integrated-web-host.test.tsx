// @vitest-environment jsdom

import axe from "axe-core";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentExecutionWebApp,
  RuntimeConfiguredAgentExecutionWebApp,
} from "../../apps/hosts/web/src/index.tsx";
import { agentExecutionUiConfiguration } from "../../apps/packages/ui-profile/contract/src/index.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  window.history.replaceState({}, "", "/runs");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if ([
      "/api/v1/runs",
      "/api/v1/users",
      "/api/v1/roles",
      "/api/v1/role-assignments",
      "/api/v1/agent-templates",
      "/api/v1/agent-auth-providers",
      "/api/v1/agent-credentials",
      "/api/v1/organizations",
    ].includes(path)) {
      return json({ items: [], pagination: {} });
    }
    if (path === "/api/v1/agent-templates/editor-metadata") {
      return json({ executionProviders: [] });
    }
    if (path === "/api/v1/agent-auth-providers/metadata") {
      return json({ credentialPresets: [], authProviderPresets: [] });
    }
    if (path === "/api/v1/local/privacy") return json(privacyStatus("declined", false));
    if (path === "/api/v1/local/diagnostics") return json({ items: [] });
    if (path === "/api/v1/runs/run-01") return json({ run: {
      runRef: { executionId: "run-01" },
      workflow: { kind: "fixture.workflow", version: 1 },
      actor: { userId: "owner", roleId: "runner" },
      createdAt: "2026-08-05T12:00:00.000Z",
      status: { kind: "status", status: "complete", updatedAt: "2026-08-05T12:00:01.000Z" },
    } });
    return json({ error: { code: "not-found", message: `No fixture for ${path}.` } }, 404);
  }));
});

describe("integrated Agent Execution web host", () => {

  it("exposes an accessible narrow-screen navigation toggle", async () => {
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "fixture" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    const toggle = screen.getByRole("button", { name: "Open menu" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Close menu" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("loads a run detail route directly and returns through browser navigation", async () => {
    window.history.replaceState({}, "", "/runs/run-01");
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "fixture" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    expect(await screen.findByRole("heading", { name: "Run details" })).toBeTruthy();
    expect(await screen.findByText("run-01")).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: /Back to runs/ }));
    expect(await screen.findByRole("heading", { name: "Agent execution runs" })).toBeTruthy();
  });

  it.each(["/", "/authentication"])("starts workflow development on Connections without platform administration from %s", async (path) => {
    window.history.replaceState({}, "", path);
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "fixture" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    expect(await screen.findByRole("heading", { name: "Connections", level: 1 })).toBeTruthy();
    expect(window.location.pathname).toBe("/connections");
    expect(within(screen.getByRole("navigation", { name: "Agent execution applications" })).getAllByRole("link").map((link) => link.textContent)).toEqual(["Connections", "Runs", "Agent Templates", "Workflows", "Settings"]);
    expect(screen.getByRole("link", { name: "Connections" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Runs" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Agent Templates" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Workflows" })).toBeTruthy();
    for (const hidden of ["Authentication", "Run comparison", "Users", "Roles", "Organizations", "Environments"]) {
      expect(screen.queryByRole("link", { name: hidden })).toBeNull();
    }
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Connections", "Credentials"]);
    expect(await screen.findByText("No connections are available.")).toBeTruthy();
    const result = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
    await userEvent.click(screen.getByRole("link", { name: "Runs" }));
    expect(await screen.findByRole("heading", { name: "Agent execution runs" })).toBeTruthy();
  });

  it("loads the UI profile from the server at runtime", async () => {
    window.history.replaceState({}, "", "/");
    const runtimeFetch = vi.fn(async () => json(agentExecutionUiConfiguration("workflow-development")));
    render(<RuntimeConfiguredAgentExecutionWebApp
      apiBaseUrl="http://api.test"
      session={{ cacheKey: "runtime-fixture" }}
      resultPlugins={[]}
      fetch={runtimeFetch}
    />);
    expect(screen.getByRole("heading", { name: "Loading portal…" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Runs" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Connections", level: 1 })).toBeTruthy();
    expect(runtimeFetch).toHaveBeenCalledWith(
      "http://api.test/api/v1/ui-configuration",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps Runs as the local landing page when Connections is not enabled", async () => {
    window.history.replaceState({}, "", "/");
    const configuration = agentExecutionUiConfiguration("workflow-development");
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "fixture" }} resultPlugins={[]} uiConfiguration={{ ...configuration, features: configuration.features.filter((feature) => feature !== "agent-authentication") }} />);
    expect(await screen.findByRole("heading", { name: "Agent execution runs" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Connections" })).toBeNull();
  });

  it("links the first-open and Settings choices to one notice without recording consent on navigation", async () => {
    const requests: Array<{ method: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v1/local/privacy") {
        requests.push({ method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : undefined });
        return json(init?.method === "PUT" ? privacyStatus("undecided", false) : privacyStatus("undecided", true));
      }
      if (url.pathname === "/api/v1/agent-auth-providers") return json({ items: [], pagination: {} });
      if (url.pathname === "/api/v1/agent-credentials") return json({ items: [], pagination: {} });
      if (url.pathname === "/api/v1/agent-auth-providers/metadata") return json({ credentialPresets: [], authProviderPresets: [] });
      return json({ items: [], pagination: {} });
    }));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "privacy" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    expect(await screen.findByRole("heading", { name: "Help improve ArkiMux" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Privacy Notice 2026-09-22-timing-sequence" }).getAttribute("href"))
      .toBe("/settings/privacy/terms");
    expect(screen.getByText(/Share Local setup steps and session timing/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "No" })).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "Privacy Notice 2026-09-22-timing-sequence" }));
    expect(await screen.findByRole("heading", { name: "Local usage Privacy Notice" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Help improve ArkiMux" })).toBeNull();
    expect(screen.getByText(/Configured retention: usage has no automatic expiry, query results 7 days/)).toBeTruthy();
    expect(screen.getByText(/Existing query-result files may still contain that data and are not deleted by this request/)).toBeTruthy();
    expect(screen.getByText(/AWS removal is asynchronous and may take longer/)).toBeTruthy();
    expect(screen.getByText(/separate from the Apache-2.0 licence/)).toBeTruthy();
    expect(requests.filter(request => request.method === "PUT")).toEqual([]);
    await userEvent.click(screen.getByRole("link", { name: /Back to Privacy/ }));
    expect(await screen.findByRole("heading", { name: "Help improve ArkiMux" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Ask later" }));
    expect(screen.queryByRole("heading", { name: "Help improve ArkiMux" })).toBeNull();
    expect(requests.at(-1)).toEqual({ method: "PUT", body: '{"choice":"ask-later"}' });
    expect(requests.filter(request => request.method === "PUT")).toEqual([
      { method: "PUT", body: '{"choice":"ask-later"}' },
    ]);
    await userEvent.click(screen.getByRole("link", { name: "Settings" }));
    expect(await screen.findByRole("heading", { name: "Privacy" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Read the Privacy Notice 2026-09-22-timing-sequence" }).getAttribute("href"))
      .toBe("/settings/privacy/terms");
    expect(screen.getByRole("link", { name: "Open Diagnostics" }).getAttribute("href")).toBe("/settings/diagnostics");
    await userEvent.click(screen.getByRole("link", { name: "Read the Privacy Notice 2026-09-22-timing-sequence" }));
    expect(await screen.findByRole("heading", { name: "Local usage Privacy Notice" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Help improve ArkiMux" })).toBeNull();
    expect(requests.filter(request => request.method === "PUT")).toEqual([
      { method: "PUT", body: '{"choice":"ask-later"}' },
    ]);
  });

  it("updates Settings immediately when the first-open prompt saves Yes", async () => {
    window.history.replaceState({}, "", "/settings/privacy");
    const privacyRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/local/privacy") {
        const method = init?.method ?? "GET";
        privacyRequests.push(method);
        return json(method === "PUT" ? privacyStatus("accepted", false) : privacyStatus("undecided", true));
      }
      return json({ items: [], pagination: {} });
    }));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "privacy-consent" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);

    expect(await screen.findByRole("heading", { name: "Help improve ArkiMux" })).toBeTruthy();
    const settings = screen.getByRole("main");
    expect(within(settings).getByText("Not decided")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Yes" }));

    expect(await within(settings).findByText("Yes")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Help improve ArkiMux" })).toBeNull();
    expect(privacyRequests.filter(method => method === "PUT")).toEqual(["PUT"]);
  });

  it("keeps the direct Privacy Notice readable when current status cannot load", async () => {
    window.history.replaceState({}, "", "/settings/privacy/terms");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname === "/api/v1/local/privacy") throw new Error("offline");
      return json({ items: [], pagination: {} });
    }));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "privacy-offline" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    expect(await screen.findByRole("heading", { name: "Local usage Privacy Notice" })).toBeTruthy();
    expect(screen.getByText(/retention and deletion policy is not configured/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Help improve ArkiMux" })).toBeNull();
    expect((await screen.findByRole("alert")).textContent).toContain("offline");
  });

  it("separates current installation from old deletion history and copies only the current ID", async () => {
    window.history.replaceState({}, "", "/settings/privacy");
    const currentId = "11223344-5566-7001-0123-123456789abc", oldId = "22334455-5566-7001-0123-123456789abc";
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname === "/api/v1/local/privacy") return json({ ...privacyStatus("accepted", false), installationId: currentId,
        deletionRequest: { status: "accepted", receipt: { request_id: "old-request" } },
        privacyHistory: [
          { id: "new", kind: "consent_granted", at: "2026-10-06T07:48:00Z", installationId: currentId },
          { id: "old", kind: "deletion_accepted", installationId: oldId, requestId: "old-request", recovered: true },
        ] });
      return json({ items: [], pagination: {} });
    }));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "privacy-history" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    await user.click(await screen.findByRole("button", { name: "Copy installation ID" }));
    expect(copy).toHaveBeenCalledWith(currentId);
    const history = screen.getByRole("list", { name: "Privacy history" });
    expect(within(history).getByText(oldId)).toBeTruthy();
    expect(within(history).getByText(/Time not recorded/)).toBeTruthy();
    expect(within(history).getByText(/Local has not confirmed completion/)).toBeTruthy();
    expect(screen.queryByText(/The service accepted your deletion request/)).toBeNull();
    expect(screen.queryByText("Deletion completed")).toBeNull();
    expect((await axe.run(document.body)).violations).toEqual([]);
    copy.mockRestore();
  });

  it("shows registering without presenting the registration secret or provisional ID", async () => {
    window.history.replaceState({}, "", "/settings/privacy");
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...privacyStatus("accepted", false), installationId: null, privacyHistory: [] })));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "privacy-registering" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    expect(await screen.findByText("Registering…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy installation ID" })).toBeNull();
    expect(screen.getByText("No privacy events recorded yet.")).toBeTruthy();
  });

  it("shows a failed deletion once through the shared copyable toaster and retains confirmation for retry", async () => {
    window.history.replaceState({}, "", "/settings/privacy");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/v1/local/privacy/deletion") return json({ error: { message: "This origin is not allowed." } }, 403);
      if (route === "/api/v1/local/privacy") return json({ ...privacyStatus("accepted", false), canDeleteSharedData: true });
      return json({}, 404);
    }));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "delete-failure" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete shared data" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete shared data" }));
    const toast = await screen.findByRole("alert");
    expect(toast.textContent).toContain("This origin is not allowed.");
    expect(screen.getAllByText("This origin is not allowed.")).toHaveLength(1);
    expect(within(toast).getByRole("button", { name: "Copy error" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm delete shared data" })).toBeTruthy();
    expect(screen.queryByText(/service accepted your deletion request/)).toBeNull();
  });

  it("requires deletion confirmation and shows pending submission rather than claiming data is deleted", async () => {
    window.history.replaceState({}, "", "/settings/privacy");
    const posts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/v1/local/privacy/deletion") {
        posts.push(JSON.parse(String(init?.body)));
        return json({ ...privacyStatus("declined", false), canDeleteSharedData: false,
          deletionRequest: { status: "pending" }, deliveryState: "retrying" }, 202);
      }
      if (route === "/api/v1/local/privacy") return json({ ...privacyStatus("accepted", false), canDeleteSharedData: true });
      return json({ items: [], pagination: {} });
    }));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "delete-sharing" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete shared data" }));
    expect(posts).toEqual([]);
    expect(screen.getByText(/source usage data within seven days/)).toBeTruthy();
    expect(screen.queryByText(/previously collected diagnostics/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(posts).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Delete shared data" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete shared data" }));
    expect(posts).toEqual([{ confirm: true }]);
    expect(await screen.findByText(/waiting to submit your deletion request/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Share usage" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/service accepted your deletion request/)).toBeNull();
  });

  it("distinguishes loading and failed Diagnostics from an empty list, and allows retry", async () => {
    window.history.replaceState({}, "", "/settings/diagnostics");
    let complete!: (response: Response) => void;
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/local/privacy") return json(privacyStatus("accepted", false));
      if (path === "/api/v1/local/diagnostics") {
        if (++attempts === 1) return new Promise<Response>(resolve => { complete = resolve; });
        return json({ items: [] });
      }
      return json({ items: [], pagination: {} });
    }));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "diagnostics-retry" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    expect(await screen.findByText("Loading diagnostics…")).toBeTruthy();
    expect(screen.queryByText("No local diagnostics recorded.")).toBeNull();
    complete(json({ error: { message: "The request could not be completed. Please try again." } }, 500));
    expect(await screen.findByText("Diagnostics could not be loaded.")).toBeTruthy();
    expect(await screen.findByText("The request could not be completed. Please try again.")).toBeTruthy();
    expect(screen.queryByText("No local diagnostics recorded.")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No local diagnostics recorded.")).toBeTruthy();
    expect(screen.queryByText("Diagnostics could not be loaded.")).toBeNull();
    expect(attempts).toBe(2);
  });

  it("offers issue reporting without usage consent or a saved diagnostic", async () => {
    window.history.replaceState({}, "", "/settings/diagnostics");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/local/privacy") return json({ ...privacyStatus("declined", false), arkimuxVersion: "0.1.0-alpha.35" });
      return json({ items: [], pagination: {} });
    }));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "manual-report-no-consent" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    await screen.findByText("No local diagnostics recorded.");
    const link = screen.getByRole("link", { name: "Report an issue on GitHub" });
    expect(new URL(link.getAttribute("href")!).searchParams.get("body")).toContain("ArkiMux version: 0.1.0-alpha.35");
    expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.queryByRole("button", { name: "Copy diagnostic" })).toBeNull();
  });

  it.each(["inspect another", "delete"])("discards a delayed diagnostic after choosing to %s", async action => {
    window.history.replaceState({}, "", "/settings/diagnostics");
    const records = [1, 2].map(index => ({ schemaVersion: 1,
      diagnosticId: `00000000-0000-4000-8000-00000000000${index}`, recordedAt: "2026-10-12T00:00:00.000Z",
      arkimuxVersion: "0.1.0", component: "local-server", operation: "worker",
      runtime: { nodeVersion: "v24.15.0", platform: "darwin", architecture: "arm64" },
      error: { name: "Error", message: `trace ${index}` }, truncated: false }));
    let complete!: (response: Response) => void;
    let removed = false;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/local/privacy") return json(privacyStatus("declined", false));
      if (path === "/api/v1/local/diagnostics") {
        if (init?.method === "DELETE") { removed = true; return new Response(null, { status: 204 }); }
        return json({ items: removed ? [] : records });
      }
      if (path.endsWith(records[0].diagnosticId)) return new Promise<Response>(resolve => { complete = resolve; });
      if (path.endsWith(records[1].diagnosticId)) return json(records[1]);
      return json({}, 404);
    }));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: `diagnostic-race-${action}` }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    const buttons = await screen.findAllByRole("button", { name: "Inspect" });
    await userEvent.click(buttons[0]);
    if (action === "inspect another") {
      await userEvent.click(buttons[1]);
      expect((await screen.findByLabelText("Diagnostic JSON")).textContent).toContain("trace 2");
    } else {
      await userEvent.click(screen.getByRole("button", { name: "Delete all" }));
      await screen.findByText("No local diagnostics recorded.");
    }
    await act(async () => { complete(json(records[0])); });
    expect(screen.queryByText(/trace 1/)).toBeNull();
    if (action === "delete") expect(screen.queryByRole("button", { name: "Copy diagnostic" })).toBeNull();
    else expect(screen.getByLabelText("Diagnostic JSON").textContent).toContain("trace 2");
  });

  it.each(["success", "failure"])("copies the full diagnostic with clipboard %s while keeping the issue form metadata-only", async outcome => {
    window.history.replaceState({}, "", "/settings/diagnostics");
    const diagnosticId = "00000000-0000-4000-8000-000000000001";
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push(init?.method ?? "GET");
      const path = new URL(String(input)).pathname;
      if (path === "/api/v1/local/privacy") return json(privacyStatus("accepted", false));
      if (path === "/api/v1/local/diagnostics") return json({ items: [{ schemaVersion: 1, diagnosticId,
        recordedAt: "2026-09-21T00:00:00.000Z", arkimuxVersion: "0.1.0", component: "local-server",
        operation: "resource-cleanup" }] });
      if (path === `/api/v1/local/diagnostics/${diagnosticId}`) return json({ schemaVersion: 1, diagnosticId,
        recordedAt: "2026-09-21T00:00:00.000Z", arkimuxVersion: "0.1.0", component: "local-server",
        operation: "resource-cleanup",
        runtime: { nodeVersion: "v24.15.0", platform: "darwin", architecture: "arm64" },
        error: { name: "Error", message: "cleanup failed", stack: "/private/project/file.ts:1" }, truncated: false });
      return json({ items: [], pagination: {} });
    }));
    render(<AgentExecutionWebApp apiBaseUrl="http://api.test" session={{ cacheKey: "diagnostics" }} resultPlugins={[]} uiConfiguration={agentExecutionUiConfiguration("workflow-development")} />);
    expect(await screen.findByRole("heading", { name: "Diagnostics" })).toBeTruthy();
    expect(screen.getByText("Full diagnostic files stay on this computer.")).toBeTruthy();
    expect(screen.getByText(/ArkiMux does not upload error reports automatically/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Read the Privacy Notice" }).getAttribute("href")).toBe("/settings/privacy/terms");
    expect(await screen.findByText(diagnosticId)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
    const displayed = (await screen.findByLabelText("Diagnostic JSON")).textContent!;
    expect(displayed).toContain("/private/project/file.ts:1");
    expect(JSON.parse(displayed)).toMatchObject({ diagnosticId, arkimuxVersion: "0.1.0", runtime: { platform: "darwin" } });
    expect(screen.queryByRole("textbox", { name: "Trace to share" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy edited trace" })).toBeNull();
    const clipboard = outcome === "success" ? vi.fn().mockResolvedValue(undefined) : vi.fn().mockRejectedValue(new Error("Denied"));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    await userEvent.click(screen.getByRole("button", { name: "Copy diagnostic" }));
    expect(clipboard).toHaveBeenCalledWith(displayed);
    if (outcome === "success") expect(await screen.findByText("Diagnostic copied. Review and remove private information before sharing.")).toBeTruthy();
    else {
      expect(await screen.findByText("Could not copy the diagnostic. Select and copy it manually.")).toBeTruthy();
      expect(screen.queryByText("Diagnostic copied. Review and remove private information before sharing.")).toBeNull();
    }
    expect(screen.getByLabelText("Diagnostic JSON").textContent).toBe(displayed);
    await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect((await screen.findByLabelText("Diagnostic JSON")).textContent).toBe(displayed);
    expect(screen.queryByText("Diagnostic copied. Review and remove private information before sharing.")).toBeNull();
    const issue = new URL(screen.getByRole("link", { name: "Report an issue on GitHub" }).getAttribute("href")!);
    expect(issue.origin + issue.pathname).toBe("https://github.com/com-pyvue/arkimux/issues/new");
    expect(issue.searchParams.get("body")).toContain("ArkiMux version: 0.1.0");
    expect(issue.href).not.toMatch(/cleanup|%2Fprivate|00000000|Reviewed/);
    expect(issue.searchParams.get("body")).toContain("Steps to reproduce");
    expect(screen.getByRole("button", { name: "Download JSON" })).toBeTruthy();
    await userEvent.click(screen.getByRole("link", { name: "Read the Privacy Notice" }));
    expect(await screen.findByRole("heading", { name: "Local usage Privacy Notice" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Local diagnostics and GitHub issues" })).toBeTruthy();
    expect(screen.getByText(/ArkiMux does not collect error reports automatically/)).toBeTruthy();
    expect(screen.getByText(/No trace or file is attached automatically/)).toBeTruthy();
    expect(screen.getByText(/They are captured independently of usage-sharing consent/)).toBeTruthy();
    expect(screen.getByText(/Deleting a local diagnostic does not delete a GitHub issue/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Diagnostics" }).getAttribute("href")).toBe("/settings/diagnostics");
    expect(requests.every(method => method === "GET")).toBe(true);
  });
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function privacyStatus(choice: "undecided" | "accepted" | "declined", promptEligible: boolean) {
  return { schemaVersion: 1, choice, sharingEnabled: choice === "accepted", promptEligible,
    privacyNoticeVersion: "2026-09-22-timing-sequence", provider: { kind: "arkimux", configured: true }, pendingEventCount: 0,
    deliveryState: "connected", credentialDeletionPending: false,
    localRetentionDays: 7, remoteRetentionDays: "indefinite", remoteDeletion: "installation-authenticated",
    privacy: { usageRetentionDays: "indefinite", queryRetentionDays: 7, logRetentionDays: 7,
      deletionDescription: "Fixture policy only." } };
}
