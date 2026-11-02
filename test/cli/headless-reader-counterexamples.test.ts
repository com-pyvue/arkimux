/** Validation only. These probes distinguish guarded execution from a promise
 * not to execute user accessors. They do not enable the released V2 debugger. */
import { spawn } from "node:child_process";
import { expect, it } from "vitest";

type InspectorReply = { result?: any; exceptionDetails?: any };
type ReaderProbe = { expression: string; reader?: string; setup: string; afterPause?: string; throwOnSideEffect?: boolean; returnByValue?: boolean;
  silent?: boolean; serializationOptions?: { serialization: "idOnly" | "json" | "deep"; maxDepth?: number } };

async function probe(options: ReaderProbe) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import inspector from "node:inspector";
    import { types } from "node:util";
    const ownKeys = Reflect.ownKeys;
    const ownDescriptor = Object.getOwnPropertyDescriptor;
    const isProxy = types.isProxy;
    const create = Object.create;
    const stringify = JSON.stringify;
    const apply = Reflect.apply;
    let effects = 0;
    globalThis.__reader = ${options.reader ?? "function (scope) { return ownKeys(scope).length; }"};
    inspector.open(0, "127.0.0.1", false);
    process.send({ endpoint: inspector.url() });
    function fixture() {
      ${options.setup}
      debugger;
      ${options.afterPause ?? ""}
      process.send(effects);
    }
    process.on("message", fixture);
  `], { env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let socket: WebSocket | undefined;
  let sequence = 0;
  const pending = new Map<number, { resolve(value: InspectorReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Inspector did not start")), 3000);
      child.once("message", value => { clearTimeout(timer); resolve((value as any).endpoint); });
      child.once("error", error => { clearTimeout(timer); reject(error); });
    });
    socket = new WebSocket(endpoint);
    let resolvePause!: (value: any) => void;
    const pause = new Promise<any>(resolve => { resolvePause = resolve; });
    socket.addEventListener("message", event => {
      const value = JSON.parse(String(event.data));
      if (typeof value.id === "number") {
        const waiter = pending.get(value.id); if (!waiter) return;
        pending.delete(value.id); clearTimeout(waiter.timer);
        if (value.error) waiter.reject(Error(JSON.stringify(value.error))); else waiter.resolve(value.result ?? {});
      }
      if (value.method === "Debugger.paused") resolvePause(value.params);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Inspector did not connect")), 3000);
      socket!.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket!.addEventListener("error", () => { clearTimeout(timer); reject(Error("Inspector connection failed")); }, { once: true });
    });
    const request = (method: string, params: unknown = {}) => new Promise<InspectorReply>((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`Timeout: ${method}`)); }, 3000);
      pending.set(id, { resolve, reject, timer }); socket!.send(JSON.stringify({ id, method, params }));
    });
    // Capture a trusted bootstrap function before workflow code can poison globals.
    const reader = await request("Runtime.evaluate", { expression: "globalThis.__reader", generatePreview: false });
    expect(reader.result?.type).toBe("function");
    await request("Debugger.enable"); child.send({ go: true });
    const paused = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("No observed pause")), 3000);
      void pause.then(value => { clearTimeout(timer); resolve(value); });
    });
    const scope = paused.callFrames[0].scopeChain.find((value: any) => value.type === "local");
    expect(scope.object.objectId).toBeTruthy();
    const response = await request("Runtime.callFunctionOn", { objectId: options.reader ? reader.result.objectId : scope.object.objectId,
      arguments: options.reader ? [{ objectId: scope.object.objectId }] : [], functionDeclaration: options.expression,
      throwOnSideEffect: options.throwOnSideEffect ?? true, silent: options.silent ?? true, generatePreview: false,
      returnByValue: options.returnByValue ?? true, ...(options.serializationOptions ? { serializationOptions: options.serializationOptions } : {}) });
    const outcome = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Worker did not resume")), 3000);
      child.once("message", value => { clearTimeout(timer); resolve(value as number); });
    });
    await request("Debugger.resume");
    return { response, effects: await outcome };
  } finally {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error("Probe closed")); }
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill("SIGKILL"); await closed;
    }
    socket?.close();
  }
}

it("records that a guarded read can still invoke a pure user getter", async () => {
  const result = await probe({ setup: `const target = {}; Object.defineProperty(target, "danger", { get() { return "getter-executed"; } });`,
    expression: "function () { return this.target.danger; }" });
  expect(result.response.exceptionDetails).toBeUndefined();
  expect(result.response.result).toMatchObject({ type: "string", value: "getter-executed" });
  expect(result.effects).toBe(0);
});

it("records whether guarded object return wrapping invokes an Error getter after evaluation", async () => {
  const result = await probe({ setup: `const target = new Error("example"); Object.defineProperty(target, "message", { get: function () { effects++; return "example"; }.bind(null) });`,
    expression: "function () { return this.target; }", returnByValue: false });
  expect(result.response.result).toMatchObject({ type: "object", subtype: "error" });
  expect(result.effects).toBeGreaterThan(0);
});

it("can enumerate a synthetic scope with captured descriptors without boxing its Error values", async () => {
  const result = await probe({ setup: `const target = new Error("example"); Object.defineProperty(target, "message", { get: function () { effects++; return "example"; }.bind(null) }); const ordinary = 12;`,
    reader: `function (scope) {
      const result = create(null);
      const names = ownKeys(scope);
      for (let index = 0; index < names.length; index++) {
        const name = names[index]; if (typeof name !== "string") continue;
        const descriptor = ownDescriptor(scope, name);
        result[name] = descriptor && ownDescriptor(descriptor, "value") ? typeof descriptor.value : "unavailable";
      }
      return stringify(result);
    }`, expression: "function (scope) { return this(scope); }" });
  expect(result.response.exceptionDetails).toBeUndefined();
  expect(result.response.result?.type).toBe("string");
  expect(JSON.parse(result.response.result.value)).toMatchObject({ target: "object", ordinary: "number" });
  expect(result.effects).toBe(0);
});

it("reports whether the captured Node proxy predicate is permitted by the evaluation guard", async () => {
  const result = await probe({ setup: `const target = new Proxy({}, { ownKeys() { effects++; return []; }, getOwnPropertyDescriptor() { effects++; return undefined; } });`,
    reader: `function (scope) { const descriptor = ownDescriptor(scope, "target"); return isProxy(descriptor.value) ? "proxy-opaque" : "not-proxy"; }`,
    expression: "function (scope) { return this(scope); }" });
  expect(result.response.exceptionDetails).toBeUndefined();
  expect(result.response.result).toMatchObject({ type: "string", value: "proxy-opaque" });
  expect(result.effects).toBe(0);
});

it("uses captured intrinsics and null-prototype outputs after workflow global poisoning", async () => {
  const result = await probe({ setup: `
    const target = { useful: 12 };
    Object.getOwnPropertyDescriptor = function () { effects++; throw Error("poisoned descriptor"); };
    Reflect.ownKeys = function () { effects++; throw Error("poisoned keys"); };
    JSON.stringify = function () { effects++; throw Error("poisoned stringify"); };
    Object.prototype.toJSON = function () { effects++; return "poisoned JSON"; };
    Array.prototype.toJSON = function () { effects++; return "poisoned array JSON"; };
  `, reader: `function (scope) {
    const object = ownDescriptor(scope, "target").value;
    const result = create(null);
    result.useful = ownDescriptor(object, "useful").value;
    return stringify(result);
  }`, expression: "function (scope) { return this(scope); }" });
  expect(result.response.exceptionDetails).toBeUndefined();
  expect(result.response.result).toMatchObject({ type: "string", value: '{"useful":12}' });
  expect(result.effects).toBe(0);
});

it("checks whether fixed guarded calls flush queued user microtasks while the workflow is paused", async () => {
  const result = await probe({ setup: `queueMicrotask(() => { effects++; }); Promise.resolve().then(() => { effects += 10; }); const target = 12;`,
    reader: "function () { return effects; }", expression: "function (scope) { return this(scope); }" });
  expect(result.response.exceptionDetails).toBeUndefined();
  expect(result.response.result).toMatchObject({ type: "number", value: 0 });
  expect(result.effects).toBe(0);
});

it("records that a TDZ scope descriptor throws while initialized undefined remains readable", async () => {
  const result = await probe({ setup: "const initialized = undefined; Error.prepareStackTrace = () => { effects++; return 'unsafe stack'; };", afterPause: "const pending = 12; void initialized; void pending;",
    reader: `function (scope) {
      function describe(name) {
        const out = create(null); let source;
        try { source = ownDescriptor(scope, name); }
        catch { out.readThrows = true; return out; }
        out.present = Boolean(source);
        if (source) {
          out.hasValue = Boolean(ownDescriptor(source, "value"));
          out.valueType = typeof source.value;
          out.writable = source.writable;
          out.enumerable = source.enumerable;
          out.configurable = source.configurable;
        }
        return out;
      }
      const output = create(null); output.initialized = describe("initialized"); output.pending = describe("pending");
      return stringify(output);
    }`, expression: "function (scope) { return this(scope); }" });
  expect(result.response.exceptionDetails).toBeUndefined();
  expect(result.response.result?.type).toBe("string");
  const values = JSON.parse(result.response.result.value);
  expect(values.initialized).toMatchObject({ present: true, hasValue: true, valueType: "undefined" });
  expect(values.pending).toEqual({ readThrows: true });
  expect(result.effects).toBe(0);
});

it.each([
  { name: "includes", operation: 'apply(String.prototype.includes, "abc", ["b"])', expected: true },
  { name: "indexOf", operation: 'apply(String.prototype.indexOf, "abc", ["b"])', expected: 1 },
  { name: "charCodeAt", operation: 'apply(String.prototype.charCodeAt, "abc", [1])', expected: 98 },
  { name: "bigint comparison", operation: 'ownDescriptor(scope, "target").value < 10n ** 4093n', expected: true },
])("checks production reader primitive $name under the native guard", async ({ operation, expected }) => {
  const result = await probe({ setup: "const target = 12n;", reader: `function (scope) { return ${operation}; }`,
    expression: "function (scope) { return this(scope); }" });
  expect(result.response.exceptionDetails).toBeUndefined();
  expect(result.response.result?.value).toBe(expected);
  expect(result.effects).toBe(0);
});

it("records that Node 24 permits lowercase conversion through the native evaluation guard", async () => {
  const result = await probe({ setup: "const target = 12;",
    reader: 'function () { return apply(String.prototype.toLowerCase, "ABC", []); }',
    expression: "function (scope) { return this(scope); }" });
  expect(result.response.exceptionDetails).toBeUndefined();
  expect(result.response.result?.value).toBe("abc");
  expect(result.effects).toBe(0);
});

it("checks native prototype comparison of a caught synthetic TDZ descriptor error", async () => {
  const result = await probe({ setup: "const initialized = undefined;", afterPause: "const pending = 12; void pending;",
    reader: `function (scope) {
      try { ownDescriptor(scope, "pending"); }
      catch (error) { return Object.getPrototypeOf(error) === ReferenceError.prototype; }
      return false;
    }`, expression: "function (scope) { return this(scope); }" });
  expect(result.response.exceptionDetails).toBeUndefined();
  expect(result.response.result?.value).toBe(true);
  expect(result.effects).toBe(0);
});

it.each([
  { name: "silent", options: { silent: true } },
  { name: "silent idOnly", options: { silent: true, serializationOptions: { serialization: "idOnly" as const } } },
  { name: "silent json", options: { silent: true, serializationOptions: { serialization: "json" as const } } },
  { name: "silent deep depth zero", options: { silent: true, serializationOptions: { serialization: "deep" as const, maxDepth: 0 } } },
  { name: "idOnly", options: { silent: false, serializationOptions: { serialization: "idOnly" as const } } },
])("records whether $name prevents Error stack hooks during guarded rejection", async ({ options }) => {
  const result = await probe({ ...options,
    setup: `const target = 12; Error.prepareStackTrace = () => { effects++; return "stack-hook-executed"; };`,
    reader: "function (scope) { const values = new WeakSet(); values.add(scope); return 'unreachable'; }",
    expression: "function (scope) { return this(scope); }" });
  expect(result.response.exceptionDetails).toBeDefined();
  expect(result.effects).toBeGreaterThan(0);
});
