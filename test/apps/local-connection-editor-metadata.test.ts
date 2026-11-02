import { expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { localProviderEditorDescriptors } from "../../apps/hosts/api/src/localFilesystemHost.ts";
import { resolveAgentProviderConfigDocument, FileAgentAuthProviderStore, FilePlaintextAgentCredentialStore, validateAgentRunPolicyProviderSchema } from "@com-pyvue/agent-execution-core";
import projectConfig from "../../cli/scaffold/config/agent-providers.default.json" with { type: "json" };
import { localApiKeySetupEvidence } from "@com-pyvue/agent-execution-core/internal/application/localApiKeyConnectionCatalog.ts";

vi.mock("@com-pyvue/agent-execution-core", async (original) => ({
  ...await original<object>(),
  // Catalog discovery is read-only; tests never invoke a CLI or read login files.
  loadPiCliModelOptions: async () => [{ value: "fixture-model", label: "Fixture model" }],
}));

it("offers only project-configured, exact-pin admitted native Connections in Local V2", async () => {
  const config = resolveAgentProviderConfigDocument(projectConfig, {});
  const descriptors = await localProviderEditorDescriptors(undefined, undefined, "/fixture", {}, config, true);
  expect(descriptors.every((provider) => provider.connectionDriven)).toBe(true);
  expect(descriptors.map((provider) => provider.providerId)).toEqual(["codex-cli"]);
  const options = descriptors.flatMap((provider) => provider.authProviderOptions ?? []);
  expect(options.map((option) => option.value)).toContain("codex-openai-native-session");
  expect(options.map((option) => option.value)).not.toContain("codex-native-session");
  expect(options.every((option) => ["openai", "openai-codex"].includes(option.modelProvider!))).toBe(true);
});

it("includes a user-created native Connection and removes it after archival without needing a credential store", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "connection-editor-"));
  try {
    const store = new FileAgentAuthProviderStore(root);
    await store.create({ schemaVersion: 2, authProviderId: "my-pi", displayName: "My Pi", kind: "runtime-native", executionProviderId: "pi-cli", modelProvider: "openai-codex" });
    const config = resolveAgentProviderConfigDocument(projectConfig, {});
    const list = async () => (await localProviderEditorDescriptors(store, undefined, "/fixture", {}, config, true)).flatMap((provider) => provider.authProviderOptions ?? []);
    expect(await list()).toContainEqual({ value: "my-pi", label: "My Pi", modelProvider: "openai-codex" });
    await store.setLifecycleStatus("my-pi", "archived");
    expect((await list()).map((option) => option.value)).not.toContain("my-pi");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("offers Pi Anthropic only with the admitted pin and an active populated Credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "key-connection-editor-"));
  try {
    const store = new FileAgentAuthProviderStore(path.join(root, "connections"));
    const credentials = new FilePlaintextAgentCredentialStore(path.join(root, "credentials"));
    const config = resolveAgentProviderConfigDocument(projectConfig, {});
    await store.create({ schemaVersion: 2, authProviderId: "my-key-pi", displayName: "My key Pi", kind: "stored-credential", executionProviderId: "pi-cli", modelProvider: "anthropic", credentialId: "my-key", targetVariable: "ANTHROPIC_API_KEY" });
    const list = async () => (await localProviderEditorDescriptors(store, credentials, "/fixture", {}, config, true)).flatMap(provider => provider.authProviderOptions ?? []);
    expect((await list()).map(option => option.value)).not.toContain("my-key-pi");
    await credentials.create({ schemaVersion: 1, credentialId: "my-key", displayName: "My key", kind: "api-key", modelProvider: "anthropic" }, "synthetic-not-used");
    expect(await list()).toContainEqual({ value: "my-key-pi", label: "My key Pi", modelProvider: "anthropic" });
    const policy = { timeoutMs: 120000, execution: { provider: "pi-cli" as const, authProvider: "my-key-pi", parameters: { provider: "anthropic", model: "fixture-model", thinking: "off" } } };
    const validate = async (candidate = policy) => validateAgentRunPolicyProviderSchema(candidate, await localProviderEditorDescriptors(store, credentials, "/fixture", {}, config, true), "Recommendation");
    await expect(validate()).resolves.toBeUndefined();
    await expect(validate({ ...policy, execution: { ...policy.execution, parameters: { ...policy.execution.parameters, provider: "openai-codex" } } })).rejects.toThrow();
    await store.setLifecycleStatus("my-key-pi", "archived");
    await expect(validate()).rejects.toThrow();
    await store.setLifecycleStatus("my-key-pi", "active");
    await expect(validate()).resolves.toBeUndefined();
    config.executionProviders["pi-cli"].requiredVersion = "999.0.0";
    expect((await list()).map(option => option.value)).not.toContain("my-key-pi");
    config.executionProviders["pi-cli"].requiredVersion = "0.84.3";
    await credentials.setLifecycleStatus("my-key", "archived");
    expect((await list()).map(option => option.value)).not.toContain("my-key-pi");
    await expect(validate()).rejects.toThrow();
    // Historical configuration remains intact even when current readiness changes.
    expect(policy.execution.authProvider).toBe("my-key-pi");
    expect(policy.execution.parameters).toEqual({ provider: "anthropic", model: "fixture-model", thinking: "off" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not resurrect implicit defaults when the project has no matching setup pins", async () => {
  const config = resolveAgentProviderConfigDocument(projectConfig, {});
  config.executionProviders["codex-cli"].requiredVersion = "999.0.0";
  config.executionProviders["pi-cli"].requiredVersion = "999.0.0";
  expect(await localProviderEditorDescriptors(undefined, undefined, "/fixture", {}, config, true)).toEqual([]);
});
