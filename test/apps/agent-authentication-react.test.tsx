// @vitest-environment jsdom

import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { renderWithToaster as render } from "./renderWithToaster.tsx";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentAuthenticationApiClient, type AgentAuthProbeResultDto } from "../../apps/packages/agent-authentication/contract/src/index.ts";
import { AgentAuthenticationFeature } from "../../apps/packages/agent-authentication/react/src/index.ts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Agent Authentication React feature", () => {
  it("creates a native Connection without a key or an automatic probe", async () => {
    const submitted: unknown[] = [];
    const client = new AgentAuthenticationApiClient({ baseUrl: "http://authentication.test", fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/metadata')) return json({credentialPresets:[],authProviderPresets:[],nativeSessionPresets:[{
        presetId:'pi-codex',label:'Pi Codex Session',executionProviderId:'pi-cli',modelProvider:'openai-codex',requiredVersion:'0.84.3',loginInstruction:'Run pi, then /login and choose OpenAI Codex.',
      }]});
      if ((init?.method ?? 'GET') === 'GET') return json({items:[],pagination:{}});
      const request = JSON.parse(String(init?.body));
      submitted.push({path:url.pathname,request});
      return json({provider:{definition:request.definition,contentHash:'a'.repeat(64),lifecycleStatus:'active',createdAt:'2026-09-05T00:00:00Z',updatedAt:'2026-09-05T00:00:00Z'}},201);
    }});
    const queryClient = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
    render(<QueryClientProvider client={queryClient}><AgentAuthenticationFeature client={client} connectionsFirst /></QueryClientProvider>);
    await screen.findByText('No connections are available.');
    await userEvent.click(screen.getByRole('button',{name:'Add connection'}));
    expect(await screen.findByText('Run pi, then /login and choose OpenAI Codex.')).toBeTruthy();
    expect(screen.queryByRole('combobox',{name:'Credential'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Add credential'})).toBeNull();
    await userEvent.type(screen.getByRole('textbox',{name:'Connection ID'}),'my-pi-codex');
    await userEvent.type(screen.getByRole('textbox',{name:'Display name'}),'My Pi Codex');
    await userEvent.click(screen.getByRole('button',{name:'Save connection'}));
    await screen.findByText('No connections are available.');
    expect(submitted).toEqual([{path:'/api/v1/agent-auth-providers',request:{definition:{schemaVersion:2,authProviderId:'my-pi-codex',displayName:'My Pi Codex',kind:'runtime-native',executionProviderId:'pi-cli',modelProvider:'openai-codex'}}}]);
  });

  it.each([false, true])("creates a credential separately from its reusable authentication configuration (Connections first: %s)", async (connectionsFirst) => {
    const submitted: Array<{ path: string; body: unknown }> = [];
    const credentials: unknown[] = [];
    const providers: unknown[] = [];
    const client = new AgentAuthenticationApiClient({
      baseUrl: "http://authentication.test",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/metadata")) return json({
          credentialPresets: [{ presetId: "anthropic-api-key", label: "Anthropic API key", modelProvider: "anthropic" }],
          authProviderPresets: [{ presetId: "pi-anthropic-api-key", label: "Pi CLI with Anthropic API key", executionProviderId: "pi-cli", modelProvider: "anthropic", targetVariable: "ANTHROPIC_API_KEY" }],
          nativeSessionPresets: connectionsFirst ? [{ presetId: "codex-native", label: "Codex Native Session", executionProviderId: "codex-cli", modelProvider: "openai", requiredVersion: "0.145.0", loginInstruction: "Run codex login." }] : [],
        });
        if (url.pathname === "/api/v1/agent-credentials" && (init?.method ?? "GET") === "GET") return json({ items: credentials, pagination: {} });
        if (url.pathname === "/api/v1/agent-auth-providers" && (init?.method ?? "GET") === "GET") return json({ items: providers, pagination: {} });
        if (url.pathname === "/api/v1/agent-credentials" && init?.method === "POST") {
          const request = JSON.parse(String(init.body)) as { definition: Record<string, unknown>; credential: string };
          submitted.push({ path: url.pathname, body: request });
          const item = { definition: request.definition, contentHash: "a".repeat(64), lifecycleStatus: "active", createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z", valueAvailable: true };
          credentials.push(item);
          return json({ credential: item }, 201);
        }
        if (url.pathname === "/api/v1/agent-auth-providers" && init?.method === "POST") {
          const request = JSON.parse(String(init.body)) as { definition: Record<string, unknown> };
          submitted.push({ path: url.pathname, body: request });
          const item = { definition: request.definition, contentHash: "b".repeat(64), lifecycleStatus: "active", createdAt: "2026-08-22T00:00:00.000Z", updatedAt: "2026-08-22T00:00:00.000Z" };
          providers.push({
            authProviderId: request.definition.authProviderId,
            displayName: request.definition.displayName,
            origin: "user",
            kind: "stored-credential",
            executionProviderId: request.definition.executionProviderId,
            modelProvider: request.definition.modelProvider,
            credentialId: request.definition.credentialId,
            lifecycleStatus: "active",
          });
          return json({ provider: item }, 201);
        }
        return json({ error: { code: "not-found", message: `No fixture for ${url.pathname}.` } }, 404);
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><AgentAuthenticationFeature client={client} connectionsFirst={connectionsFirst} /></QueryClientProvider>);

    expect(await screen.findByText("No credentials configured.")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(connectionsFirst ? ["Connections", "Credentials"] : ["Credentials", "Authentication configurations"]);
    expect(screen.getByText(".arkimux/local/credentials/values")).toBeTruthy();
    expect(screen.queryByText(".agent-execution/local-store/file/credentials/values")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Add credential" }));
    await userEvent.type(screen.getByPlaceholderText("my-anthropic-key"), "personal-anthropic-key");
    await userEvent.type(screen.getByPlaceholderText("My Anthropic key"), "Personal Anthropic key");
    await userEvent.type(screen.getByLabelText("API key"), "write-only-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save credential" }));
    expect(await screen.findByText("Personal Anthropic key")).toBeTruthy();
    expect(screen.queryByText("write-only-secret")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: connectionsFirst ? "Add connection" : "Add configuration" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: connectionsFirst ? "Connection type" : "Configuration type" }), "pi-anthropic-api-key");
    await userEvent.type(screen.getByPlaceholderText("claude-with-my-key"), "claude-personal");
    await userEvent.type(screen.getByPlaceholderText("Claude with my key"), "Claude personal");
    await userEvent.click(screen.getByRole("button", { name: connectionsFirst ? "Save connection" : "Save configuration" }));
    expect(await screen.findByText("Claude personal")).toBeTruthy();
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual({ path: "/api/v1/agent-auth-providers", body: { definition: {
      schemaVersion: 2,
      authProviderId: "claude-personal",
      displayName: "Claude personal",
      kind: "stored-credential",
      executionProviderId: "pi-cli",
      modelProvider: "anthropic",
      credentialId: "personal-anthropic-key",
      targetVariable: "ANTHROPIC_API_KEY",
    } } });
    expect(JSON.stringify(submitted[1])).not.toContain("write-only-secret");
  });

  it("shows native session instructions and probes only after explicit quota confirmation", async () => {
    const checkedAt = "2026-08-25T10:00:00.000Z";
    let probed = false;
    const client = new AgentAuthenticationApiClient({
      baseUrl: "http://authentication.test",
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/metadata")) return json({ credentialPresets: [], authProviderPresets: [] });
        if (url.pathname === "/api/v1/agent-credentials") return json({ items: [], pagination: {} });
        if (url.pathname === "/api/v1/agent-auth-providers" && (init?.method ?? "GET") === "GET") return json({
          items: [{
            authProviderId: "claude-code-native-session",
            displayName: "Claude Code native session",
            origin: "platform",
            kind: "runtime-native",
            executionProviderId: "claude-code-cli",
            modelProvider: "anthropic",
            lifecycleStatus: "active",
            loginRequirement: {
              application: "Claude Code",
              instruction: "Requires login to Claude Code. Run /login inside Claude Code.",
            },
            ...(probed ? { latestProbe: { schemaVersion: 1, authProviderId: "claude-code-native-session", checkedAt, status: "connected", mechanism: "minimal-inference", latencyMs: 123, probeModel: "haiku", message: "Connection succeeded." } } : {}),
          }],
          pagination: {},
        });
        if (url.pathname.endsWith("/claude-code-native-session/probe") && init?.method === "POST") {
          probed = true;
          return json({ probe: { schemaVersion: 1, authProviderId: "claude-code-native-session", checkedAt, status: "connected", mechanism: "minimal-inference", latencyMs: 123, probeModel: "haiku", message: "Connection succeeded." } });
        }
        return json({ error: { code: "not-found", message: `No fixture for ${url.pathname}.` } }, 404);
      },
    });
    const probe = vi.spyOn(client, "probe");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><AgentAuthenticationFeature client={client} connectionsFirst /></QueryClientProvider>);

    expect(await screen.findByText("Claude Code native session")).toBeTruthy();
    expect(screen.getByText("Requires login to Claude Code. Run /login inside Claude Code.")).toBeTruthy();
    expect(screen.getByText(/do not need to copy native login credentials/)).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.getByText("Never tested")).toBeTruthy();
    expect(probe).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    const confirmation = screen.getByRole("dialog", { name: "Test connection?" });
    expect(within(confirmation).getByText("Claude Code native session")).toBeTruthy();
    expect(within(confirmation).getByText(/consume your provider quota, or incur charges/)).toBeTruthy();
    expect(probe).not.toHaveBeenCalled();
    const accessibility = await axe.run(confirmation, { rules: { "color-contrast": { enabled: false } } });
    expect(accessibility.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
    await userEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    expect(screen.getByText("Never tested")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm connection test" }));
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Connections" })).getByText("Connection succeeded.")).toBeTruthy();
    expect(screen.getByText("haiku")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Connection succeeded");
    expect(screen.getByRole("button", { name: "Test connection" }).hasAttribute("disabled")).toBe(false);
    expect(probe).toHaveBeenCalledExactlyOnceWith("claude-code-native-session");
  });

  it("reports an action-required probe in a toast and restores the row action", async () => {
    const client = probeClient({
      status: "action-required",
      message: "Log in to Claude Code or configure an API key.",
    });
    renderFeature(client);

    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm connection test" }));

    const notification = await screen.findByRole("status");
    expect(notification.textContent).toContain("Action required");
    expect(notification.textContent).toContain("Log in to Claude Code or configure an API key.");
    expect(within(screen.getByRole("table", { name: "Authentication configurations" })).getByText("Action required")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test connection" }).hasAttribute("disabled")).toBe(false);
  });

  it("reports an HTTP probe failure in a toast and restores the row action", async () => {
    const client = probeClient(undefined, 500);
    renderFeature(client);

    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm connection test" }));

    const notification = await screen.findByRole("alert");
    expect(notification.textContent).toContain("Connection test failed");
    expect(notification.textContent).toContain("Internal application error.");
    expect(screen.getByRole("button", { name: "Test connection" }).hasAttribute("disabled")).toBe(false);
  });

  it.each([
    ["failed", "Failed", "Connection failed", "The provider rejected the connection. Check its login and try again."],
    ["indeterminate", "Connection inconclusive", "Connection inconclusive", "The provider did not confirm readiness. Try the connection test again."],
  ] as const)("keeps a %s probe result distinct from connected", async (status, label, notificationTitle, message) => {
    const client = probeClient({ status, message });
    renderFeature(client, true);
    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm connection test" }));

    const notification = await screen.findByRole(status === "failed" ? "alert" : "status");
    expect(notification.textContent).toContain(notificationTitle);
    const connections = within(screen.getByRole("table", { name: "Connections" }));
    expect(await connections.findByText(label)).toBeTruthy();
    expect(connections.getByText(message)).toBeTruthy();
    expect(connections.queryByText("Connected")).toBeNull();
  });

  it.each([
    { code: "rate_limit_exceeded", httpStatus: 429, expected: "Provider code: rate_limit_exceeded · HTTP 429" },
    { code: "model_unavailable", expected: "Provider code: model_unavailable" },
    { httpStatus: 503, expected: "HTTP 503" },
  ])("shows optional provider metadata on a separate line ($expected)", async ({ code, httpStatus, expected }) => {
    const message = "\n  Retry after 42 seconds.\nSee https://provider.example/help\n";
    const client = probeClient({ status: "failed", message, externalDiagnostic: {
      origin: "external", provider: "claude-code-cli", message,
      ...(code === undefined ? {} : { code }), ...(httpStatus === undefined ? {} : { httpStatus }),
    } });
    renderFeature(client, true);
    await userEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm connection test" }));
    const connections = within(screen.getByRole("table", { name: "Connections" }));
    const metadata = await connections.findByText(expected);
    expect(metadata.tagName).toBe("P");
    expect(metadata.previousElementSibling?.textContent).toBe(message);
    expect(metadata.previousElementSibling?.className).toContain("whitespace-pre-wrap");
  });
});

function probeClient(
  result?: { status: "action-required" | "failed" | "indeterminate"; message: string; externalDiagnostic?: AgentAuthProbeResultDto["externalDiagnostic"] },
  failureStatus?: number,
): AgentAuthenticationApiClient {
  let latestProbe: Record<string, unknown> | undefined;
  return new AgentAuthenticationApiClient({
    baseUrl: "http://authentication.test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/metadata")) return json({ credentialPresets: [], authProviderPresets: [] });
      if (url.pathname === "/api/v1/agent-credentials") return json({ items: [], pagination: {} });
      if (url.pathname === "/api/v1/agent-auth-providers" && (init?.method ?? "GET") === "GET") return json({
        items: [{
          authProviderId: "claude-code-native-session",
          displayName: "Claude Code native session",
          origin: "platform",
          kind: "runtime-native",
          executionProviderId: "claude-code-cli",
          modelProvider: "anthropic",
          lifecycleStatus: "active",
          ...(latestProbe ? { latestProbe } : {}),
        }],
        pagination: {},
      });
      if (url.pathname.endsWith("/claude-code-native-session/probe") && init?.method === "POST") {
        if (failureStatus) return json({ error: { code: "internal-error", message: "Internal application error." } }, failureStatus);
        latestProbe = {
          schemaVersion: 1,
          authProviderId: "claude-code-native-session",
          checkedAt: "2026-08-25T10:00:00.000Z",
          status: result?.status ?? "connected",
          mechanism: "minimal-inference",
          latencyMs: 123,
          message: result?.message ?? "Connection succeeded.",
          ...(result?.externalDiagnostic === undefined ? {} : { externalDiagnostic: result.externalDiagnostic }),
        };
        return json({ probe: latestProbe });
      }
      return json({ error: { code: "not-found", message: `No fixture for ${url.pathname}.` } }, 404);
    },
  });
}

function renderFeature(client: AgentAuthenticationApiClient, connectionsFirst = false): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><AgentAuthenticationFeature client={client} connectionsFirst={connectionsFirst} /></QueryClientProvider>);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}
