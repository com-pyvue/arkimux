import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAuthProviderRegistry, AgentExecutionRequest } from "../../core/src/application/agentProvider.ts";
import { CodexCliAgentRunner } from "../../core/src/infrastructure/agents/codexCliAgentRunner.ts";
import { PiCliAgentRunner } from "../../core/src/infrastructure/agents/piCliAgentRunner.ts";
import { ClaudeCodeCliAgentRunner } from "../../core/src/infrastructure/agents/claudeCodeCliAgentRunner.ts";
import { KimiCodeCliAgentRunner } from "../../core/src/infrastructure/agents/kimiCodeCliAgentRunner.ts";
import { disposeAgentResources } from "../../core/src/infrastructure/agents/agentProcessLifetime.ts";
import { runStreamingCli } from "../../core/src/infrastructure/agents/nativeStreamingCliProcess.ts";
import { probeCliExecutable } from "../../core/src/infrastructure/agents/cliExecutableResolver.ts";

const roots: string[] = [], controllers: AbortController[] = [], children: ChildProcess[] = [];
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.abort());
  children.splice(0).forEach(child => child.kill("SIGKILL"));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
async function fixture(body: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-lifetime-")); roots.push(root);
  const command = path.join(root, "agent.mjs");
  await fs.writeFile(command, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nimport {spawn} from 'node:child_process';\nif(process.argv.includes('--version')) {console.log('1.0.0');process.exit(0)}\n${body}`, { mode: 0o700 });
  const controller = new AbortController(); controllers.push(controller);
  const request: AgentExecutionRequest = { cwd: root, prompt: "OK", authProviderId: "fixture", parameters: { provider: "openai", model: "fixture" }, timeoutMs: 10_000, signal: controller.signal, artifactPrefix: path.join(root, "attempt") };
  return { root, controller, request, config: { command, heartbeatIntervalMs: 5, environmentAllowlist: ["PATH"] } };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const runningBody = `process.on('SIGTERM',()=>{});process.stdin.resume();writeFileSync('pid',String(process.pid));setInterval(()=>{},1000);`;
const runners = [CodexCliAgentRunner, PiCliAgentRunner, ClaudeCodeCliAgentRunner, KimiCodeCliAgentRunner];

describe("native agent cancellation lifetime", () => {
  for (const Runner of runners) {
    it(`${Runner.name} settles cancellation, authentication disposal and heartbeat writes`, async () => {
      const f = await fixture(runningBody);
      if (Runner !== PiCliAgentRunner) f.request.parameters = { model: "fixture" };
      const dispose = vi.fn(async () => undefined);
      const registry: AgentAuthProviderRegistry = { get: () => ({ authProviderId: "fixture", kind: "environment", preflight: async () => ({ authProviderId: "fixture", kind: "environment", available: true, status: "ready" }), prepare: async () => ({ environment: {}, dispose }) }) };
      const runner = new Runner(f.config, registry);
      const outcome = runner.run(f.request).catch(error => error);
      await vi.waitFor(async () => expect(Number(await fs.readFile(path.join(f.root, "pid"), "utf8"))).toBeGreaterThan(0), { timeout: 3000 });
      const pid = Number(await fs.readFile(path.join(f.root, "pid"), "utf8"));
      f.controller.abort();
      const error = await outcome;
      expect(error.message).toBe("Agent execution was cancelled.");
      expect(error.metrics.status).toBe("failed");
      expect(dispose).toHaveBeenCalledOnce();
      expect(alive(pid)).toBe(false);
      const heartbeat = await fs.readFile(`${f.request.artifactPrefix}.heartbeat.json`, "utf8");
      expect(JSON.parse(heartbeat).status).toBe("failed");
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(await fs.readFile(`${f.request.artifactPrefix}.heartbeat.json`, "utf8")).toBe(heartbeat);
    });

    it(`${Runner.name} does no work for an already cancelled request`, async () => {
      const f = await fixture(runningBody); f.controller.abort();
      const get = vi.fn();
      await expect(new Runner(f.config, { get }).run(f.request)).rejects.toMatchObject({ message: "Agent execution was cancelled.", failureCode: "agent_cancelled" });
      expect(get).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(f.root, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it(`${Runner.name} disposes authentication if cancelled while preparing it`, async () => {
      const f = await fixture(runningBody);
      if (Runner !== PiCliAgentRunner) f.request.parameters = { model: "fixture" };
      const dispose = vi.fn(async () => undefined);
      const registry: AgentAuthProviderRegistry = { get: () => ({ authProviderId: "fixture", kind: "environment", preflight: async () => ({ authProviderId: "fixture", kind: "environment", available: true, status: "ready" }), prepare: async () => { f.controller.abort(); return { environment: {}, dispose }; } }) };
      await expect(new Runner(f.config, registry).run(f.request)).rejects.toMatchObject({ message: "Agent execution was cancelled.", failureCode: "agent_cancelled" });
      expect(dispose).toHaveBeenCalledOnce();
      await expect(fs.stat(path.join(f.root, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }

  it("awaits every disposer and reports cleanup failure", async () => {
    const calls: string[] = [];
    await expect(disposeAgentResources([
      () => { throw new Error("first"); },
      async () => { await new Promise(resolve => setTimeout(resolve, 20)); calls.push("second"); },
    ])).rejects.toThrow("Agent resource cleanup failed");
    expect(calls).toEqual(["second"]);
  });

  it("does not leave a version probe running after its timeout", async () => {
    const f = await fixture("");
    await fs.writeFile(f.config.command, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\n${runningBody}`, { mode: 0o700 });
    const result = await probeCliExecutable(f.config.command, f.root, process.env, 1500);
    expect(result.available).toBe(false);
    expect(result.message).toContain("did not complete --version");
    expect(alive(Number(await fs.readFile(path.join(f.root, "pid"), "utf8")))).toBe(false);
  });

  it("kills a timed-out process that ignores SIGTERM before returning", async () => {
    const f = await fixture(runningBody);
    const outcome = runStreamingCli({ ...f.request, timeoutMs: 1500 }, f.config, process.env, { providerId: "fixture", args: [] });
    const result = await outcome;
    expect(result.timedOut).toBe(true);
    expect(alive(Number(await fs.readFile(path.join(f.root, "pid"), "utf8")))).toBe(false);
    expect(JSON.parse(await fs.readFile(result.artifacts.heartbeatPath, "utf8")).status).toBe("timed-out");
  });

  it("settles spawn errors and heartbeat errors without leaving running processes", async () => {
    const f = await fixture(runningBody);
    await expect(runStreamingCli(f.request, { ...f.config, command: path.join(f.root, "missing") }, process.env, { providerId: "fixture", args: [] })).rejects.toThrow("cleanup failed");
    await fs.mkdir(`${f.request.artifactPrefix}.heartbeat.json.directory`);
    await fs.rm(`${f.request.artifactPrefix}.heartbeat.json`);
    await fs.rename(`${f.request.artifactPrefix}.heartbeat.json.directory`, `${f.request.artifactPrefix}.heartbeat.json`);
    await expect(runStreamingCli(f.request, f.config, process.env, { providerId: "fixture", args: [] })).rejects.toThrow("cleanup failed");
    const pid = await fs.readFile(path.join(f.root, "pid"), "utf8").catch(() => undefined);
    if (pid) expect(alive(Number(pid))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("kills remaining group members on parent exit without killing unrelated processes", async () => {
    const f = await fixture(`const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});writeFileSync('descendant',String(child.pid));process.exit(0);`);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); children.push(unrelated);
    const result = await runStreamingCli(f.request, f.config, process.env, { providerId: "fixture", args: [] });
    expect(result.exitCode).toBe(0);
    const pid = Number(await fs.readFile(path.join(f.root, "descendant"), "utf8"));
    await vi.waitFor(() => expect(alive(pid)).toBe(false));
    expect(alive(unrelated.pid!)).toBe(true);
  });
});
