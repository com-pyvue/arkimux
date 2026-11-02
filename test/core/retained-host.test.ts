import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build as bundle } from "esbuild";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { runKey, validateRetainedRunControl } from "../../core/src/application/retainedExecution.ts";
import { inputRequestTimingV1, RetainedAttemptReadinessError } from "../../core/src/application/activeCompute.ts";
import { LocalRetainedExecutionHostV2, type RetainedAttemptResultV2, type RetainedAttemptWorkerV2 } from "../../local/src/localRetainedExecutionHost.ts";

const roots: string[] = [], stores: FileRetainedExecutionStoreV1[] = [];
const ref = { executionId: "accounted-run" }, requirements = { node: "22" };
const limits = { totalMs: 900_000, attemptMs: 600_000, finalizationReserveMs: 1000 };
const form = { schemaVersion: 1 as const, id: "trip", version: "v1", fields: [] };
const response = { schemaVersion: 1 as const, fields: {}, files: {} };
afterEach(async () => { for (const store of stores.splice(0)) await store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "retained-host-unit-")); roots.push(root);
  let time = Date.parse("2026-09-08T12:00:00.000Z"), mono = 0;
  const store = await FileRetainedExecutionStoreV1.open(root, { now: () => new Date(time) }); stores.push(store);
  const build = await store.publishBuild({ inputSha256: "a".repeat(64), entryPoint: "entry.mjs", files: { "entry.mjs": Buffer.from("export const value = 1;") }, hostRequirements: requirements });
  const binding = { id: "binding", buildSha256: build.buildSha256, workflow: {}, invocation: {}, runConfiguration: {}, executionProfile: {}, nonSecretEnvironment: {}, credentialReferences: [], hostRequirements: requirements };
  await store.createRun(ref, binding);
  const host = new LocalRetainedExecutionHostV2(store, { monotonicNow: () => mono });
  return { root, store, host, binding, advance: (ms: number) => { time += ms; mono += ms; }, wallOnly: (ms: number) => { time += ms; },
    claim: (attempt = "attempt-1") => store.claim(ref, attempt, requirements, limits),
    submit: (requestId: string) => store.submit(ref, requestId, { submissionId: "answer", expectedRevision: 1, response }, "developer", async (_r, value) => value) };
}
const done = (output = { ok: true }): RetainedAttemptWorkerV2 => ({ completion: Promise.resolve({ status: "completed", output }), stop: async () => {} });

describe("Local V2 suspended attempt accounting", () => {
  it("records storage failures before converting them into a failed attempt", async () => {
    const f = await setup(), error = new Error("storage unavailable"), onFrameworkError = vi.fn(async () => {});
    vi.spyOn(f.store, "claim").mockRejectedValueOnce(error);
    const host = new LocalRetainedExecutionHostV2(f.store, { onFrameworkError });
    const result = await host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async () => ({ start: () => done() }) });
    expect(result).toMatchObject({ status: "failed", code: "attempt-not-started" });
    expect(onFrameworkError).toHaveBeenCalledWith(error, "storage");
  });
  it("checks a persisted cancellation again after preparation, before dispatch", async () => {
    const f = await setup(); let started = false;
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async () => {
      await f.store.cancel(ref); return { start: () => { started = true; return done(); } };
    } });
    expect(started).toBe(false); expect(result).toMatchObject({ status: "cancelled", code: "attempt-cancelled" });
  });
  it("checks the deadline after synchronous preparation before starting a worker", async () => {
    const f = await setup(); let started = false;
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async () => {
      f.advance(limits.attemptMs - limits.finalizationReserveMs);
      return { start: () => { started = true; return done(); } };
    } });
    expect(started).toBe(false); expect(result).toMatchObject({ status: "failed", code: "compute-deadline-exceeded" });
  });

  it("honors cancellation while teardown is in progress", async () => {
    const f = await setup(), cancellation = new AbortController();
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, signal: cancellation.signal,
      prepare: async () => ({ start: () => ({ ...done(), stop: async () => { cancellation.abort(); } }) }) });
    expect(result.status).toBe("cancelled"); expect((await f.store.read(ref))!.owner).toBeNull();
  });
  it("lets the retained worker finish finalization after cancellation before teardown", async () => {
    const f = await setup(), cancellation = new AbortController();
    let finalized = false, stoppedBeforeFinalization = false;
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, signal: cancellation.signal,
      prepare: async context => ({ start: () => {
        const completion = new Promise<RetainedAttemptResultV2>(resolve => {
          context.signal.addEventListener("abort", () => {
            setTimeout(() => { finalized = true; resolve({ status: "completed", output: { cleaned: true } }); }, 10);
          }, { once: true });
        });
        queueMicrotask(() => cancellation.abort());
        return { completion, stop: async () => { stoppedBeforeFinalization = !finalized; } };
      } }) });
    expect(result.status).toBe("cancelled");
    expect({ finalized, stoppedBeforeFinalization }).toEqual({ finalized: true, stoppedBeforeFinalization: false });
  });
  it("bounds an unresponsive worker and includes its cleanup in spent time", async () => {
    const f = await setup(), host = new LocalRetainedExecutionHostV2(f.store); let stopped = false;
    const result = await host.execute({ runRef: ref, limits: { totalMs: 1000, attemptMs: 300, finalizationReserveMs: 100 }, hostRequirements: requirements,
      prepare: async () => ({ start: () => ({ completion: new Promise(() => {}), stop: async () => { await new Promise(r => setTimeout(r, 10)); stopped = true; } }) }) });
    expect(stopped).toBe(true); expect(result).toMatchObject({ status: "failed", code: "compute-deadline-exceeded" });
    expect((await f.store.read(ref))!.compute!.spentMs).toBeGreaterThanOrEqual(200);
    expect((await f.store.read(ref))!.owner).toBeNull();
  });

  it("stops waiting for hung teardown but pins the uncertain owner", async () => {
    const f = await setup(), host = new LocalRetainedExecutionHostV2(f.store);
    const result = await host.execute({ runRef: ref, limits: { totalMs: 1000, attemptMs: 150, finalizationReserveMs: 50 }, hostRequirements: requirements,
      prepare: async () => ({ start: () => ({ ...done(), stop: () => new Promise(() => {}) }) }) });
    expect(result).toMatchObject({ status: "failed", code: "compute-accounting-uncertain" });
    expect((await f.store.read(ref))!.owner).not.toBeNull();
  });

  it("never starts a worker after preparation returns late", async () => {
    const f = await setup(), host = new LocalRetainedExecutionHostV2(f.store); let prepared!: (value: { start(): RetainedAttemptWorkerV2 }) => void, started = false;
    const result = await host.execute({ runRef: ref, limits: { totalMs: 1000, attemptMs: 150, finalizationReserveMs: 50 }, hostRequirements: requirements,
      prepare: () => new Promise(resolve => { prepared = resolve; }) });
    prepared({ start: () => { started = true; return done(); } });
    await Promise.resolve(); expect(started).toBe(false); expect(result).toMatchObject({ status: "failed", code: "compute-deadline-exceeded" });
  });

  it("does not suspend on an input whose response was already consumed", async () => {
    const f = await setup(), owner = await f.claim();
    const request = await f.store.openRequest(ref, owner, { stepId: "ask", title: "Input", form, expiresAfter: "1h" });
    await f.store.settleAttempt(ref, owner, { elapsedMs: 1, outcome: "suspended", requestId: request.requestId });
    await f.submit(request.requestId); const next = await f.claim("next");
    await f.store.completeInput(ref, next, request.requestId);
    await expect(f.store.settleAttempt(ref, next, { elapsedMs: 1, outcome: "suspended", requestId: request.requestId })).rejects.toThrow("request-closed");
  });
  it("blocks resumption after an actual accounted owner is killed before settlement", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "accounted-crash-unit-")); roots.push(root);
    const worker = path.join(root, "worker.mjs"), storage = path.join(root, "store");
    await bundle({ entryPoints: [fileURLToPath(new URL("./fixtures/retained-worker.ts", import.meta.url))], outfile: worker, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
    const child = fork(worker, [storage, "accounted"], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Worker not ready")), 10_000);
        child.once("message", () => { clearTimeout(timer); resolve(); });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Unexpected worker exit")); });
      });
      child.kill("SIGKILL"); await closed;
      const store = await FileRetainedExecutionStoreV1.open(storage); stores.push(store);
      expect(await store.recover()).toEqual([]);
      const state = (await store.read({ executionId: "crash-run" }))!;
      expect(state.failure?.code).toBe("compute-accounting-uncertain"); expect(state.compute?.certainty).toBe("uncertain");
      expect(state.receipts.one).toBeDefined(); expect(state.owner).toBeNull();
    } finally { child.kill("SIGKILL"); await closed; }
  });

  it("persists actionable preparation failures without executing a worker", async () => {
    for (const code of ["credentials-unavailable", "retained-code-incompatible"] as const) {
      const f = await setup();
      const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async () => { throw new RetainedAttemptReadinessError(code); } });
      expect(result).toMatchObject({ status: "failed", code });
      expect((await f.store.read(ref))!.failure!.code).toBe(code);
      expect((await f.store.read(ref))!.owner).toBeNull();
    }
  });

  it("uses remaining total allowance for later attempts and cannot reset it", async () => {
    const f = await setup(), owner = await f.claim();
    const request = await f.store.openRequest(ref, owner, { stepId: "ask", title: "Input", form, expiresAfter: "366d" });
    await f.store.settleAttempt(ref, owner, { elapsedMs: 599_500, outcome: "suspended", requestId: request.requestId });
    await f.submit(request.requestId); const next = await f.claim("attempt-2");
    const active = (await f.store.read(ref))!.compute!.active!;
    expect(Date.parse(active.deadlineAt) - Date.parse(active.startedAt)).toBe(300_500);
    await f.store.completeInput(ref, next, request.requestId);
    const second = await f.store.openRequest(ref, next, { stepId: "more", title: "More", form, expiresAfter: "366d" });
    await f.store.settleAttempt(ref, next, { elapsedMs: 300_000, outcome: "suspended", requestId: second.requestId });
    await f.store.submit(ref, second.requestId, { submissionId: "second", expectedRevision: 1, response }, "developer", async (_r, v) => v);
    await expect(f.claim("attempt-3")).rejects.toThrow("run-closed");
    expect((await f.store.read(ref))!.failure!.code).toBe("compute-budget-exhausted");
  });
  it("saves 3 minutes spent, excludes two days waiting and resumes with 12 minutes", async () => {
    const f = await setup(); let requestId = "", stopped = false;
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async context => ({ start: () => ({
      completion: (async () => {
        f.advance(179_000);
        const request = await f.store.openRequest(ref, context.owner, { stepId: "ask", title: "Input", form, expiresAfter: "366d" }); requestId = request.requestId;
        return { status: "suspended" as const, request };
      })(), stop: async () => { f.advance(1000); stopped = true; },
    }) }) });
    expect(result).toMatchObject({ schemaVersion: 2, status: "suspended", spentMs: 180_000 }); expect(stopped).toBe(true);
    expect((await f.store.read(ref))?.owner).toBeNull(); expect((await f.store.read(ref))?.status).toBe("waiting_for_input");
    f.advance(2 * 86400_000); await f.submit(requestId);
    const resumed = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async context => {
      const state = (await f.store.read(ref))!; expect(state.compute!.limits.totalMs - state.compute!.spentMs).toBe(720_000);
      expect(Date.parse(context.deadlineAt) - Date.parse(state.compute!.active!.startedAt)).toBe(600_000);
      await f.store.completeInput(ref, context.owner, requestId);
      return { start: () => { f.advance(2000); return done(); } };
    } });
    expect(resumed).toMatchObject({ status: "completed", spentMs: 182_000 });
  });

  it("keeps the queued answer when submission races teardown and rejects a second owner", async () => {
    const f = await setup(); let rid = "";
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async context => ({ start: () => ({
      completion: (async () => { const r = await f.store.openRequest(ref, context.owner, { stepId: "ask", title: "Input", form, expiresAfter: "1h" }); rid = r.requestId;
        return { status: "suspended" as const, request: r }; })(),
      stop: async () => { await f.submit(rid); await expect(f.claim("duplicate")).rejects.toThrow("owner-active"); f.advance(3000); },
    }) }) });
    expect(result.status).toBe("suspended"); const state = (await f.store.read(ref))!;
    expect(state.status).toBe("resume_queued"); expect(state.compute!.spentMs).toBe(3000); expect(Object.keys(state.receipts)).toHaveLength(1);
    await f.store.close(); const reopened = await FileRetainedExecutionStoreV1.open(f.root); stores.push(reopened);
    expect((await reopened.recover())[0].compute!.spentMs).toBe(3000);
    await expect(reopened.claim(ref, "bypass", requirements)).rejects.toThrow("binding-mismatch");
    await expect(reopened.claim(ref, "reset", requirements, { ...limits, totalMs: 1800_000 })).rejects.toThrow("binding-mismatch");
    await reopened.claim(ref, "resume", requirements, limits);
  });

  it("blocks unknown crash accounting without discarding the saved answer", async () => {
    const f = await setup(), owner = await f.claim();
    const request = await f.store.openRequest(ref, owner, { stepId: "ask", title: "Input", form, expiresAfter: "1h" }); await f.submit(request.requestId);
    // Fault injection models a dead owner; the live-process kill test is separate.
    const file = path.join(f.root, "runs", `${runKey(ref)}.json`), state = JSON.parse(await readFile(file, "utf8"));
    state.owner.pid = 2_147_483_647; await writeFile(file, JSON.stringify(state));
    expect(await f.store.recover()).toEqual([]);
    const blocked = (await f.store.read(ref))!;
    expect(blocked.compute!.certainty).toBe("uncertain"); expect(blocked.failure!.code).toBe("compute-accounting-uncertain");
    expect(blocked.receipts.answer).toBeDefined(); expect(blocked.owner).toBeNull();
    await expect(f.claim("resume")).rejects.toThrow("run-closed");
  });

  it("does not release ownership when teardown rejects", async () => {
    const f = await setup();
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async () => ({ start: () => ({
      ...done(), stop: async () => { throw new Error("still alive"); },
    }) }) });
    expect(result).toMatchObject({ status: "failed", code: "compute-accounting-uncertain" });
    expect((await f.store.read(ref))!.owner).not.toBeNull();
    await expect(f.claim("other")).rejects.toThrow("run-closed");
    await expect(f.store.deleteRetainedControlData(ref)).rejects.toThrow("owner-active");
  });

  it("prevents unaccounted release, completion, stale settlement and success with an open request", async () => {
    const f = await setup(), owner = await f.claim();
    await expect(f.store.release(ref, owner)).rejects.toThrow("settleAttempt");
    await expect(f.store.finish(ref, owner, "complete")).rejects.toThrow("settleAttempt");
    const request = await f.store.openRequest(ref, owner, { stepId: "ask", title: "Input", form, expiresAfter: "366d" });
    await expect(f.store.settleAttempt(ref, owner, { elapsedMs: 100, outcome: "completed" })).rejects.toThrow("request-closed");
    await f.store.settleAttempt(ref, owner, { elapsedMs: 100, outcome: "suspended", requestId: request.requestId });
    await expect(f.store.settleAttempt(ref, owner, { elapsedMs: 100, outcome: "failed" })).rejects.toThrow("stale-owner");
    expect((await f.store.read(ref))!.compute!.spentMs).toBe(100);
  });

  it("fails at the execution limit and does not turn a timeout into successful suspension", async () => {
    const f = await setup(), owner = await f.claim();
    const request = await f.store.openRequest(ref, owner, { stepId: "ask", title: "Input", form, expiresAfter: "366d" });
    const state = await f.store.settleAttempt(ref, owner, { elapsedMs: limits.attemptMs, outcome: "suspended", requestId: request.requestId });
    expect(state.status).toBe("failed"); expect(state.failure!.code).toBe("compute-deadline-exceeded");
    expect(state.requests[request.requestId].status).toBe("cancelled");
    await expect(f.claim("again")).rejects.toThrow("run-closed");
  });

  it("keeps cancellation and expiry winners during late suspension", async () => {
    for (const mode of ["cancel", "expire"] as const) {
      const f = await setup(), owner = await f.claim();
      const request = await f.store.openRequest(ref, owner, { stepId: "ask", title: "Input", form, expiresAfter: "1s" });
      if (mode === "cancel") await f.store.cancel(ref); else { f.advance(1000); await f.store.expire(ref, request.requestId); }
      const settled = await f.store.settleAttempt(ref, owner, { elapsedMs: 2000, outcome: "suspended", requestId: request.requestId });
      expect(settled.status).toBe(mode === "cancel" ? "cancelled" : "failed"); expect(settled.compute!.spentMs).toBe(2000); expect(settled.owner).toBeNull();
    }
  });

  it("rejects fake suspension and sanitizes preparation failures without starting a worker", async () => {
    const f = await setup(); let started = false;
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async () => { throw new Error("secret credential value"); } });
    expect(result.status).toBe("failed"); expect(JSON.stringify(result)).not.toContain("secret"); expect(started).toBe(false);
    const g = await setup();
    const bad = await g.host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async () => ({ start: () => {
      started = true; return { completion: Promise.resolve({ status: "suspended", request: {} } as RetainedAttemptResultV2), stop: async () => {} };
    } }) });
    expect(bad.status).toBe("failed"); expect((await g.store.read(ref))!.owner).toBeNull();
  });

  it("uses monotonic active time despite a calendar adjustment", async () => {
    const f = await setup();
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async () => {
      f.wallOnly(86400_000); f.advance(2000); return { start: () => done() };
    } });
    expect(result).toMatchObject({ status: "completed", spentMs: 2000 });
  });

  it("records human wait at acceptance, not replay, and rejects invalid timing", () => {
    const request = { createdAt: "2026-09-08T12:00:00.000Z", expiresAt: "2026-09-10T12:00:00.000Z" };
    expect(inputRequestTimingV1(request, "2026-09-09T12:00:00.000Z")).toEqual({ startedAt: request.createdAt, completedAt: "2026-09-09T12:00:00.000Z", elapsedMs: 86400_000, humanWaitMs: 86400_000 });
    expect(() => inputRequestTimingV1(request, request.expiresAt)).toThrow();
    expect(() => inputRequestTimingV1(request, "2026-09-08T11:59:59.000Z")).toThrow();
  });

  it("physically exits a live worker before reporting suspension and stops heartbeat activity", async () => {
    const f = await setup(); let heartbeats = 0, childPid = 0;
    const result = await f.host.execute({ runRef: ref, limits, hostRequirements: requirements, prepare: async context => ({ start: () => {
      const child = spawn(process.execPath, ["-e", "process.on('message', m => { process.send(m); setInterval(() => process.send({heartbeat:true}), 5); });"], { stdio: ["ignore", "ignore", "ignore", "ipc"] }); childPid = child.pid!;
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      const completion = new Promise<RetainedAttemptResultV2>((resolve, reject) => {
        child.on("message", m => { const msg = m as Record<string, unknown>; if (msg.heartbeat) heartbeats++; else resolve(msg as unknown as RetainedAttemptResultV2); });
        child.once("error", reject); child.once("exit", () => reject(new Error("worker exited")));
      });
      void f.store.openRequest(ref, context.owner, { stepId: "ask", title: "Input", form, expiresAfter: "366d" }).then(r => child.send({ status: "suspended", request: r }));
      return { completion, stop: async () => { child.kill("SIGKILL"); await closed; } };
    } }) });
    expect(result.status).toBe("suspended"); expect(() => process.kill(childPid, 0)).toThrow();
    const count = heartbeats; await new Promise(resolve => setTimeout(resolve, 25)); expect(heartbeats).toBe(count);
    expect((await f.store.read(ref))!.owner).toBeNull();
  });

  it("validates accounting owner identity and refuses an added budget on a legacy attempt", async () => {
    const f = await setup(), owner = await f.claim(), state = (await f.store.read(ref))!;
    state.compute!.active!.fence++; expect(() => validateRetainedRunControl(state)).toThrow("Compute owner differs");
    await f.store.settleAttempt(ref, owner, { elapsedMs: 1, outcome: "failed" });
    const g = await setup(), legacy = await g.store.claim(ref, "legacy", requirements); await g.store.release(ref, legacy);
    await expect(g.claim()).rejects.toThrow("binding-mismatch");
  });
});
