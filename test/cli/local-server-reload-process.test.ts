/** Production private CLI entry + installed Local split bundle. Offline only. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { bootstrapLocalOperator } from "../../apps/hosts/api/src/localOperatorBootstrap.ts";

it("starts the real CLI child, reloads its registry and active role at one address, and stops cleanly", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "arkimux-local-reload-process-")));
  let child: ChildProcess | undefined;
  let exited: Promise<unknown[]> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let stopDeadline: ReturnType<typeof setTimeout> | undefined;
  let stderr = "";
  let failed = false;
  try {
    await mkdir(path.join(root, "src"));
    const installed = path.join(root, "node_modules/@com-pyvue/agent-execution-local");
    await mkdir(installed, { recursive: true });
    // Install the actual already-built package bytes, including shared chunks,
    // private configuration and web assets. No mocks or checkout source aliases.
    await cp(path.resolve("local/dist"), path.join(installed, "dist"), { recursive: true });
    await cp(path.resolve("local/package.json"), path.join(installed, "package.json"));
    await writeFile(path.join(root, "package.json"), '{"type":"module"}');
    for (const kind of ["alpha", "beta"]) {
      const directory = path.join(root, "workflows", kind);
      await mkdir(path.join(directory, "src"), { recursive: true });
      await writeFile(path.join(directory, "src/workflow.ts"), `export const input = {parse(value: unknown) {return value;}};
        export const output = {parse(value: unknown) {return value;}};
        export const define = () => ({input, output});`);
      await writeFile(path.join(directory, "environment.json"), '{"schemaVersion":1,"variables":[]}');
      await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1, workflowId: kind,
        workflowContractVersion: "1", workflowMode: "arkimux-portable", requiredCapabilities: [], sourceBindings: [],
        executionRequirements: { schemaVersion: 1, run: { maxDurationSeconds: 30 }, operations: {} } }));
    }
    // Simulate an editor/agent saving the registry before creating its new files.
    const pendingBeta = path.join(root, "pending-beta");
    await rename(path.join(root, "workflows/beta"), pendingBeta);
    const registry = (kinds: string[], title: string) => `import {withLocalWorkflowDeclaration} from '@com-pyvue/agent-execution-local';
      ${kinds.map((kind, i) => `import {input as input${i}, output as output${i}} from '../workflows/${kind}/src/workflow.js';
        import manifest${i} from '../workflows/${kind}/manifest.json'; import environment${i} from '../workflows/${kind}/environment.json';`).join("\n")}
      export const workflowDeclarations = ${JSON.stringify(kinds.map(kind => ({ manifest: `workflows/${kind}/manifest.json`,
        environment: `workflows/${kind}/environment.json`, definition: { file: `workflows/${kind}/src/workflow.ts`, export: "define" },
        inputValidator: { file: `workflows/${kind}/src/workflow.ts`, export: "input" },
        resultValidator: { file: `workflows/${kind}/src/workflow.ts`, export: "output" },
        result: { kind: `${kind}.result`, schemaVersion: 1 }, effects: [], agentSlots: [] })))};
      export async function loadProjectWorkflows() { return [${kinds.map((kind, i) => `withLocalWorkflowDeclaration({
        workflow: {kind: '${kind}', version: 1}, title: '${kind}-${title}', agentSlots: [], inputExample: {},
        validateInput: value => value, reserve: async () => ({executionId: 'offline-fixture-run'}), execute: async () => undefined,
        runConfigurationValidator: {workflow: {kind: '${kind}', version: 1}, validate: value => value}
      }, {manifest: manifest${i}, result: {kind: '${kind}.result', schemaVersion: 1}, inputValidator: input${i}, resultValidator: output${i},
        environment: {file: 'workflows/${kind}/environment.json', declaration: environment${i}}})`).join(",")}]; }`;
    const entry = path.join(root, "src/arkimux.workflows.ts");
    await writeFile(entry, registry(["alpha"], "first"));
    await bootstrapLocalOperator(["--repository-root", root, "--subject-id", "local-developer", "--user-id", "local-developer",
      "--role-family", "arkimux-workflow-developer", "--role-preset", "local-workflow-developer",
      "--permission", "workflow:alpha:start", "--permission", "workflow:alpha:configure"], root, {});
    const record = path.join(root, ".arkimux/local/processes/local-server.json");
    await mkdir(path.dirname(record), { recursive: true });
    const writeRecord = async (value: unknown) => {
      const temporary = `${record}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
        await rename(temporary, record);
      } finally {
        await rm(temporary, { force: true });
      }
    };
    const token = randomUUID(), started = Date.now();
    child = spawn(process.execPath, [path.resolve("cli/dist/local-server.js"), "--port", "0", "--project-root", root, "--process-token", token], {
      cwd: root, env: { PATH: process.env.PATH, ARKIMUX_LOCAL_PROCESS_TOKEN: token, LANG: "en_US.UTF-8", TZ: "UTC" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    child.stderr!.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-12_000); });
    exited = once(child, "exit");
    const owned = { schemaVersion: 1, pid: child.pid, token, projectRoot: root, url: "http://127.0.0.1:0", roleId: "arkimux-workflow-developer-v1" };
    const recorded = writeRecord(owned);
    const ready = new Promise<string>((resolve, reject) => {
      deadline = setTimeout(() => reject(new Error(`CLI startup exceeded 30 seconds. ${stderr}`)), 30_000);
      child!.on("message", message => {
        void (async () => {
          const value = message as { kind: string; token: string; pid: number; projectRoot: string; url: string };
          expect(value).toMatchObject({ token, pid: child!.pid, projectRoot: root });
          if (value.kind === "arkimux-local-awaiting-authorization") {
            await recorded;
            child!.send({ ...owned, kind: "arkimux-local-start-authorized" });
          } else if (value.kind === "arkimux-local-ready") {
            // Mirror the CLI parent's port-0 acknowledgement without overwriting
            // the child-owned active role update made during initial activation.
            // Replace atomically, as the real CLI does: the child reads this file
            // concurrently while waiting for its final address.
            const active = JSON.parse(await readFile(record, "utf8"));
            await writeRecord({ ...active, url: value.url });
            clearTimeout(deadline);
            resolve(value.url);
          }
        })().catch(reject);
      });
      exited!.then(() => reject(new Error(`CLI exited before ready. ${stderr}`)));
    });
    const url = await ready;
    expect(Date.now() - started).toBeLessThan(30_000);
    const get = async (route: string) => {
      const response = await fetch(`${url}${route}`);
      expect(response.status, stderr).toBe(200);
      return response.json();
    };
    expect(await get("/arkimux/workflow-registry")).toMatchObject({ revision: 1, status: "ready" });
    expect((await get("/api/v1/workflows")).items.map((item: { title: string }) => item.title)).toEqual(["alpha-first"]);
    expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({ url, roleId: "arkimux-workflow-developer-v1", pid: child.pid, token });
    await writeFile(`${entry}.next`, registry(["alpha", "beta"], "second"));
    await rename(`${entry}.next`, entry);
    await vi.waitFor(async () => expect(await get("/arkimux/workflow-registry")).toMatchObject({ revision: 1, status: "error",
      diagnostic: { kind: "source", code: "source-missing", file: "workflows/beta/manifest.json" } }), { timeout: 10_000 });
    expect((await get("/api/v1/workflows")).items.map((item: { title: string }) => item.title)).toEqual(["alpha-first"]);
    const registryBytes = await readFile(entry, "utf8");
    await rename(pendingBeta, path.join(root, "workflows/beta"));
    await vi.waitFor(async () => expect(await get("/arkimux/workflow-registry")).toMatchObject({ revision: 2, status: "ready" }), { timeout: 10_000 });
    expect(await readFile(entry, "utf8")).toBe(registryBytes);
    expect(await get("/arkimux/workflow-registry")).not.toHaveProperty("diagnostic");
    expect((await get("/api/v1/workflows")).items.map((item: { title: string }) => item.title)).toEqual(["alpha-second", "beta-second"]);
    expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({ url, roleId: "arkimux-workflow-developer-v2", pid: child.pid, token });
    await writeFile(entry, "export const invalid = ;");
    await vi.waitFor(async () => expect(await get("/arkimux/workflow-registry")).toMatchObject({ revision: 2, status: "error",
      diagnostic: { kind: "source", code: "TS1109", message: "Expression expected.",
        file: "src/arkimux.workflows.ts", line: 1, column: 24 } }), { timeout: 10_000 });
    expect(JSON.stringify(await get("/arkimux/workflow-registry"))).not.toContain(root);
    expect((await get("/api/v1/workflows")).items.map((item: { title: string }) => item.title)).toEqual(["alpha-second", "beta-second"]);
    await writeFile(entry, registry(["beta"], "third"));
    await vi.waitFor(async () => expect(await get("/arkimux/workflow-registry")).toMatchObject({ revision: 3, status: "ready" }), { timeout: 10_000 });
    expect(await get("/arkimux/workflow-registry")).not.toHaveProperty("diagnostic");
    expect((await get("/api/v1/workflows")).items.map((item: { title: string }) => item.title)).toEqual(["beta-third"]);
    expect(JSON.parse(await readFile(record, "utf8"))).toMatchObject({ url, roleId: "arkimux-workflow-developer-v3", pid: child.pid, token });
    child.kill("SIGTERM");
    expect(await Promise.race([exited, new Promise((_, reject) => {
      stopDeadline = setTimeout(() => reject(new Error("CLI did not stop")), 5000);
    })])).toEqual([0, null]);
    await expect(fetch(`${url}/arkimux/workflow-registry`)).rejects.toThrow();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    clearTimeout(deadline);
    clearTimeout(stopDeadline);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    if (failed) console.error(`Local reload test child diagnostics: pid=${child?.pid ?? "not started"}, `
      + `exitCode=${child?.exitCode ?? "none"}, signal=${child?.signalCode ?? "none"}\n`
      + `Child stderr:\n${stderr.trim() || "(empty)"}`);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
