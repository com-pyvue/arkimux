import { describe, expect, it } from "vitest";
import type {
  AgentExecutionProvider,
  AgentExecutionRequest,
} from "../../core/src/application/agentProvider.ts";
import { ExecutionAgentAuthConnectionProbe } from "../../core/src/infrastructure/agents/agentAuthConnectionProbe.ts";
import type { ResolvedAgentProviderConfig } from "../../core/src/infrastructure/agents/agentProviderConfigProvider.ts";
import { DefaultAgentExecutionProviderRegistry } from "../../core/src/infrastructure/agents/providerRegistry.ts";
import { ExternalProviderError } from "../../core/src/application/externalError.ts";
import { connectionProbeDiagnostic } from "../../core/src/infrastructure/agents/connectionProbeDiagnostic.ts";

function provider(providerId: string): AgentExecutionProvider {
  return {
    providerId,
    getConnectionProbeParameters: async () => ({ model: "fixture-model", model_reasoning_effort: "low" }),
    preflight: async (request) => ({
      providerId,
      auth: {
        authProviderId: request.authProviderId,
        kind: "runtime-native",
        available: true,
        status: "ready",
      },
      available: true,
    }),
    run: async (_request: AgentExecutionRequest) => {
      throw new Error("not invoked by registry unit tests");
    },
  };
}

describe("agent execution provider registry", () => {
  it("returns the registered provider by its exact provider ID", () => {
    const codex = provider("codex-cli");
    const pi = provider("pi-cli");
    const registry = new DefaultAgentExecutionProviderRegistry([codex, pi]);

    expect(registry.get("codex-cli")).toBe(codex);
    expect(registry.get("pi-cli")).toBe(pi);
  });

  it("rejects a provider that has no installed execution adapter", () => {
    const registry = new DefaultAgentExecutionProviderRegistry([provider("codex-cli")]);

    expect(() => registry.get("pi")).toThrow("Agent execution provider pi is not installed.");
  });

  it("rejects duplicate provider IDs during composition", () => {
    expect(() => new DefaultAgentExecutionProviderRegistry([
      provider("codex-cli"),
      provider("codex-cli"),
    ])).toThrow("Agent execution provider registry contains duplicate provider IDs.");
  });

  it("performs an isolated minimal auth probe without workflow context or tools", async () => {
    let request: AgentExecutionRequest | undefined;
    const codex: AgentExecutionProvider = {
      providerId: "codex-cli",
      getConnectionProbeParameters: async () => ({ model: "fixture-model", model_reasoning_effort: "low" }),
      preflight: async ({ authProviderId }) => ({
        providerId: "codex-cli",
        auth: { authProviderId, kind: "runtime-native", available: true, status: "indeterminate" },
        available: true,
      }),
      run: async (value) => {
        request = value;
        return {
          output: "OK",
          metrics: {
            providerId: "codex-cli",
            model: "fixture-model",
            status: "complete",
            elapsedMs: 20,
            nativeToolCalls: 0,
            toolCallUnit: "native-tool-call",
            artifacts: {
              eventsPath: `${value.artifactPrefix}.events.jsonl`,
              stderrPath: `${value.artifactPrefix}.stderr.log`,
              lastMessagePath: `${value.artifactPrefix}.last-message.txt`,
              heartbeatPath: `${value.artifactPrefix}.heartbeat.json`,
            },
          },
        };
      },
    };
    const probe = new ExecutionAgentAuthConnectionProbe(
      new DefaultAgentExecutionProviderRegistry([codex]),
      providerConfig(),
      "/fixture/repository",
      {},
    );

    await expect(probe.probe({ authProviderId: "codex-native-session", executionProviderId: "codex-cli" }))
      .resolves.toMatchObject({
        status: "connected",
        mechanism: "minimal-inference",
        probeModel: "fixture-model",
        message: "Connection succeeded through an isolated minimal inference request.",
      });
    expect(request).toMatchObject({
      cwd: "/fixture/repository",
      prompt: "Reply exactly OK. Do not inspect files, call tools, run commands, or use repository context.",
      authProviderId: "codex-native-session",
      parameters: { model: "fixture-model", model_reasoning_effort: "low" },
    });
    expect(request?.timeoutMs).toBeGreaterThan(0);
    expect(request?.timeoutMs).toBeLessThanOrEqual(60_000);
  });

  it("keeps a preflight version mismatch and the affected configured executable", async () => {
    const codex = provider("codex-cli");
    codex.preflight = async ({ authProviderId }) => ({ providerId: "codex-cli", available: false,
      auth: { authProviderId, kind: "runtime-native", available: true, status: "ready" },
      message: "Command /private/bin/codex version 0.1 does not match required version 0.2." });
    const config = providerConfig();
    config.executionProviders["codex-cli"].command = "/private/bin/codex";
    const probe = new ExecutionAgentAuthConnectionProbe(new DefaultAgentExecutionProviderRegistry([codex]), config, "/fixture/repository", {});
    await expect(probe.probe({ authProviderId: "codex-native-session", executionProviderId: "codex-cli" })).resolves.toMatchObject({
      status: "failed", mechanism: "native-status", message: "Command /private/bin/codex version 0.1 does not match required version 0.2.",
    });
  });

  it("does not turn a transport failure into a login problem because of a redaction marker", async () => {
    const codex = provider("codex-cli");
    codex.run = async () => { throw new ExternalProviderError("codex-cli", connectionProbeDiagnostic("codex exec exited with code 1.\nstderr:\nError: transport disconnected Bearer abc123\nstdout:\n", {}, [])); };
    const probe = new ExecutionAgentAuthConnectionProbe(new DefaultAgentExecutionProviderRegistry([codex]), providerConfig(), "/fixture/repository", {});
    const result = await probe.probe({ authProviderId: "codex-native-session", executionProviderId: "codex-cli" });
    expect(result).toMatchObject({ status: "failed", message: "codex exec exited with code 1. Error: transport disconnected Bearer [redacted]" });
  });

  it("stops before inference when Codex cannot discover a default", async () => {
    const codex = provider("codex-cli");
    let executions = 0;
    codex.getConnectionProbeParameters = async () => { throw new ExternalProviderError("codex-cli", "Codex model catalog has no visible default. Retry Test connection."); };
    codex.run = async () => { executions++; throw new Error("must not run"); };
    const probe = new ExecutionAgentAuthConnectionProbe(new DefaultAgentExecutionProviderRegistry([codex]), providerConfig(), "/fixture/repository", {});
    expect(await probe.probe({ authProviderId: "codex-native-session", executionProviderId: "codex-cli" })).toMatchObject({
      status: "failed", mechanism: "provider-check", message: "Codex model catalog has no visible default. Retry Test connection.",
    });
    expect(executions).toBe(0);
  });

  it("reports missing catalog support rather than inheriting a personal default", async () => {
    const codex = provider("codex-cli");
    delete codex.getConnectionProbeParameters;
    const probe = new ExecutionAgentAuthConnectionProbe(new DefaultAgentExecutionProviderRegistry([codex]), providerConfig(), "/fixture/repository", {});
    expect(await probe.probe({ authProviderId: "codex-native-session", executionProviderId: "codex-cli" })).toMatchObject({
      status: "failed", mechanism: "provider-check", message: "Codex CLI model discovery is unavailable. Update the ArkiMux Codex adapter and retry.",
    });
  });

  it("checks CLI/login readiness before model discovery", async () => {
    const codex = provider("codex-cli");
    let catalogs = 0;
    codex.getConnectionProbeParameters = async () => { catalogs++; throw new Error("must not discover"); };
    codex.preflight = async ({ authProviderId }) => ({ providerId: "codex-cli", available: false,
      auth: { authProviderId, kind: "runtime-native", available: false, status: "unavailable", reason: "session-missing" },
      message: "Run codex login." });
    const probe = new ExecutionAgentAuthConnectionProbe(new DefaultAgentExecutionProviderRegistry([codex]), providerConfig(), "/fixture/repository", {});
    expect(await probe.probe({ authProviderId: "codex-native-session", executionProviderId: "codex-cli" })).toMatchObject({
      status: "action-required", mechanism: "native-status", message: "Run codex login.",
    });
    expect(catalogs).toBe(0);
  });

  it("retries a stable Pi catalog model when an earlier candidate is unavailable", async () => {
    const attemptedModels: string[] = [];
    const pi: AgentExecutionProvider = {
      providerId: "pi-cli",
      preflight: async ({ authProviderId }) => ({
        providerId: "pi-cli",
        auth: { authProviderId, kind: "environment", available: true, status: "ready" },
        available: true,
      }),
      run: async (value) => {
        const model = String(value.parameters.model);
        attemptedModels.push(model);
        if (model === "unavailable-model") {
          throw new ExternalProviderError("pi-cli", "Pi assistant message failed with error: model unavailable-model was not found or permission denied.");
        }
        return {
          output: "OK",
          metrics: {
            providerId: "pi-cli",
            model,
            status: "complete",
            elapsedMs: 20,
            nativeToolCalls: 0,
            toolCallUnit: "native-tool-call",
            artifacts: {
              eventsPath: `${value.artifactPrefix}.events.jsonl`,
              stderrPath: `${value.artifactPrefix}.stderr.log`,
              lastMessagePath: `${value.artifactPrefix}.last-message.txt`,
              heartbeatPath: `${value.artifactPrefix}.heartbeat.json`,
            },
          },
        };
      },
    };
    const probe = new ExecutionAgentAuthConnectionProbe(
      new DefaultAgentExecutionProviderRegistry([pi]),
      providerConfig(),
      "/fixture/repository",
      {},
      async () => ["unavailable-model", "stable-model"],
    );

    await expect(probe.probe({
      authProviderId: "kimi-platform-key",
      executionProviderId: "pi-cli",
      modelProvider: "moonshotai",
    })).resolves.toMatchObject({
      status: "connected",
      probeModel: "stable-model",
    });
    expect(attemptedModels).toEqual(["unavailable-model", "stable-model"]);
  });

  it.each([
    { modelProvider: "anthropic", error: '400 {"error":{"message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."},"request_id":"private-request"}', status: "action-required" },
    { modelProvider: "anthropic", error: "400 invalid request: unsupported parameter", status: "failed" },
    { modelProvider: "openai", error: "Third-party apps now draw from your extra usage, not your plan limits.", status: "failed" },
  ])("classifies Pi billing rejection without retrying or guessing account status: $modelProvider / $status", async ({ modelProvider, error, status }) => {
    let attempts = 0;
    const pi = provider("pi-cli");
    pi.run = async () => { attempts++; throw new ExternalProviderError("pi-cli", connectionProbeDiagnostic(`Pi assistant message failed with error: ${error}`, {}, [])); };
    const probe = new ExecutionAgentAuthConnectionProbe(
      new DefaultAgentExecutionProviderRegistry([pi]), providerConfig(), "/fixture/repository", {},
      async () => ["first-model", "second-model"],
    );
    const result = await probe.probe({ authProviderId: "pi-connection", executionProviderId: "pi-cli", modelProvider });
    expect(result.status).toBe(status);
    expect(attempts).toBe(1);
    if (status === "action-required") {
      expect(result.message).toContain("Third-party apps now draw from your extra usage, not your plan limits.");
      expect(result.message).toContain("claude.ai/settings/usage");
      expect(result.message).toContain("request_id: private-request");
      expect(result.message).not.toMatch(/free plan|ineligible/i);
    }
  });
});

function providerConfig(): ResolvedAgentProviderConfig {
  const runtime = (command: string) => ({ command, heartbeatIntervalMs: 15_000, environmentAllowlist: ["PATH", "TMPDIR"] });
  return {
    schemaVersion: 1,
    executionProviders: {
      "codex-cli": runtime("codex"),
      "pi-cli": runtime("pi"),
      "claude-code-cli": runtime("claude"),
      "kimi-code-cli": runtime("kimi"),
    },
    authProviders: {},
    legacyEnvironmentOverrides: [],
  };
}
