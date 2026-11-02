import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createAgentAuthProviderRegistry, createAgentExecutionProviderRegistry,
  FilePlaintextAgentCredentialStore, withStoredAgentAuthProviders,
  validateAgentExecutionMetrics,
  type AgentExecutionMetrics, type AgentExecutionRequest, type ResolvedAgentProviderConfig,
} from "../../../core/src/index.ts";

// Synthetic authentication and CLI processes only. This does not prove live
// eligibility, actual CLI compatibility, workflow replay or Results API reads.
const rows = [
  { id: "codex-openai-native-session", runtime: "codex-cli", provider: "openai", kind: "runtime-native" },
  { id: "pi-openai-codex-native-session", runtime: "pi-cli", provider: "openai-codex", kind: "runtime-native" },
  { id: "pi-anthropic-api-key", runtime: "pi-cli", provider: "anthropic", kind: "stored-credential" },
  { id: "claude-anthropic-native-session", runtime: "claude-code-cli", provider: "anthropic", kind: "runtime-native" },
] as const;
type Row = typeof rows[number];
type Outcome = "complete" | "failure" | "cancel" | "timeout";
const resultSchema = z.strictObject({ schemaVersion: z.literal(1), answer: z.number().int() });
const key = "synthetic-selected-anthropic-key-442211";
const roots: string[] = [], controllers: AbortController[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort());
  await Promise.allSettled(pending.splice(0));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(row: Row, outcome: Outcome, missingCredential = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arkimux-four-connections-")); roots.push(root);
  const home = path.join(root, "native"); await fs.mkdir(home);
  // Pi API-key checks deliberately have an eligible native session available:
  // it must not be copied as a fallback when a stored Credential is selected.
  await fs.writeFile(path.join(home, "auth.json"), JSON.stringify({
    fixtureSession: true,
    "openai-codex": { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: 0 },
    anthropic: { type: "oauth", access: "wrong-native-session", refresh: "wrong-refresh", expires: 0 },
  }));
  await fs.writeFile(path.join(home, "claude-session"), "synthetic-session");
  const command = path.join(root, "fake-cli.mjs");
  await fs.writeFile(command, `#!${process.execPath}
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
const row=${JSON.stringify(row)}, outcome=${JSON.stringify(outcome)}, expectedKey=${JSON.stringify(key)};
const authFile = directory => path.join(directory, 'auth.json');
if(process.argv.includes('--version')) { console.log('0.0.0-controlled'); process.exit(0); }
if(process.argv.slice(2).join(' ')==='login status') {
  if(!existsSync(authFile(process.env.CODEX_HOME))) { console.error('Not logged in'); process.exit(1); }
  console.log('Logged in using ChatGPT'); process.exit(0);
}
if(process.argv.slice(2).join(' ')==='auth status --json') {
  console.log(JSON.stringify({loggedIn:existsSync(path.join(process.env.CLAUDE_CONFIG_DIR,'claude-session')),authMethod:'claude.ai',subscriptionType:'pro'})); process.exit(0);
}
if(process.env.UNRELATED_SECRET || Object.keys(process.env).some(k=>k.startsWith('ARKIMUX_RESOLVED_SECRET_'))) throw new Error('Unexpected inherited environment');
if(row.kind==='stored-credential') {
  if(process.env.ANTHROPIC_API_KEY!==expectedKey) throw new Error('Selected Credential missing');
  if(existsSync(authFile(process.env.PI_CODING_AGENT_DIR))) throw new Error('Native session fallback leaked into API-key execution');
} else {
  if(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) throw new Error('Native mode inherited an API key');
  if(row.runtime==='pi-cli' && !JSON.parse(readFileSync(authFile(process.env.PI_CODING_AGENT_DIR))).hasOwnProperty('openai-codex')) throw new Error('Selected Pi session missing');
  if(row.runtime==='codex-cli' && !existsSync(authFile(process.env.CODEX_HOME))) throw new Error('Selected Codex session missing');
  if(row.runtime==='claude-code-cli' && !existsSync(path.join(process.env.CLAUDE_CONFIG_DIR,'claude-session'))) throw new Error('Selected Claude session missing');
}
if(row.runtime==='pi-cli' && process.argv[process.argv.indexOf('--provider')+1]!==row.provider) throw new Error('Wrong model provider');
writeFileSync('started.json',JSON.stringify({pid:process.pid,authChecked:true,provider:row.provider}));
process.stdin.resume(); process.stdin.on('end',()=>{
  if(outcome==='cancel'||outcome==='timeout') { setInterval(()=>appendFileSync('ticks','x'),20); return; }
  if(row.runtime==='claude-code-cli') console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'tool-1',name:'Read',input:{}}]}}));
  if(outcome==='failure') { console.error('Provider refused fixture request. Retry after 43 seconds. https://provider.example/help'+(row.kind==='stored-credential'?' '+expectedKey:'')); process.exitCode=1; return; }
  const output=JSON.stringify({schemaVersion:1,answer:11});
  if(row.runtime==='codex-cli') {
    writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],output);
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
  } else if(row.runtime==='pi-cli') {
    const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:output}],usage:{input:1,output:1}};
    console.log(JSON.stringify({type:'message_end',message})); console.log(JSON.stringify({type:'agent_end',messages:[message]}));
  } else console.log(JSON.stringify({type:'result',result:output,usage:{input_tokens:1,output_tokens:1}}));
});
`, { mode: 0o700 });
  const runtime = { command, parentHome: home, agentDirectory: home, heartbeatIntervalMs: 20, environmentAllowlist: ["PATH"] };
  let config: ResolvedAgentProviderConfig = { schemaVersion: 1,
    executionProviders: { "codex-cli": runtime, "pi-cli": runtime, "claude-code-cli": runtime, "kimi-code-cli": runtime },
    authProviders: {}, legacyEnvironmentOverrides: [] };
  const credentials = new FilePlaintextAgentCredentialStore(path.join(root, "credentials"));
  if (row.kind === "stored-credential") {
    if (!missingCredential) await credentials.create({ schemaVersion: 1, credentialId: "selected-key", displayName: "Synthetic", kind: "api-key", modelProvider: "anthropic" }, key);
    config = withStoredAgentAuthProviders(config, [{ schemaVersion: 2, authProviderId: row.id, displayName: row.id,
      kind: "stored-credential", executionProviderId: "pi-cli", modelProvider: "anthropic", credentialId: "selected-key", targetVariable: "ANTHROPIC_API_KEY" }]);
  } else config.authProviders[row.id] = { kind: "runtime-native", runtime: row.runtime, modelProvider: row.provider };
  const environment = { PATH: path.dirname(process.execPath), HOME: root, USER: "fixture", CLAUDE_CONFIG_DIR: home,
    ANTHROPIC_API_KEY: "unselected-shell-key", OPENAI_API_KEY: "unselected-openai-key", UNRELATED_SECRET: "unrelated-secret" };
  const runner = createAgentExecutionProviderRegistry(config, createAgentAuthProviderRegistry(config, environment, credentials), environment).get(row.runtime);
  const controller = new AbortController(); controllers.push(controller);
  const request: AgentExecutionRequest = { cwd: root, prompt: "Return the controlled result.",
    parameters: { model: "controlled-model", ...(row.runtime === "pi-cli" ? { provider: row.provider } : {}) },
    authProviderId: row.id, artifactPrefix: path.join(root, "attempt"), signal: controller.signal, timeoutMs: outcome === "timeout" ? 1500 : 5000 };
  return { root, runner, request, controller };
}

describe.each(rows)("$id controlled Connection contract", row => {
  for (const outcome of ["complete", "failure", "cancel", "timeout"] as const) it(outcome, async () => {
    const f = await fixture(row, outcome);
    const preflight = await f.runner.preflight(f.request);
    expect(preflight, preflight.message).toMatchObject({ available: true, auth: { kind: row.kind } });
    const settled = f.runner.run(f.request).then(value => ({ value }), (error: unknown) => ({ error }));
    pending.push(settled);
    await vi.waitFor(() => fs.access(path.join(f.root, "started.json")), { timeout: 4000 });
    const started = JSON.parse(await fs.readFile(path.join(f.root, "started.json"), "utf8"));
    expect(started).toMatchObject({ authChecked: true, provider: row.provider });
    if (outcome === "cancel") f.controller.abort();
    const result = await settled;
    let metrics: AgentExecutionMetrics;
    if ("value" in result) {
      expect(outcome).toBe("complete");
      expect(resultSchema.parse(JSON.parse(result.value.output))).toEqual({ schemaVersion: 1, answer: 11 });
      metrics = result.value.metrics;
    } else {
      expect(outcome).not.toBe("complete");
      const codes = { failure: "agent_provider_failed", cancel: "agent_cancelled", timeout: "agent_timed_out" };
      expect(result.error).toMatchObject({ failureCode: codes[outcome as keyof typeof codes] });
      if (outcome === "failure") expect((result.error as Error).message).toBe(
        `${row.runtime === "codex-cli" ? "codex exec" : row.runtime === "pi-cli" ? "pi" : "claude"} exited with code 1. Provider refused fixture request. Retry after 43 seconds. https://provider.example/help${row.kind === "stored-credential" ? " [redacted]" : ""}`);
      metrics = (result.error as Error & { metrics: AgentExecutionMetrics }).metrics;
    }
    expect(metrics.status).toBe(outcome === "complete" ? "complete" : outcome === "timeout" ? "timed-out" : "failed");
    expect(validateAgentExecutionMetrics(metrics)).toEqual(metrics);
    if (row.runtime === "claude-code-cli" && ["complete", "failure"].includes(outcome)) {
      expect(metrics).toMatchObject({ nativeToolCalls: 1, toolCallUnit: "native-tool-call" });
    }
    expect(() => process.kill(started.pid, 0)).toThrow();
    const files = await fs.readdir(f.root);
    const snapshots = new Map<string, string>();
    for (const name of files.filter(name => name.startsWith("attempt.") || name === "ticks")) {
      const text = await fs.readFile(path.join(f.root, name), "utf8"); snapshots.set(name, text);
      for (const secret of [key, "unselected-shell-key", "unselected-openai-key", "unrelated-secret"]) expect(text).not.toContain(secret);
      if (outcome === "cancel" || outcome === "timeout") expect(text).not.toContain('"answer":11');
    }
    await new Promise(resolve => setTimeout(resolve, 120));
    for (const [name, text] of snapshots) expect(await fs.readFile(path.join(f.root, name), "utf8")).toBe(text);
    expect((await fs.readdir(f.root)).sort()).toEqual(files.sort());
  });
});

it("missing Pi Anthropic Credential cannot fall back to its available native session or shell key", async () => {
  const f = await fixture(rows[2], "complete", true);
  await expect(f.runner.preflight(f.request)).resolves.toMatchObject({ available: false });
  await expect(f.runner.run(f.request)).rejects.toThrow();
  await expect(fs.access(path.join(f.root, "started.json"))).rejects.toMatchObject({ code: "ENOENT" });
});
