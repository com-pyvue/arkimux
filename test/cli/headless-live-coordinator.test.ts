import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build as bundle } from "esbuild";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHeadlessDebugger, type HeadlessDebuggerOptions, type PreparedHeadlessSession } from "../../local/src/headlessDebugger.ts";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import type { HeadlessManifestV2 } from "../../local/src/headlessDebuggerContracts.ts";

type Client = Awaited<ReturnType<typeof createHeadlessDebugger>>;
type RunRef = { executionId: string };
type CaseSnapshot = { caseId: string; runRef: RunRef | null; state: string; runStatus: string | null; comparison: string;
  inputRequests: { requestId: string; revision: number; status: string }[];
  evidence: { evidenceId: string; kind: string }[]; error: unknown };
type SessionSnapshot = { sessionId: string; build: { buildSha256: string }; cases: CaseSnapshot[] };
type Pause = { pauseId: string; reason: string; sourceId: string; line: number; column: number; breakpointIds: string[] };
type DebugSnapshot = { caseId: string; runRef: RunRef | null; attemptId: string | null; debuggerRevision: number; state: string; pause: Pause | null;
  budget: { limitMs: number; spentMs: number | null; remainingMs: number | null; excludedPauseMs: number | null; clock: string; reason: string };
  externalWork: { activeCount: number; activityKnown: boolean }; error: unknown };
type LiveValue = { kind: string; value?: unknown; type?: string; objectId?: string };
type Properties = { items: { name: string; value: LiveValue }[]; nextOffset: number | null };
type Frame = { frameId: string; functionName: string; kind: string; location: { sourceId: string; line: number; column: number } | null };
type Source = { sourceId: string; buildSha256: string; displayPath: string; contentSha256: string; exactSourceMap: boolean };
const clients: Client[] = [], roots: string[] = [];
const authorization = { executeProjectCode: true, discloseWorkflowData: true, discloseLiveState: true,
  allowSimulatedEvaluation: true } as const;
const workflow = { kind: "headless-live-fixture", version: 1 } as const;
const displayPath = "workflows/debug/src/workflow.ts";
const sourceText = `const identity = { parse: value => value };
const recordExecution = { schemaVersion: 1, operationId: "record-live-fixture", definitionVersion: "v1",
  safety: "idempotent-write", input: identity, output: identity };
function nested(number) {
  const twice = number * 2; // nested-entry
  const plusOne = twice + 1; // nested-next
  return plusOne; // nested-return
}
export function construct(context) {
  return { agentPrompts: {}, workflow: {
    workflow: { kind: "headless-live-fixture", version: 1 }, workflowContractVersion: "1", resultKind: "headless-live-fixture.result",
    input: { parse(value) { if (!Number.isInteger(value?.count) || !["complete", "wait"].includes(value?.mode)) throw Error("Invalid input"); return value; } },
    output: { parse(value) { if (value?.schemaVersion !== 1 || !Number.isInteger(value?.count) || !Number.isInteger(value?.nested)) throw Error("Invalid result"); return value; } },
    async execute(ctx, value) {
      const before = value.count; // workflow-entry
      const result = before + 1; // increment
      const doubled = nested(result); // nested-call
      const first = await ctx.steps.run({ schemaVersion: 1, id: "calculate", definitionVersion: "v1", input: identity, output: identity,
        async execute(stepContext) {
          await stepContext.effects.run(recordExecution, { count: result, pid: process.pid });
          return { count: result };
        },
      }, value);
      let answer = "";
      if (value.mode === "wait") {
        const received = await ctx.steps.waitForInput({ id: "confirm", title: "Confirm", expiresAfter: "366d", form: {
          descriptor: { schemaVersion: 1, id: "answer", version: "v1", fields: [{ id: "answer", label: "Answer", type: "text", required: true, maxLength: 30 }] },
          output: identity,
        } });
        answer = received.output.fields.answer;
      }
      return { schemaVersion: 1, count: first.output.count, nested: doubled, answer }; // workflow-return
    },
  } };
}
`;
const effectAdapterSource = `import { appendFile } from "node:fs/promises";
const identity = { parse: value => value };
export function createRecordLiveFixtureAdapter(context) { return {
  schemaVersion: 1, operationId: "record-live-fixture", definitionVersion: "v1", safety: "idempotent-write",
  input: identity, output: identity,
  async execute(_execution, input) {
    await appendFile(context.environment.AUDIT_FILE, JSON.stringify({ count: input.count, pid: input.pid }) + "\\n");
    return { recorded: true };
  },
}; }
`;
const sourceLine = (marker: string) => {
  const index = sourceText.split("\n").findIndex(line => line.endsWith(`// ${marker}`));
  if (index === -1) throw Error(`Missing test source marker ${marker}`);
  return index + 1;
};
let worker: Uint8Array;
beforeAll(async () => {
  worker = (await bundle({ entryPoints: ["local/src/retainedAttemptWorker.ts"], bundle: true, platform: "node",
    format: "esm", write: false, logLevel: "silent" })).outputFiles[0].contents;
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(totalMs = 30_000) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "headless-live-coordinator-")); roots.push(projectRoot);
  const workerPath = path.join(projectRoot, "worker.mjs"), auditFile = path.join(projectRoot, "effects.jsonl"), pidFile = path.join(projectRoot, "workers.jsonl");
  const sourceFile = path.join(projectRoot, displayPath);
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await writeFile(sourceFile, sourceText);
  await writeFile(path.join(projectRoot, "registry.mjs"), "throw Error('Mutable registry must not be loaded');");
  await writeFile(workerPath, Buffer.concat([Buffer.from(`import { appendFileSync as recordWorker } from "node:fs"; recordWorker(${JSON.stringify(pidFile)}, JSON.stringify({pid:process.pid})+"\\n");\n`), worker]));
  await mkdir(path.join(projectRoot, "config"));
  await copyFile("core/config/agent-providers.default.json", path.join(projectRoot, "config/agent-providers.default.json"));
  const prepareSession = vi.fn<NonNullable<HeadlessDebuggerOptions["prepareSession"]>>(async options => {
    const currentSource = await readFile(sourceFile, "utf8");
    const compiled = (await bundle({ stdin: { contents: currentSource, sourcefile: `arkimux-source:///${displayPath}`, loader: "ts" },
      bundle: true, platform: "node", format: "esm", sourcemap: "inline", sourcesContent: true, write: false, logLevel: "silent" })).outputFiles[0].contents;
    const build = await options.store.publishBuild({ inputSha256: hashJson(currentSource), entryPoint: "entry.mjs", files: {
      "entry.mjs": compiled, "effect-adapters.mjs": Buffer.from(effectAdapterSource),
      "construction.json": Buffer.from(JSON.stringify({ schemaVersion: 2, export: "construct",
        effectAdapterEntryPoint: "effect-adapters.mjs", effectAdapters: ["createRecordLiveFixtureAdapter"] })),
    }, hostRequirements: options.hostRequirements });
    return { workflow, configuration: { schemaVersion: 1, configurationId: "live-v1", workflow, agents: {} },
      buildSha256: build.buildSha256, buildVersion: build.createdAt, workflowContractVersion: "1", resultKind: "headless-live-fixture.result",
      agentSlotIds: [], nonSecretEnvironment: { AUDIT_FILE: auditFile }, credentialReferences: [], hostRequirements: options.hostRequirements,
      executionProfile: { maxScratchBytes: 1048576, computeLimits: { totalMs, attemptMs: totalMs, finalizationReserveMs: Math.min(3000, Math.floor(totalMs / 10)) } },
    } satisfies PreparedHeadlessSession;
  });
  const open = async (options: Partial<HeadlessDebuggerOptions> = {}) => {
    const client = await createHeadlessDebugger({ projectRoot, packageVersion: "0.1.0-fixture.live", workerPath, prepareSession, ...options });
    clients.push(client); return client;
  };
  const readLines = async (file: string) => (await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; }))
    .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { projectRoot, sourceFile, open, prepareSession, effects: () => readLines(auditFile), pids: async () => (await readLines(pidFile)).map(item => item.pid as number),
    sessionRoot: path.join(projectRoot, ".arkimux/debug/sessions/live") };
}
const live = (client: Client, method: string, params: unknown = {}) => client.request(method, params, 2);
const manifest = (mode: "complete" | "wait" = "complete"): HeadlessManifestV2 => ({ schemaVersion: 2, sessionId: "live", workflowId: workflow.kind,
  configurationId: "live-v1", debug: { stopOnEntry: true }, cases: [{ caseId: "first", input: { count: 10, mode },
    mocks: {}, expectations: [{ id: "count", target: "result", pointer: "/count", operator: "equals", value: 11 }] }] });
async function create(client: Client, mode: "complete" | "wait" = "complete") { return await live(client, "session.create", { manifest: manifest(mode), authorization }) as SessionSnapshot; }
async function inspect(client: Client) { return await live(client, "debug.inspect", { caseId: "first" }) as DebugSnapshot; }
async function caseState(client: Client) { return (await live(client, "session.inspect") as SessionSnapshot).cases[0]; }
async function waitPause(client: Client, previousPause?: string) {
  let snapshot!: DebugSnapshot;
  await expect.poll(async () => {
    snapshot = await inspect(client);
    if (["action_required", "terminated"].includes(snapshot.state)) throw Error(`Expected live pause, got ${JSON.stringify(snapshot)}`);
    return snapshot.state === "paused" && !!snapshot.pause && snapshot.pause.pauseId !== previousPause;
  }, { timeout: 10_000, interval: 20 }).toBe(true);
  expect(snapshot.pause?.sourceId).toBeTruthy();
  return snapshot as DebugSnapshot & { pause: Pause };
}
async function waitCase(client: Client, state: string) {
  let snapshot!: CaseSnapshot;
  try {
    await expect.poll(async () => { snapshot = await caseState(client); return snapshot.state; }, { timeout: 10_000, interval: 20 }).toBe(state);
  } catch (cause) {
    const summary = snapshot && { state: snapshot.state, runStatus: snapshot.runStatus, comparison: snapshot.comparison, error: snapshot.error };
    throw Error(`Expected ${state}. Case: ${JSON.stringify(summary)}. Debugger: ${JSON.stringify(await inspect(client))}`, { cause });
  }
  return snapshot;
}
async function topScope(client: Client, paused: DebugSnapshot & { pause: Pause }) {
  const stack = await live(client, "debug.stack", { caseId: "first", pauseId: paused.pause.pauseId, offset: 0, limit: 100 }) as { items: Frame[] };
  const frame = stack.items[0]; expect(frame.kind).toBe("workflow");
  const scopes = await live(client, "debug.scopes", { caseId: "first", pauseId: paused.pause.pauseId, frameId: frame.frameId }) as { items: { type: string; value: LiveValue }[] };
  const local = scopes.items.find(scope => scope.type === "local")!; expect(local.value.kind).toBe("object");
  const properties = await live(client, "debug.properties", { caseId: "first", pauseId: paused.pause.pauseId, objectId: local.value.objectId, offset: 0, limit: 100 }) as Properties;
  return { frame, objectId: local.value.objectId!, values: Object.fromEntries(properties.items.map(item => [item.name, item.value])) };
}
async function result(client: Client, snapshot: CaseSnapshot) {
  const descriptor = snapshot.evidence.find(item => item.kind === "result")!;
  expect(descriptor).toBeDefined();
  const page = await live(client, "evidence.read", { caseId: "first", evidenceId: descriptor.evidenceId, offset: 0, limit: 262144 }) as { data: string; nextOffset: number | null };
  expect(page.nextOffset).toBeNull();
  return JSON.parse(Buffer.from(page.data, "base64").toString("utf8"));
}

describe("live headless debugger retained coordinator", () => {
  it("stops before the first statement, reads input, binds retained source and steps without duplicating a control", async () => {
    const f = await fixture(), client = await f.open(), session = await create(client);
    expect(session.cases[0]).toMatchObject({ state: "not_started", runRef: null });
    expect(await f.effects()).toEqual([]); expect(await f.pids()).toEqual([]);
    const sources = await live(client, "debug.sources", { offset: 0, limit: 100 }) as { items: Source[] };
    expect(sources.items).toHaveLength(1);
    const source = sources.items[0];
    expect(source).toMatchObject({ buildSha256: session.build.buildSha256, displayPath, exactSourceMap: true });
    const sourceRead = await live(client, "debug.source.read", { sourceId: source.sourceId, offset: 0, limit: 262144 }) as { data: string };
    expect(Buffer.from(sourceRead.data, "base64").toString("utf8")).toBe(sourceText);
    await live(client, "case.run", { caseId: "first" });
    const entry = await waitPause(client);
    expect(entry.pause).toMatchObject({ reason: "entry", sourceId: source.sourceId, line: sourceLine("workflow-entry") });
    expect(await caseState(client)).toMatchObject({ state: "paused", runStatus: "running", comparison: "pending" });
    expect(await f.effects()).toEqual([]);
    const initial = await topScope(client, entry);
    expect(initial.values.value.kind).toBe("object");
    const input = await live(client, "debug.properties", { caseId: "first", pauseId: entry.pause.pauseId, objectId: initial.values.value.objectId, offset: 0, limit: 100 }) as Properties;
    expect(input.items).toContainEqual({ name: "count", value: { kind: "scalar", type: "number", value: 10 } });
    expect(initial.values.before.kind).toBe("uninitialized");
    expect(initial.values.result.kind).toBe("uninitialized");
    const breakpoint = { expectedDebuggerRevision: entry.debuggerRevision, breakpoints: [{ breakpointId: "nested-call", sourceId: source.sourceId,
      line: sourceLine("nested-call"), column: 1 }] };
    const binding = await live(client, "debug.breakpoints.set", breakpoint);
    expect(await live(client, "debug.breakpoints.set", breakpoint)).toEqual(binding);
    await live(client, "debug.continue", { caseId: "first", pauseId: entry.pause.pauseId, controlId: "to-call" });
    const call = await waitPause(client, entry.pause.pauseId);
    expect(call.pause).toMatchObject({ reason: "breakpoint", line: sourceLine("nested-call"), breakpointIds: ["nested-call"] });
    const beforeCall = await topScope(client, call);
    expect(beforeCall.values.before).toMatchObject({ kind: "scalar", value: 10 });
    expect(beforeCall.values.result).toMatchObject({ kind: "scalar", value: 11 });
    await expect(live(client, "debug.scopes", { caseId: "first", pauseId: call.pause.pauseId, frameId: initial.frame.frameId })).rejects.toMatchObject({ code: "stale_handle" });
    const into = { caseId: "first", pauseId: call.pause.pauseId, controlId: "step-in", kind: "into" };
    const receipt = await live(client, "debug.step", into) as { receipt: unknown };
    const inside = await waitPause(client, call.pause.pauseId);
    expect(inside.pause).toMatchObject({ reason: "step", line: sourceLine("nested-entry") });
    expect((await topScope(client, inside)).values.number).toMatchObject({ kind: "scalar", value: 11 });
    expect((await live(client, "debug.step", into) as { receipt: unknown }).receipt).toEqual(receipt.receipt);
    expect((await inspect(client)).pause?.pauseId).toBe(inside.pause.pauseId);
    await expect(live(client, "debug.step", { ...into, kind: "over" })).rejects.toMatchObject({ code: "control_conflict" });
    await expect(live(client, "debug.continue", { caseId: "first", pauseId: call.pause.pauseId, controlId: "stale-new" })).rejects.toMatchObject({ code: "stale_pause" });
    await live(client, "debug.step", { caseId: "first", pauseId: inside.pause.pauseId, controlId: "step-over", kind: "over" });
    const afterAssignment = await waitPause(client, inside.pause.pauseId);
    expect(afterAssignment.pause.line).toBe(sourceLine("nested-next"));
    expect((await topScope(client, afterAssignment)).values.twice).toMatchObject({ kind: "scalar", value: 22 });
    await live(client, "debug.step", { caseId: "first", pauseId: afterAssignment.pause.pauseId, controlId: "step-out", kind: "out" });
    const caller = await waitPause(client, afterAssignment.pause.pauseId);
    expect((await topScope(client, caller)).frame.functionName).toContain("execute");
    await live(client, "debug.breakpoints.set", { expectedDebuggerRevision: caller.debuggerRevision, breakpoints: [] });
    await live(client, "debug.continue", { caseId: "first", pauseId: caller.pause.pauseId, controlId: "finish" });
    const completed = await waitCase(client, "terminal");
    expect(completed).toMatchObject({ runRef: entry.runRef, runStatus: "complete", comparison: "pass" });
    expect(await result(client, completed)).toMatchObject({ count: 11, nested: 23, answer: "" });
    expect(await f.effects()).toHaveLength(1);
    await client.close();
    for (const pid of await f.pids()) expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);

  it("excludes a connected quiet pause longer than the Run budget without resetting spent time", async () => {
    const f = await fixture(6000), client = await f.open(); await create(client);
    await live(client, "case.run", { caseId: "first" });
    const first = await waitPause(client);
    expect(first.budget).toMatchObject({ limitMs: 6000, clock: "paused", reason: "debug_pause" });
    expect(first.externalWork).toMatchObject({ activeCount: 0, activityKnown: true });
    await new Promise(resolve => setTimeout(resolve, 6500));
    const later = await inspect(client);
    expect(later).toMatchObject({ state: "paused", pause: { pauseId: first.pause.pauseId } });
    expect(later.budget.spentMs).toBe(first.budget.spentMs);
    expect(later.budget.remainingMs).toBe(first.budget.remainingMs);
    expect(later.budget.excludedPauseMs! - first.budget.excludedPauseMs!).toBeGreaterThanOrEqual(6400);
    await live(client, "debug.continue", { caseId: "first", pauseId: first.pause.pauseId, controlId: "finish" });
    const completed = await waitCase(client, "terminal");
    expect(completed).toMatchObject({ runStatus: "complete", comparison: "pass" });
    const terminal = await inspect(client);
    expect(terminal.budget.spentMs).toBeGreaterThanOrEqual(first.budget.spentMs!);
    expect(terminal.budget.spentMs).toBeLessThan(6000);
  }, 20_000);

  it.each(["cancel", "close"] as const)("%s terminates a paused worker without continuing workflow effects", async mode => {
    const f = await fixture(), client = await f.open(); await create(client);
    await live(client, "case.run", { caseId: "first" });
    const paused = await waitPause(client);
    const pids = await f.pids(); expect(pids.length).toBeGreaterThan(0);
    if (mode === "cancel") {
      const cancelled = await live(client, "case.cancel", { caseId: "first" });
      expect(cancelled, JSON.stringify(cancelled)).toMatchObject({ state: "terminal", runStatus: "cancelled" });
    }
    else expect(await live(client, "session.close")).toEqual({ closed: true });
    await client.close();
    expect(await f.effects()).toEqual([]);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    const reopened = await f.open();
    const state = await live(reopened, "session.open", { sessionId: "live" }) as SessionSnapshot;
    expect(state.cases[0]).toMatchObject({ runRef: paused.runRef, state: "terminal", runStatus: "cancelled" });
    expect((await inspect(reopened)).pause).toBeNull();
    const journal = JSON.parse(await readFile(path.join(f.sessionRoot, "session.json"), "utf8"));
    expect(journal.schemaVersion).toBe(2);
    expect(JSON.stringify(journal)).not.toMatch(/ws:\/\/127\.0\.0\.1|callFrameId|scopeChain/);
  }, 20_000);

  it("resumes the same waiting Run with original source and breakpoint intent without repeating a completed effect", async () => {
    const f = await fixture(), first = await f.open(), session = await create(first, "wait");
    const sources = await live(first, "debug.sources", { offset: 0, limit: 100 }) as { items: Source[] };
    const source = sources.items[0];
    await live(first, "debug.breakpoints.set", { expectedDebuggerRevision: (await inspect(first)).debuggerRevision,
      breakpoints: [{ breakpointId: "final-result", sourceId: source.sourceId, line: sourceLine("workflow-return"), column: 1 }] });
    await live(first, "case.run", { caseId: "first" });
    const entry = await waitPause(first);
    await live(first, "debug.continue", { caseId: "first", pauseId: entry.pause.pauseId, controlId: "to-wait" });
    const waiting = await waitCase(first, "waiting_for_input");
    expect(await f.effects()).toHaveLength(1);
    expect((await inspect(first)).pause).toBeNull();
    await first.close();
    await writeFile(f.sourceFile, sourceText.replace("const result = before + 1", "const result = before + 999"));
    await writeFile(path.join(f.projectRoot, "registry.mjs"), "throw Error('Edited registry must not execute');");
    const second = await f.open({ prepareSession: async () => { throw Error("Current preparation must not run on reopen"); } });
    const reopened = await live(second, "session.open", { sessionId: "live" }) as SessionSnapshot;
    expect(reopened.build).toEqual(session.build);
    expect(reopened.cases[0]).toMatchObject({ runRef: waiting.runRef, state: "waiting_for_input" });
    const retained = await live(second, "debug.source.read", { sourceId: source.sourceId, offset: 0, limit: 262144 }) as { data: string };
    expect(Buffer.from(retained.data, "base64").toString("utf8")).toBe(sourceText);
    const inputRequest = waiting.inputRequests[0];
    await live(second, "case.respond", { caseId: "first", requestId: inputRequest.requestId, submissionId: "answer-1", expectedRevision: inputRequest.revision,
      response: { schemaVersion: 1, fields: { answer: "confirmed" }, files: {} } });
    const resumed = await waitPause(second);
    expect(resumed.runRef).toEqual(entry.runRef);
    expect(resumed.attemptId).not.toBe(entry.attemptId);
    expect(resumed.pause).toMatchObject({ reason: "entry", sourceId: source.sourceId, line: sourceLine("workflow-entry") });
    await expect(live(second, "debug.continue", { caseId: "first", pauseId: entry.pause.pauseId, controlId: "foreign-old-pause" })).rejects.toMatchObject({ code: "stale_pause" });
    await live(second, "debug.continue", { caseId: "first", pauseId: resumed.pause.pauseId, controlId: "to-result" });
    const finalPause = await waitPause(second, resumed.pause.pauseId);
    expect(finalPause.pause).toMatchObject({ reason: "breakpoint", sourceId: source.sourceId, line: sourceLine("workflow-return"), breakpointIds: ["final-result"] });
    expect((await topScope(second, finalPause)).values.result).toMatchObject({ kind: "scalar", value: 11 });
    await live(second, "debug.continue", { caseId: "first", pauseId: finalPause.pause.pauseId, controlId: "finish" });
    const completed = await waitCase(second, "terminal");
    expect(completed).toMatchObject({ runRef: waiting.runRef, runStatus: "complete", comparison: "pass" });
    expect(await result(second, completed)).toMatchObject({ count: 11, nested: 23, answer: "confirmed" });
    expect(await f.effects()).toHaveLength(1);
    expect(f.prepareSession).toHaveBeenCalledOnce();
  }, 30_000);
});
