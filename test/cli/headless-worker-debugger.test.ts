import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { build, transform } from "esbuild";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHeadlessWorkerDebugger, type HeadlessWorkerDebugger } from "../../local/src/headlessWorkerDebugger.ts";
import { HeadlessDebugSources } from "../../local/src/headlessDebugSources.ts";

const children = new Set<ChildProcess>();
const controllers = new Set<HeadlessWorkerDebugger>();
afterEach(async () => {
  for (const child of children) { if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGKILL"); await exited;
  } } children.clear();
  for (const controller of controllers) await controller.close(); controllers.clear();
});
const workflow = `let getterReads = 0;
let proxyReads = 0;
function inner(value) {
  const doubled = value * 2;
  return doubled;
}
export async function run(input) {
  const before = input.value;
  const visible = { plain: before, get danger() { getterReads++; return 'WRONG'; } }; Object.defineProperty(visible, 'boundGetter', { get: function() { getterReads++; return 'WRONG'; }.bind(null) });
  const trapped = new Proxy({}, { ownKeys() { proxyReads++; return []; }, get() { proxyReads++; return 'WRONG'; } });
  const apiKey = 'known-canary-secret-value';
  const result = before + 1;
  const doubled = inner(result);
  return {result, doubled, getterReads, proxyReads};
}
`;
async function compile(text = workflow) {
  const result = await transform(text, { loader: "ts", format: "esm", target: "es2022", sourcemap: "inline", sourcefile: "arkimux-source:///workflows/demo/src/workflow.ts" });
  const sha = createHash("sha256").update(result.code).digest("hex"); return { code: result.code, sha };
}
async function launch(options: { text?: string; stopOnEntry?: boolean; onPause?(id: string): Promise<void>; onResume?(id: string): Promise<void> } = {}) {
  const { code, sha } = await compile(options.text);
  const readerCode = (await build({ entryPoints: ["local/src/headlessFixedReader.ts"], platform: "node", format: "esm", bundle: true, write: false })).outputFiles[0].text;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import inspector from 'node:inspector';
    import {createHeadlessFixedReader} from ${JSON.stringify(`data:text/javascript;base64,${Buffer.from(readerCode).toString("base64")}`)};
    const fixed = createHeadlessFixedReader();
    inspector.open(0, '127.0.0.1', false);
    process.send({kind:'endpoint', endpoint:inspector.url()});
    function arkimuxHeadlessReaderGate(privateReader, privateEntry) { debugger; void privateReader; void privateEntry; }
    function arkimuxHeadlessEntryGate(workflowExecute) { debugger; void workflowExecute; }
    process.on('message', async message => {
      if (message.kind !== 'start') return;
      arkimuxHeadlessReaderGate(fixed.reader, fixed.entry);
      const loaded = await import('data:text/javascript;base64,' + Buffer.from(message.code).toString('base64'));
      arkimuxHeadlessEntryGate(loaded.run);
      const result = await loaded.run({value:10});
      process.send({kind:'result',result});
    });
  `], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", TZ: "UTC" } });
  children.add(child);
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Inspector endpoint did not arrive.")), 5000);
    child.on("message", message => { const value = message as any; if (value.kind === "endpoint") { clearTimeout(timer); resolve(value.endpoint); } });
    child.once("error", reject);
  });
  const result = new Promise<any>(resolve => child.on("message", message => { if ((message as any).kind === "result") resolve((message as any).result); }));
  const controller = await createHeadlessWorkerDebugger({ endpoint, workerScriptUrl: pathToFileURL(path.resolve("[eval1]")).href,
    onDisconnect: () => { child.kill("SIGKILL"); }, retainedCode: code, buildSha256: sha, attemptId: "attempt-test",
    stopOnEntry: options.stopOnEntry ?? true, knownSecrets: ["known-canary-secret-value"], onPause: options.onPause, onResume: options.onResume });
  controllers.add(controller);
  const start = () => child.send({ kind: "start", code: `${code}\n//# sourceURL=arkimux-retained://${sha}/entry.mjs\n` });
  return { controller, child, start, result, code, sha };
}
async function paused(controller: HeadlessWorkerDebugger, previousId?: string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const snapshot = controller.inspect();
    if (snapshot.state === "action_required") throw new Error(JSON.stringify(snapshot));
    if (snapshot.state === "paused" && snapshot.pause?.pauseId !== previousId) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Pause did not arrive: ${JSON.stringify(controller.inspect())}`);
}
async function localValues(controller: HeadlessWorkerDebugger, pauseId: string) {
  const stack = await controller.stack(pauseId, 0, 100);
  const frame = stack.items.find(frame => frame.kind === "workflow")!;
  const scopes = await controller.scopes(pauseId, frame.frameId);
  const local = scopes.items.find(scope => scope.type === "local")!;
  return (await controller.properties(pauseId, local.value.objectId as string, 0, 100)).items;
}

describe("retained source catalog", () => {
  it("lists only retained sources, reads bounded bytes, and maps original executable lines", async () => {
    const { code, sha } = await compile(); const catalog = new HeadlessDebugSources(code, sha);
    const source = catalog.list(0, 100).items[0]; expect(source.displayPath).toBe("workflows/demo/src/workflow.ts");
    const read = catalog.read(source.sourceId, 0, 262144); expect(Buffer.from(read.data, "base64").toString()).toBe(workflow);
    const generated = catalog.generated({ sourceId: source.sourceId, line: 12, column: 1 });
    expect(catalog.original(generated.lineNumber, generated.columnNumber)).toMatchObject({ sourceId: source.sourceId, line: 12 });
    expect(() => catalog.read("/etc/passwd", 0, 100)).toThrow();
    expect(() => catalog.read(source.sourceId, -1, 100)).toThrow();
    expect(() => catalog.generated({ sourceId: source.sourceId, line: 999, column: 1 })).toThrow();
    expect(() => catalog.read(source.sourceId, 0, 10, ["known-canary-secret-value"])).toThrow("known credential");
  });
});

describe("owned headless inspector", () => {
  it("stops on actual workflow entry, reads input and keeps live handles pause-scoped", async () => {
    const events: string[] = [];
    const { controller, start, result } = await launch({ onPause: async id => { events.push(`pause:${id}`); }, onResume: async id => { events.push(`resume:${id}`); } });
    start(); const first = await paused(controller);
    expect(first.pause).toMatchObject({ reason: "entry", line: 8 });
    const values = await localValues(controller, first.pause!.pauseId);
    expect(values.find(value => value.name === "before")?.value).toEqual({ kind: "uninitialized" });
    const input = values.find(value => value.name === "input")!;
    expect((await controller.properties(first.pause!.pauseId, input.value.objectId as string, 0, 100)).items).toContainEqual({ name: "value", value: { kind: "scalar", type: "number", value: 10 } });
    await controller.continue(first.pause!.pauseId);
    expect(await result).toEqual({ result: 11, doubled: 22, getterReads: 0, proxyReads: 0 });
    await expect(controller.properties(first.pause!.pauseId, input.value.objectId as string, 0, 100)).rejects.toMatchObject({ code: "not_paused" });
    expect(events).toEqual([`pause:${first.pause!.pauseId}`, `resume:${first.pause!.pauseId}`]);
  });
  it("binds retained breakpoints, steps over locals, and never invokes getters or proxies", async () => {
    const { controller, start, result } = await launch();
    const source = controller.sources.list(0, 100).items[0];
    await controller.replaceBreakpoints([{ breakpointId: "after-values", sourceId: source.sourceId, line: 12, column: 1 }]);
    start(); const entry = await paused(controller); await controller.continue(entry.pause!.pauseId);
    const atResult = await paused(controller, entry.pause!.pauseId); expect(atResult.pause!.line).toBe(12);
    const values = await localValues(controller, atResult.pause!.pauseId);
    expect(values.find(v => v.name === "before")?.value).toMatchObject({ value: 10 });
    expect(values.find(v => v.name === "apiKey")?.value.kind).toBe("redacted");
    expect(values.find(v => v.name === "trapped")?.value).toEqual({ kind: "opaque", type: "proxy" });
    const visible = values.find(v => v.name === "visible")!;
    expect((await controller.properties(atResult.pause!.pauseId, visible.value.objectId as string, 0, 100)).items.find(p => p.name === "danger")?.value).toEqual({ kind: "accessor" });
    await controller.step(atResult.pause!.pauseId, "over");
    const afterResult = await paused(controller, atResult.pause!.pauseId);
    expect((await localValues(controller, afterResult.pause!.pauseId)).find(v => v.name === "result")?.value).toMatchObject({ value: 11 });
    await controller.step(afterResult.pause!.pauseId, "into");
    const inside = await paused(controller, afterResult.pause!.pauseId);
    expect(inside.pause!.line).toBe(4);
    expect((await localValues(controller, inside.pause!.pauseId)).find(v => v.name === "value")?.value).toMatchObject({ value: 11 });
    await controller.step(inside.pause!.pauseId, "over");
    const assigned = await paused(controller, inside.pause!.pauseId);
    expect((await localValues(controller, assigned.pause!.pauseId)).find(v => v.name === "doubled")?.value).toMatchObject({ value: 22 });
    await controller.step(assigned.pause!.pauseId, "out");
    const caller = await paused(controller, assigned.pause!.pauseId);
    expect(caller.pause!.line).toBe(14);
    await controller.continue(caller.pause!.pauseId);
    expect(await result).toMatchObject({ getterReads: 0, proxyReads: 0 });
  });
  it("applies conditional breakpoints and records bounded logpoints without pausing", async () => {
    const { controller, start, result } = await launch();
    const source = controller.sources.list(0, 100).items[0];
    await controller.replaceBreakpoints([{ breakpointId: "conditional", sourceId: source.sourceId, line: 12, column: 1,
      condition: "before === 10" }]);
    start(); const entry = await paused(controller); await controller.continue(entry.pause!.pauseId);
    const conditional = await paused(controller, entry.pause!.pauseId);
    expect(conditional.pause).toMatchObject({ reason: "breakpoint", breakpointIds: ["conditional"], line: 12 });
    const bindings = await controller.replaceBreakpoints([
      { breakpointId: "log-result", sourceId: source.sourceId, line: 13, column: 1,
        condition: "result === 11", logExpression: "result + 4" },
      { breakpointId: "finish", sourceId: source.sourceId, line: 14, column: 1 },
    ]);
    expect(bindings[0].requested).toMatchObject({ condition: "result === 11", logExpression: "result + 4" });
    await controller.continue(conditional.pause!.pauseId);
    const finish = await paused(controller, conditional.pause!.pauseId);
    expect(finish.pause).toMatchObject({ breakpointIds: ["finish"], line: 14 });
    expect(controller.inspect().logs).toMatchObject({ dropped: 0, truncated: false });
    expect(controller.inspect().logs.items).toEqual([expect.objectContaining({ breakpointId: "log-result", status: "completed",
      expressionSha256: createHash("sha256").update("result + 4").digest("hex"),
      value: { kind: "scalar", type: "number", value: 15 } })]);
    await controller.continue(finish.pause!.pauseId);
    expect(await result).toMatchObject({ result: 11, doubled: 22 });
  });
  it("rejects foreign endpoints and stale attempt control", async () => {
    await expect(createHeadlessWorkerDebugger({ endpoint: "ws://example.com:9229/id", workerScriptUrl: "file:///worker.mjs", onDisconnect() {}, retainedCode: "", buildSha256: "a".repeat(64), attemptId: "a", stopOnEntry: true })).rejects.toMatchObject({ code: "debugger_unavailable" });
    const { controller } = await launch(); await expect(controller.pause("another-attempt")).rejects.toMatchObject({ code: "stale_attempt" });
  });
  it("runs without an entry stop and can remove a pending breakpoint before dispatch", async () => {
    const { controller, start, result } = await launch({ stopOnEntry: false });
    const source = controller.sources.list(0, 100).items[0];
    await controller.replaceBreakpoints([{ breakpointId: "remove-me", sourceId: source.sourceId, line: 12, column: 1 }]);
    await controller.replaceBreakpoints([]); start();
    expect(await result).toMatchObject({ result: 11 }); expect(controller.inspect().pause).toBeNull();
  });
  it("interrupts a running owned worker and permits physical cancellation while paused", async () => {
    const { controller, child, start } = await launch({ stopOnEntry: false, text: `export function run(input) {
      process.send({kind:'looping'});
      let iterations = 0;
      while (true) { iterations++; }
    }` });
    const looping = new Promise<void>(resolve => child.on("message", message => { if ((message as any).kind === "looping") resolve(); }));
    start(); await looping; await controller.pause("attempt-test");
    const state = await paused(controller); expect(state.pause!.reason).toBe("interrupt");
    const exited = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGKILL"); await exited;
    await controller.close(); expect(controller.inspect()).toMatchObject({ state: "terminated", pause: null });
  });
  it("bounds inspection, rejects foreign handles, and refuses framework scopes", async () => {
    const { controller, start } = await launch(); start(); const state = await paused(controller);
    const pauseId = state.pause!.pauseId;
    await expect(controller.stack(pauseId, 0, 101)).rejects.toMatchObject({ code: "inspection_unavailable" });
    await expect(controller.scopes(pauseId, "foreign-frame")).rejects.toMatchObject({ code: "stale_handle" });
    await expect(controller.properties(pauseId, "foreign-object", 0, 10)).rejects.toMatchObject({ code: "stale_handle" });
    const framework = (await controller.stack(pauseId, 0, 100)).items.find(frame => frame.kind === "framework");
    expect(framework).toBeDefined(); await expect(controller.scopes(pauseId, framework!.frameId)).rejects.toMatchObject({ code: "inspection_unavailable" });
  });
  it("steps out of the outer workflow to completion, without presenting a framework stop", async () => {
    const { controller, start, result } = await launch(); start(); const entry = await paused(controller);
    await controller.step(entry.pause!.pauseId, "out"); expect(await result).toMatchObject({ result: 11 });
    expect(controller.inspect().pause).toBeNull();
  });
  it("evaluates expressions and changes one simulated local only in a paused workflow frame", async () => {
    const text = `export async function run(input) {
  const before = input.value;
  let result = before + 1;
  debugger;
  const doubled = result * 2;
  return { result, doubled, marker: input.marker };
}
`;
    const { controller, start, result } = await launch({ text });
    start(); const entry = await paused(controller); await controller.continue(entry.pause!.pauseId);
    const stopped = await paused(controller, entry.pause!.pauseId), pauseId = stopped.pause!.pauseId;
    const stack = await controller.stack(pauseId, 0, 100), frame = stack.items.find(item => item.kind === "workflow")!;
    await expect(controller.evaluate(pauseId, frame.frameId, "eval-result", "result + 1")).resolves.toMatchObject({
      evaluationId: "eval-result", changedSimulatedState: "unknown", status: "completed",
      result: { kind: "scalar", type: "number", value: 12 },
    });
    await expect(controller.evaluate(pauseId, frame.frameId, "eval-secret", "'known-canary-secret-value'"))
      .resolves.toMatchObject({ result: { kind: "scalar", type: "string", value: "[redacted]" } });
    const objectEvaluation = await controller.evaluate(pauseId, frame.frameId, "eval-object", "({ answer: result })");
    expect(objectEvaluation).toMatchObject({ result: { kind: "object", type: "object" } });
    if (!("result" in objectEvaluation)) throw new Error("Object evaluation did not return a value.");
    await expect(controller.properties(pauseId, (objectEvaluation.result as any).objectId, 0, 100)).resolves.toMatchObject({
      items: [{ name: "answer", value: { kind: "scalar", type: "number", value: 11 } }],
    });
    await expect(controller.evaluate(pauseId, frame.frameId, "eval-throw", "(() => { throw new Error('simulated') })()"))
      .resolves.toMatchObject({ evaluationId: "eval-throw", changedSimulatedState: "unknown", status: "threw" });
    await expect(controller.setVariable(pauseId, frame.frameId, "set-missing", "missing", "20"))
      .rejects.toMatchObject({ code: "stale_handle" });
    await expect(controller.setVariable(pauseId, frame.frameId, "set-rejected", "result",
      "(() => { input.marker = 7; throw new Error('rejected') })()"))
      .resolves.toMatchObject({ status: "rejected", changedSimulatedState: "unknown" });
    await expect(controller.evaluate(pauseId, frame.frameId, "eval-marker", "input.marker"))
      .resolves.toMatchObject({ result: { value: 7 } });
    await expect(controller.setVariable(pauseId, frame.frameId, "set-result", "result", "20")).resolves.toMatchObject({
      controlId: "set-result", changedSimulatedState: true, status: "applied",
      result: { kind: "scalar", type: "number", value: 20 },
    });
    await expect(controller.evaluate(pauseId, frame.frameId, "eval-updated", "result")).resolves.toMatchObject({
      result: { kind: "scalar", type: "number", value: 20 },
    });
    expect((await localValues(controller, pauseId)).find(item => item.name === "result")?.value).toMatchObject({ value: 20 });
    await controller.continue(pauseId);
    await expect(result).resolves.toEqual({ result: 20, doubled: 40, marker: 7 });
    await expect(controller.evaluate(pauseId, frame.frameId, "stale", "result"))
      .rejects.toMatchObject({ code: "not_paused" });
  });
});
