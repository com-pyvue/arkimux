import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build as bundle } from "esbuild";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHeadlessDebugger, type HeadlessDebuggerOptions, type PreparedHeadlessSession } from "../../local/src/headlessDebugger.ts";
import { createLocalRetainedRuntime } from "../../local/src/localRetainedRuntime.ts";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import { runKey } from "../../core/src/application/retainedExecution.ts";
import type { HeadlessExpectation, HeadlessManifest } from "../../local/src/headlessDebuggerContracts.ts";

type Client = Awaited<ReturnType<typeof createHeadlessDebugger>>;
type CaseSnapshot = {
  caseId: string; runRef: { executionId: string } | null; state: string; runStatus: string | null;
  comparison: string; checks: { id: string; outcome: string; reason: string | null }[];
  inputRequests: { requestId: string; revision: number; status: string; expiresAt: string; form: unknown }[];
  evidence: { evidenceId: string; kind: string; totalBytes: number; sha256: string; redacted: boolean }[];
  error: { code: string; message: string; externalDiagnostic?: { origin: string; provider: string; code?: string; message: string } } | null;
};
type Snapshot = { sessionId: string; revision: number; preparation: string; manifestHash: string;
  build: { buildSha256: string; version: string } | null; cases: CaseSnapshot[] };
const roots: string[] = [], clients: Client[] = [], runtimes: Awaited<ReturnType<typeof createLocalRetainedRuntime>>[] = [];
let worker: Uint8Array;
const authorization = { executeProjectCode: true, allowProviderCharges: true, allowExternalEffects: true, discloseWorkflowData: true } as const;
const workflow = { kind: "headless-fixture", version: 1 } as const;
beforeAll(async () => {
  worker = (await bundle({ entryPoints: ["local/src/retainedAttemptWorker.ts"], bundle: true,
    platform: "node", format: "esm", write: false, logLevel: "silent" })).outputFiles[0].contents;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "headless-coordinator-unit-")); roots.push(projectRoot);
  const workerPath = path.join(projectRoot, "worker.mjs"), auditFile = path.join(projectRoot, "calls.jsonl");
  const guards = path.join(projectRoot, "guards.mjs");
  await copyFile("test/cli/fixtures/headless-guards.mjs", guards);
  await writeFile(workerPath, Buffer.concat([Buffer.from(`import ${JSON.stringify(pathToFileURL(guards).href)};\n`), worker]));
  await mkdir(path.join(projectRoot, "config"));
  await copyFile("core/config/agent-providers.default.json", path.join(projectRoot, "config/agent-providers.default.json"));
  await copyFile("test/cli/fixtures/headless-workflow.mjs", path.join(projectRoot, "workflow.mjs"));
  await copyFile("test/cli/fixtures/headless-effect-adapter.mjs", path.join(projectRoot, "effect-adapters.mjs"));
  await writeFile(path.join(projectRoot, "proof.txt"), "retained asset");
  await writeFile(path.join(projectRoot, "registry.mjs"), "throw new Error('Registry must not execute');");
  const prepareSession = vi.fn<NonNullable<HeadlessDebuggerOptions["prepareSession"]>>(async options => {
    const code = await readFile(path.join(projectRoot, "workflow.mjs"));
    const effectAdapters = await readFile(path.join(projectRoot, "effect-adapters.mjs"));
    const asset = await readFile(path.join(projectRoot, "proof.txt"));
    const build = await options.store.publishBuild({ inputSha256: hashJson(code.toString()), entryPoint: "entry.mjs",
      files: { "entry.mjs": code, "effect-adapters.mjs": effectAdapters, "assets/proof.txt": asset,
        "construction.json": Buffer.from(JSON.stringify({ schemaVersion: 2, export: "construct",
          effectAdapterEntryPoint: "effect-adapters.mjs", effectAdapters: ["createRecordFixtureAdapter"] })) }, hostRequirements: options.hostRequirements });
    return { workflow, configuration: { schemaVersion: 1, configurationId: "fixture-v1", workflow, marker: "original",
      validatorFile: path.join(projectRoot, "validator.pid"), agents: {} },
      buildSha256: build.buildSha256, buildVersion: `${build.createdAt.replace(/[-:]/g, "")}-${build.buildSha256.slice(0, 16)}`,
      workflowContractVersion: "1", resultKind: "headless-fixture.result", agentSlotIds: [],
      nonSecretEnvironment: { MARKER: "original", AUDIT_FILE: auditFile, VALIDATOR_FILE: path.join(projectRoot, "validator.pid") }, credentialReferences: [], hostRequirements: options.hostRequirements,
      executionProfile: { maxScratchBytes: 1048576, computeLimits: { totalMs: 30000, attemptMs: 30000, finalizationReserveMs: 3000 } },
    } satisfies PreparedHeadlessSession;
  });
  const open = async (options: Partial<HeadlessDebuggerOptions> = {}) => {
    const client = await createHeadlessDebugger({ projectRoot, packageVersion: "0.1.0-fixture.48", workerPath, prepareSession, ...options });
    clients.push(client); return client;
  };
  const sessionRoot = (sessionId = "diagnostic") => path.join(projectRoot, ".arkimux/debug/sessions", sessionId);
  const calls = async () => (await readFile(auditFile, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; }))
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { count: number; pid: number });
  return { projectRoot, workerPath, auditFile, prepareSession, open, sessionRoot, calls };
}
function manifest(cases: HeadlessManifest["cases"], sessionId = "diagnostic"): HeadlessManifest {
  return { schemaVersion: 1, sessionId, workflowId: workflow.kind, configurationId: "fixture-v1", cases };
}
const item = (caseId: string, count = 10, mode = "complete", expectations: HeadlessExpectation[] = []) => ({ caseId, input: { count, mode }, expectations });
const countExpectation = (value: number): HeadlessExpectation => ({ id: "count", target: "result", pointer: "/count", operator: "equals", value });
async function inspect(client: Client) { return await client.request("session.inspect", {}) as Snapshot; }
async function waitCase(client: Client, caseId: string, state: string) {
  let result!: CaseSnapshot;
  await expect.poll(async () => { result = (await inspect(client)).cases.find(value => value.caseId === caseId)!; return result.state; },
    { timeout: 10000, interval: 20 }).toBe(state);
  return result;
}
async function evidence(client: Client, snapshot: CaseSnapshot, kind: string, limit = 262144) {
  const descriptor = snapshot.evidence.find(value => value.kind === kind)!;
  expect(descriptor, `${kind} evidence`).toBeDefined();
  let offset: number | null = 0; const chunks: Buffer[] = [];
  do {
    const page = await client.request("evidence.read", { caseId: snapshot.caseId, evidenceId: descriptor.evidenceId, offset, limit }) as
      { data: string; offset: number; nextOffset: number | null; totalBytes: number; encoding: string };
    expect(page).toMatchObject({ offset, totalBytes: descriptor.totalBytes, encoding: "base64" });
    chunks.push(Buffer.from(page.data, "base64")); offset = page.nextOffset;
  } while (offset !== null);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

describe("headless debugger retained coordinator", () => {
  it.each([false, true])("exposes safe failure and step evidence with an actual retained worker, external=%s", async external => {
    const f = await fixture(), source = await readFile(path.join(f.projectRoot, "workflow.mjs"), "utf8");
    const message = "Service rejected [region]. Retry after 42 seconds.\nSee https://provider.test/help and /provider/resource. " + "detail ".repeat(650);
    const code = (await bundle({ stdin: { resolveDir: process.cwd(), contents:
      `import { ExternalProviderError } from ${JSON.stringify(path.resolve("core/src/application/externalError.ts"))};\n` +
      source.replace("return { count: value.count + 1 };", external
        ? `throw new ExternalProviderError('weather-fixture', ${JSON.stringify(message + " key=opaque-fixture-secret")}, { code: 'SERVICE_UNAVAILABLE', httpStatus: 503, secretValues: ['opaque-fixture-secret'] });`
        : "throw new TypeError('private internal problem /private/runtime key=opaque-fixture-secret');") },
      bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent" })).outputFiles[0].contents;
    await writeFile(path.join(f.projectRoot, "workflow.mjs"), code);
    const client = await f.open();
    await client.request("session.create", { manifest: manifest([item("failure")]), authorization });
    await client.request("case.run", { caseId: "failure" });
    const failed = await waitCase(client, "failure", "terminal"), steps = await evidence(client, failed, "steps"), savedFailure = await evidence(client, failed, "failure");
    expect(failed.runStatus).toBe("failed");
    expect(steps.items[0]).toMatchObject({ stepId: "calculate", state: "FAILED",
      terminal: { code: external ? "SERVICE_UNAVAILABLE" : "step_failed" } });
    if (external) {
      const expected = { origin: "external", provider: "weather-fixture", code: "SERVICE_UNAVAILABLE", httpStatus: 503, message: message + " key=[redacted]" };
      expect(failed.error).toMatchObject({ code: "action_required" });
      expect(failed.error!.message.length).toBeLessThanOrEqual(4096);
      expect(failed.error!.message).toContain("Read the failure evidence");
      expect(failed.error!.externalDiagnostic).toBeUndefined();
      expect(savedFailure.externalDiagnostic).toEqual(expected);
      expect(steps.items[0].terminal.externalDiagnostic).toEqual(expected);
    } else {
      expect(failed.error!.code).toBe("internal_error");
      expect(savedFailure.externalDiagnostic).toBeUndefined(); expect(steps.items[0].terminal.externalDiagnostic).toBeUndefined();
    }
    expect(JSON.stringify([failed, steps, savedFailure])).not.toMatch(/opaque-fixture-secret|private internal problem|private\/runtime/);
    await client.close();
    const reopened = await f.open(); await reopened.request("session.open", { sessionId: "diagnostic" });
    const later = (await inspect(reopened)).cases[0];
    expect(later.error).toEqual(failed.error); expect(await evidence(reopened, later, "failure")).toEqual(savedFailure);
    expect(await f.calls()).toHaveLength(1);
  });

  it("requires authorization before preparation and preserves immutable session identity without execution", async () => {
    const f = await fixture(), client = await f.open(), source = manifest([item("first")]);
    await expect(client.request("session.create", { manifest: source, authorization: { ...authorization, executeProjectCode: false } }))
      .rejects.toMatchObject({ code: "authorization_required" });
    expect(f.prepareSession).not.toHaveBeenCalled();
    const first = await client.request("session.create", { manifest: source, authorization }) as Snapshot;
    expect(first).toMatchObject({ sessionId: "diagnostic", preparation: "ready", cases: [{ caseId: "first", state: "not_started", runRef: null, comparison: "pending" }] });
    expect(await client.request("session.create", { manifest: source, authorization })).toEqual(first);
    expect(await client.request("session.open", { sessionId: "diagnostic" })).toEqual(first);
    expect(f.prepareSession).toHaveBeenCalledOnce(); expect(await f.calls()).toEqual([]);
    await expect(client.request("session.create", { manifest: manifest([item("first", 20)]), authorization })).rejects.toMatchObject({ code: "identity_conflict" });
    await expect(client.request("session.create", { manifest: source, authorization: { ...authorization, increaseExecutionBudget: true } })).rejects.toMatchObject({ code: "identity_conflict" });
    await expect(client.request("session.open", { sessionId: "other" })).rejects.toMatchObject({ code: "session_busy" });
    const other = await f.open();
    await expect(other.request("session.open", { sessionId: "diagnostic" })).rejects.toMatchObject({ code: "session_busy" });
    await client.close();
    const reopened = await f.open({ prepareSession: async () => { throw Error("Current source must not execute on open"); } });
    expect(await reopened.request("session.open", { sessionId: "diagnostic" })).toEqual(first);
  });

  it("acknowledges cases, compares typed results and exposes saved intermediate values without duplicate effects", async () => {
    const f = await fixture(), client = await f.open(), revisions: number[] = [];
    const source = manifest([item("correct", 10, "complete", [countExpectation(11)]), item("wrong", 20, "complete", [countExpectation(99)]), item("unchecked", 30)]);
    await client.request("session.create", { manifest: source, authorization });
    for (const [caseId, count, comparison] of [["correct", 11, "pass"], ["wrong", 21, "mismatch"], ["unchecked", 31, "not_checked"]] as const) {
      const ack = await client.request("case.run", { caseId }) as CaseSnapshot;
      expect(ack).toMatchObject({ caseId, comparison: "pending" });
      const complete = await waitCase(client, caseId, "terminal");
      expect(complete).toMatchObject({ runStatus: "complete", comparison, error: null });
      expect(await evidence(client, complete, "result")).toMatchObject({ count });
      const steps = await evidence(client, complete, "steps");
      expect(steps).toEqual({ final: true, items: [expect.objectContaining({ stepId: "calculate", state: "COMPLETED", attemptCount: 1, outputEvidenceId: expect.any(String) })] });
      expect(await evidence(client, complete, "step-output")).toEqual({ stepId: "calculate", output: { count } });
      const performance = await evidence(client, complete, "performance");
      expect(performance).toMatchObject({ certainty: "known", agents: [], limits: { totalMs: 30000, finalizationReserveMs: 3000 } });
      const again = await client.request("case.run", { caseId }) as CaseSnapshot;
      expect(again.runRef).toEqual(complete.runRef); expect(again.comparison).toBe(comparison);
      revisions.push((await inspect(client)).revision);
    }
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(await f.calls()).toHaveLength(3); expect(f.prepareSession).toHaveBeenCalledOnce();
    const snap = await inspect(client); expect(new Set(snap.cases.map(value => value.runRef!.executionId)).size).toBe(3);
    expect(JSON.stringify(snap)).not.toContain(f.projectRoot);
  });

  it("resumes the same waiting Run from retained source and validator after reopen, retaining duplicate receipts", async () => {
    const f = await fixture(), first = await f.open();
    await first.request("session.create", { manifest: manifest([item("waiter", 20, "wait", [countExpectation(21)])]), authorization });
    await first.request("case.run", { caseId: "waiter" });
    const waiting = await waitCase(first, "waiter", "waiting_for_input"), request = waiting.inputRequests[0];
    expect(waiting.comparison).toBe("pending"); expect(await f.calls()).toHaveLength(1);
    const waitingPerformance = await evidence(first, waiting, "performance");
    expect(waitingPerformance).toMatchObject({ final: false, usage: null });
    await first.close();
    await rm(path.join(f.projectRoot, "workflow.mjs")); await rm(path.join(f.projectRoot, "registry.mjs"));
    await writeFile(path.join(f.projectRoot, "proof.txt"), "changed current asset");
    await writeFile(path.join(f.projectRoot, ".env"), "MARKER=changed\n");
    const second = await f.open({ prepareSession: async () => { throw Error("No current preparation on reopen"); } });
    const opened = await second.request("session.open", { sessionId: "diagnostic" }) as Snapshot;
    expect(opened.cases[0]).toMatchObject({ runRef: waiting.runRef, state: "waiting_for_input", inputRequests: waiting.inputRequests });
    const answer = { caseId: "waiter", requestId: request.requestId, submissionId: "answer", expectedRevision: request.revision,
      response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } };
    await expect(second.request("case.respond", { ...answer, response: { ...answer.response, fields: { city: "reject" } } })).rejects.toMatchObject({ code: "invalid_response" });
    await expect(second.request("case.respond", { ...answer, expectedRevision: 999 })).rejects.toMatchObject({ code: "stale_revision" });
    await expect(second.request("case.respond", { ...answer, response: { ...answer.response, files: { attachment: [] } } })).rejects.toMatchObject({ code: "unsupported_operation" });
    const accepted = await second.request("case.respond", answer) as { receipt: unknown; case: CaseSnapshot };
    const completed = await waitCase(second, "waiter", "terminal");
    expect(completed).toMatchObject({ runRef: waiting.runRef, comparison: "pass", runStatus: "complete" });
    expect(await evidence(second, completed, "result")).toMatchObject({ count: 21, city: "ISTANBUL", marker: "original", asset: "retained asset" });
    expect((await second.request("case.respond", answer) as { receipt: unknown }).receipt).toEqual(accepted.receipt);
    await waitCase(second, "waiter", "terminal"); await second.close();
    const third = await f.open(); await third.request("session.open", { sessionId: "diagnostic" });
    expect(await evidence(third, waiting, "performance")).toEqual(waitingPerformance);
    expect((await third.request("case.respond", answer) as { receipt: unknown }).receipt).toEqual(accepted.receipt);
    await waitCase(third, "waiter", "terminal");
    expect(await f.calls()).toHaveLength(1);
  }, 20000);

  it("cancels active and unstarted cases without running other cases or leaving workers alive", async () => {
    const f = await fixture(), client = await f.open();
    await client.request("session.create", { manifest: manifest([item("active", 1, "hang"), item("never", 2)]), authorization });
    await client.request("case.run", { caseId: "active" });
    await expect.poll(async () => (await f.calls()).length).toBe(1);
    const pid = (await f.calls())[0].pid;
    const active = (await inspect(client)).cases[0];
    expect(await evidence(client, active, "performance")).toMatchObject({ final: false, published: false,
      usage: null, agentAttempts: null, totalElapsedMs: null, stages: null });
    await expect(client.request("case.run", { caseId: "never" })).rejects.toMatchObject({ code: "case_busy" });
    const never = await client.request("case.cancel", { caseId: "never" }) as CaseSnapshot;
    expect(never).toMatchObject({ state: "terminal", runRef: null, runStatus: null, comparison: "not_checked" });
    expect(await client.request("case.run", { caseId: "never" })).toEqual(never);
    const cancelled = await client.request("case.cancel", { caseId: "active" }) as CaseSnapshot;
    expect(cancelled.state).toBe("terminal"); expect(cancelled.runStatus).toBe("cancelled");
    expect(() => process.kill(pid, 0)).toThrow(); expect(await f.calls()).toHaveLength(1);
    expect((await client.request("case.cancel", { caseId: "active" }) as CaseSnapshot).runRef).toEqual(cancelled.runRef);
  });

  it("closes active execution, preserves unstarted cases and remains separate from the normal store", async () => {
    const f = await fixture();
    const normal = await createLocalRetainedRuntime({ projectRoot: f.projectRoot, workerPath: f.workerPath }); runtimes.push(normal);
    const normalFile = path.join(f.projectRoot, ".arkimux/local/preserved.json");
    await writeFile(normalFile, '{"normal":"untouched"}');
    const client = await f.open();
    await client.request("session.create", { manifest: manifest([item("active", 4, "hang"), item("unstarted", 5)]), authorization });
    await client.request("case.run", { caseId: "active" });
    await expect.poll(async () => (await f.calls()).length).toBe(1);
    const pid = (await f.calls())[0].pid;
    expect(await client.request("session.close", {})).toEqual({ closed: true });
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(client.request("session.inspect", {})).rejects.toMatchObject({ code: "session_busy" });
    const reopened = await f.open();
    const state = await reopened.request("session.open", { sessionId: "diagnostic" }) as Snapshot;
    expect(state.cases).toMatchObject([{ caseId: "active", state: "terminal", runStatus: "cancelled" }, { caseId: "unstarted", state: "not_started", runRef: null }]);
    expect(await normal.store.listRuns()).toEqual([]);
    expect(await readFile(normalFile, "utf8")).toBe('{"normal":"untouched"}');
    expect(await readdir(path.join(f.sessionRoot(), "retained/runs"))).toHaveLength(1);
  });

  it("paginates sanitized evidence without mutating inputs and prevents cross-case or symlink reads", async () => {
    const f = await fixture(), client = await f.open();
    const first = { ...item("private"), input: { count: 10, mode: "complete", apiKey: "synthetic-private-key", text: "Istanbul İstanbul" } };
    await client.request("session.create", { manifest: manifest([first, item("other")]), authorization });
    const snapshot = await inspect(client), one = snapshot.cases[0], descriptor = one.evidence.find(value => value.kind === "input")!;
    expect(descriptor.redacted).toBe(true);
    expect(await evidence(client, one, "input", 7)).toEqual({ ...first.input, apiKey: "[REDACTED]" });
    const journal = JSON.parse(await readFile(path.join(f.sessionRoot(), "session.json"), "utf8"));
    expect(journal.manifest.cases[0].input.apiKey).toBe("synthetic-private-key");
    await expect(client.request("evidence.read", { caseId: "other", evidenceId: descriptor.evidenceId, offset: 0, limit: 100 })).rejects.toMatchObject({ code: "not_found" });
    await expect(client.request("evidence.read", { caseId: "private", evidenceId: descriptor.evidenceId, offset: descriptor.totalBytes + 1, limit: 100 })).rejects.toMatchObject({ code: "invalid_request" });
    const file = path.join(f.sessionRoot(), "evidence", `${descriptor.evidenceId}.json`);
    const outside = path.join(f.projectRoot, "not-evidence.json"); await writeFile(outside, '{"private":"not exportable"}');
    await rm(file); await symlink(outside, file);
    await expect(client.request("evidence.read", { caseId: "private", evidenceId: descriptor.evidenceId, offset: 0, limit: 100 })).rejects.toMatchObject({ code: "state_uncertain" });
  });

  it("journals failed preparation and refuses to silently reprepare or execute after reopening", async () => {
    const f = await fixture(), first = await f.open({ prepareSession: async () => { throw Error("PRIVATE setup failure"); } });
    await expect(first.request("session.create", { manifest: manifest([item("first")]), authorization })).rejects.toMatchObject({ code: "internal_error" });
    await first.close();
    const second = await f.open();
    const state = await second.request("session.open", { sessionId: "diagnostic" }) as Snapshot;
    expect(state).toMatchObject({ preparation: "incomplete", build: null, cases: [{ state: "not_started" }] });
    await expect(second.request("case.run", { caseId: "first" })).rejects.toMatchObject({ code: "preparation_incomplete" });
    expect(f.prepareSession).not.toHaveBeenCalled(); expect(await f.calls()).toEqual([]);
  });

  it("records invalid results as failures and never manufactures a passing result expectation", async () => {
    const f = await fixture(), client = await f.open();
    await client.request("session.create", { manifest: manifest([item("bad-output", 10, "invalid-result", [countExpectation(11)])]), authorization });
    await client.request("case.run", { caseId: "bad-output" });
    const result = await waitCase(client, "bad-output", "terminal");
    expect(result).toMatchObject({ runStatus: "failed", comparison: "mismatch" });
    expect(result.evidence.some(value => value.kind === "result")).toBe(false);
    expect(result.evidence.some(value => value.kind === "failure")).toBe(true);
    expect(await f.calls()).toHaveLength(1);
  });

  it.each(["case.cancel", "session.close"] as const)("keeps inspection responsive and joins a hanging answer validator on %s", async operation => {
    const f = await fixture();
    const source = await readFile(path.join(f.projectRoot, "workflow.mjs"), "utf8");
    await writeFile(path.join(f.projectRoot, "workflow.mjs"), `import { writeFileSync } from 'node:fs';\n${source.replace(
      "output: { parse(v) {", "output: { parse(v) { if (v.fields.city === 'hang') { writeFileSync(context.runConfiguration.validatorFile, String(process.pid)); while (true) {} }",
    )}`);
    const client = await f.open();
    await client.request("session.create", { manifest: manifest([item("waiter", 1, "wait"), item("other", 2)]), authorization });
    await client.request("case.run", { caseId: "waiter" });
    const waiting = await waitCase(client, "waiter", "waiting_for_input"), request = waiting.inputRequests[0];
    const response = client.request("case.respond", { caseId: "waiter", requestId: request.requestId, submissionId: "hung-answer", expectedRevision: request.revision,
      response: { schemaVersion: 1, fields: { city: "hang" }, files: {} } }).then(value => ({ ok: true, value }), error => ({ ok: false, error }));
    const validatorFile = path.join(f.projectRoot, "validator.pid");
    await expect.poll(() => readFile(validatorFile, "utf8").catch(() => ""), { timeout: 3000 }).not.toBe("");
    const pid = Number(await readFile(validatorFile, "utf8"));
    const inspected = await Promise.race([inspect(client), new Promise<never>((_, reject) => setTimeout(() => reject(Error("Inspection blocked behind answer validation")), 1000))]);
    expect(inspected.cases[0].state).toBe("active");
    await expect(client.request("case.run", { caseId: "other" })).rejects.toMatchObject({ code: "case_busy" });
    await client.request(operation, operation === "case.cancel" ? { caseId: "waiter" } : {});
    expect((await response).ok).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    const control = JSON.parse(await readFile(path.join(f.sessionRoot(), "retained/runs", `${runKey(waiting.runRef!)}.json`), "utf8"));
    expect(control.receipts).toEqual({}); expect(control.requests[request.requestId].response).toBeUndefined();
    expect(await f.calls()).toHaveLength(1);
  }, 15000);

  it("reports expired input while a durable accepted receipt remains idempotent after expiry", async () => {
    const f = await fixture(), source = await readFile(path.join(f.projectRoot, "workflow.mjs"), "utf8");
    await writeFile(path.join(f.projectRoot, "workflow.mjs"), source.replace("expiresAfter: '366d'", "expiresAfter: '2s'"));
    const client = await f.open();
    await client.request("session.create", { manifest: manifest([item("accepted", 1, "wait"), item("expired", 2, "wait")]), authorization });
    await client.request("case.run", { caseId: "accepted" });
    const acceptedWait = await waitCase(client, "accepted", "waiting_for_input"), acceptedRequest = acceptedWait.inputRequests[0];
    const answer = { caseId: "accepted", requestId: acceptedRequest.requestId, submissionId: "saved-answer", expectedRevision: acceptedRequest.revision,
      response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } };
    const accepted = await client.request("case.respond", answer) as { receipt: unknown };
    await waitCase(client, "accepted", "terminal");
    await client.request("case.run", { caseId: "expired" });
    const expiredWait = await waitCase(client, "expired", "waiting_for_input"), expiredRequest = expiredWait.inputRequests[0];
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expiredRequest.expiresAt) - Date.now() + 50)));
    await expect(client.request("case.respond", { ...answer, caseId: "expired", requestId: expiredRequest.requestId, submissionId: "too-late", expectedRevision: expiredRequest.revision }))
      .rejects.toMatchObject({ code: "input_expired" });
    expect((await client.request("case.respond", answer) as { receipt: unknown }).receipt).toEqual(accepted.receipt);
    const control = JSON.parse(await readFile(path.join(f.sessionRoot(), "retained/runs", `${runKey(expiredWait.runRef!)}.json`), "utf8"));
    expect(control.receipts).toEqual({});
  }, 10000);

  it("cancels an initial construction validator before Run admission and joins its worker", async () => {
    const f = await fixture(), marker = path.join(f.projectRoot, "constructor.pid");
    const source = await readFile(path.join(f.projectRoot, "workflow.mjs"), "utf8");
    await writeFile(path.join(f.projectRoot, "workflow.mjs"), `import { writeFileSync } from 'node:fs';\n${source.replace(
      "export function construct(context) {", `export function construct(context) { writeFileSync(${JSON.stringify(marker)}, String(process.pid)); while (true) {}`,
    )}`);
    const client = await f.open();
    await client.request("session.create", { manifest: manifest([item("constructing")]), authorization });
    await client.request("case.run", { caseId: "constructing" });
    await expect.poll(() => readFile(marker, "utf8").catch(() => ""), { timeout: 3000 }).not.toBe("");
    const pid = Number(await readFile(marker, "utf8"));
    expect(await client.request("case.cancel", { caseId: "constructing" })).toMatchObject({ state: "terminal", runRef: null, runStatus: null, comparison: "not_checked", error: null });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(await readdir(path.join(f.sessionRoot(), "retained/runs")).catch(error => { if (error.code === "ENOENT") return []; throw error; })).toEqual([]);
    expect(await f.calls()).toEqual([]);
  }, 10000);

  it("returns the durable accepted receipt when evidence fails, then recovers without replacing or repeating the Run", async () => {
    const f = await fixture(), first = await f.open();
    await first.request("session.create", { manifest: manifest([item("waiter", 10, "wait", [countExpectation(11)])]), authorization });
    await first.request("case.run", { caseId: "waiter" });
    const waiting = await waitCase(first, "waiter", "waiting_for_input"), request = waiting.inputRequests[0];
    const evidenceRoot = path.join(f.sessionRoot(), "evidence"), heldEvidence = path.join(f.sessionRoot(), "saved-evidence"), external = path.join(f.projectRoot, "not-evidence");
    await mkdir(external); await rename(evidenceRoot, heldEvidence); await symlink(external, evidenceRoot, "dir");
    const answer = { caseId: "waiter", requestId: request.requestId, submissionId: "accepted-answer", expectedRevision: request.revision,
      response: { schemaVersion: 1, fields: { city: "Istanbul" }, files: {} } };
    const accepted = await first.request("case.respond", answer) as { receipt: { submissionId: string }; case: CaseSnapshot };
    expect(accepted).toMatchObject({ receipt: { submissionId: "accepted-answer" }, case: { state: "action_required", comparison: "unavailable", error: { code: "storage_unavailable" } } });
    await rm(evidenceRoot); await rename(heldEvidence, evidenceRoot);
    const terminal = await waitCase(first, "waiter", "terminal");
    expect(terminal).toMatchObject({ runRef: waiting.runRef, runStatus: "complete", comparison: "pass", error: null });
    expect(await evidence(first, terminal, "result")).toMatchObject({ count: 11, city: "ISTANBUL" });
    await first.close();
    const reopened = await f.open(); await reopened.request("session.open", { sessionId: "diagnostic" });
    const again = await reopened.request("case.respond", answer) as { receipt: unknown };
    expect(again.receipt).toEqual(accepted.receipt);
    await waitCase(reopened, "waiter", "terminal"); expect(await f.calls()).toHaveLength(1);
  }, 15000);
});
