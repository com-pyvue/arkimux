// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { renderWithToaster as render } from "./renderWithToaster.tsx";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentAuthenticationApiClient } from "../../apps/packages/agent-authentication/contract/src/index.ts";
import { AgentAuthenticationFeature } from "../../apps/packages/agent-authentication/react/src/index.ts";

afterEach(cleanup);
const date = "2026-09-07T08:00:00.000Z";
const credential = (id: string, available = true, lifecycleStatus = "active") => ({
  definition: { schemaVersion: 1, credentialId: id, displayName: `Key ${id}`, kind: "api-key", modelProvider: "anthropic" },
  contentHash: "a".repeat(64), lifecycleStatus, createdAt: date, updatedAt: date, valueAvailable: available,
});
const metadata = {
  credentialPresets: [{ presetId: "anthropic", label: "Anthropic key", modelProvider: "anthropic" }],
  authProviderPresets: [{ presetId: "pi-key", label: "Pi API key", executionProviderId: "pi-cli", modelProvider: "anthropic", targetVariable: "ANTHROPIC_API_KEY" }],
  nativeSessionPresets: [{ presetId: "native", label: "Codex session", executionProviderId: "codex-cli", modelProvider: "openai", requiredVersion: "0.145.0", loginInstruction: "Run codex login." }],
};
function fixture(initialCredentials = [credential("personal")], initialProviders: Record<string, unknown>[] = []) {
  const state = { credentials: initialCredentials, providers: initialProviders, failNext: false };
  const requests: Array<{ path: string; method: string; query: string; body?: unknown }> = [];
  const client = new AgentAuthenticationApiClient({ baseUrl: "http://acceptance.test", fetch: async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path: url.pathname, method, query: url.search, body });
    if (url.pathname.endsWith("/metadata")) return json(metadata);
    if (method === "GET") {
      const items = url.pathname.endsWith("/agent-credentials") ? state.credentials : state.providers;
      return json({ items: items.filter(item => url.searchParams.get("lifecycleStatus") === "all" || item.lifecycleStatus === "active"), pagination: {} });
    }
    if (state.failNext) { state.failNext = false; return json({ error: { code: "conflict", message: "Save failed. Retry this change." } }, 409); }
    if (url.pathname.endsWith("/agent-auth-providers")) {
      const { schemaVersion: _schemaVersion, targetVariable: _targetVariable, ...catalog } = body.definition;
      state.providers.push({ ...catalog, origin: "user", lifecycleStatus: "active" });
      return json({ provider: { definition: body.definition, contentHash: "b".repeat(64), lifecycleStatus: "active", createdAt: date, updatedAt: date } }, 201);
    }
    if (url.pathname.endsWith("/agent-credentials")) {
      const item = { ...credential(body.definition.credentialId), definition: body.definition };
      state.credentials.push(item);
      return json({ credential: item }, 201);
    }
    if (url.pathname.endsWith("/personal/value") && method === "PUT") {
      state.credentials[0] = credential("personal");
      return json({ credential: state.credentials[0] });
    }
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  } });
  const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><AgentAuthenticationFeature client={client} connectionsFirst /></QueryClientProvider>);
  return { state, requests, client, show };
}

it("shows separate safe Connection and Credential metadata and requests archived rows only when selected", async () => {
  const f = fixture([credential("personal"), credential("missing", false), credential("retired", true, "archived")], [
    { authProviderId: "native-id", displayName: "Native login", origin: "platform", kind: "runtime-native", executionProviderId: "codex-cli", modelProvider: "openai", lifecycleStatus: "active", loginRequirement: { application: "Codex CLI", instruction: "Run codex login." } },
    { authProviderId: "key-id", displayName: "Key connection", origin: "user", kind: "stored-credential", executionProviderId: "pi-cli", modelProvider: "anthropic", credentialId: "personal", lifecycleStatus: "active", latestProbe: { schemaVersion: 1, authProviderId: "key-id", mechanism: "minimal-inference", latencyMs: 1, status: "connected", message: "Connection succeeded.", checkedAt: date, probeModel: "fixture-model" } },
    { authProviderId: "old-id", displayName: "Archived connection", origin: "user", kind: "stored-credential", executionProviderId: "pi-cli", modelProvider: "anthropic", credentialId: "retired", lifecycleStatus: "archived" },
  ]);
  f.show();
  const connections = within(await screen.findByRole("table", { name: "Connections" }));
  const native = within(connections.getByText("Native login").closest("tr")!);
  for (const text of ["native-id", "Native session", "codex-cli", "openai", "active", "Never tested", "Run codex login."]) expect(native.getByText(text)).toBeTruthy();
  const keyed = within(connections.getByText("Key connection").closest("tr")!);
  for (const text of ["key-id", "API key", "pi-cli", "anthropic", "personal", "Connected", "fixture-model"]) expect(keyed.getByText(text)).toBeTruthy();
  const keys = within(screen.getByRole("table", { name: "Credentials" }));
  const personal = within(keys.getByText("Key personal").closest("tr")!);
  for (const text of ["personal", "anthropic", "configured", "active"]) expect(personal.getByText(text)).toBeTruthy();
  expect(keys.getByText("missing", { selector: "span" })).toBeTruthy();
  expect(screen.getByText(/API keys are stored as plaintext mode-0600/).textContent).toContain("Values are never returned by the API or copied into run artifacts.");
  expect(screen.queryByText("Archived connection")).toBeNull();
  expect(screen.queryByText("Key retired")).toBeNull();
  await userEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
  expect(await screen.findByText("Archived connection")).toBeTruthy();
  expect(await screen.findByText("Key retired")).toBeTruthy();
  expect(within(screen.getByText("Key retired").closest("tr")!).getByText("archived")).toBeTruthy();
  await userEvent.click(screen.getByRole("checkbox", { name: "Show archived" }));
  expect(await screen.findByText("Native login")).toBeTruthy();
  expect(screen.queryByText("Archived connection")).toBeNull();
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
});

it("keeps a Connection draft after a save error and persists the retry without probing", async () => {
  const f = fixture(); f.state.failNext = true; f.show();
  await screen.findByText("No connections are available.");
  await userEvent.click(screen.getByRole("button", { name: "Add connection" }));
  await userEvent.type(screen.getByLabelText("Connection ID"), "my-session");
  await userEvent.type(screen.getByLabelText("Display name"), "My session");
  await userEvent.click(screen.getByRole("button", { name: "Save connection" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Retry this change");
  expect((screen.getByLabelText("Connection ID") as HTMLInputElement).value).toBe("my-session");
  expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("My session");
  await userEvent.click(screen.getByRole("button", { name: "Save connection" }));
  expect(await screen.findByText("My session")).toBeTruthy();
  cleanup(); f.show();
  expect(await screen.findByText("My session")).toBeTruthy();
  const writes = f.requests.filter(request => request.method !== "GET");
  expect(writes).toHaveLength(2);
  expect(writes[0].body).toEqual(writes[1].body);
  expect(writes.every(request => request.path === "/api/v1/agent-auth-providers")).toBe(true);
});

it("rejects an API-key Connection without a compatible credential before sending a request", async () => {
  const f = fixture([credential("missing", false)]); f.show();
  await screen.findByText("No connections are available.");
  await userEvent.click(screen.getByRole("button", { name: "Add connection" }));
  await userEvent.selectOptions(screen.getByLabelText("Connection type"), "pi-key");
  await userEvent.click(screen.getByRole("button", { name: "Save connection" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Create a compatible credential first");
  expect(f.requests.every(request => request.method === "GET")).toBe(true);
});

it("masks a credential draft through a failed save and clears it after successful creation", async () => {
  const f = fixture([]); f.state.failNext = true; f.show();
  await userEvent.click(await screen.findByRole("button", { name: "Add credential" }));
  await userEvent.type(screen.getByLabelText("Credential ID"), "fresh");
  await userEvent.type(screen.getByLabelText("Display name"), "Fresh key");
  const input = screen.getByLabelText("API key") as HTMLInputElement;
  expect(input.type).toBe("password");
  await userEvent.type(input, "synthetic-create-secret");
  await userEvent.click(screen.getByRole("button", { name: "Save credential" }));
  await screen.findByRole("alert");
  expect(input.type).toBe("password");
  expect(input.value).toBe("synthetic-create-secret");
  expect(document.body.textContent).not.toContain(input.value);
  await userEvent.click(screen.getByRole("button", { name: "Save credential" }));
  expect(await screen.findByText("Fresh key")).toBeTruthy();
  expect(screen.queryByLabelText("API key")).toBeNull();
  expect(document.body.textContent).not.toContain("synthetic-create-secret");
  expect(within(screen.getByRole("table", { name: "Credentials" })).getByText("configured")).toBeTruthy();
});

it("replaces a missing key using an empty masked field, retains safe retry state, and refreshes availability", async () => {
  const f = fixture([credential("personal", false)]); f.state.failNext = true; f.show();
  await userEvent.click(await screen.findByRole("button", { name: "Replace key" }));
  const input = screen.getByLabelText("Replacement API key") as HTMLInputElement;
  expect(input.type).toBe("password"); expect(input.value).toBe("");
  await userEvent.type(input, "synthetic-replacement-secret");
  await userEvent.click(screen.getByRole("button", { name: "Replace", exact: true }));
  await screen.findByRole("alert");
  expect(input.type).toBe("password");
  expect(document.body.textContent).not.toContain("synthetic-replacement-secret");
  await userEvent.click(screen.getByRole("button", { name: "Replace", exact: true }));
  expect(await screen.findByText("configured")).toBeTruthy();
  expect(screen.queryByLabelText("Replacement API key")).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "Replace key" }));
  expect((screen.getByLabelText("Replacement API key") as HTMLInputElement).value).toBe("");
  expect(f.requests.filter(request => request.method === "PUT").map(request => ({ path: request.path, body: request.body }))).toEqual([
    { path: "/api/v1/agent-credentials/personal/value", body: { credential: "synthetic-replacement-secret" } },
    { path: "/api/v1/agent-credentials/personal/value", body: { credential: "synthetic-replacement-secret" } },
  ]);
});

function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }); }
