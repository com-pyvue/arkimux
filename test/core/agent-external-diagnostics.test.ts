import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAuthProviderRegistry, AgentExecutionProvider, AgentExecutionRequest } from "../../core/src/application/agentProvider.ts";
import { ExternalProviderError, getExternalErrorDiagnostic } from "../../core/src/application/externalError.ts";
import { createAgentAuthProviderRegistry } from "../../core/src/infrastructure/agents/agentAuthProvider.ts";
import { CodexCliAgentRunner } from "../../core/src/infrastructure/agents/codexCliAgentRunner.ts";
import { ClaudeCodeCliAgentRunner, parseClaudeCodeStream } from "../../core/src/infrastructure/agents/claudeCodeCliAgentRunner.ts";
import { KimiCodeCliAgentRunner } from "../../core/src/infrastructure/agents/kimiCodeCliAgentRunner.ts";
import { PiCliAgentRunner } from "../../core/src/infrastructure/agents/piCliAgentRunner.ts";
import { ExecutionAgentAuthConnectionProbe } from "../../core/src/infrastructure/agents/agentAuthConnectionProbe.ts";
import type { ResolvedAgentProviderConfig } from "../../core/src/infrastructure/agents/agentProviderConfigProvider.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function temporary() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-external-error-")); roots.push(root); return root; }
function config(root: string, command: string): ResolvedAgentProviderConfig {
  const runtime = { command, parentHome: root, heartbeatIntervalMs: 100, environmentAllowlist: ["PATH"] };
  return { schemaVersion: 1, executionProviders: { "codex-cli": runtime, "claude-code-cli": runtime, "kimi-code-cli": runtime, "pi-cli": runtime }, authProviders: {}, legacyEnvironmentOverrides: [] };
}

describe("external agent failures", () => {
  const runtimeIds = ["codex-cli", "claude-code-cli", "kimi-code-cli", "pi-cli"] as const;
  const failureCases = runtimeIds.flatMap((id) => ["error-event", "plain-stderr", "json-message"].map((mode) => ({ id, mode })));
  failureCases.push(...(["codex-cli", "kimi-code-cli"] as const).flatMap((id) => ["zero-exit", "zero-exit-partial"].map((mode) => ({ id, mode }))));
  it.each(failureCases)("keeps $id $mode errors and scrubs the actual custom credential binding", async ({ id, mode }) => {
    const root = await temporary(), command = path.join(root, "fixture-cli.mjs");
    await fs.writeFile(command, `#!${process.execPath}
import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('0.145.0'); process.exit(0); }
if (Object.keys(process.env).some(key => key.startsWith('ARKIMUX_RESOLVED_SECRET_'))) throw new Error('redaction-only map leaked into CLI');
const message = 'Rejected ' + process.env.CUSTOM_BINDING + '. Retry after 43 seconds.\\nSupported values: [low, medium]. See https://provider.example/help';
const id = ${JSON.stringify(id)};
const mode = ${JSON.stringify(mode)};
const selectedMessage = mode === 'json-message' ? JSON.stringify({error:{message},prompt:'literal explanation'}) : message;
const event = id === 'claude-code-cli' ? {type:'result',is_error:true,result:selectedMessage} : id === 'pi-cli' ? {type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:selectedMessage}} : {type:id === 'codex-cli' ? 'turn.failed' : 'error',message:selectedMessage};
process.stdin.resume(); process.stdin.on('end', () => {
  if (mode === 'zero-exit-partial') {
    console.log(JSON.stringify({role:'assistant',content:'partial output'}));
    const outputIndex = process.argv.indexOf('--output-last-message');
    if (outputIndex >= 0) fs.writeFileSync(process.argv[outputIndex + 1], 'partial output');
  }
  if (mode === 'plain-stderr') console.error(message); else console.log(JSON.stringify(event));
  process.exit(mode === 'plain-stderr' ? 1 : mode.startsWith('zero-exit') || id === 'claude-code-cli' || id === 'pi-cli' ? 0 : 1);
});
`, { mode: 0o700 });
    const configuration = config(root, command);
    let disposed = false;
    const auth: AgentAuthProviderRegistry = { get: () => ({ authProviderId: "fixture", kind: "stored-credential",
      preflight: async () => ({ authProviderId: "fixture", kind: "stored-credential", available: true, status: "ready" }),
      prepare: async () => ({ environment: { CUSTOM_BINDING: "opaque-resolved-value" }, dispose: async () => { disposed = true; } }),
    }) };
    const environment = { PATH: path.dirname(process.execPath) };
    const runtime = configuration.executionProviders[id];
    const runner: AgentExecutionProvider = id === "codex-cli" ? new CodexCliAgentRunner(runtime, auth, environment)
      : id === "claude-code-cli" ? new ClaudeCodeCliAgentRunner(runtime, auth, environment)
        : id === "kimi-code-cli" ? new KimiCodeCliAgentRunner(runtime, auth, environment) : new PiCliAgentRunner(runtime, auth, environment);
    const request: AgentExecutionRequest = { cwd: root, prompt: "OK", timeoutMs: 5_000, authProviderId: "fixture",
      artifactPrefix: path.join(root, "attempt"), parameters: id === "pi-cli" ? { provider: "anthropic", model: "fixture" } : { model: "fixture" } };
    const failure = await runner.run(request).then(() => undefined, (error: unknown) => error);
    const diagnostic = getExternalErrorDiagnostic(failure);
    expect(failure).toMatchObject({ failureCode: "agent_provider_failed" });
    expect(diagnostic).toMatchObject({ origin: "external", provider: id });
    const expected = "Rejected [redacted]. Retry after 43 seconds.\nSupported values: [low, medium]. See https://provider.example/help";
    expect(diagnostic?.message).toContain(mode === "json-message" ? JSON.stringify({ error: { message: expected }, prompt: "literal explanation" }) : expected);
    expect(diagnostic?.message).not.toContain("opaque-resolved-value");
    expect(failure).toMatchObject({ metrics: { status: "failed" } });
    expect(disposed).toBe(true);
  });

  it("scrubs custom prepared credentials in metadata discovery messages and codes without injecting redaction state", async () => {
    const root = await temporary(), command = path.join(root, "fixture-catalog.mjs");
    await fs.writeFile(command, `#!${process.execPath}
import readline from 'node:readline';
if (Object.keys(process.env).some(key => key.startsWith('ARKIMUX_RESOLVED_SECRET_'))) throw new Error('redaction-only map leaked into CLI');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') console.log(JSON.stringify({id:request.id,result:{}}));
  if (request.method === 'model/list') console.log(JSON.stringify({id:request.id,error:{message:'Rejected ' + process.env.CUSTOM_BINDING,code:'denied-' + process.env.CUSTOM_BINDING}}));
});
`, { mode: 0o700 });
    const configuration = config(root, command);
    let disposed = false;
    const auth: AgentAuthProviderRegistry = { get: () => ({ authProviderId: "fixture", kind: "stored-credential",
      preflight: async () => ({ authProviderId: "fixture", kind: "stored-credential", available: true, status: "ready" }),
      prepare: async () => ({ environment: { CUSTOM_BINDING: "opaque-resolved-value" }, dispose: async () => { disposed = true; } }),
    }) };
    const runner = new CodexCliAgentRunner(configuration.executionProviders["codex-cli"], auth, { PATH: path.dirname(process.execPath) });
    const failure = await runner.getConnectionProbeParameters({ cwd: root, authProviderId: "fixture", parameters: {}, timeoutMs: 3000 }).then(() => undefined, (error: unknown) => error);
    expect(getExternalErrorDiagnostic(failure)).toMatchObject({ message: "Codex model discovery failed: Rejected [redacted]", code: "denied-[redacted]" });
    expect(disposed).toBe(true);
  });

  it.each(runtimeIds)("preserves $s preflight classification without relabelling internal errors", async (id) => {
    const root = await temporary();
    const configuration = config(root, "unused");
    const auth: AgentAuthProviderRegistry = { get: () => { throw new Error("must not reach auth"); } };
    const runner = id === "codex-cli" ? new CodexCliAgentRunner(configuration.executionProviders[id], auth, {})
      : id === "claude-code-cli" ? new ClaudeCodeCliAgentRunner(configuration.executionProviders[id], auth, {})
        : id === "kimi-code-cli" ? new KimiCodeCliAgentRunner(configuration.executionProviders[id], auth, {}) : new PiCliAgentRunner(configuration.executionProviders[id], auth, {});
    const request: AgentExecutionRequest = { cwd: root, prompt: "OK", timeoutMs: 1000, authProviderId: "fixture", artifactPrefix: path.join(root, "unused"), parameters: {} };
    for (const external of [false, true]) {
      const diagnostic = new ExternalProviderError(id, "Provider busy. Retry after 42 seconds.", { code: "busy", httpStatus: 429 }).externalDiagnostic;
      runner.preflight = async () => ({ providerId: id, available: false,
        auth: { authProviderId: "fixture", kind: "environment", available: false, status: "unavailable" },
        message: external ? diagnostic.message : "private internal state", ...(external ? { externalDiagnostic: diagnostic } : {}) });
      const failure = await runner.run(request).then(() => undefined, (error: unknown) => error);
      expect(getExternalErrorDiagnostic(failure)).toEqual(external ? diagnostic : undefined);
      expect((failure as Error).message).not.toContain("private internal state");
    }
  });

  it("does not accept Claude terminal errors as successful output", () => {
    expect(() => parseClaudeCodeStream(JSON.stringify({ type: "result", is_error: true, result: "Billing disabled. Enable API billing." })))
      .toThrow("Billing disabled. Enable API billing.");
    expect(() => parseClaudeCodeStream(JSON.stringify({ type: "result", is_error: true, errors: ["First cause", "Second cause"] })))
      .toThrow("First cause\nSecond cause");
  });

  it.each(["codex-cli", "claude-code-cli", "kimi-code-cli"] as const)("does not convert %s status process failures into missing login", async (id) => {
    const root = await temporary(), command = path.join(root, "fixture-status.mjs");
    await fs.writeFile(command, `#!${process.execPath}\nconsole.error('Error loading config: invalid value\\nin model_reasoning_effort. Retry after 12 seconds.'); process.exit(1);\n`, { mode: 0o700 });
    const configuration = config(root, command);
    configuration.authProviders.fixture = { kind: "runtime-native", runtime: id };
    const registry = createAgentAuthProviderRegistry(configuration, { PATH: path.dirname(process.execPath) });
    const result = await registry.get("fixture").preflight({ cwd: root, executionProviderId: id, model: "fixture" });
    expect(result).toMatchObject({ available: false, reason: "provider-unavailable", externalDiagnostic: { origin: "external", provider: id, message: result.message } });
    expect(result.message).toContain("Error loading config: invalid value\nin model_reasoning_effort. Retry after 12 seconds.");
    expect(result.message).not.toContain("could not find an active");
  });

  it("sanitizes unexpected probe errors and does not retry them as model-access errors", async () => {
    const root = await temporary();
    let runs = 0;
    const runner: AgentExecutionProvider = { providerId: "pi-cli", preflight: async () => ({ providerId: "pi-cli", available: true,
      auth: { authProviderId: "fixture", kind: "environment", available: true, status: "ready" } }),
      run: async () => { runs++; throw new TypeError("Internal model unavailable lookup read private implementation state"); } };
    const probe = new ExecutionAgentAuthConnectionProbe({ get: () => runner }, config(root, "unused"), root, {}, async () => ["one", "two"]);
    const result = await probe.probe({ authProviderId: "fixture", executionProviderId: "pi-cli", modelProvider: "anthropic" });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("failed inside ArkiMux");
    expect(result.message).not.toContain("private implementation");
    expect(runs).toBe(1);
  });

  it("preserves a typed multiline provider error through the probe", async () => {
    const root = await temporary();
    const message = "Rate limit exceeded.\nRetry after 43 seconds. See https://provider.example/usage";
    const runner: AgentExecutionProvider = { providerId: "pi-cli", preflight: async () => ({ providerId: "pi-cli", available: true,
      auth: { authProviderId: "fixture", kind: "environment", available: true, status: "ready" } }),
      run: async () => { throw new ExternalProviderError("pi-cli", message + " parent-secret", { code: "quota-parent-secret", httpStatus: 429 }); } };
    const probe = new ExecutionAgentAuthConnectionProbe({ get: () => runner }, config(root, "unused"), root, { AUTH: "parent-secret" }, async () => ["one"]);
    expect(await probe.probe({ authProviderId: "fixture", executionProviderId: "pi-cli", modelProvider: "anthropic" }))
      .toMatchObject({ status: "failed", message: message + " [redacted]", externalDiagnostic: { message: message + " [redacted]", code: "quota-[redacted]", httpStatus: 429 } });
  });
});
