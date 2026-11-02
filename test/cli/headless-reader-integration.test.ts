/** Adversarial integration coverage over an owned Node worker and the production
 * inspector controller. No provider calls, project scaffolds or API server. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, transform } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHeadlessWorkerDebugger, type HeadlessWorkerDebugger } from "../../local/src/headlessWorkerDebugger.ts";

type Value = { kind: string; type?: string; value?: unknown; objectId?: string; truncated?: boolean; reason?: string };
type PropertyPage = { items: { name: string; value: Value }[]; total: number; nextOffset: number | null };
const children = new Set<ChildProcess>();
const controllers = new Set<HeadlessWorkerDebugger>();
const temporaryRoots = new Set<string>();
const secret = "known-integration-credential-value";
let readerModuleUrl: string;

beforeAll(async () => {
  // Bundle only this private reader module into memory. This is not a package build.
  const output = await build({ entryPoints: ["local/src/headlessFixedReader.ts"], bundle: true, write: false,
    platform: "node", format: "esm", logLevel: "silent" });
  readerModuleUrl = `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].contents).toString("base64")}`;
});

afterEach(async () => {
  // A failed assertion must kill its paused worker before inspector disconnect,
  // since dropping an inspector connection can resume the target automatically.
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill("SIGKILL"); await closed;
  }
  children.clear();
  for (const controller of controllers) await controller.close();
  controllers.clear();
  for (const root of temporaryRoots) await rm(root, { recursive: true, force: true });
  temporaryRoots.clear();
});

async function launch(source: string, options: { stopOnEntry?: boolean; guardedReaderFailure?: boolean } = {}) {
  const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2022", sourcemap: "inline",
    sourcefile: "arkimux-source:///workflows/reader/src/workflow.ts" });
  const sha = createHash("sha256").update(compiled.code).digest("hex");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import inspector from "node:inspector";
    import { createHeadlessFixedReader } from ${JSON.stringify(readerModuleUrl)};
    const send = process.send.bind(process), serialize = JSON.stringify;
    const readerAuthority = createHeadlessFixedReader();
    const fixedReader = ${options.guardedReaderFailure ? `function guardedFixtureReader(target) {
      const attemptedMutation = new WeakSet(); attemptedMutation.add(target); return "{}";
    }` : "readerAuthority.reader"};
    function arkimuxHeadlessReaderGate(privateReader, privateEntry) { debugger; void privateReader; void privateEntry; }
    function arkimuxHeadlessEntryGate(workflowExecute) { debugger; void workflowExecute; }
    inspector.open(0, "127.0.0.1", false);
    send({ kind: "endpoint", endpoint: inspector.url() });
    process.once("message", async message => {
      arkimuxHeadlessReaderGate(fixedReader, readerAuthority.entry);
      try {
        const module = await import("data:text/javascript;base64," + Buffer.from(message.code).toString("base64"));
        arkimuxHeadlessEntryGate(module.run);
        const result = await module.run({ value: 10 });
        send(serialize({ kind: "result", result }));
      } catch { send("worker-error"); }
    });
  `], { env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", TZ: "UTC" }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  children.add(child);
  let stderr = ""; child.stderr?.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-2048); });
  let outcome: unknown, workerError = false;
  child.on("message", message => {
    if (message === "worker-error") workerError = true;
    else if (typeof message === "string") {
      const parsed = JSON.parse(message) as { kind: string; result: unknown };
      if (parsed.kind === "result") outcome = parsed.result;
    }
  });
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error(`Private worker endpoint did not arrive: ${stderr}`)), 3000);
    child.once("message", message => { clearTimeout(timeout); resolve((message as { endpoint: string }).endpoint); });
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code, signal) => { clearTimeout(timeout); reject(Error(`Private worker exited before endpoint (${code}/${signal}): ${stderr}`)); });
  });
  const controller = await createHeadlessWorkerDebugger({ endpoint, retainedCode: compiled.code, buildSha256: sha,
    attemptId: "reader-attempt", stopOnEntry: options.stopOnEntry ?? false, knownSecrets: [secret],
    // Node's inline-module script URL retains literal brackets, unlike pathToFileURL.
    workerScriptUrl: `${pathToFileURL(resolve(".")).href}/[eval1]`,
    onDisconnect: () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); } });
  controllers.add(controller);
  const start = () => child.send({ code: `${compiled.code}\n//# sourceURL=arkimux-retained://${sha}/entry.mjs\n` });
  const result = async () => {
    await expect.poll(() => {
      if (workerError) throw Error("The integration fixture failed to execute.");
      return outcome !== undefined;
    }, { interval: 10, timeout: 5000 }).toBe(true);
    return outcome;
  };
  return { child, controller, start, result };
}

async function pause(controller: HeadlessWorkerDebugger, previous?: string) {
  await expect.poll(() => {
    const current = controller.inspect();
    if (current.state === "action_required") throw Error(`Debugger unavailable: ${JSON.stringify(current.error)}`);
    return current.state === "paused" && !!current.pause && current.pause.pauseId !== previous;
  }, { interval: 10, timeout: 5000 }).toBe(true);
  return controller.inspect().pause!;
}

async function scope(controller: HeadlessWorkerDebugger, pauseId: string) {
  const stack = await controller.stack(pauseId, 0, 100);
  const frame = stack.items.find(item => item.kind === "workflow")!;
  expect(frame).toBeDefined();
  const scopes = await controller.scopes(pauseId, frame.frameId);
  const local = scopes.items.find(item => item.type === "local")!;
  expect(local.value.kind).toBe("object");
  return { frameId: frame.frameId, objectId: local.value.objectId as string };
}
async function properties(controller: HeadlessWorkerDebugger, pauseId: string, objectId: string, offset = 0, limit = 100) {
  return await controller.properties(pauseId, objectId, offset, limit) as PropertyPage;
}
const named = (page: PropertyPage, name: string) => {
  const value = page.items.find(item => item.name === name)?.value;
  expect(value, `Missing expected property ${name}`).toBeDefined(); return value!;
};

describe("production fixed reader with an owned worker", () => {
  it("reads actual entry input and never reports an uninitialized local as undefined", async () => {
    const f = await launch(`export function run(input) {
      const before = input.value;
      const initialized = undefined;
      debugger;
      const pending = before + 1;
      return { result: pending, initialized: initialized === undefined };
    }`, { stopOnEntry: true });
    f.start(); const entry = await pause(f.controller);
    expect(entry.reason).toBe("entry"); expect(entry.line).toBe(2);
    const entryScope = await scope(f.controller, entry.pauseId);
    const entryValues = await properties(f.controller, entry.pauseId, entryScope.objectId);
    expect(["uninitialized", "unavailable"]).toContain(named(entryValues, "before").kind);
    expect(["uninitialized", "unavailable"]).toContain(named(entryValues, "initialized").kind);
    const input = named(entryValues, "input"); expect(input.kind).toBe("object");
    expect(named(await properties(f.controller, entry.pauseId, input.objectId!), "value")).toMatchObject({ kind: "scalar", value: 10 });
    await f.controller.continue(entry.pauseId); const later = await pause(f.controller, entry.pauseId);
    const laterScope = await scope(f.controller, later.pauseId), values = await properties(f.controller, later.pauseId, laterScope.objectId);
    expect(named(values, "initialized").kind).toBe("undefined");
    expect(["uninitialized", "unavailable"]).toContain(named(values, "pending").kind);
    await f.controller.continue(later.pauseId);
    expect(await f.result()).toEqual({ result: 11, initialized: true });
  });

  it("keeps pure, bound and throwing getters, Error hooks, proxies and conversion hooks inert", async () => {
    const f = await launch(`export function run(input) {
      const counters = { getter: 0, proxy: 0, conversion: 0, inspection: 0 };
      const visible = { plain: input.value,
        get pure() { return 99; }, get danger() { counters.getter++; return 99; },
        get thrower() { counters.getter++; throw Error('unsafe'); },
        toJSON() { counters.conversion++; return 'unsafe'; },
        toString() { counters.conversion++; return 'unsafe'; },
        [Symbol.toPrimitive]() { counters.conversion++; return 'unsafe'; },
        [Symbol.for('nodejs.util.inspect.custom')]() { counters.inspection++; return 'unsafe'; } };
      Object.defineProperty(visible, 'bound', { get: function() { counters.getter++; return 99; }.bind(null) });
      const error = new Error('before');
      Object.defineProperty(error, 'message', { get: function() { counters.getter++; return 'unsafe'; }.bind(null) });
      const previousPrepare = Error.prepareStackTrace;
      Error.prepareStackTrace = function() { counters.inspection++; return 'unsafe'; };
      const proxy = new Proxy({}, { ownKeys() { counters.proxy++; return []; }, getOwnPropertyDescriptor() { counters.proxy++; return undefined; }, get() { counters.proxy++; return 1; }, getPrototypeOf() { counters.proxy++; return null; } });
      const revoked = Proxy.revocable({}, {}); revoked.revoke();
      const fn = function() {}; Object.defineProperty(fn, 'name', { get() { counters.getter++; return 'unsafe'; } });
      debugger;
      Error.prepareStackTrace = previousPrepare;
      return counters;
    }`);
    f.start(); const current = await pause(f.controller), local = await scope(f.controller, current.pauseId);
    const values = await properties(f.controller, current.pauseId, local.objectId);
    for (const name of ["error", "proxy", "fn"]) {
      const value = named(values, name); expect(value.kind).toBe("opaque"); expect(value.objectId).toBeUndefined();
    }
    const visible = named(values, "visible"), members = await properties(f.controller, current.pauseId, visible.objectId!);
    expect(named(members, "plain")).toMatchObject({ kind: "scalar", value: 10 });
    for (const key of ["pure", "danger", "thrower", "bound"]) expect(named(members, key).kind).toBe("accessor");
    const revoked = named(values, "revoked");
    expect(named(await properties(f.controller, current.pauseId, revoked.objectId!), "proxy")).toMatchObject({ kind: "opaque" });
    expect(JSON.stringify(values)).not.toContain("ws://");
    await f.controller.continue(current.pauseId);
    expect(await f.result()).toEqual({ getter: 0, proxy: 0, conversion: 0, inspection: 0 });
  });

  it("uses captures when workflow code poisons globals and inherited serialization hooks", async () => {
    const f = await launch(`import { types } from 'node:util';
    export function run(input) {
      const counters = { poison: 0, conversion: 0 };
      const saved = { descriptor: Object.getOwnPropertyDescriptor, names: Object.getOwnPropertyNames, create: Object.create,
        prototype: Object.getPrototypeOf, isArray: Array.isArray, apply: Reflect.apply, stringify: JSON.stringify,
        keys: Reflect.ownKeys, slice: String.prototype.slice, charCodeAt: String.prototype.charCodeAt,
        lower: String.prototype.toLowerCase, includes: String.prototype.includes, indexOf: String.prototype.indexOf,
        finite: Number.isFinite, nan: Number.isNaN, safeInteger: Number.isSafeInteger, same: Object.is,
        proxy: types.isProxy, nativeError: types.isNativeError };
      const poison = () => { counters.poison++; throw Error('poisoned'); };
      Object.getOwnPropertyDescriptor = poison; Object.getOwnPropertyNames = poison; Object.create = poison;
      Object.getPrototypeOf = poison; Array.isArray = poison; Reflect.apply = poison; JSON.stringify = poison;
      Reflect.ownKeys = poison; String.prototype.slice = poison; String.prototype.charCodeAt = poison;
      String.prototype.toLowerCase = poison; String.prototype.includes = poison; String.prototype.indexOf = poison;
      Number.isFinite = poison; Number.isNaN = poison; Number.isSafeInteger = poison; Object.is = poison;
      types.isProxy = poison; types.isNativeError = poison;
      Object.prototype.toJSON = function() { counters.conversion++; return 'unsafe'; };
      Array.prototype.toJSON = function() { counters.conversion++; return 'unsafe'; };
      const optionalFields = ['data', 'error', 'key', 'count', 'type', 'reason'];
      for (const field of optionalFields) {
        const trap = saved.create(null); trap.get = poison; trap.configurable = true;
        Object.defineProperty(Object.prototype, field, trap);
      }
      const visible = { answer: input.value + 1 }; const list = [10, 20];
      debugger;
      for (const field of optionalFields) delete Object.prototype[field];
      Object.getOwnPropertyDescriptor = saved.descriptor; Object.getOwnPropertyNames = saved.names; Object.create = saved.create;
      Object.getPrototypeOf = saved.prototype; Array.isArray = saved.isArray; Reflect.apply = saved.apply; JSON.stringify = saved.stringify;
      Reflect.ownKeys = saved.keys; String.prototype.slice = saved.slice; String.prototype.charCodeAt = saved.charCodeAt;
      String.prototype.toLowerCase = saved.lower; String.prototype.includes = saved.includes; String.prototype.indexOf = saved.indexOf;
      Number.isFinite = saved.finite; Number.isNaN = saved.nan; Number.isSafeInteger = saved.safeInteger; Object.is = saved.same;
      types.isProxy = saved.proxy; types.isNativeError = saved.nativeError;
      delete Object.prototype.toJSON; delete Array.prototype.toJSON;
      return counters;
    }`);
    f.start(); const current = await pause(f.controller), local = await scope(f.controller, current.pauseId);
    const values = await properties(f.controller, current.pauseId, local.objectId);
    const visible = named(values, "visible");
    expect(named(await properties(f.controller, current.pauseId, visible.objectId!), "answer")).toMatchObject({ kind: "scalar", value: 11 });
    const list = named(values, "list");
    expect(named(await properties(f.controller, current.pauseId, list.objectId!), "0")).toMatchObject({ kind: "scalar", value: 10 });
    await f.controller.continue(current.pauseId);
    expect(await f.result()).toEqual({ poison: 0, conversion: 0 });
  });

  it("redacts scalar and object aliases before exposing a selected page", async () => {
    const f = await launch(`export function run(input) {
      const shared = { payload: 'must-not-disclose' };
      const aliases = { ordinary: shared, harmless: '${secret}', nested: { alias: shared } };
      const password = shared;
      const globalAlias = globalThis; const processAlias = process;
      debugger;
      return { result: input.value };
    }`);
    f.start(); const current = await pause(f.controller), local = await scope(f.controller, current.pauseId);
    const first = await properties(f.controller, current.pauseId, local.objectId, 0, 2);
    expect(named(first, "shared").kind).toBe("redacted");
    const all = await properties(f.controller, current.pauseId, local.objectId);
    expect(named(all, "shared").kind).toBe("redacted"); expect(named(all, "password").kind).toBe("redacted");
    expect(named(all, "globalAlias").kind).toBe("redacted"); expect(named(all, "processAlias").kind).toBe("redacted");
    const aliases = named(all, "aliases"), page = await properties(f.controller, current.pauseId, aliases.objectId!, 0, 1);
    expect(named(page, "ordinary").kind).toBe("redacted");
    const aliasValues = await properties(f.controller, current.pauseId, aliases.objectId!);
    expect(named(aliasValues, "harmless").kind).toBe("redacted");
    const nested = named(aliasValues, "nested"), nestedValues = await properties(f.controller, current.pauseId, nested.objectId!);
    expect(named(nestedValues, "alias").kind).toBe("redacted");
    expect(JSON.stringify([first, all, page, aliasValues, nestedValues])).not.toContain(secret);
    expect(JSON.stringify([first, all, page, aliasValues, nestedValues])).not.toContain("must-not-disclose");
    await f.controller.continue(current.pauseId); expect(await f.result()).toEqual({ result: 10 });
  });

  it("keeps exact Unicode and code-looking keys expandable while bounding UTF8 scalar previews", async () => {
    const key = "界".repeat(300), otherKey = `${key}different`, overlong = "界".repeat(1500);
    const f = await launch(`export function run(input) {
      const value = { ${JSON.stringify(key)}: { answer: 11 }, ${JSON.stringify(otherKey)}: { answer: 12 },
        "x;globalThis.unwanted=1": { answer: 13 }, ${JSON.stringify(overlong)}: { answer: 14 } };
      const long = '😀'.repeat(2000);
      debugger;
      return { result: input.value, unwanted: globalThis.unwanted === undefined };
    }`);
    f.start(); const current = await pause(f.controller), local = await scope(f.controller, current.pauseId);
    const values = await properties(f.controller, current.pauseId, local.objectId), value = named(values, "value");
    const long = named(values, "long"); expect(long.kind).toBe("scalar"); expect(long.truncated).toBe(true);
    expect(Buffer.byteLength(long.value as string)).toBeLessThanOrEqual(4096); expect(long.value).not.toContain("�");
    const members = await properties(f.controller, current.pauseId, value.objectId!);
    for (const [name, answer] of [[key, 11], [otherKey, 12], ["x;globalThis.unwanted=1", 13]] as const) {
      const selected = named(members, name); expect(selected.kind).toBe("object");
      expect(named(await properties(f.controller, current.pauseId, selected.objectId!), "answer")).toMatchObject({ kind: "scalar", value: answer });
    }
    const unavailable = members.items.find(item => item.value.kind === "unavailable");
    expect(unavailable).toBeDefined(); expect(unavailable?.value.objectId).toBeUndefined();
    await f.controller.continue(current.pauseId); expect(await f.result()).toEqual({ result: 10, unwanted: true });
  }, 10_000);

  it("invalidates frame and object handles across continue and later pauses", async () => {
    const f = await launch(`export function run(input) {
      const visible = { answer: input.value }; debugger;
      visible.answer++; debugger;
      return { result: visible.answer };
    }`);
    f.start(); const first = await pause(f.controller), initial = await scope(f.controller, first.pauseId);
    const values = await properties(f.controller, first.pauseId, initial.objectId), objectId = named(values, "visible").objectId!;
    await f.controller.continue(first.pauseId); const second = await pause(f.controller, first.pauseId);
    await expect(f.controller.properties(first.pauseId, objectId, 0, 100)).rejects.toMatchObject({ code: "stale_pause" });
    await expect(f.controller.properties(second.pauseId, objectId, 0, 100)).rejects.toMatchObject({ code: "stale_handle" });
    await expect(f.controller.scopes(second.pauseId, initial.frameId)).rejects.toMatchObject({ code: "stale_handle" });
    const latest = await scope(f.controller, second.pauseId), currentValues = await properties(f.controller, second.pauseId, latest.objectId);
    const currentObject = named(currentValues, "visible");
    expect(named(await properties(f.controller, second.pauseId, currentObject.objectId!), "answer")).toMatchObject({ kind: "scalar", value: 11 });
    await f.controller.continue(second.pauseId); expect(await f.result()).toEqual({ result: 11 });
    await expect(f.controller.properties(second.pauseId, currentObject.objectId!, 0, 100)).rejects.toMatchObject({ code: "not_paused" });
  });

  it("records the Node 24 stack-hook side effect before killing the rejected real worker", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "arkimux-reader-error-")); temporaryRoots.add(temporaryRoot);
    const canaryPath = join(temporaryRoot, "unsafe-stack-hook.txt");
    const f = await launch(`import { writeFileSync } from 'node:fs';
    export function run(input) {
      Error.prepareStackTrace = () => { writeFileSync(${JSON.stringify(canaryPath)}, 'stack-hook-executed'); return 'unsafe'; };
      const visible = { answer: input.value }; debugger;
      return { result: 11 };
    }`, { guardedReaderFailure: true });
    f.start(); const current = await pause(f.controller), local = await scope(f.controller, current.pauseId);
    let error: unknown;
    try { await f.controller.properties(current.pauseId, local.objectId, 0, 100); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: "debugger_unavailable" });
    expect(error).toBeInstanceOf(Error);
    const serialized = JSON.stringify({ message: (error as Error).message, state: f.controller.inspect() });
    expect(serialized).not.toMatch(/EvalError|WeakSet|objectId|scopeChain|ws:\/\//);
    await expect.poll(() => f.child.exitCode !== null || f.child.signalCode !== null, { timeout: 5000, interval: 10 }).toBe(true);
    expect(f.controller.inspect()).toMatchObject({ state: "action_required", pause: null });
    await expect(f.controller.continue(current.pauseId)).rejects.toMatchObject({ code: "not_paused" });
    expect(await readFile(canaryPath, "utf8")).toBe("stack-hook-executed");
  });

  it("does not drain Promise or microtask jobs while inspecting a paused workflow", async () => {
    const f = await launch(`export function run(input) {
      const counters = { microtask: 0, promise: 0 };
      queueMicrotask(() => { counters.microtask++; });
      Promise.resolve().then(() => { counters.promise++; });
      debugger;
      return { microtask: counters.microtask, promise: counters.promise };
    }`);
    f.start(); const current = await pause(f.controller), local = await scope(f.controller, current.pauseId);
    const values = await properties(f.controller, current.pauseId, local.objectId), counters = named(values, "counters");
    const first = await properties(f.controller, current.pauseId, counters.objectId!);
    const second = await properties(f.controller, current.pauseId, counters.objectId!);
    for (const page of [first, second]) {
      expect(named(page, "microtask")).toMatchObject({ kind: "scalar", value: 0 });
      expect(named(page, "promise")).toMatchObject({ kind: "scalar", value: 0 });
    }
    await f.controller.continue(current.pauseId);
    expect(await f.result()).toEqual({ microtask: 0, promise: 0 });
  });

  it("treats a project function with a copied private gate name as ordinary workflow code", async () => {
    const f = await launch(`let getterReads = 0;
    function arkimuxHeadlessEntryGate() {
      const error = new Error('example');
      Object.defineProperty(error, 'message', { get: function() { getterReads++; return 'unsafe'; }.bind(null) });
      debugger;
    }
    arkimuxHeadlessEntryGate();
    export function run(input) { return { result: input.value + 1, getterReads }; }
    `, { stopOnEntry: true });
    f.start(); const fake = await pause(f.controller);
    expect(fake.reason).not.toBe("entry");
    const local = await scope(f.controller, fake.pauseId), values = await properties(f.controller, fake.pauseId, local.objectId);
    expect(named(values, "error")).toMatchObject({ kind: "opaque" });
    await f.controller.continue(fake.pauseId); const actual = await pause(f.controller, fake.pauseId);
    expect(actual.reason).toBe("entry");
    await f.controller.continue(actual.pauseId);
    expect(await f.result()).toEqual({ result: 11, getterReads: 0 });
  });

  it("does not trust a project eval that copies both the private gate name and worker source URL", async () => {
    const fakeGate = `function arkimuxHeadlessEntryGate() {
      const error = new Error('example');
      Object.defineProperty(error, 'message', { get: function() { globalThis.fixtureReads++; return 'unsafe'; }.bind(null) });
      debugger;
    }
    arkimuxHeadlessEntryGate();
    //# sourceURL=${pathToFileURL(resolve(".")).href}/[eval1]
    `;
    const f = await launch(`globalThis.fixtureReads = 0;
    eval(${JSON.stringify(fakeGate)});
    export function run(input) {
      const getterReads = globalThis.fixtureReads; delete globalThis.fixtureReads;
      return { result: input.value + 1, getterReads };
    }`, { stopOnEntry: true });
    f.start(); const spoof = await pause(f.controller);
    expect(spoof.reason).not.toBe("entry"); expect(spoof.sourceId).toBeNull();
    const frame = (await f.controller.stack(spoof.pauseId, 0, 100)).items[0];
    expect(frame.kind).toBe("framework");
    await expect(f.controller.scopes(spoof.pauseId, frame.frameId)).rejects.toMatchObject({ code: "inspection_unavailable" });
    await f.controller.continue(spoof.pauseId); const actual = await pause(f.controller, spoof.pauseId);
    expect(actual.reason).toBe("entry");
    await f.controller.continue(actual.pauseId);
    expect(await f.result()).toEqual({ result: 11, getterReads: 0 });
  });
});
