/**
 * Bounded LJ2-052 experiment only. This does not enable V2 or alter the
 * released debugger. It records whether a reader in a separate VM realm can
 * receive a paused workflow scope without sharing the workflow's Error realm.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();
const sockets = new Set<WebSocket>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
    child.kill("SIGKILL");
    await closed;
  }
  children.clear();
  for (const socket of sockets) socket.close();
  sockets.clear();
});

type Reply = { result?: any; exceptionDetails?: any };

async function start(canaryPath: string) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import inspector from "node:inspector";
    import vm from "node:vm";
    import { writeFileSync } from "node:fs";

    const readerRealm = vm.createContext({}, { name: "arkimux-pristine-reader" });
    vm.runInContext(String.raw\`
      const ownKeys = Reflect.ownKeys;
      const ownDescriptor = Object.getOwnPropertyDescriptor;
      const stringify = JSON.stringify;
      globalThis.reader = function (scope, mode) {
        if (mode === "fault") {
          const values = new WeakSet();
          values.add(scope);
          return "unreachable";
        }
        const output = Object.create(null);
        for (const key of ownKeys(scope)) {
          if (typeof key !== "string") continue;
          const details = ownDescriptor(scope, key);
          if (!details || !("value" in details)) continue;
          if (key === "input") output.input = ownDescriptor(details, "value").value.value;
          if (key === "answer") output.answer = ownDescriptor(details, "value").value;
        }
        return stringify(output);
      };
    \`, readerRealm);

    function workflow(input) {
      Error.prepareStackTrace = () => {
        writeFileSync(${JSON.stringify(canaryPath)}, "workflow-stack-hook-executed");
        return "unsafe";
      };
      const answer = input.value + 1;
      debugger;
      process.send({ kind: "finished", answer });
    }

    inspector.open(0, "127.0.0.1", false);
    process.send({ kind: "endpoint", endpoint: inspector.url() });
    process.once("message", () => workflow({ value: 10 }));
  `], { env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", TZ: "UTC" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  children.add(child);
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Inspector did not start.")), 5000);
    child.once("message", message => { clearTimeout(timer); resolve((message as any).endpoint); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });

  const socket = new WebSocket(endpoint);
  sockets.add(socket);
  const pending = new Map<number, { resolve(value: Reply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  const contexts: any[] = [];
  let sequence = 0;
  let resolvePause!: (value: any) => void;
  const paused = new Promise<any>(resolve => { resolvePause = resolve; });
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id === "number") {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`Inspector rejected request: ${message.error.message}`));
      else entry.resolve(message.result ?? {});
      return;
    }
    if (message.method === "Runtime.executionContextCreated") contexts.push(message.params.context);
    if (message.method === "Debugger.paused") resolvePause(message.params);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Inspector did not connect.")), 5000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Inspector connection failed.")); }, { once: true });
  });
  const request = (method: string, params: Record<string, unknown> = {}) => new Promise<Reply>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Inspector timeout: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });

  await request("Runtime.enable");
  await request("Debugger.enable");
  const context = contexts.find(value => value.name === "arkimux-pristine-reader");
  expect(context).toBeDefined();
  const reader = await request("Runtime.evaluate", { expression: "globalThis.reader", contextId: context.id, silent: true, generatePreview: false });
  expect(reader.exceptionDetails).toBeUndefined();
  expect(reader.result).toMatchObject({ type: "function" });

  child.send({ start: true });
  const pause = await paused;
  const scope = pause.callFrames[0].scopeChain.find((item: any) => item.type === "local");
  expect(scope?.object?.objectId).toBeTruthy();
  const invoke = (mode: "read" | "fault") => request("Runtime.callFunctionOn", {
    objectId: reader.result.objectId,
    functionDeclaration: "function(scope, mode) { return this(scope, mode); }",
    arguments: [{ objectId: scope.object.objectId }, { value: mode }],
    throwOnSideEffect: true,
    returnByValue: true,
    generatePreview: false,
    silent: true,
  });
  const finish = async () => {
    const result = new Promise<number>(resolve => child.once("message", message => resolve((message as any).answer)));
    await request("Debugger.resume");
    return result;
  };
  return { invoke, finish };
}

describe("pristine inspector reader context experiment", () => {
  it("rejects a cross-realm scope read before either realm evaluates code", async () => {
    const root = await mkdtemp(join(tmpdir(), "arkimux-pristine-reader-"));
    const canary = join(root, "hook.txt");
    const { invoke, finish } = await start(canary);
    await expect(invoke("read")).rejects.toThrow("same JavaScript world as target object");
    expect(await finish()).toBe(11);
    await expect(readFile(canary, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects the guarded-failure reader before it can inspect the workflow scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "arkimux-pristine-reader-"));
    const canary = join(root, "hook.txt");
    const { invoke, finish } = await start(canary);
    await expect(invoke("fault")).rejects.toThrow("same JavaScript world as target object");
    expect(await finish()).toBe(11);
    await expect(readFile(canary, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
