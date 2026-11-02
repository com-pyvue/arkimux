/** Capability evidence only: this proves an unsafe Node inspector behavior.
 * Passing these probes does NOT mean live object inspection is safe/shippable. */
import { spawn } from "node:child_process";
import { expect, it } from "vitest";

it.each([
  { flags: { ownProperties: true, generatePreview: false }, scopeOnly: false },
  { flags: { ownProperties: true, generatePreview: false, accessorPropertiesOnly: true }, scopeOnly: false },
  { flags: { ownProperties: true, generatePreview: false, nonIndexedPropertiesOnly: true }, scopeOnly: false },
  { flags: { ownProperties: true, generatePreview: false }, scopeOnly: true },
])("records bound getter execution despite read-only inspector flags %j", async ({ flags, scopeOnly }) => {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import inspector from 'node:inspector';
    inspector.open(0,'127.0.0.1',false);
    process.send({endpoint:inspector.url()});
    function fixture() {
      let reads=0;
      const target=${scopeOnly ? "new Error('example')" : "{}"};
      Object.defineProperty(target,${JSON.stringify(scopeOnly ? "message" : "danger")},{get:function(){reads++;return 'example'}.bind(null)});
      debugger;
      process.send({reads});
    }
    process.on('message',fixture);
  `], { env: { PATH: process.env.PATH }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let socket: WebSocket | undefined;
  try {
    const endpoint = await new Promise<string>(resolve => child.once("message", value => resolve((value as any).endpoint)));
    socket = new WebSocket(endpoint);
    const pending = new Map<number, (result: any) => void>(); let sequence = 0;
    let observedPause!: (params: any) => void;
    const pause = new Promise<any>(resolve => { observedPause = resolve; });
    socket.addEventListener("message", event => {
      const value = JSON.parse(String(event.data));
      if (value.id) { pending.get(value.id)?.(value.result); pending.delete(value.id); }
      if (value.method === "Debugger.paused") observedPause(value.params);
    });
    await new Promise<void>(resolve => socket!.addEventListener("open", () => resolve(), { once: true }));
    const request = (method: string, params: unknown = {}) => new Promise<any>(resolve => {
      const id = ++sequence; pending.set(id, resolve); socket!.send(JSON.stringify({ id, method, params }));
    });
    await request("Debugger.enable"); child.send({ go: true });
    const paused = await pause;
    const local = paused.callFrames[0].scopeChain.find((scope: any) => scope.type === "local");
    const scope = await request("Runtime.getProperties", { objectId: local.object.objectId, ownProperties: true, generatePreview: false });
    const target = scope.result.find((property: any) => property.name === "target").value;
    if (!scopeOnly) await request("Runtime.getProperties", { objectId: target.objectId, ...flags });
    const outcome = new Promise<number>(resolve => child.once("message", value => resolve((value as any).reads)));
    await request("Debugger.resume");
    expect(await outcome).toBeGreaterThan(0);
  } finally {
    const exited = new Promise<void>(resolve => child.once("close", () => resolve())); child.kill("SIGKILL"); await exited; socket?.close();
  }
});
