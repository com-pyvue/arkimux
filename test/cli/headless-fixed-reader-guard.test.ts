import { spawn } from "node:child_process";
import { expect, it } from "vitest";

it("reads through the real inspector side-effect guard", async () => {
  const moduleUrl = new URL("../../local/src/headlessFixedReader.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    import inspector from 'node:inspector';
    import {createHeadlessFixedReader} from ${JSON.stringify(moduleUrl)};
    const {reader}=createHeadlessFixedReader();
    function trustedGate(privateReader){debugger;void privateReader;}
    function workflow(input){debugger;const result=input.value+1;process.send({done:result});}
    inspector.open(0,'127.0.0.1',false); process.send({endpoint:inspector.url()});
    process.once('message',()=>{trustedGate(reader);workflow({value:10});});
  `], { env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let socket: WebSocket | undefined;
  try {
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Inspector did not start.")), 5000);
      child.once("message", value => { clearTimeout(timeout); resolve((value as any).endpoint); });
    });
    socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener("open", () => resolve(), { once: true }); socket!.addEventListener("error", () => reject(new Error("Inspector connection failed.")), { once: true }); });
    let sequence = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }>();
    const pauses: any[] = [], waiters: ((value: any) => void)[] = [];
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const call = pending.get(message.id); if (!call) return;
        clearTimeout(call.timeout); pending.delete(message.id);
        if (message.error) call.reject(new Error("Inspector rejected request.")); else call.resolve(message.result);
      } else if (message.method === "Debugger.paused") {
        const waiter = waiters.shift(); if (waiter) waiter(message.params); else pauses.push(message.params);
      }
    });
    const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject, timeout: setTimeout(() => { pending.delete(id); reject(new Error("Inspector timed out.")); }, 5000) });
      socket!.send(JSON.stringify({ id, method, params }));
    });
    const nextPause = () => pauses.length ? Promise.resolve(pauses.shift()) : new Promise<any>(resolve => waiters.push(resolve));
    await request("Runtime.enable"); await request("Debugger.enable"); child.send({go:true});
    const gate = await nextPause(), privateScope = gate.callFrames[0].scopeChain.find((scope: any) => scope.type === "local");
    const values = await request("Runtime.getProperties", { objectId: privateScope.object.objectId, ownProperties: true, generatePreview: false });
    const functionId = values.result.find((item: any) => item.name === "privateReader").value.objectId;
    const pinned = await request("Runtime.callFunctionOn", { objectId: functionId, functionDeclaration: "function(){return this;}", returnByValue: false, throwOnSideEffect: true, objectGroup: "fixed-reader-test" });
    await request("Debugger.resume"); const pause = await nextPause();
    const scope = pause.callFrames[0].scopeChain.find((item: any) => item.type === "local");
    for (const target of [{value:{value:10}}, {objectId:scope.object.objectId}]) {
      const reply = await request("Runtime.callFunctionOn", { objectId: pinned.result.objectId,
        functionDeclaration: "function(target,path,offset,limit,secrets){return this(target,path,offset,limit,secrets);}",
        arguments: [target, {value:[]}, {value:0}, {value:100}, {value:[]}], throwOnSideEffect: true, returnByValue: true, generatePreview: false });
      // This fixture contains no secrets; keep the trusted guard diagnosis in test failures.
      expect(reply.exceptionDetails, reply.result?.description).toBeUndefined();
      expect(reply.result.type).toBe("string");
      const result = JSON.parse(reply.result.value);
      expect(result.kind).toBe("page");
      if ("objectId" in target) {
        const entries = Object.values(result.items) as any[];
        expect(entries.find(item => item.name === "result").value.kind).toBe("uninitialized");
        expect(entries.find(item => item.name === "input")).toMatchObject({ key: "input", value: { kind: "object" } });
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGKILL"); await closed;
    }
    socket?.close();
  }
});
