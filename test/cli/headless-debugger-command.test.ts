import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const roots: string[] = [];
const processes = new Set<ChildProcessWithoutNullStreams>();
let packageRoot: string;
let cliFile: string;

function request(id: string, method = "session.inspect", params: unknown = {}, schemaVersion: 1 | 2 = 1) {
  return JSON.stringify({ schemaVersion, id, method, params });
}

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "lj2-048-command-unit-"));
  roots.push(root);
  return root;
}

function launch(args: string[], cwd = packageRoot) {
  const child = spawn(process.execPath, [cliFile, ...args], {
    cwd, env: { PATH: process.env.PATH, LANG: "en_US.UTF-8", TZ: "UTC" }, stdio: "pipe",
  });
  processes.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", data => { stdout += String(data); });
  child.stderr.on("data", data => { stderr += String(data); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { processes.delete(child); resolve({ code, signal, stdout, stderr }); });
  });
  return { child, done, text: () => stdout };
}

beforeAll(async () => {
  packageRoot = await project();
  await mkdir(path.join(packageRoot, "dist"));
  await symlink(path.resolve("node_modules"), path.join(packageRoot, "node_modules"), "dir");
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ type: "module", version: "0.1.0-test.48" }));
  cliFile = path.join(packageRoot, "dist", "cli.js");
  // Exercise the real CLI dispatch and transport in a fresh process. Only the
  // execution factory is substituted: these checks never invoke providers.
  await build({
    entryPoints: [path.resolve("cli/src/cli.ts")], outfile: cliFile, bundle: true, platform: "node", format: "esm",
    target: "node22", logLevel: "silent", external: ["typescript-parser", "vite", "postcss", "esbuild"],
    plugins: [{ name: "headless-command-client", setup(builder) {
      builder.onResolve({ filter: /(?:headlessDebugger|prepareHeadlessDebugger)\.ts$/ }, args => ({ path: args.path, namespace: "command-test" }));
      builder.onResolve({ filter: /dockerMockDebuggerCoordinator\.ts$/ }, args => ({ path: args.path, namespace: "command-test" }));
      builder.onLoad({ filter: /prepareHeadlessDebugger\.ts$/, namespace: "command-test" }, () => ({
        contents: "export async function prepareHeadlessDebuggerSession() { throw new Error('not used in transport checks'); }", loader: "js",
      }));
      builder.onLoad({ filter: /headlessDebugger\.ts$/, namespace: "command-test" }, () => ({ contents: `
        import { writeFile } from 'node:fs/promises';
        import { appendFileSync } from 'node:fs';
        import path from 'node:path';
        export async function createHeadlessDebugger(options) {
          console.log('PRIVATE constructor stdout');
          process.stderr.write('PRIVATE constructor stderr');
          let release;
          const active = new Promise(resolve => { release = resolve; });
          return {
            async request(method, params) {
              appendFileSync(path.join(options.projectRoot, 'command-requests.jsonl'), JSON.stringify({ method }) + '\\n');
              console.log('PRIVATE request stdout');
              console.error('PRIVATE request stderr');
              if (method === 'case.run') await active;
              if (method === 'case.cancel') release();
              if (method === 'session.open' && params.sessionId === 'unknown-error') throw new Error('PRIVATE exception path and token');
              if (method === 'session.open' && params.sessionId === 'known-error') throw { code: 'session_busy', message: 'This session is already open.', retry: 'after_action' };
              if (method === 'session.create') options.onChange(params.manifest.sessionId, 1);
              return { method, params, projectRoot: options.projectRoot, packageVersion: options.packageVersion, preparationInstalled: typeof options.prepareSession === 'function' };
            },
            async close() {
              console.log('PRIVATE cleanup stdout');
              console.error('PRIVATE cleanup stderr');
              await writeFile(path.join(options.projectRoot, 'command-closed.json'), JSON.stringify({ closed: true }));
            },
          };
        }
      `, loader: "js" }));
      builder.onLoad({ filter: /dockerMockDebuggerCoordinator\.ts$/, namespace: "command-test" }, () => ({ contents: `
        import { writeFile } from 'node:fs/promises';
        import { appendFileSync } from 'node:fs';
        import path from 'node:path';
        export async function createPreparedDockerMockDebuggerCoordinator(options) {
          return {
            async request(method, params, schemaVersion) {
              appendFileSync(path.join(options.projectRoot, 'docker-command-requests.jsonl'), JSON.stringify({ method, schemaVersion, imageSource: options.imageSource }) + '\\n');
              if (method === 'session.create') options.onChange(params.manifest.sessionId, 1);
              return { method, params, schemaVersion, imageSource: options.imageSource, hostRequirements: options.hostRequirements };
            },
            async close() {
              await writeFile(path.join(options.projectRoot, 'docker-command-closed.json'), JSON.stringify({ closed: true }));
            },
          };
        }
      `, loader: "js" }));
    } }],
  });
});

afterEach(async () => {
  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      child.kill("SIGKILL");
      await closed;
    }
  }
});
afterAll(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

describe("arkimux debug stdio command", () => {
  it("advertises the project-pinned stdio command in help", async () => {
    const process = launch(["help"]);
    process.child.stdin.end();
    expect(await process.done).toMatchObject({ code: 0, stderr: "", stdout: expect.stringContaining("arkimux debug stdio --project PATH") });
  });

  it.each([[], ["stdio"], ["stdio", "--project"], ["stdio", "--project", ".", "--unsafe"], ["http", "--project", "."]].map(args => [args]))("rejects incomplete or extra command arguments %j", async args => {
    const process = launch(["debug", ...args]);
    process.child.stdin.end();
    expect(await process.done).toEqual({ code: 2, signal: null, stdout: "", stderr: "Usage: arkimux debug stdio --project PATH\n" });
  });

  it("rejects an unavailable project without emitting protocol noise", async () => {
    const process = launch(["debug", "stdio", "--project", path.join(packageRoot, "missing")]);
    process.child.stdin.end();
    expect(await process.done).toMatchObject({ code: 2, stdout: "", stderr: expect.stringContaining("Check --project") });
  });

  it("uses the selected project and installed version, preserving stdout for responses only", async () => {
    const root = await project();
    const process = launch(["debug", "stdio", "--project", path.relative(packageRoot, root)]);
    process.child.stdin.end(`${request("inspect")}\n`);
    const result = await process.done;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    expect(result.stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual([{
      schemaVersion: 1, id: "inspect", ok: true,
      result: { method: "session.inspect", params: {}, projectRoot: await realpath(root), packageVersion: "0.1.0-test.48", preparationInstalled: true },
    }]);
    expect(await readFile(path.join(root, "command-closed.json"), "utf8")).toBe('{"closed":true}');
  });

  it("passes explicit diagnostic budget authorization through unchanged and emits revision events", async () => {
    const root = await project();
    const process = launch(["debug", "stdio", "--project", root]);
    const params = { manifest: { schemaVersion: 1, sessionId: "budget-probe", workflowId: "fixture", configurationId: "default", executionBudgetMs: 180000,
      cases: [{ caseId: "first", input: {}, expectations: [] }] }, authorization: { executeProjectCode: true, allowProviderCharges: true,
      allowExternalEffects: true, discloseWorkflowData: true, increaseExecutionBudget: true } };
    process.child.stdin.write(`${request("create", "session.create", params)}\n`);
    await expect.poll(() => process.text()).toContain('"id":"create"');
    process.child.stdin.end();
    const result = await process.done;
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const messages = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(messages).toEqual([
      { schemaVersion: 1, event: "session.changed", sessionId: "budget-probe", revision: 1 },
      expect.objectContaining({ id: "create", ok: true, result: expect.objectContaining({ params }) }),
    ]);
  });

  it("allows cancellation while another request is pending", async () => {
    const root = await project();
    const process = launch(["debug", "stdio", "--project", root]);
    process.child.stdin.end(`${request("run", "case.run", { caseId: "first" })}\n${request("cancel", "case.cancel", { caseId: "first" })}\n`);
    const result = await process.done;
    expect(result).toMatchObject({ code: 0, stderr: "" });
    const messages = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(messages.map(message => message.id).sort()).toEqual(["cancel", "run"]);
    expect(messages.every(message => message.ok)).toBe(true);
  });

  it("routes V2 requests to the packaged immutable Docker mock-debugger image", async () => {
    const root = await project();
    const process = launch(["debug", "stdio", "--project", root]);
    const permissions = { executeProjectCode: true, discloseWorkflowData: true, discloseLiveState: true, allowSimulatedEvaluation: true };
    const methods: [string, unknown][] = [
      ["session.create", { manifest: { schemaVersion: 2, sessionId: "live", workflowId: "fixture", configurationId: "default", debug: { stopOnEntry: true },
        cases: [{ caseId: "first", input: {}, mocks: {}, expectations: [] }] }, authorization: permissions }],
      ["session.open", { sessionId: "live" }], ["session.inspect", {}], ["case.run", { caseId: "first" }],
      ["case.respond", { caseId: "first", requestId: "request", submissionId: "answer", expectedRevision: 1, response: { schemaVersion: 1, fields: {}, files: {} } }],
      ["case.cancel", { caseId: "first" }], ["evidence.read", { caseId: "first", evidenceId: "input", offset: 0, limit: 10 }],
      ["debug.sources", { offset: 0, limit: 100 }], ["debug.source.read", { sourceId: "source", offset: 0, limit: 100 }],
      ["debug.breakpoints.set", { expectedDebuggerRevision: 0, breakpoints: [] }], ["debug.inspect", { caseId: "first" }],
      ["debug.pause", { caseId: "first", attemptId: "attempt", controlId: "pause" }],
      ["debug.continue", { caseId: "first", pauseId: "pause", controlId: "continue" }],
      ["debug.step", { caseId: "first", pauseId: "pause", controlId: "step", kind: "into" }],
      ["debug.stack", { caseId: "first", pauseId: "pause", offset: 0, limit: 100 }],
      ["debug.scopes", { caseId: "first", pauseId: "pause", frameId: "frame" }],
      ["debug.properties", { caseId: "first", pauseId: "pause", objectId: "object", offset: 0, limit: 100 }],
      ["debug.evaluate", { caseId: "first", pauseId: "pause", frameId: "frame", evaluationId: "evaluation", expression: "1 + 1" }],
      ["debug.variable.set", { caseId: "first", pauseId: "pause", frameId: "frame", controlId: "set", name: "result", expression: "12" }],
      ["session.close", {}],
    ];
    process.child.stdin.end(methods.map(([method, params], index) => request(`v2-${index}`, method, params, 2)).join("\n") + "\n");
    const result = await process.done;
    expect(result).toMatchObject({ code: 0, signal: null, stderr: "" });
    const messages = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(messages).toHaveLength(methods.length);
    expect(messages.every(message => message.ok === true && message.schemaVersion === 2)).toBe(true);
    expect(messages[0].result).toMatchObject({ schemaVersion: 2,
      imageSource: { kind: "registry", imageReference: "public.ecr.aws/q0q4q1u4/arkimux/mock-debugger@sha256:a3281d39eb47cf3c673535ce3c211ee21987f4abeb4051c01af5cb671483b6be" },
      hostRequirements: { node: "24" } });
    await expect(readFile(path.join(root, "command-requests.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(path.join(root, "docker-command-requests.jsonl"), "utf8")).trim().split("\n")).toHaveLength(methods.length);
    expect(await readFile(path.join(root, "docker-command-closed.json"), "utf8")).toBe('{"closed":true}');
  });

  it("keeps safe protocol errors, masks unexpected exceptions and leaves the stream usable", async () => {
    const root = await project();
    const process = launch(["debug", "stdio", "--project", root]);
    process.child.stdin.end([
      request("known", "session.open", { sessionId: "known-error" }),
      request("unknown", "session.open", { sessionId: "unknown-error" }), request("inspect"), "",
    ].join("\n"));
    const result = await process.done;
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).not.toContain("PRIVATE");
    const messages = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(messages).toEqual([
      expect.objectContaining({ id: "known", ok: false, error: { code: "session_busy", message: "This session is already open.", retry: "after_action" } }),
      expect.objectContaining({ id: "unknown", ok: false, error: expect.objectContaining({ code: "internal_error", retry: "same_identity" }) }),
      expect.objectContaining({ id: "inspect", ok: true }),
    ]);
  });

  it("closes once requested and ignores later input", async () => {
    const root = await project();
    const process = launch(["debug", "stdio", "--project", root]);
    process.child.stdin.end(`${request("close", "session.close")}\n${request("ignored")}\n`);
    const result = await process.done;
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout.trim().split("\n").map(line => JSON.parse(line).id)).toEqual(["close"]);
    expect(await readFile(path.join(root, "command-closed.json"), "utf8")).toBe('{"closed":true}');
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)("cleans up on %s and preserves its exit code", async (signal, code) => {
    const root = await project();
    const process = launch(["debug", "stdio", "--project", root]);
    process.child.stdin.write(`${request("ready")}\n`);
    await expect.poll(() => process.text()).toContain('"id":"ready"');
    process.child.kill(signal);
    expect(await process.done).toMatchObject({ code, signal: null, stderr: "" });
    expect(await readFile(path.join(root, "command-closed.json"), "utf8")).toBe('{"closed":true}');
  });
});
