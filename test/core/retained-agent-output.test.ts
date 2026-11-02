import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentAuthProviderRegistry } from "../../core/src/application/agentProvider.ts";
import { createCredentialOutputRedactor, credentialValuesForRetention } from "../../core/src/infrastructure/agents/retainedAgentOutput.ts";
import { CodexCliAgentRunner } from "../../core/src/infrastructure/agents/codexCliAgentRunner.ts";
import { PiCliAgentRunner } from "../../core/src/infrastructure/agents/piCliAgentRunner.ts";
import { ClaudeCodeCliAgentRunner } from "../../core/src/infrastructure/agents/claudeCodeCliAgentRunner.ts";
import { KimiCodeCliAgentRunner } from "../../core/src/infrastructure/agents/kimiCodeCliAgentRunner.ts";

it("redacts raw, URL and nested JSON values across every split without changing other text", () => {
  const secret = 'selected-credential-"with/slash\n雪';
  const redactor = createCredentialOutputRedactor([secret, "", "short", "short-long"]);
  let encoded = secret;
  const forms = [secret, encodeURIComponent(secret), "short-long", "short"];
  for (let depth = 0; depth < 3; depth++) { encoded = JSON.stringify(encoded).slice(1, -1); forms.push(encoded); }
  for (const form of forms) {
    const text = `ordinary https://provider.example/help\n${form}\nRetry after 43 seconds.`;
    const expected = "ordinary https://provider.example/help\n[redacted]\nRetry after 43 seconds.";
    expect(redactor.redact(text)).toBe(expected);
    for (let split = 0; split <= text.length; split++) {
      const stream = redactor.stream();
      expect(stream.push(text.slice(0, split)) + stream.push(text.slice(split)) + stream.finish()).toBe(expected);
    }
    const stream = redactor.stream();
    expect([...text].map(char => stream.push(char)).join("") + stream.finish()).toBe(expected);
  }
  const stream = redactor.stream();
  expect(stream.push("ordinary shor")).toBe("ordinary ");
  expect(stream.finish()).toBe("shor");
  expect(createCredentialOutputRedactor([]).redact('{"token":12,"secret":"business value"}')).toBe('{"token":12,"secret":"business value"}');
  expect(createCredentialOutputRedactor(["key-\ud800"]).redact('key-\\ud800')).toBe("[redacted]");
});

const roots: string[] = [], controllers: AbortController[] = [];
it("does not treat native-session setup paths or locale as selected credentials", () => {
  const environment = { HOME: "/native/home", USER: "developer", LANG: "C", CLAUDE_CONFIG_DIR: "/native/config", AUTH_TOKEN: "actual-selected-token" };
  const redact = createCredentialOutputRedactor(credentialValuesForRetention(environment, environment, "runtime-native")).redact;
  expect(redact("C developer /native/home /native/config actual-selected-token")).toBe("C developer /native/home /native/config [redacted]");
  expect(credentialValuesForRetention({}, { CUSTOM_BINDING: "opaque-value" }, "stored-credential")).toEqual(["opaque-value"]);
});
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort());
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const secret = "selected-output-sentinel-938741";
const runners = [CodexCliAgentRunner, PiCliAgentRunner, ClaudeCodeCliAgentRunner, KimiCodeCliAgentRunner];
for (const Runner of runners) for (const mode of ["complete", "failure", "timeout", "cancel"] as const) {
  it(`${Runner.name} redacts retained output on ${mode}, including while running`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "retained-output-")); roots.push(root);
    const command = path.join(root, "fixture.mjs"), controller = new AbortController(); controllers.push(controller);
    await fs.writeFile(command, `#!${process.execPath}
import fs from 'node:fs';
if(process.argv.includes('--version')) { console.log('1.0.0'); process.exit(0); }
if(Object.keys(process.env).some(k=>k.startsWith('ARKIMUX_RESOLVED_SECRET_'))) throw new Error('redaction map must not reach child');
const secret = process.env.CUSTOM_BINDING;
if(secret !== ${JSON.stringify(secret)}) throw new Error('selected credential did not reach provider');
const mode = ${JSON.stringify(mode)};
const kind = ${JSON.stringify(Runner.name)};
process.stdin.resume();
const output = JSON.stringify({answer:11, echo:secret, note:'Retry after 43 seconds.'});
const messageIndex = process.argv.indexOf('--output-last-message');
if(messageIndex >= 0) {
  fs.writeFileSync(process.argv[messageIndex+1], output);
  fs.writeFileSync('private-message-path', process.argv[messageIndex+1]);
}
// Both streams split inside the known secret, not merely at a line boundary.
process.stdout.write('{"type":"'+secret.slice(0,14));
process.stderr.write('Provider note '+secret.slice(0,14));
fs.writeFileSync('partial-ready','yes');
const timer=setInterval(()=>{
  if(!fs.existsSync('continue')) return;
  clearInterval(timer);
  process.stdout.write(secret.slice(14)+'"}\\n');
  process.stderr.write(secret.slice(14)+' Retry after 43 seconds.\\n');
  if(mode==='timeout'||mode==='cancel') { fs.writeFileSync('waiting','yes'); setInterval(()=>{},1000); return; }
  if(mode==='failure') { process.exitCode=1; return; }
  const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:output}],usage:{input:1,output:1,totalTokens:2}};
  if(kind==='PiCliAgentRunner') console.log(JSON.stringify({type:'message_end',message}));
  const event=kind==='PiCliAgentRunner' ? {type:'agent_end',messages:[message]} : kind==='ClaudeCodeCliAgentRunner' ? {type:'result',subtype:'success',result:output} : kind==='KimiCodeCliAgentRunner' ? {role:'assistant',content:output} : {type:'turn.completed',usage:{input_tokens:1,output_tokens:1}};
  console.log(JSON.stringify(event));
},10);
`, { mode: 0o700 });
    const dispose = vi.fn(async () => undefined);
    const auth: AgentAuthProviderRegistry = { get: () => ({ authProviderId: "fixture", kind: "stored-credential",
      preflight: async () => ({ authProviderId: "fixture", kind: "stored-credential", available: true, status: "ready" }),
      prepare: async () => ({ environment: { CUSTOM_BINDING: secret }, dispose }),
    }) };
    const runner = new Runner({ command, parentHome: root, childHome: path.join(root, "configured-home"), heartbeatIntervalMs: 10, environmentAllowlist: ["PATH"] }, auth, { PATH: path.dirname(process.execPath) });
    const prefix = path.join(root, "attempt");
    const result = runner.run({ cwd: root, prompt: "OK", parameters: Runner === PiCliAgentRunner ? { provider: "anthropic", model: "fixture" } : { model: "fixture" },
      authProviderId: "fixture", artifactPrefix: prefix, timeoutMs: mode === "timeout" ? 1500 : 5000, signal: controller.signal }).then(value => ({ value }), error => ({ error }));
    await vi.waitFor(() => fs.access(path.join(root, "partial-ready")), { timeout: 3000 });
    for (const name of ["events.jsonl", "stderr.log", "heartbeat.json"]) {
      const text = await fs.readFile(`${prefix}.${name}`, "utf8");
      expect(text).not.toContain(secret.slice(0, 14));
    }
    if (Runner === CodexCliAgentRunner) await expect(fs.access(`${prefix}.last-message.txt`)).rejects.toMatchObject({ code: "ENOENT" });
    await fs.writeFile(path.join(root, "continue"), "yes");
    if (mode === "cancel") { await vi.waitFor(() => fs.access(path.join(root, "waiting"))); controller.abort(); }
    const outcome = await result;
    expect(dispose).toHaveBeenCalledOnce();
    if (mode === "complete") {
      expect("error" in outcome ? outcome.error : undefined).toBeUndefined();
      if ("value" in outcome) expect(JSON.parse(outcome.value.output)).toEqual({ answer: 11, echo: "[redacted]", note: "Retry after 43 seconds." });
    } else {
      expect("error" in outcome).toBe(true);
      expect("error" in outcome ? outcome.error : undefined).toMatchObject({
        failureCode: mode === "cancel" ? "agent_cancelled" : mode === "timeout" ? "agent_timed_out" : "agent_provider_failed",
      });
    }
    expect(JSON.stringify(outcome)).not.toContain(secret);
    for (const name of (await fs.readdir(root)).filter(name => name.startsWith("attempt."))) {
      const text = await fs.readFile(path.join(root, name), "utf8");
      expect(text).not.toContain(secret);
      if (name.endsWith("stderr.log")) expect(text).toBe("Provider note [redacted] Retry after 43 seconds.\n");
    }
    if (Runner === CodexCliAgentRunner) {
      const privatePath = await fs.readFile(path.join(root, "private-message-path"), "utf8");
      expect(privatePath).not.toBe(`${prefix}.last-message.txt`);
      await expect(fs.access(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
}
