import { EventEmitter } from "node:events";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { parseDockerMockDebuggerBootstrap, parseDockerMockDebuggerBridgeRequest, type DockerMockDebuggerBootstrap } from "../../cli/src/dockerMockDebuggerBridgeContracts.ts";
import { describeDockerMockDebuggerAssets, launchDockerMockDebugger } from "../../cli/src/dockerMockDebuggerLauncher.ts";
import { dockerMockDebuggerRunSecurityArgs, type EnsuredDebugImage } from "../../cli/src/dockerMockDebugger.ts";
import { dockerMockDebuggerCaseResult } from "../../cli/src/dockerMockDebuggerTerminal.ts";

const imageId = "sha256:" + "a".repeat(64);
const image: EnsuredDebugImage = {
  sourceKind: "candidate-archive", manifestReference: "arkimux/mock-debug:candidate-1", runtimeReference: imageId,
  imageIdentity: imageId, dockerServerVersion: "29.3.1", acquired: false,
};
const bootstrap: DockerMockDebuggerBootstrap = {
  schemaVersion: 1,
  kind: "arkimux-mock-debugger-bootstrap",
  caseId: "case-1",
  buildSha256: "b".repeat(64),
  construction: { schemaVersion: 1, export: "construct" },
  invocation: { runRef: { executionId: "mock-case-1" }, workflow: { kind: "fixture", version: 1 }, input: { value: 10 } },
  runConfiguration: {},
  assets: [],
  mocks: {},
  expectations: [],
  stopOnEntry: true,
};

function fakeDockerProcess(onRequest?: (request: Record<string, unknown>) => unknown): {
  child: ChildProcessWithoutNullStreams; stdout: PassThrough; requests: Record<string, unknown>[];
} {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new PassThrough();
  const requests: Record<string, unknown>[] = [];
  Object.assign(child, { stdin: new PassThrough(), stdout, stderr: new PassThrough(), kill: vi.fn(() => true) });
  let partial = "";
  child.stdin.on("data", chunk => {
    partial += String(chunk);
    while (partial.includes("\n")) {
      const split = partial.indexOf("\n"), request = JSON.parse(partial.slice(0, split)); partial = partial.slice(split + 1);
      requests.push(request);
      const result = onRequest?.(request) ?? (request.method === "session.close" ? { closed: true } : { state: { state: "paused" } });
      const response = result && typeof result === "object" && "error" in result
        ? { schemaVersion: 1, id: request.id, ok: false, error: result.error }
        : { schemaVersion: 1, id: request.id, ok: true, result };
      stdout.write(JSON.stringify(response) + "\n");
      if (request.method === "session.close") queueMicrotask(() => child.emit("close", 0, null));
    }
  });
  return { child, stdout, requests };
}

function ready() {
  return { schemaVersion: 1, event: "bridge.ready", sessionId: "case-1", result: {
    schemaVersion: 1, kind: "arkimux-mock-debugger-retained-bridge", ok: true, simulated: true, caseId: "case-1",
  } };
}

describe("Docker mock-debugger launcher", () => {
  it("accepts only exact bounded mock fixtures", () => {
    const normalizedValue = Object.assign(Object.create(null) as Record<string, unknown>, { temperatureC: 24 });
    expect(parseDockerMockDebuggerBootstrap({ ...bootstrap, mocks: {
      "weather.current": { kind: "result", value: normalizedValue, delayMs: 10 },
      "agent.recommend": { kind: "error", error: { code: "quota_exhausted", message: "Fixture failure." } },
    } }).mocks).toMatchObject({ "weather.current": { kind: "result" }, "agent.recommend": { kind: "error" } });
    for (const fixture of [
      { kind: "result", value: Number.NaN },
      { kind: "result", value: new Date() },
      { kind: "result", value: null, extra: true },
      { kind: "result", value: null, delayMs: 60_001 },
      { kind: "error", error: { code: "Bad Code", message: "failure" } },
      { kind: "error", error: { code: "failed", message: "x".repeat(4_097) } },
      { kind: "error", error: { code: "failed", message: "failure", detail: "not allowed" } },
    ]) expect(() => parseDockerMockDebuggerBootstrap({ ...bootstrap, mocks: { operation: fixture } })).toThrow("fixtures are invalid");
  });

  it("rejects unsafe and duplicate retained asset descriptors", () => {
    const descriptor = { path: "workflows/fixture/prompts/system.txt", byteLength: 6, sha256: "a".repeat(64) };
    expect(parseDockerMockDebuggerBootstrap({ ...bootstrap, assets: [descriptor] }).assets).toEqual([descriptor]);
    for (const assets of [
      [{ ...descriptor, path: "workflows/fixture/../secret" }],
      [{ ...descriptor, path: "workflows/fixture/prompt\n.txt" }],
      [descriptor, descriptor],
      [{ ...descriptor, byteLength: 16 * 1024 * 1024 + 1 }],
    ]) expect(() => parseDockerMockDebuggerBootstrap({ ...bootstrap, assets })).toThrow("retained assets are invalid");
  });

  it("validates exact bounded terminal expectations", () => {
    const expectations = [{ id: "count", target: "result", pointer: "/count", operator: "equals", value: 11 }] as const;
    expect(parseDockerMockDebuggerBootstrap({ ...bootstrap, expectations }).expectations).toEqual(expectations);
    expect(() => parseDockerMockDebuggerBootstrap({ ...bootstrap, expectations: [expectations[0], expectations[0]] }))
      .toThrow("expectations are invalid");
    expect(() => parseDockerMockDebuggerBootstrap({ ...bootstrap, expectations: [{ ...expectations[0], extra: true }] }))
      .toThrow("expectations are invalid");
  });

  it("accepts only exact bounded graph preparation data", () => {
    const graph = {
      request: { city: "Istanbul" },
      identity: { runRef: { executionId: "mock-case-1" }, requestId: "graph-case-1" },
      agentSlotIds: ["advisor", "reviewer"],
    };
    expect(parseDockerMockDebuggerBootstrap({ ...bootstrap, graph }).graph).toEqual(graph);
    expect(() => parseDockerMockDebuggerBootstrap({ ...bootstrap, graph: { ...graph, extra: true } }))
      .toThrow("graph bootstrap is invalid");
    expect(() => parseDockerMockDebuggerBootstrap({ ...bootstrap, graph: { ...graph, agentSlotIds: ["advisor", "advisor"] } }))
      .toThrow("graph bootstrap is invalid");
    expect(() => parseDockerMockDebuggerBootstrap({ ...bootstrap, graph: { ...graph, request: new Date() } }))
      .toThrow("graph bootstrap is invalid");
  });

  it("returns explicit simulated pass, mismatch, expected failure and unavailable results", () => {
    const count = [{ id: "count", target: "result", pointer: "/count", operator: "equals", value: 11 }] as const;
    expect(dockerMockDebuggerCaseResult("case-1", count, { kind: "result", result: { status: "completed", output: { count: 11 } } }))
      .toMatchObject({ simulated: true, status: "passed", comparison: { comparison: "pass" }, output: { count: 11 } });
    expect(dockerMockDebuggerCaseResult("case-1", count, { kind: "result", result: { status: "completed", output: { count: 12 } } }))
      .toMatchObject({ status: "mismatch", comparison: { comparison: "mismatch" } });
    expect(dockerMockDebuggerCaseResult("case-1", [{ id: "failed", target: "run-status", operator: "equals", value: "failed" }],
      { kind: "error", externalDiagnostic: { origin: "external", provider: "arkimux-mock", code: "fixture_failure", message: "Expected fixture failure." } }))
      .toMatchObject({ status: "passed", comparison: { comparison: "pass" },
        failure: { code: "fixture_failure", message: "Expected fixture failure.", provider: "arkimux-mock" } });
    expect(dockerMockDebuggerCaseResult("case-1", [], { kind: "error" }))
      .toMatchObject({ status: "failed", comparison: { comparison: "not_checked" }, failure: { code: "simulated_workflow_failed" } });
    expect(dockerMockDebuggerCaseResult("case-1", count, { kind: "exit" }))
      .toMatchObject({ status: "sandbox_unavailable", comparison: { comparison: "unavailable" } });
    expect(dockerMockDebuggerCaseResult("case-1", count, { kind: "result", result: { status: "completed", output: new Date() } }))
      .toMatchObject({ status: "sandbox_unavailable", failure: { code: "invalid_simulated_result" } });
    expect(dockerMockDebuggerCaseResult("case-1", [
      { id: "private", target: "result", pointer: "/secret", operator: "equals", value: "business-value" },
    ], { kind: "result", result: { status: "completed", output: { secret: "business-value" } } })).toMatchObject({
      status: "passed", comparison: { comparison: "pass" }, output: { secret: "[REDACTED]" },
    });
    expect(dockerMockDebuggerCaseResult("case-1", [], { kind: "result", result: { status: "suspended", request: {} } }))
      .toMatchObject({ status: "sandbox_unavailable", failure: { code: "unsupported_simulated_outcome" } });
  });

  it("accepts only strict bounded control request shapes", () => {
    const base = { schemaVersion: 1 as const, id: "request-1" };
    expect(parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.pause", params: { attemptId: "mock-case-1" } }))
      .toMatchObject({ method: "debug.pause", params: { attemptId: "mock-case-1" } });
    expect(parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.step", params: { pauseId: "pause-1", kind: "into" } }))
      .toMatchObject({ method: "debug.step", params: { pauseId: "pause-1", kind: "into" } });
    expect(parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.properties", params: {
      pauseId: "pause-1", objectId: "object-1", offset: 0, limit: 100,
    } })).toMatchObject({ method: "debug.properties", params: { pauseId: "pause-1", objectId: "object-1" } });
    expect(parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.variable.set", params: {
      pauseId: "pause-1", frameId: "frame-1", controlId: "set-1", name: "result", expression: "20",
    } })).toMatchObject({ method: "debug.variable.set", params: { name: "result", expression: "20" } });
    expect(() => parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.pause", params: {} })).toThrow("invalid");
    expect(() => parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.step", params: { pauseId: "pause-1", kind: "around" } })).toThrow("invalid");
    expect(() => parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.sources", params: { offset: 0, limit: 101 } })).toThrow("invalid");
    expect(() => parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.stack", params: {
      pauseId: "pause-1", offset: 0, limit: 101,
    } })).toThrow("invalid");
    expect(() => parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.evaluate", params: {
      pauseId: "pause-1", frameId: "frame-1", evaluationId: "eval-1", expression: "x".repeat(4097),
    } })).toThrow("invalid");
    expect(() => parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.breakpoints.set", params: { breakpoints: [
      { breakpointId: "same", sourceId: "source-1", line: 1, column: 1 },
      { breakpointId: "same", sourceId: "source-1", line: 2, column: 1 },
    ] } })).toThrow("invalid");
    expect(parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.breakpoints.set", params: { breakpoints: [
      { breakpointId: "log", sourceId: "source-1", line: 2, column: 1, condition: "value > 1", logExpression: "value" },
    ] } })).toMatchObject({ params: { breakpoints: [{ condition: "value > 1", logExpression: "value" }] } });
    expect(() => parseDockerMockDebuggerBridgeRequest({ ...base, method: "debug.breakpoints.set", params: { breakpoints: [
      { breakpointId: "log", sourceId: "source-1", line: 2, column: 1, logExpression: "" },
    ] } })).toThrow("invalid");
    expect(parseDockerMockDebuggerBridgeRequest({ ...base, method: "case.respond", params: { caseId: "case-1",
      requestId: "request-1", submissionId: "submission-1", expectedRevision: 1,
      response: { schemaVersion: 1, fields: { approved: true }, files: {} } } })).toMatchObject({ method: "case.respond" });
    expect(() => parseDockerMockDebuggerBridgeRequest({ ...base, method: "case.respond", params: { caseId: "case-1",
      requestId: "request-1", submissionId: "submission-1", expectedRevision: 0,
      response: { schemaVersion: 1, fields: {}, files: {} } } })).toThrow("invalid");
  });

  it("mounts only private retained input, exchanges bounded JSON and confirms cleanup", async () => {
    const args: string[][] = [], docker: string[][] = [];
    let inputDirectory = "";
    const { child, stdout } = fakeDockerProcess();
    const sessionPromise = launchDockerMockDebugger({ image, bootstrap, retainedCode: "export const retained = true;" }, {
      makeInputDirectory: async () => { inputDirectory = await mkdtemp(path.join(tmpdir(), "arkimux-mock-debug-input-test-")); return inputDirectory; },
      spawnDocker: command => { args.push([...command]); queueMicrotask(() => stdout.write(JSON.stringify(ready()) + "\n")); return child; },
      runDocker: async command => { docker.push([...command]); return { code: command[0] === "container" ? 1 : 0, stdout: "", stderr: "" }; },
    });
    const session = await sessionPromise;
    expect(session.ready).toMatchObject({ simulated: true, caseId: "case-1" });
    expect(args).toHaveLength(1);
    expect(args[0].slice(0, dockerMockDebuggerRunSecurityArgs.length)).toEqual(dockerMockDebuggerRunSecurityArgs);
    expect(args[0]).toEqual([
      ...dockerMockDebuggerRunSecurityArgs, "--name", session.containerName, "--mount",
      `type=bind,src=${inputDirectory},dst=/work/input,readonly`, imageId,
    ]);
    expect(args[0].join(" ")).not.toContain(process.cwd());
    await expect(session.request("session.inspect", {})).resolves.toMatchObject({ state: { state: "paused" } });
    await session.close();
    expect(docker).toEqual([
      ["rm", "--force", "--volumes", session.containerName],
      ["container", "inspect", session.containerName],
    ]);
    await expect(stat(inputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("copies only manifest-bound retained assets into the private read-only input", async () => {
    const retainedAssets = { "workflows/fixture/prompts/system.txt": Buffer.from("Pinned prompt") };
    const assetBootstrap = { ...bootstrap, assets: describeDockerMockDebuggerAssets(retainedAssets) };
    let inputDirectory = "";
    const { child, stdout } = fakeDockerProcess();
    const session = await launchDockerMockDebugger({ image, bootstrap: assetBootstrap, retainedCode: "export {};", retainedAssets }, {
      makeInputDirectory: async () => { inputDirectory = await mkdtemp(path.join(tmpdir(), "arkimux-mock-debug-input-test-")); return inputDirectory; },
      spawnDocker: () => { queueMicrotask(() => stdout.write(JSON.stringify(ready()) + "\n")); return child; },
      runDocker: async command => ({ code: command[0] === "container" ? 1 : 0, stdout: "", stderr: "" }),
    });
    await expect(readFile(path.join(inputDirectory, "assets/workflows/fixture/prompts/system.txt"), "utf8"))
      .resolves.toBe("Pinned prompt");
    await session.close();
    await expect(stat(inputDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects retained assets when bytes differ from the manifest before Docker starts", async () => {
    const retainedAssets = { "workflows/fixture/prompts/system.txt": Buffer.from("Pinned prompt") };
    const spawnDocker = vi.fn();
    await expect(launchDockerMockDebugger({ image, bootstrap: { ...bootstrap, assets: [{
      path: "workflows/fixture/prompts/system.txt", byteLength: 13, sha256: "d".repeat(64),
    }] }, retainedCode: "export {};", retainedAssets }, { spawnDocker })).rejects.toMatchObject({ code: "debugger_unavailable" });
    expect(spawnDocker).not.toHaveBeenCalled();
  });

  it("fails before Docker spawn when retained input is invalid", async () => {
    const spawnDocker = vi.fn();
    await expect(launchDockerMockDebugger({ image, bootstrap: { ...bootstrap, caseId: "bad case" }, retainedCode: "ok" }, { spawnDocker }))
      .rejects.toMatchObject({ code: "debugger_unavailable" });
    expect(spawnDocker).not.toHaveBeenCalled();
  });

  it("never cleans a temporary path outside its owned prefix", async () => {
    const removeInputDirectory = vi.fn();
    await expect(launchDockerMockDebugger({ image, bootstrap, retainedCode: "ok" }, {
      makeInputDirectory: async () => "/tmp/not-owned-by-arkimux",
      removeInputDirectory,
    })).rejects.toMatchObject({ code: "debugger_unavailable" });
    expect(removeInputDirectory).not.toHaveBeenCalled();
  });

  it("fails closed and removes the container after an invalid readiness message", async () => {
    const docker: string[][] = [];
    const { child, stdout } = fakeDockerProcess();
    await expect(launchDockerMockDebugger({ image, bootstrap, retainedCode: "export {};" }, {
      spawnDocker: () => { queueMicrotask(() => stdout.write('{"unsafe":true}\n')); return child; },
      runDocker: async command => { docker.push([...command]); return { code: command[0] === "container" ? 1 : 0, stdout: "", stderr: "" }; },
    })).rejects.toMatchObject({ code: "debugger_unavailable" });
    expect(docker[0]?.slice(0, 3)).toEqual(["rm", "--force", "--volumes"]);
    expect(docker[1]?.slice(0, 2)).toEqual(["container", "inspect"]);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("reports cleanup uncertainty while Docker still sees the named container", async () => {
    const { child, stdout } = fakeDockerProcess();
    const session = await launchDockerMockDebugger({ image, bootstrap, retainedCode: "export {};" }, {
      spawnDocker: () => { queueMicrotask(() => stdout.write(JSON.stringify(ready()) + "\n")); return child; },
      runDocker: async () => ({ code: 0, stdout: "still-present", stderr: "" }),
    });
    await expect(session.close()).rejects.toMatchObject({ code: "cleanup_unconfirmed" });
  });

  it("accepts confirmed forced cleanup after the container exits unexpectedly", async () => {
    const docker: string[][] = [];
    const { child, stdout } = fakeDockerProcess();
    const session = await launchDockerMockDebugger({ image, bootstrap, retainedCode: "export {};" }, {
      spawnDocker: () => { queueMicrotask(() => stdout.write(JSON.stringify(ready()) + "\n")); return child; },
      runDocker: async command => { docker.push([...command]); return { code: command[0] === "container" ? 1 : 0, stdout: "", stderr: "" }; },
    });
    child.stdin.destroy();
    child.emit("close", 137, null);
    await expect(session.close()).resolves.toBeUndefined();
    expect(docker).toEqual([
      ["rm", "--force", "--volumes", session.containerName],
      ["container", "inspect", session.containerName],
    ]);
  });

  it("sends bounded source, breakpoint and step requests without changing their identities", async () => {
    const sourceId = `source-${"c".repeat(40)}`;
    const pauseId = "pause-1";
    const { child, stdout, requests } = fakeDockerProcess(request => request.method === "session.close"
      ? { closed: true }
      : { method: request.method, params: request.params });
    const session = await launchDockerMockDebugger({ image, bootstrap, retainedCode: "export {};" }, {
      spawnDocker: () => { queueMicrotask(() => stdout.write(JSON.stringify(ready()) + "\n")); return child; },
      runDocker: async command => ({ code: command[0] === "container" ? 1 : 0, stdout: "", stderr: "" }),
    });
    await expect(session.request("debug.sources", { offset: 0, limit: 100 })).resolves.toEqual({
      method: "debug.sources", params: { offset: 0, limit: 100 },
    });
    await expect(session.request("debug.source.read", { sourceId, offset: 0, limit: 4096 })).resolves.toEqual({
      method: "debug.source.read", params: { sourceId, offset: 0, limit: 4096 },
    });
    const breakpoints = [{ breakpointId: "later", sourceId, line: 8, column: 1,
      condition: "result > 1", logExpression: "result" }];
    await expect(session.request("debug.breakpoints.set", { breakpoints })).resolves.toEqual({
      method: "debug.breakpoints.set", params: { breakpoints },
    });
    await expect(session.request("debug.pause", { attemptId: "mock-case-1" })).resolves.toEqual({
      method: "debug.pause", params: { attemptId: "mock-case-1" },
    });
    await expect(session.request("debug.step", { pauseId, kind: "over" })).resolves.toEqual({
      method: "debug.step", params: { pauseId, kind: "over" },
    });
    await expect(session.request("debug.stack", { pauseId, offset: 0, limit: 100 })).resolves.toEqual({
      method: "debug.stack", params: { pauseId, offset: 0, limit: 100 },
    });
    await expect(session.request("debug.scopes", { pauseId, frameId: "frame-1" })).resolves.toEqual({
      method: "debug.scopes", params: { pauseId, frameId: "frame-1" },
    });
    await expect(session.request("debug.properties", { pauseId, objectId: "object-1", offset: 0, limit: 100 })).resolves.toEqual({
      method: "debug.properties", params: { pauseId, objectId: "object-1", offset: 0, limit: 100 },
    });
    await expect(session.request("debug.evaluate", { pauseId, frameId: "frame-1", evaluationId: "eval-1", expression: "result + 1" }))
      .resolves.toEqual({ method: "debug.evaluate", params: {
        pauseId, frameId: "frame-1", evaluationId: "eval-1", expression: "result + 1",
      } });
    await expect(session.request("debug.variable.set", {
      pauseId, frameId: "frame-1", controlId: "set-1", name: "result", expression: "20",
    })).resolves.toEqual({ method: "debug.variable.set", params: {
      pauseId, frameId: "frame-1", controlId: "set-1", name: "result", expression: "20",
    } });
    await session.close();
    expect(requests.map(request => request.method)).toEqual([
      "debug.sources", "debug.source.read", "debug.breakpoints.set", "debug.pause", "debug.step",
      "debug.stack", "debug.scopes", "debug.properties", "debug.evaluate", "debug.variable.set", "session.close",
    ]);
  });

  it("preserves allowlisted debugger errors and hides unknown container failures", async () => {
    const { child, stdout } = fakeDockerProcess(request => request.method === "session.close"
      ? { closed: true }
      : request.method === "debug.continue"
        ? { error: { code: "stale_pause", message: "This pause is no longer current.", retry: "after_action" } }
        : { error: { code: "container_secret", message: "unsafe detail", retry: "never" } });
    const session = await launchDockerMockDebugger({ image, bootstrap, retainedCode: "export {};" }, {
      spawnDocker: () => { queueMicrotask(() => stdout.write(JSON.stringify(ready()) + "\n")); return child; },
      runDocker: async command => ({ code: command[0] === "container" ? 1 : 0, stdout: "", stderr: "" }),
    });
    await expect(session.request("debug.continue", { pauseId: "old-pause" })).rejects.toMatchObject({
      code: "stale_pause", message: "This pause is no longer current.", retry: "after_action",
    });
    await expect(session.request("debug.inspect", {})).rejects.toMatchObject({
      code: "debugger_unavailable", message: "The mock debug container rejected its internal request.",
    });
    await session.close();
  });
});
