import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentAuthProviderRegistry } from "../../core/src/infrastructure/agents/agentAuthProvider.ts";
import { CodexCliAgentRunner } from "../../core/src/infrastructure/agents/codexCliAgentRunner.ts";
import { ExecutionAgentAuthConnectionProbe } from "../../core/src/infrastructure/agents/agentAuthConnectionProbe.ts";
import type { ResolvedAgentProviderConfig } from "../../core/src/infrastructure/agents/agentProviderConfigProvider.ts";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

async function fixture(native: boolean) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-probe-model-test-"));
  roots.push(root);
  const parentHome = path.join(root, "parent-home"), childHome = path.join(root, "configured-child-home");
  await fs.mkdir(parentHome);
  await fs.mkdir(childHome);
  const personalConfig = 'model = "personal-astra"\nmodel_reasoning_effort = "high"\n[mcp_servers.private]\ncommand = "must-not-run"\n';
  await fs.writeFile(path.join(parentHome, "config.toml"), personalConfig);
  await fs.writeFile(path.join(parentHome, "AGENTS.md"), "must-not-load-personal-instructions");
  await fs.writeFile(path.join(parentHome, "auth.json"), "synthetic-native-session");
  await fs.writeFile(path.join(childHome, "sentinel"), "preserve-configured-home");
  const modelFile = path.join(root, "model.json"), callsFile = path.join(root, "calls.jsonl");
  await fs.writeFile(modelFile, JSON.stringify({ model: "catalog-sol", effort: "low" }));
  const bin = path.join(root, "node_modules", ".bin");
  await fs.mkdir(bin, { recursive: true });
  const command = path.join(bin, "codex");
  await fs.writeFile(command, `#!${process.execPath}
import { appendFileSync, readFileSync, existsSync, writeFileSync, realpathSync } from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const record = value => appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(value) + '\\n');
if (args[0] === '--version') { console.log('codex-cli 0.145.0'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'app-server') {
  record({ kind: 'catalog', cwd: process.cwd(), home: realpathSync(home), config: readFileSync(home + '/config.toml', 'utf8'),
    hasInstructions: existsSync(home + '/AGENTS.md'), hasAuth: existsSync(home + '/auth.json'),
    apiKey: process.env.OPENAI_API_KEY, unrelated: process.env.UNRELATED_SECRET, args });
  readline.createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    record({ kind: 'rpc', method: request.method });
    if (request.method === 'initialize') console.log(JSON.stringify({ id: request.id, result: {} }));
    else if (request.method === 'model/list') {
      const selected = JSON.parse(readFileSync(${JSON.stringify(modelFile)}, 'utf8'));
      console.log(JSON.stringify({ id: request.id, result: { data: selected.empty ? [] : [{
        id: 'different-catalog-id', model: selected.model, isDefault: true, hidden: false,
        defaultReasoningEffort: selected.effort, supportedReasoningEfforts: [{ reasoningEffort: selected.effort }],
      }], nextCursor: null } }));
    } else if (request.method !== 'initialized') process.exit(13);
  });
} else if (args[0] === 'exec') {
  let prompt = '';
  process.stdin.on('data', data => { prompt += data; });
  process.stdin.on('end', () => {
    record({ kind: 'exec', cwd: process.cwd(), home, args, prompt,
      apiKey: process.env.OPENAI_API_KEY, hasAuth: existsSync(home + '/auth.json'), unrelated: process.env.UNRELATED_SECRET });
    writeFileSync(args[args.indexOf('--output-last-message') + 1], 'OK');
    console.log(JSON.stringify({ type: 'turn.completed' }));
  });
} else process.exit(14);
`, { mode: 0o700 });
  const runtime = { command: "codex", requiredVersion: "0.145.0", heartbeatIntervalMs: 15_000,
    environmentAllowlist: ["PATH", "TMPDIR"], parentHome, childHome };
  const config: ResolvedAgentProviderConfig = {
    schemaVersion: 1,
    executionProviders: { "codex-cli": runtime, "pi-cli": runtime, "claude-code-cli": runtime, "kimi-code-cli": runtime },
    authProviders: { selected: native ? { kind: "runtime-native", runtime: "codex-cli", modelProvider: "openai" }
      : { kind: "environment", sourceVariable: "SELECTED_KEY", targetVariable: "OPENAI_API_KEY" } },
    legacyEnvironmentOverrides: [],
  };
  const environment = { PATH: "/usr/bin:/bin", TMPDIR: root, SELECTED_KEY: "synthetic-selected-key",
    OPENAI_API_KEY: "wrong-ambient-key", UNRELATED_SECRET: "must-not-propagate" };
  const runner = new CodexCliAgentRunner(runtime, createAgentAuthProviderRegistry(config, environment), environment);
  const probe = new ExecutionAgentAuthConnectionProbe({ get: () => runner }, config, root, environment);
  const target = { authProviderId: "selected", executionProviderId: "codex-cli" as const, modelProvider: "openai" };
  const calls = async () => (await fs.readFile(callsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  return { root, parentHome, childHome, personalConfig, modelFile, probe, target, runner, calls, runtime, callsFile };
}

describe("Codex probe model selection integration", () => {
  it("does not start metadata after auth preparation consumes the discovery budget", async () => {
    const f = await fixture(true);
    let now = Date.now(), disposed = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const runner = new CodexCliAgentRunner(f.runtime, { get: () => ({
      authProviderId: "selected", kind: "runtime-native",
      preflight: async () => { throw new Error("unused"); },
      prepare: async () => { now += 100; return { environment: {}, dispose: async () => { disposed++; } }; },
    }) }, {});
    await expect(runner.getConnectionProbeParameters({ cwd: f.root, authProviderId: "selected", parameters: {}, timeoutMs: 50 }))
      .rejects.toThrow("Codex model discovery timed out before reading the catalog");
    expect(disposed).toBe(1);
    await expect(fs.stat(f.callsFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(f.childHome)).toEqual(["sentinel"]);
  });

  it.each([true, false])("uses the project CLI catalog and the selected auth binding (native: %s)", async native => {
    const f = await fixture(native);
    expect(await f.probe.probe(f.target)).toMatchObject({ status: "connected", probeModel: "catalog-sol", mechanism: "minimal-inference" });
    await fs.writeFile(f.modelFile, JSON.stringify({ model: "future-default", effort: "medium" }));
    expect(await f.probe.probe(f.target)).toMatchObject({ status: "connected", probeModel: "future-default" });
    const calls = await f.calls(), catalogs = calls.filter(call => call.kind === "catalog"), executions = calls.filter(call => call.kind === "exec");
    expect(catalogs).toHaveLength(2);
    expect(executions).toHaveLength(2);
    for (const call of [...catalogs, ...executions]) {
      expect(call.hasAuth).toBe(native);
      expect(call.apiKey).toBe(native ? undefined : "synthetic-selected-key");
      expect(call.unrelated).toBeUndefined();
    }
    for (const catalog of catalogs) {
      expect(catalog.cwd).toBe(catalog.home);
      expect(catalog.home).not.toBe(f.childHome);
      expect(catalog.config).toBe("");
      expect(catalog.hasInstructions).toBe(false);
      await expect(fs.stat(catalog.home)).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(executions[0].args).toContain('model="catalog-sol"');
    expect(executions[0].args).toContain('model_reasoning_effort="low"');
    expect(executions[1].args).toContain('model="future-default"');
    expect(executions[1].args).toContain('model_reasoning_effort="medium"');
    expect(calls.filter(call => call.kind === "rpc").map(call => call.method)).toEqual([
      "initialize", "initialized", "model/list", "initialize", "initialized", "model/list",
    ]);
    expect(await fs.readFile(path.join(f.parentHome, "config.toml"), "utf8")).toBe(f.personalConfig);
    expect(await fs.readFile(path.join(f.childHome, "sentinel"), "utf8")).toBe("preserve-configured-home");

    // A real workflow request keeps its explicit model/effort and never consults the probe catalog.
    await f.runner.run({ cwd: f.root, authProviderId: "selected", prompt: "fixture workflow", timeoutMs: 5_000,
      artifactPrefix: path.join(f.root, "workflow"), parameters: { model: "workflow-luna", model_reasoning_effort: "high" } });
    const after = await f.calls();
    expect(after.filter(call => call.kind === "catalog")).toHaveLength(2);
    expect(after.at(-1).args).toContain('model="workflow-luna"');
    expect(after.at(-1).args).toContain('model_reasoning_effort="high"');
  });

  it("cleans up the catalog home and does not start inference when no default is available", async () => {
    const f = await fixture(true);
    await fs.writeFile(f.modelFile, JSON.stringify({ empty: true }));
    const result = await f.probe.probe(f.target);
    expect(result).toMatchObject({ status: "failed", mechanism: "provider-check" });
    expect(result.probeModel).toBeUndefined();
    expect(result.message).toMatch(/default/i);
    const calls = await f.calls();
    expect(calls.some(call => call.kind === "exec")).toBe(false);
    await expect(fs.stat(calls.find(call => call.kind === "catalog").home)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(f.parentHome, "config.toml"), "utf8")).toBe(f.personalConfig);
    expect(await fs.readdir(f.childHome)).toEqual(["sentinel"]);
  });
});
