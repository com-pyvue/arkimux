import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { createPrivateApiKeySetup, configurePrivateAnthropicKey, resolvePrivateApiKeyConfig } from "../../scripts/lib/local-api-key-setup.ts";
import { FileAgentAuthProviderStore, FilePlaintextAgentCredentialStore, createStoreBackedAgentAuthProviderRegistry, type ResolvedAgentProviderConfig } from "@com-pyvue/agent-execution-core";

describe("private Pi Anthropic API-key setup through existing REST routes", () => {
  it("validates the scaffold document before isolating private authentication", async () => {
    const document = JSON.parse(await readFile("cli/scaffold/config/agent-providers.default.json", "utf8"));
    const before = structuredClone(document);
    const config = resolvePrivateApiKeyConfig(document, {});
    expect(config.executionProviders["pi-cli"].requiredVersion).toBe("0.84.3");
    expect(config.authProviders).toEqual({});
    expect(document).toEqual(before);
    expect(() => resolvePrivateApiKeyConfig({ ...document, authProviders: {} }, {})).toThrow(/at least one authentication provider/);
  });
  it("creates separate records without probing and sends only the selected key to the runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "private-key-api-test-"));
    try {
      const runtime = { command: "not-executed", heartbeatIntervalMs: 1000, environmentAllowlist: ["PATH"] };
      const config: ResolvedAgentProviderConfig = { schemaVersion: 1, authProviders: {}, legacyEnvironmentOverrides: [], executionProviders: { "codex-cli": runtime, "pi-cli": runtime, "claude-code-cli": runtime, "kimi-code-cli": runtime } };
      let calls = 0;
      const fixtureSecret = 'synthetic-only-key-"escaped"';
      const { client, routes } = createPrivateApiKeySetup(root, config, {}, { probe: async (target) => {
        calls++;
        const auth = createStoreBackedAgentAuthProviderRegistry(config, new FileAgentAuthProviderStore(path.join(root, "definitions")), new FilePlaintextAgentCredentialStore(path.join(root, "credentials")), { ANTHROPIC_API_KEY: "wrong-shell-key" });
        const prepared = await auth.get(target.authProviderId).prepare({ cwd: root, executionProviderId: "pi-cli", modelProvider: "anthropic" });
        expect(prepared.environment).toEqual({ ANTHROPIC_API_KEY: fixtureSecret });
        expect(prepared.credentialDirectory).toBeUndefined();
        await prepared.dispose();
        return { schemaVersion: 1, authProviderId: target.authProviderId, status: "connected", mechanism: "minimal-inference", checkedAt: "2026-09-06T00:00:00.000Z", latencyMs: 1, message: `Fixture diagnostic ${fixtureSecret}` };
      } });
      await configurePrivateAnthropicKey(client, fixtureSecret);
      expect(calls).toBe(0);
      expect(JSON.stringify(await client.listCredentials())).not.toContain(fixtureSecret);
      expect(JSON.stringify(await client.list())).not.toContain(fixtureSecret);
      const result = await client.probe("pi-anthropic-api-key");
      expect(result.probe.message).toBe("Fixture diagnostic [REDACTED]");
      expect(calls).toBe(1);
      expect(JSON.stringify(await client.list())).not.toContain(fixtureSecret);
      expect(routes).toContain("POST /api/v1/agent-credentials");
      expect(routes).toContain("POST /api/v1/agent-auth-providers");
      expect(routes).toContain("POST /api/v1/agent-auth-providers/pi-anthropic-api-key/probe");
      expect(await readFile(path.join(root, "credentials/values/private-anthropic-key.key"), "utf8")).toBe(fixtureSecret);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
