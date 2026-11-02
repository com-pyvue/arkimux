import { describe, expect, it, vi } from "vitest";
import { createDockerMockDebuggerCoordinator, type PreparedDockerMockDebuggerSession } from "../../cli/src/dockerMockDebuggerCoordinator.ts";
import type { DockerMockDebuggerBridgeSession } from "../../cli/src/dockerMockDebuggerLauncher.ts";
import { HeadlessDebuggerError, type HeadlessManifestV2 } from "../../local/src/headlessDebuggerContracts.ts";

const authorization = { executeProjectCode: true, discloseWorkflowData: true, discloseLiveState: true,
  allowSimulatedEvaluation: true } as const;
const manifest = (stopOnEntry = true): HeadlessManifestV2 => ({ schemaVersion: 2, sessionId: "docker-session", workflowId: "fixture",
  configurationId: "fixture-v1", debug: { stopOnEntry }, cases: [
    { caseId: "first", input: { value: 10 }, mocks: {}, expectations: [{ id: "result", target: "result", pointer: "/value", operator: "equals", value: 11 }] },
    { caseId: "second", input: { value: 20 }, mocks: {}, expectations: [] },
  ] });

const prepared: PreparedDockerMockDebuggerSession = {
  image: { sourceKind: "candidate-archive", manifestReference: "candidate:test", runtimeReference: `sha256:${"a".repeat(64)}`,
    imageIdentity: `sha256:${"a".repeat(64)}`, dockerServerVersion: "test", acquired: false },
  retainedCode: "export function construct() {}", retainedAssets: { "workflows/fixture/prompts/system.txt": Buffer.from("prompt") },
  buildSha256: "b".repeat(64), buildVersion: "build-v1",
  workflow: { kind: "fixture", version: 1 }, configuration: { configurationId: "fixture-v1", contentHash: "c".repeat(64) },
  construction: { schemaVersion: 1, export: "construct" }, workflowContractVersion: "1", resultKind: "fixture.result",
  runConfiguration: { configurationId: "fixture-v1" }, invocationModel: "workflow-input", agentSlotIds: [],
};

type MutableBridge = DockerMockDebuggerBridgeSession & {
  terminal: unknown;
  suspension: unknown;
  state: Record<string, unknown>;
  requests: { method: string; params: unknown }[];
  closed: boolean;
  inspectionError?: Error;
};

function bridge(caseId = "first"): MutableBridge {
  const session = {
    containerName: `mock-${caseId}`, imageIdentity: prepared.image.imageIdentity,
    ready: { kind: "arkimux-mock-debugger-retained-bridge", ok: true, simulated: true, caseId,
      pause: { pauseId: "pause-entry", attemptId: `mock-${caseId}` } },
    terminal: null as unknown,
    suspension: null as unknown,
    state: { state: "paused", debuggerRevision: 0, pause: { pauseId: "pause-entry", attemptId: `mock-${caseId}` } } as Record<string, unknown>,
    requests: [] as { method: string; params: unknown }[],
    closed: false,
    inspectionError: undefined as Error | undefined,
    async request(method: string, params: unknown) {
      session.requests.push({ method, params });
      if (method === "session.inspect" || method === "debug.inspect") {
        if (session.inspectionError) throw session.inspectionError;
        return { state: session.state, sources: { items: [] }, suspension: session.suspension, terminal: session.terminal };
      }
      if (method === "case.respond") { session.suspension = null; session.state = { state: "paused", debuggerRevision: 0,
        pause: { pauseId: "pause-resumed", attemptId: `mock-${caseId}` } }; return { receipt: { submissionId: "submission-1" }, state: session.state }; }
      if (method === "debug.continue") { session.state = { state: "running", debuggerRevision: 1, attemptId: `mock-${caseId}` }; return { applied: true }; }
      return { method, params };
    },
    async close() { session.closed = true; },
  };
  return session as MutableBridge;
}

function fixture(stopOnEntry = true) {
  const launched: { input: Parameters<NonNullable<Parameters<typeof createDockerMockDebuggerCoordinator>[0]["launch"]>>[0]; bridge: MutableBridge }[] = [];
  const prepare = vi.fn(async () => prepared);
  const launch = vi.fn(async input => {
    const value = bridge(input.bootstrap.caseId);
    launched.push({ input, bridge: value });
    return value;
  });
  const changes: [string, number][] = [];
  const client = createDockerMockDebuggerCoordinator({ prepare, launch, onChange: (sessionId, revision) => changes.push([sessionId, revision]),
    now: () => new Date("2026-09-20T12:00:00.000Z") });
  const call = (method: string, params: unknown = {}) => client.request(method, params, 2);
  const create = () => call("session.create", { manifest: manifest(stopOnEntry), authorization });
  return { client, call, create, prepare, launch, launched, changes };
}

function graphFixture() {
  const graphPrepared: PreparedDockerMockDebuggerSession = {
    ...prepared,
    workflow: { kind: "graph-fixture", version: 1 },
    invocationModel: "graph-entry",
    agentSlotIds: ["advisor", "reviewer"],
  };
  const launched: { input: Parameters<NonNullable<Parameters<typeof createDockerMockDebuggerCoordinator>[0]["launch"]>>[0]; bridge: MutableBridge }[] = [];
  const prepare = vi.fn(async () => graphPrepared);
  const launch = vi.fn(async input => {
    const value = bridge(input.bootstrap.caseId);
    launched.push({ input, bridge: value });
    return value;
  });
  const client = createDockerMockDebuggerCoordinator({ prepare, launch,
    now: () => new Date("2026-09-20T12:00:00.000Z") });
  const call = (method: string, params: unknown = {}) => client.request(method, params, 2);
  return { call, launched };
}

describe("Docker mock debugger V2 coordinator", () => {
  it("prepares without execution, launches one case and forwards only the private bridge fields", async () => {
    const f = fixture();
    const created = await f.create() as any;
    expect(created).toMatchObject({ sessionId: "docker-session", simulated: true, preparation: "ready",
      cases: [{ caseId: "first", state: "not_started" }, { caseId: "second", state: "not_started" }] });
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.launch).not.toHaveBeenCalled();
    await expect(f.create()).resolves.toMatchObject({ sessionId: "docker-session", revision: 1 });
    expect(f.prepare).toHaveBeenCalledOnce();
    const changedManifest = manifest(); changedManifest.cases[0].input = { value: 99 };
    await expect(f.call("session.create", { manifest: changedManifest, authorization })).rejects.toMatchObject({ code: "identity_conflict" });

    await expect(f.call("case.run", { caseId: "first" })).resolves.toMatchObject({ caseId: "first", state: "paused" });
    expect(f.launched[0].input.bootstrap).toMatchObject({ caseId: "first", buildSha256: prepared.buildSha256,
      stopOnEntry: true, invocation: { input: { value: 10 }, runRef: { executionId: "mock-docker-session-first" } } });
    expect(f.launched[0].input.retainedCode).toBe(prepared.retainedCode);
    expect(f.launched[0].input.retainedAssets).toBe(prepared.retainedAssets);
    expect(f.launched[0].input.bootstrap.assets).toEqual([{ path: "workflows/fixture/prompts/system.txt", byteLength: 6,
      sha256: "cf07194ee232eb531e15f690000d19846dea69cf05504782658afcfacb9228a2" }]);

    await expect(f.call("debug.breakpoints.set", { expectedDebuggerRevision: 99, breakpoints: [] }))
      .rejects.toMatchObject({ code: "stale_debugger_revision" });
    await expect(f.call("debug.breakpoints.set", { expectedDebuggerRevision: 0, breakpoints: [] }))
      .resolves.toEqual({ method: "debug.breakpoints.set", params: { breakpoints: [] } });

    await expect(f.call("debug.continue", { caseId: "first", pauseId: "pause-entry", controlId: "continue-1" }))
      .resolves.toEqual({ applied: true });
    expect(f.launched[0].bridge.requests.at(-1)).toEqual({ method: "debug.continue", params: { pauseId: "pause-entry" } });
    const requestCount = f.launched[0].bridge.requests.length;
    await expect(f.call("debug.continue", { caseId: "first", pauseId: "pause-entry", controlId: "continue-1" }))
      .resolves.toEqual({ applied: true });
    expect(f.launched[0].bridge.requests).toHaveLength(requestCount);
    await expect(f.call("debug.continue", { caseId: "first", pauseId: "another-pause", controlId: "continue-1" }))
      .rejects.toMatchObject({ code: "control_conflict" });
    await expect(f.call("case.run", { caseId: "second" })).rejects.toMatchObject({ code: "case_busy" });
  });

  it("retains a terminal simulated result, closes its container and pages terminal evidence", async () => {
    const f = fixture(); await f.create(); await f.call("case.run", { caseId: "first" });
    f.launched[0].bridge.terminal = { schemaVersion: 1, kind: "arkimux-mock-debugger-case-result", simulated: true,
      caseId: "first", status: "passed", comparison: { comparison: "pass", checks: [] }, output: { value: 11 } };
    f.launched[0].bridge.state = { state: "terminated" };
    const snapshot = await f.call("session.inspect") as any;
    expect(snapshot.cases[0]).toMatchObject({ state: "terminal", terminal: { status: "passed", simulated: true },
      evidence: [{ kind: "terminal", redacted: true }] });
    expect(f.launched[0].bridge.closed).toBe(true);
    const descriptor = snapshot.cases[0].evidence[0];
    const page = await f.call("evidence.read", { caseId: "first", evidenceId: descriptor.evidenceId, offset: 0, limit: 262144 }) as any;
    expect(page.nextOffset).toBeNull();
    expect(JSON.parse(Buffer.from(page.data, "base64").toString("utf8"))).toMatchObject({ caseId: "first", status: "passed" });
    await expect(f.call("case.run", { caseId: "second" })).resolves.toMatchObject({ state: "paused" });
  });

  it("records cancellation for started and unstarted cases and cleans up on close", async () => {
    const f = fixture(); await f.create(); await f.call("case.run", { caseId: "first" });
    await expect(f.call("case.cancel", { caseId: "first" })).resolves.toMatchObject({ state: "terminal", terminal: { status: "cancelled" } });
    expect(f.launched[0].bridge.closed).toBe(true);
    await expect(f.call("case.cancel", { caseId: "second" })).resolves.toMatchObject({ state: "terminal", terminal: { status: "cancelled" } });
    await expect(f.call("session.close")).resolves.toEqual({ closed: true });
    await expect(f.call("session.inspect")).rejects.toMatchObject({ code: "session_busy" });
  });

  it("continues from entry when stopOnEntry is false", async () => {
    const f = fixture(false); await f.create();
    await expect(f.call("case.run", { caseId: "first" })).resolves.toMatchObject({ state: "active" });
    expect(f.launched[0].bridge.requests).toContainEqual({ method: "debug.continue", params: { pauseId: "pause-entry" } });
  });

  it("records sandbox unavailability, forwards breakpoints and resumes a suspended mock case", async () => {
    const f = fixture(); f.launch.mockRejectedValueOnce(new HeadlessDebuggerError("debugger_unavailable", "Start Docker Desktop."));
    await f.create();
    await expect(f.call("case.run", { caseId: "first" })).rejects.toMatchObject({ code: "debugger_unavailable" });
    const unavailable = await f.call("session.inspect") as any;
    expect(unavailable.cases[0]).toMatchObject({ state: "terminal", terminal: { status: "sandbox_unavailable" } });
    await f.call("case.run", { caseId: "second" });
    await expect(f.call("debug.breakpoints.set", { expectedDebuggerRevision: 0,
      breakpoints: [{ breakpointId: "condition", sourceId: "source", line: 1, column: 1,
        condition: "value > 1", logExpression: "value" }] })).resolves.toEqual({ method: "debug.breakpoints.set", params: {
          breakpoints: [{ breakpointId: "condition", sourceId: "source", line: 1, column: 1,
            condition: "value > 1", logExpression: "value" }],
        } });
    f.launched[0].bridge.suspension = { schemaVersion: 1, requestId: "request-1", title: "Confirm" };
    f.launched[0].bridge.state = { state: "terminated", debuggerRevision: 2, pause: null };
    await expect(f.call("session.inspect")).resolves.toMatchObject({ cases: [{ state: "terminal" }, {
      caseId: "second", state: "waiting_for_input", request: { requestId: "request-1" },
    }] });
    await expect(f.call("case.respond", { caseId: "second", requestId: "request-1", submissionId: "submission-1", expectedRevision: 1,
      response: { schemaVersion: 1, fields: {}, files: {} } })).resolves.toMatchObject({ receipt: { submissionId: "submission-1" } });
    await expect(f.call("session.inspect")).resolves.toMatchObject({ cases: [{ state: "terminal" }, { state: "paused", request: null }] });
  });

  it("turns an unexpected container stop into terminal sandbox-unavailable evidence", async () => {
    const f = fixture(); await f.create(); await f.call("case.run", { caseId: "first" });
    f.launched[0].bridge.inspectionError = new HeadlessDebuggerError("debugger_unavailable", "Container stopped.");
    await expect(f.call("session.inspect")).rejects.toMatchObject({ code: "debugger_unavailable" });
    expect(f.launched[0].bridge.closed).toBe(true);
    const snapshot = await f.call("session.inspect") as any;
    expect(snapshot.cases[0]).toMatchObject({ state: "terminal", terminal: { status: "sandbox_unavailable" } });
  });

  it("keeps graph preparation inside the Docker bootstrap", async () => {
    const f = graphFixture();
    await f.call("session.create", { manifest: manifest(), authorization });
    await f.call("case.run", { caseId: "first" });
    expect(f.launched[0].input.bootstrap).toMatchObject({
      invocation: { input: { value: 10 } },
      graph: {
        request: { value: 10 },
        identity: {
          runRef: { executionId: "mock-docker-session-first" },
          executableBindingId: "mock-docker-session-first",
          requestId: "graph-first",
        },
        agentSlotIds: ["advisor", "reviewer"],
      },
    });
  });
});
