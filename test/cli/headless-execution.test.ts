import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, copyFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RetainedRunControlV1 } from "../../core/src/application/retainedExecution.ts";

const roots: string[] = [], hosts: Host[] = [];
let hostCode: Uint8Array, workerCode: Uint8Array;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
beforeAll(async () => {
  for (const [entry, host] of [["test/cli/fixtures/headless-host.ts", true], ["local/src/retainedAttemptWorker.ts", false]] as const) {
    const result = await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", write: false, metafile: true, logLevel: "silent" });
    expect(Object.keys(result.metafile.inputs).filter(file => file.startsWith("apps/") || /(?:developmentServer|localRetainedServerRuntime|localRetainedRunService)\.ts$/.test(file))).toEqual([]);
    if (host) hostCode = result.outputFiles[0].contents; else workerCode = result.outputFiles[0].contents;
  }
});
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

class Host {
  readonly child: ChildProcess;
  readonly workers = new Set<number>();
  readonly active = new Set<number>();
  readonly exited: Promise<void>;
  readonly ready: Promise<void>;
  #next = 0;
  #pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  #errorText = "";
  constructor(root: string) {
    this.child = fork(path.join(root, "host.mjs"), [root, path.join(root, "worker.mjs")], {
      execArgv: [], cwd: root, stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8", TZ: "UTC" },
    });
    this.child.stderr!.on("data", chunk => { this.#errorText = (this.#errorText + chunk).slice(-2000); });
    this.exited = new Promise(resolve => this.child.once("close", () => resolve()));
    this.ready = new Promise((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", () => {
        const error = new Error(`Test host exited: ${this.#errorText}`);
        reject(error); for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear();
      });
      this.child.on("message", (message: { event?: string; pid?: number; id?: number; value?: unknown; error?: { code?: string; message: string; stack?: string } }) => {
        if (message.event === "ready") resolve();
        if (message.event === "worker-started") { this.workers.add(message.pid!); this.active.add(message.pid!); }
        if (message.event === "worker-closed") this.active.delete(message.pid!);
        if (message.id !== undefined) {
          const pending = this.#pending.get(message.id); this.#pending.delete(message.id);
          if (message.error) pending?.reject(Object.assign(new Error(message.error.message), { code: message.error.code,
            ...(message.error.stack ? { stack: message.error.stack } : {}) }));
          else pending?.resolve(message.value);
        }
      });
    });
  }
  call<T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const work = this.ready.then(() => new Promise<T>((resolve, reject) => {
      const id = ++this.#next;
      const timeout = setTimeout(() => { this.#pending.delete(id); reject(new Error(`Test command timed out: ${command}`)); }, 20000);
      this.#pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value as T); }, reject: error => { clearTimeout(timeout); reject(error); } });
      this.child.send({ id, command, ...args }, error => { if (error) { clearTimeout(timeout); this.#pending.delete(id); reject(error); } });
    }));
    // Execute is intentionally awaited after cancel/close. Observe an early
    // rejection immediately without changing the promise asserted by the test.
    void work.catch(() => {});
    return work;
  }
  async stop() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    try { await this.call("close"); await this.exited; }
    catch {
      this.child.kill("SIGKILL"); await this.exited;
      // The retained worker exits on IPC disconnect. Never signal a recorded
      // grandchild PID after host death: it might already have been reused.
      await vi.waitFor(() => { for (const pid of this.active) expect(alive(pid)).toBe(false); }, { timeout: 5000 });
    }
  }
  async closeAndCheck() {
    await this.call("close"); await this.exited;
    expect(this.child.exitCode).toBe(0);
    expect(this.active.size).toBe(0);
    for (const pid of this.workers) expect(alive(pid)).toBe(false);
    expect(alive(this.child.pid!)).toBe(false);
  }
}

async function setup(options: { interruptEventWrite?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "lj2-046-headless-unit-")); roots.push(root);
  await mkdir(path.join(root, "config"));
  await copyFile("core/config/agent-providers.default.json", path.join(root, "config/agent-providers.default.json"));
  await copyFile("test/cli/fixtures/headless-workflow.mjs", path.join(root, "workflow.mjs"));
  await copyFile("test/cli/fixtures/headless-effect-adapter.mjs", path.join(root, "effect-adapters.mjs"));
  await copyFile("test/cli/fixtures/headless-guards.mjs", path.join(root, "guards.mjs"));
  await writeFile(path.join(root, "proof.txt"), "retained asset");
  await writeFile(path.join(root, "registry.mjs"), "throw new Error('Current registry must not run');");
  await writeFile(path.join(root, "host.mjs"), hostCode);
  let preamble = `import ${JSON.stringify(path.join(root, "guards.mjs"))};\n`;
  if (options.interruptEventWrite) {
    // Reproduce SIGKILL between opening an immutable event and writing its
    // bytes. The production store, worker, cancellation and recovery stay real.
    preamble += `
      import { promises as interruptedEventFs } from "node:fs";
      import { syncBuiltinESMExports as interruptedEventSync } from "node:module";
      const interruptedEventWrite = interruptedEventFs.writeFile.bind(interruptedEventFs);
      interruptedEventFs.writeFile = async (...args) => {
        if (String(args[0]).includes("/events/") && String(args[1]).includes('"type": "step-completed"')) {
          const interruptedHandle = await interruptedEventFs.open(args[0], "wx", 0o600);
          await interruptedEventWrite(${JSON.stringify(path.join(root, "event-write-started.json"))}, JSON.stringify({ pid: process.pid }));
          await new Promise(() => {});
          await interruptedHandle.close();
        }
        return interruptedEventWrite(...args);
      };
      interruptedEventSync();
    `;
  }
  await writeFile(path.join(root, "worker.mjs"), Buffer.concat([Buffer.from(preamble), workerCode]));
  const start = async () => { const host = new Host(root); hosts.push(host); await host.ready; return host; };
  const calls = async () => (await readFile(path.join(root, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const result = async (runId = "fixture-run") => JSON.parse(await readFile(path.join(root, ".arkimux/local/runs", runId, "headless-fixture.result.json"), "utf8"));
  return { root, start, calls, result };
}
const clean = (host: Host, state: RetainedRunControlV1) => {
  expect(state.owner).toBeNull(); expect(state.compute?.active).toBeNull(); expect(state.compute?.certainty).toBe("known");
  expect(host.active.size).toBe(0); for (const pid of host.workers) expect(alive(pid)).toBe(false);
};

describe("LJ2-046 standalone headless conformance", () => {
  it("executes and publishes a validated result in a fresh process with no HTTP or IDE", async () => {
    const f = await setup(), host = await f.start();
    await host.call("admit", { input: { count: 10, mode: "complete" } });
    const state = await host.call<RetainedRunControlV1>("execute");
    expect(state.status).toBe("complete"); clean(host, state);
    expect(await f.result()).toEqual({ envelopeSchemaVersion: 1, runRef: { executionId: "fixture-run" }, resultKind: "headless-fixture.result",
      payload: { schemaVersion: 1, count: 11, city: "", marker: "original", asset: "retained asset" } });
    expect(await f.calls()).toHaveLength(1); expect(host.workers.size).toBeGreaterThanOrEqual(2);
    await expect(host.call("admit", { input: { count: 99, mode: "complete" } })).rejects.toThrow("already exists");
    expect((await host.call<RetainedRunControlV1>("read")).binding).toEqual(state.binding);
    await host.call("admit", { runId: "changed-input", input: { count: 99, mode: "complete" } });
    const changed = await host.call<RetainedRunControlV1>("execute", { runId: "changed-input" }); clean(host, changed);
    expect(changed.binding.buildSha256).toBe(state.binding.buildSha256);
    expect((await f.result("changed-input")).payload.count).toBe(100);
    expect((await f.result()).payload.count).toBe(11); expect(await f.calls()).toHaveLength(2);
    await host.closeAndCheck();
  });

  it("restarts and resumes the same retained Run after deleting source without repeating completed work", async () => {
    const f = await setup(), first = await f.start();
    await first.call("admit", { input: { count: 20, mode: "wait" } });
    const waiting = await first.call<RetainedRunControlV1>("execute");
    expect(waiting.status).toBe("waiting_for_input"); clean(first, waiting);
    expect(await f.calls()).toHaveLength(1);
    await first.closeAndCheck();
    await rm(path.join(f.root, "workflow.mjs")); await rm(path.join(f.root, "registry.mjs"));
    await writeFile(path.join(f.root, "proof.txt"), "changed current asset");
    await writeFile(path.join(f.root, ".env"), "MARKER=changed\n");
    const second = await f.start(); expect(second.child.pid).not.toBe(first.child.pid);
    await second.call("recover");
    const state = await second.call<RetainedRunControlV1>("read");
    expect(state.compute?.spentMs).toBe(waiting.compute?.spentMs);
    const request = Object.values(state.requests)[0];
    const body = { submissionId: "answer", expectedRevision: request.revision, response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } };
    await expect(second.call("submit", { requestId: request.definition.requestId, body: { ...body, response: { ...body.response, fields: { city: "reject" } } } })).rejects.toMatchObject({ code: "invalid-response" });
    expect((await second.call<RetainedRunControlV1>("read")).receipts).toEqual({});
    await expect(second.call("submit", { requestId: request.definition.requestId, body: { ...body, expectedRevision: 99 } })).rejects.toMatchObject({ code: "stale-revision" });
    const receipt = await second.call("submit", { requestId: request.definition.requestId, body });
    await vi.waitFor(async () => expect((await second.call<RetainedRunControlV1>("read")).status).toBe("complete"), { timeout: 10000 });
    // Canonical worker settlement precedes result/performance publication.
    // Join application completion before treating its results as ready.
    await second.call("execute");
    const complete = await second.call<RetainedRunControlV1>("read"); clean(second, complete);
    expect(complete.binding).toEqual(waiting.binding); expect(complete.fence).toBeGreaterThan(waiting.fence);
    expect(await second.call("submit", { requestId: request.definition.requestId, body })).toEqual(receipt);
    expect((await f.result()).payload).toEqual({ schemaVersion: 1, count: 21, city: "ISTANBUL", marker: "original", asset: "retained asset" });
    expect(await f.calls()).toHaveLength(1);
    await second.closeAndCheck();
    const third = await f.start(); await third.call("recover");
    expect((await third.call<RetainedRunControlV1>("read")).fence).toBe(complete.fence);
    expect(third.workers.size).toBe(0); await third.closeAndCheck();
  }, 20000);

  it("rejects invalid initial input and an invalid result without publishing success", async () => {
    const f = await setup(), host = await f.start();
    await expect(host.call("admit", { input: { count: "bad", mode: "complete" } })).rejects.toMatchObject({ code: "invalid-input" });
    expect(await host.call("read")).toBeNull();
    await host.call("admit", { input: { count: 1, mode: "invalid-result" } });
    const state = await host.call<RetainedRunControlV1>("execute");
    expect(state.status).toBe("failed"); clean(host, state);
    await expect(f.result()).rejects.toMatchObject({ code: "ENOENT" }); await host.closeAndCheck();
  });

  it("rejects a second writer and cancels an active worker before releasing ownership", async () => {
    const f = await setup(), host = await f.start();
    await expect(f.start()).rejects.toThrow("exclusive writer ownership");
    await host.call("admit", { input: { count: 1, mode: "hang" } });
    const running = host.call<RetainedRunControlV1>("execute");
    await vi.waitFor(async () => expect(await f.calls()).toHaveLength(1));
    const cancelled = await host.call<RetainedRunControlV1>("cancel"); await running;
    expect(cancelled.status).toBe("cancelled"); clean(host, cancelled);
    await host.closeAndCheck();
    const next = await f.start(); await next.call("recover");
    expect((await next.call<RetainedRunControlV1>("read")).status).toBe("cancelled");
    expect(next.workers.size).toBe(0); await next.closeAndCheck();
  });

  it("enforces compute deadlines on a hanging workflow and reopens storage cleanly", async () => {
    const f = await setup(), host = await f.start();
    await host.call("admit", { input: { count: 1, mode: "hang" }, limits: { totalMs: 5000, attemptMs: 3000, finalizationReserveMs: 1000 } });
    const state = await host.call<RetainedRunControlV1>("execute");
    expect(state.status).toBe("failed"); expect(state.compute?.lastAttempt?.outcome).toBe("deadline_exceeded"); clean(host, state);
    expect(await f.calls()).toHaveLength(1); await expect(f.result()).rejects.toMatchObject({ code: "ENOENT" });
    await host.closeAndCheck(); const next = await f.start(); await next.call("recover");
    expect(next.workers.size).toBe(0); await next.closeAndCheck();
  });

  it("shuts down an active host without leaving its worker or a reusable owner behind", async () => {
    const f = await setup(), host = await f.start();
    await host.call("admit", { input: { count: 2, mode: "hang" } });
    const running = host.call<RetainedRunControlV1>("execute");
    await vi.waitFor(async () => expect(await f.calls()).toHaveLength(1));
    await host.closeAndCheck(); await running;
    const next = await f.start(); await next.call("recover");
    const state = await next.call<RetainedRunControlV1>("read");
    expect(state.status).toBe("cancelled"); clean(next, state);
    expect(next.workers.size).toBe(0); await next.closeAndCheck();
  });

  it("cancels during an immutable event write without publishing partial JSON or losing retained state", async () => {
    const f = await setup({ interruptEventWrite: true }), host = await f.start();
    await host.call("admit", { input: { count: 2, mode: "hang" } });
    const running = host.call<RetainedRunControlV1>("execute");
    await vi.waitFor(async () => {
      const marker = JSON.parse(await readFile(path.join(f.root, "event-write-started.json"), "utf8"));
      expect(host.active.has(marker.pid)).toBe(true);
    }, { timeout: 5000 });
    await host.closeAndCheck(); await running;
    const next = await f.start(); await next.call("recover");
    const state = await next.call<RetainedRunControlV1>("read");
    expect(state.status).toBe("cancelled"); clean(next, state);
    expect(next.workers.size).toBe(0); expect(await f.calls()).toHaveLength(1);
    const durableRoot = path.join(f.root, ".arkimux/local/runs/fixture-run/durable");
    for (const name of (await readdir(path.join(durableRoot, "events"))).filter(name => /^\d+\.json$/.test(name))) {
      expect(JSON.parse(await readFile(path.join(durableRoot, "events", name), "utf8"))).toHaveProperty("type");
    }
    expect(JSON.parse(await readFile(path.join(durableRoot, "steps/calculate.json"), "utf8"))).toMatchObject({ state: "COMPLETED" });
    await next.closeAndCheck();
  }, 20000);
});
