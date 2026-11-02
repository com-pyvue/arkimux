/** Validation-only experiment. Production live inspection remains disabled. */
import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();
const sockets = new Set<WebSocket>();
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGKILL"); await closed;
    }
  }
  children.clear(); for (const socket of sockets) socket.close(); sockets.clear();
});
const readerUrl = new URL("./fixtures/headless-fixed-reader.mjs", import.meta.url).href;
const fixedCall = "function(target,path,offset,limit){return this(target,path,offset,limit);}";

async function session(workflowBody: string, poison = "", probe: string | null = null, pauseInBody = false) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import inspector from 'node:inspector';
    import {types as projectTypes} from 'node:util';
    import {createFixedInspectorReader} from ${JSON.stringify(readerUrl)};
    const fixedReader = createFixedInspectorReader(${JSON.stringify(probe)});
    const send = process.send.bind(process);
    function trustedGate(privateReader) { debugger; void privateReader; }
    function projectWorkflow(input) {
      const counters = {getter:0,proxy:0,conversion:0,inspection:0,poison:0};
      ${workflowBody}
      ${pauseInBody ? "" : "debugger;"}
      if(typeof restore==='function') restore();
      send({kind:'outcome', counters});
    }
    inspector.open(0,'127.0.0.1',false);
    send({kind:'endpoint', endpoint:inspector.url()});
    process.once('message', () => {
      trustedGate(fixedReader);
      ${poison}
      projectWorkflow({value:10});
    });
  `], { env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", TZ: "UTC" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.add(child);
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Private inspector did not start.")), 5000);
    child.once("message", message => { clearTimeout(timeout); resolve((message as any).endpoint); });
  });
  const socket = new WebSocket(endpoint); sockets.add(socket);
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }>();
  const pauseQueue: any[] = []; const pauseWaiters: ((value: any) => void)[] = []; let sequence = 0;
  socket.addEventListener("message", event => {
    const value = JSON.parse(String(event.data));
    if (value.id) {
      const request = pending.get(value.id); if (!request) return;
      clearTimeout(request.timeout); pending.delete(value.id);
      if (value.error) request.reject(new Error(`Inspector command rejected: ${value.error.message}`)); else request.resolve(value.result);
    }
    if (value.method === "Debugger.paused") {
      const waiter = pauseWaiters.shift(); if (waiter) waiter(value.params); else pauseQueue.push(value.params);
    }
  });
  await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("Inspector connection failed.")), { once: true }); });
  const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject, timeout: setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 5000) });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const nextPause = () => pauseQueue.length ? Promise.resolve(pauseQueue.shift()) : new Promise<any>(resolve => pauseWaiters.push(resolve));
  await request("Debugger.enable"); await request("Runtime.enable"); child.send({ go: true });
  const gate = await nextPause();
  expect(gate.callFrames[0].functionName).toBe("trustedGate");
  // This is the only getProperties call. The private bootstrap scope contains
  // exactly its reader function argument, before project code has executed.
  const privateScope = gate.callFrames[0].scopeChain.find((scope: any) => scope.type === "local");
  const privateValues = await request("Runtime.getProperties", { objectId: privateScope.object.objectId, ownProperties: true, generatePreview: false });
  const reader = privateValues.result.find((property: any) => property.name === "privateReader").value;
  const pinned = await request("Runtime.callFunctionOn", { objectId: reader.objectId, functionDeclaration: "function(){return this;}",
    throwOnSideEffect: true, returnByValue: false, objectGroup: "fixed-reader-prototype" });
  expect(pinned.exceptionDetails).toBeUndefined();
  const readerObjectId = pinned.result.objectId;
  await request("Debugger.resume");
  const paused = await nextPause();
  expect(paused.callFrames[0].functionName).toBe("projectWorkflow");
  const localScope = paused.callFrames[0].scopeChain.find((scope: any) => scope.type === "local");
  const read = async (path: string[] = [], offset = 0, limit = 100) => {
    const reply = await request("Runtime.callFunctionOn", { objectId: readerObjectId, functionDeclaration: fixedCall,
      arguments: [{ objectId: localScope.object.objectId }, { value: path }, { value: offset }, { value: limit }],
      throwOnSideEffect: true, returnByValue: true, generatePreview: false });
    if (reply.exceptionDetails) throw new Error(`Fixed reader rejected by side-effect guard: ${reply.exceptionDetails.text}; ${reply.result?.description ?? ""}`);
    expect(reply.result.type).toBe("string");
    return JSON.parse(reply.result.value);
  };
  const finish = async () => {
    const outcome = new Promise<any>(resolve => child.once("message", message => resolve((message as any).counters)));
    await request("Debugger.resume"); return outcome;
  };
  return { read, finish };
}

describe("validation-only fixed reader over real paused scopes", () => {
  it.each(["constant", "is-proxy", "is-error", "descriptors"])("checks captured primitive %s under the side-effect guard", async probe => {
    const { read, finish } = await session("const result = input.value + 1;", "", probe);
    expect(await read()).toBeDefined();
    expect(await finish()).toMatchObject({ getter: 0, proxy: 0, conversion: 0, inspection: 0, poison: 0 });
  });
  it.each(["null-array", "weak-set"])("records that %s is rejected by the side-effect guard", async probe => {
    const { read, finish } = await session("const result = input.value + 1;", "", probe);
    await expect(read()).rejects.toThrow("side-effect guard");
    expect(await finish()).toMatchObject({ getter: 0, proxy: 0, conversion: 0, inspection: 0, poison: 0 });
  });
  it("reads a synthetic scope and expands a selected ordinary object without raw user getProperties", async () => {
    const { read, finish } = await session("const result = input.value + 1; const object = {inner:{answer:result}};");
    const scope = await read();
    expect(scope).toMatchObject({ kind: "snapshot", value: { kind: "object" } });
    expect(Object.values(scope.value.items).find((item: any) => item.name === "result")).toMatchObject({ value: { kind: "number", value: 11 } });
    expect(await read(["object", "inner"])).toMatchObject({ value: { items: {0:{ name: "answer", value: { kind: "number", value: 11 } }} } });
    expect(await finish()).toEqual({ getter: 0, proxy: 0, conversion: 0, inspection: 0, poison: 0 });
  });
  it("preserves initialized input when an entry scope contains an unavailable uninitialized binding", async () => {
    const { read, finish } = await session("const initialized = undefined; debugger; const pending = 17; void pending;", "", null, true);
    const scope = await read();
    expect(scope.kind).toBe("snapshot");
    const items = Object.values(scope.value.items) as any[];
    expect(items.find(item => item.name === "pending").value.kind).toBe("unavailable");
    expect(items.find(item => item.name === "initialized").value.kind).toBe("undefined");
    expect((await read(["input"])).value.items[0]).toMatchObject({ name: "value", value: { value: 10 } });
    expect(await finish()).toEqual({ getter: 0, proxy: 0, conversion: 0, inspection: 0, poison: 0 });
  });
  it("keeps bound/unbound getters, Error hooks, and proxies inert while reading the real scope", async () => {
    const { read, finish } = await session(`
      const object={plain:11,get unbound(){counters.getter++;return 12},get pure(){return 123},get thrower(){counters.getter++;throw Error('never execute')}};
      Object.defineProperty(object,'bound',{get:function(){counters.getter++;return 13}.bind(null)});
      const error=new Error('before');
      Object.defineProperty(error,'message',{get:function(){counters.getter++;return 'unsafe'}.bind(null)});
      const previousPrepare=Error.prepareStackTrace;
      Error.prepareStackTrace=function(){counters.inspection++;return 'unsafe stack'};
      const proxy=new Proxy({}, {ownKeys(){counters.proxy++;return []},getOwnPropertyDescriptor(){counters.proxy++;return undefined},get(){counters.proxy++;return 1},getPrototypeOf(){counters.proxy++;return null}});
      const revoked=Proxy.revocable({},{}); revoked.revoke();
      const fn=function(){}; Object.defineProperty(fn,'name',{get(){counters.getter++;return 'unsafe function'}});
      const restore=()=>{Error.prepareStackTrace=previousPrepare};
    `);
    const scope = await read();
    expect(scope.kind).toBe("snapshot");
    const items = Object.values(scope.value.items) as any[];
    expect(items.find(item => item.name === "error").value.kind).toBe("native-error");
    expect(items.find(item => item.name === "proxy").value.kind).toBe("proxy");
    const selected = await read(["object"]);
    expect((Object.values(selected.value.items) as any[]).find(item => item.name === "plain").value.value).toBe(11);
    expect((Object.values(selected.value.items) as any[]).filter(item => item.value.kind === "accessor")).toHaveLength(4);
    expect((await read(["object", "bound"])).kind).toBe("accessor");
    expect((await read(["object", "pure"])).kind).toBe("accessor");
    expect((await read(["object", "thrower"])).kind).toBe("accessor");
    expect((await read(["proxy"])).value.kind).toBe("proxy");
    expect((await read(["revoked", "proxy"])).value.kind).toBe("proxy");
    expect((await read(["error", "stack"])).kind).toBe("native-error");
    expect((await read(["error", "message"])).kind).toBe("native-error");
    expect((await read(["fn", "name"])).kind).toBe("function");
    expect(await finish()).toEqual({ getter: 0, proxy: 0, conversion: 0, inspection: 0, poison: 0 });
  });
  it("treats code-looking keys as data and rejects malformed reader options", async () => {
    const { read, finish } = await session("const object={answer:11};");
    expect((await read(["x;globalThis.counters.getter++;throw Error('execute')"])).kind).toBe("unavailable");
    for (const path of [null, {}, { length: {} }, "object", [12], Array(9).fill("object")]) {
      expect((await read(path as any)).kind).toBe("invalid-request");
    }
    expect((await read([], {} as any)).kind).toBe("invalid-request");
    expect((await read([], 0, "10" as any)).kind).toBe("invalid-request");
    expect((await read(["missing"])).kind).toBe("unavailable");
    expect(await finish()).toEqual({ getter: 0, proxy: 0, conversion: 0, inspection: 0, poison: 0 });
  });
  it("does not call conversion/custom-inspection hooks and bounds cycles, strings and pages", async () => {
    const { read, finish } = await session(`
      const object={plain:11,toJSON(){counters.conversion++;return 'unsafe'},toString(){counters.conversion++;return 'unsafe'},[Symbol.toPrimitive](){counters.conversion++;return 'unsafe'},[Symbol.for('nodejs.util.inspect.custom')](){counters.inspection++;return 'unsafe'}};
      object.self=object;
      Object.defineProperty(object,Symbol.toStringTag,{get(){counters.getter++;return 'unsafe'}});
      const list=[10,20,30];
      const long='x'.repeat(5000);
      const primitives={nothing:undefined,nil:null,notANumber:NaN,infinity:Infinity,negativeZero:-0,big:123n,symbol:Symbol('example')};
      const exotic=new Date(); const dictionary=Object.create(null); dictionary.answer=11;
    `);
    const scope = await read(); expect(scope.kind).toBe("snapshot");
    const object = await read(["object"]);
    expect((Object.values(object.value.items) as any[]).find(item => item.name === "self").value.kind).toBe("cycle");
    const list = await read(["list"], 1, 1);
    expect(list.value.itemCount).toBe(1); expect(list.value.items[0]).toMatchObject({ name: "1", value: { value: 20 } });
    expect((await read(["long"])).value).toMatchObject({ kind: "string", truncated: true, value: "x".repeat(4096) });
    const special = Object.values((await read(["primitives"])).value.items) as any[];
    expect(special.find(item => item.name === "nothing").value.kind).toBe("undefined");
    expect(special.find(item => item.name === "notANumber").value.special).toBe("NaN");
    expect(special.find(item => item.name === "big").value.text).toBe("123");
    expect((await read(["exotic"])).value.kind).toBe("unsupported-object");
    expect((await read(["dictionary"])).value.items[0]).toMatchObject({ name: "answer", value: { value: 11 } });
    expect(await finish()).toEqual({ getter: 0, proxy: 0, conversion: 0, inspection: 0, poison: 0 });
  });
  it("uses captured intrinsics after the project poisons global helpers and prototype hooks", async () => {
    const { read, finish } = await session(`
      const originals={descriptors:Object.getOwnPropertyDescriptors,descriptor:Object.getOwnPropertyDescriptor,names:Object.getOwnPropertyNames,create:Object.create,getPrototype:Object.getPrototypeOf,isArray:Array.isArray,apply:Reflect.apply,stringify:JSON.stringify,slice:String.prototype.slice,integer:Number.isSafeInteger,proxy:projectTypes.isProxy,error:projectTypes.isNativeError};
      const poison=()=>{counters.poison++;throw Error('poisoned intrinsic')};
      Object.getOwnPropertyDescriptors=poison; Object.getOwnPropertyDescriptor=poison; Object.getOwnPropertyNames=poison; Object.create=poison; Object.getPrototypeOf=poison; Array.isArray=poison; Reflect.apply=poison; JSON.stringify=poison; String.prototype.slice=poison; Number.isSafeInteger=poison; projectTypes.isProxy=poison; projectTypes.isNativeError=poison;
      Object.prototype.toJSON=function(){counters.conversion++;return 'unsafe object'};
      Array.prototype.toJSON=function(){counters.conversion++;return 'unsafe array'};
      const object={answer:11}; const list=[1,2];
      const restore=()=>{Object.getOwnPropertyDescriptors=originals.descriptors;Object.getOwnPropertyDescriptor=originals.descriptor;Object.getOwnPropertyNames=originals.names;Object.create=originals.create;Object.getPrototypeOf=originals.getPrototype;Array.isArray=originals.isArray;Reflect.apply=originals.apply;JSON.stringify=originals.stringify;String.prototype.slice=originals.slice;Number.isSafeInteger=originals.integer;projectTypes.isProxy=originals.proxy;projectTypes.isNativeError=originals.error;delete Object.prototype.toJSON;delete Array.prototype.toJSON;};
    `);
    expect((await read(["object"])).value.items[0]).toMatchObject({ name: "answer", value: { value: 11 } });
    expect((await read(["list"])).value.itemCount).toBe(3);
    expect(await finish()).toEqual({ getter: 0, proxy: 0, conversion: 0, inspection: 0, poison: 0 });
  });
});
