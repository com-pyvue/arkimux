import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createProjectWorkflowRegistrySource } from "../../cli/src/projectWorkflowReload.ts";
import type { assertLocalWorkflowDeclarations } from "../../local/src/workflowDeclarations.ts";

const roots: string[] = [];
const sources: Awaited<ReturnType<typeof createProjectWorkflowRegistrySource>>[] = [];
afterEach(async () => {
  for (const source of sources.splice(0)) await source.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const definition = `export const input = {parse(value: unknown) { return value; }};
export const output = {parse(value: unknown) { return value; }};
export const define = () => ({input, output});`;

async function fixture(beforeLoad?: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-registry-reload-"));
  roots.push(root);
  await mkdir(path.join(root, "src"));
  const local = path.join(root, "node_modules/@com-pyvue/agent-execution-local");
  await mkdir(local, { recursive: true });
  // Bundle the real declaration implementation once as the installed Local
  // package. Both native injection and Vite's external import must share its map.
  await build({ entryPoints: [new URL("../../local/src/workflowDeclarations.ts", import.meta.url).pathname],
    outfile: path.join(local, "index.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  await writeFile(path.join(local, "package.json"), JSON.stringify({ name: "@com-pyvue/agent-execution-local", type: "module", exports: "./index.mjs" }));
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await writeFile(path.join(root, ".env"), "RELOAD_PRIVATE_SENTINEL=do-not-export");
  await writeFile(path.join(root, "vite.config.ts"), 'throw new Error("Project Vite config must not execute");');
  const entry = path.join(root, "src/arkimux.workflows.ts");
  const install = async (name: string) => {
    const directory = path.join(root, "workflows", name);
    await mkdir(path.join(directory, "src"), { recursive: true });
    await mkdir(path.join(directory, "prompts"));
    await writeFile(path.join(directory, "prompts/prompt.md"), "initial prompt");
    await writeFile(path.join(directory, "src/workflow.ts"), definition);
    await writeFile(path.join(directory, "environment.json"), '{"schemaVersion":1,"variables":[]}');
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ schemaVersion: 1,
      workflowId: name, workflowContractVersion: "1", workflowMode: "arkimux-portable",
      requiredCapabilities: [], executionRequirements: { schemaVersion: 1, run: { maxDurationSeconds: 30 }, operations: {} }, sourceBindings: [] }));
  };
  const registry = (names: string[], title = "first", suffix = "") => {
    const declarations = names.map(name => ({ manifest: `workflows/${name}/manifest.json`, environment: `workflows/${name}/environment.json`,
      definition: { file: `workflows/${name}/src/workflow.ts`, export: "define" },
      inputValidator: { file: `workflows/${name}/src/workflow.ts`, export: "input" },
      resultValidator: { file: `workflows/${name}/src/workflow.ts`, export: "output" },
      result: { kind: `${name}.result`, schemaVersion: 1 }, effects: [], agentSlots: [] }));
    return `import {withLocalWorkflowDeclaration} from '@com-pyvue/agent-execution-local';
      ${names.map((name, i) => `import {input as input${i}, output as output${i}} from '../workflows/${name}/src/workflow.js';
        import manifest${i} from '../workflows/${name}/manifest.json';
        import environment${i} from '../workflows/${name}/environment.json';`).join("\n")}
      export const workflowDeclarations = ${JSON.stringify(declarations)};
      export async function loadProjectWorkflows() {
        return [${names.map((name, i) => `withLocalWorkflowDeclaration({
          workflow: {kind: '${name}', version: 1}, title: ${JSON.stringify(title)}, description: '', inputExample: {},
          agentSlots: [], validateInput: value => value,
          runConfigurationValidator: {workflow: {kind: '${name}', version: 1}, validate: value => value},
          reserve: async () => ({executionId: 'fixture-run'}), execute: async () => undefined,
        }, {manifest: manifest${i}, result: {kind: '${name}.result', schemaVersion: 1},
          inputValidator: input${i}, resultValidator: output${i},
          environment: {file: 'workflows/${name}/environment.json', declaration: environment${i}}})`).join(",")}];
      }
      ${suffix}`;
  };
  await install("alpha");
  await writeFile(entry, registry(["alpha"]));
  await beforeLoad?.(root);
  const installed = await import(pathToFileURL(path.join(local, "index.mjs")).href);
  const assertDeclarations: typeof assertLocalWorkflowDeclarations = installed.assertLocalWorkflowDeclarations;
  const source = await createProjectWorkflowRegistrySource(root, assertDeclarations);
  sources.push(source);
  const initial = await source.load();
  let current = initial.workflows;
  const events: string[] = [];
  const failed = vi.fn();
  const released = vi.fn(async () => {});
  const watch = (options: { prepare?: () => Promise<void>; activate?: () => Promise<void> } = {}) => source.watch({
    validating: () => events.push("validating"), failed: (restart, diagnostic) => {
      events.push(restart ? "restart" : "failed"); failed(restart, diagnostic);
    },
    async prepareCandidate(workflows) { await options.prepare?.(); return { workflows, release: released }; },
    async activateCandidate(candidate, isCurrent) {
      await options.activate?.();
      try {
        if (!isCurrent()) return false;
        await candidate.validate();
        current = candidate.workflows;
        events.push("ready");
        return true;
      } finally { await candidate.release(); }
    },
  });
  return { root, entry, local, initial, install, registry, source, watch, events, failed, released, current: () => current };
}

async function event(events: string[], expected: string) {
  await vi.waitFor(() => expect(events).toContain(expected), { timeout: 10_000, interval: 30 });
}

it("loads the registry and validators from one graph sharing the installed Local package", async () => {
  const f = await fixture();
  expect(f.initial.workflows.map(workflow => workflow.workflow.kind)).toEqual(["alpha"]);
  expect(f.initial.admission.workflowIds).toEqual([]);
  await f.initial.assertCurrent();
  expect(process.env.RELOAD_PRIVATE_SENTINEL).toBeUndefined();
  expect(await f.source.load()).toBe(f.initial);
});

it("reloads registry changes and atomic editor replacements without adopting implementation changes", async () => {
  const f = await fixture();
  f.watch();
  await f.install("beta");
  await writeFile(`${f.entry}.next`, f.registry(["alpha", "beta"], "second"));
  await rename(`${f.entry}.next`, f.entry);
  await event(f.events, "ready");
  expect(f.current().map(workflow => workflow.workflow.kind)).toEqual(["alpha", "beta"]);
  expect(f.current()[0]!.title).toBe("second");
  f.events.length = 0;
  await writeFile(f.entry, f.registry(["beta"], "third"));
  await event(f.events, "ready");
  expect(f.current().map(workflow => workflow.workflow.kind)).toEqual(["beta"]);
});

it("does not miss a registry save between initial loading and starting the watcher", async () => {
  const f = await fixture();
  await writeFile(f.entry, f.registry(["alpha"], "saved-before-watch"));
  f.watch();
  await event(f.events, "ready");
  expect(f.current()[0]!.title).toBe("saved-before-watch");
});

it("recovers when a registry is saved before its new workflow files, without another registry save", async () => {
  const f = await fixture();
  f.watch();
  const contents = f.registry(["alpha", "beta"]);
  await writeFile(f.entry, contents);
  await event(f.events, "failed");
  expect(f.current().map(w => w.workflow.kind)).toEqual(["alpha"]);
  expect(f.failed).toHaveBeenLastCalledWith(false, expect.objectContaining({ code: "source-missing",
    file: "workflows/beta/manifest.json" }));
  const attempts = f.events.filter(value => value === "validating").length;
  await new Promise(resolve => setTimeout(resolve, 550));
  expect(f.events.filter(value => value === "validating")).toHaveLength(attempts);
  await f.install("beta");
  await event(f.events, "ready");
  expect(f.current().map(w => w.workflow.kind)).toEqual(["alpha", "beta"]);
  expect(await readFile(f.entry, "utf8")).toBe(contents);
  // Once accepted, beta implementation changes are restart-only, just like alpha.
  f.events.length = 0;
  await writeFile(path.join(f.root, "workflows/beta/src/workflow.ts"), definition + "\n");
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(f.events).toEqual([]);
  await writeFile(f.entry, contents + "\n");
  await event(f.events, "restart");
});

it("retries repairs to a new invalid source file but does not adopt changes to accepted source", async () => {
  const f = await fixture();
  await f.install("beta");
  const file = path.join(f.root, "workflows/beta/src/workflow.ts");
  await writeFile(file, "export const broken = ;");
  f.watch();
  await writeFile(f.entry, f.registry(["alpha", "beta"]));
  await event(f.events, "failed");
  await writeFile(path.join(f.root, "workflows/alpha/src/workflow.ts"), definition + "\n");
  await writeFile(file, definition);
  await event(f.events, "restart");
  expect(f.current().map(w => w.workflow.kind)).toEqual(["alpha"]);
});

it("discovers missing transitive imports on successive retries and stops retrying after close", async () => {
  const f = await fixture();
  await f.install("beta");
  const file = path.join(f.root, "workflows/beta/src/workflow.ts");
  await writeFile(file, 'export { input, output, define } from "./later.js";');
  f.watch();
  await writeFile(f.entry, f.registry(["alpha", "beta"]));
  await event(f.events, "failed");
  await writeFile(file, definition + '\nimport "./later.js";');
  await vi.waitFor(() => expect(f.failed.mock.calls.length).toBeGreaterThan(1), { timeout: 10_000 });
  await writeFile(path.join(f.root, "workflows/beta/src/later.ts"), "export const ready = true;");
  await event(f.events, "ready");
  await writeFile(f.entry, f.registry(["alpha", "beta", "gamma"]));
  await vi.waitFor(() => expect(f.failed).toHaveBeenLastCalledWith(false,
    expect.objectContaining({ file: "workflows/gamma/manifest.json" })), { timeout: 10_000 });
  await f.source.close();
  const count = f.events.length;
  await f.install("gamma");
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(f.events).toHaveLength(count);
});

it("retries new workflow asset arrivals after factory failure without repeatedly evaluating unchanged files", async () => {
  const f = await fixture();
  await f.install("beta");
  const prompt = path.join(f.root, "workflows/beta/prompts/prompt.md");
  await rm(prompt);
  f.watch();
  const source = f.registry(["alpha", "beta"])
    .replace("export async function loadProjectWorkflows() {", `export async function loadProjectWorkflows() {
      await readFile(${JSON.stringify(prompt)}, 'utf8');`);
  await writeFile(f.entry, `import {readFile} from 'node:fs/promises';\n${source}`);
  await event(f.events, "failed");
  await writeFile(prompt, "ready");
  await event(f.events, "ready");
  expect(f.current().map(w => w.workflow.kind)).toEqual(["alpha", "beta"]);
});

it("does not retry against an escaping directory link and recovers when replaced with regular source", async () => {
  const f = await fixture();
  f.watch();
  await writeFile(f.entry, f.registry(["alpha", "beta"]));
  await event(f.events, "failed");
  const attempts = f.events.filter(value => value === "validating").length;
  // Same project, but not under src/workflows: it must not be probed or loaded.
  const outside = path.join(f.root, "private-data");
  await mkdir(outside);
  await writeFile(path.join(outside, "manifest.json"), "PRIVATE_NOT_A_MANIFEST");
  await symlink(outside, path.join(f.root, "workflows/beta"));
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(f.events.filter(value => value === "validating")).toHaveLength(attempts);
  expect(f.current().map(w => w.workflow.kind)).toEqual(["alpha"]);
  await rm(path.join(f.root, "workflows/beta"));
  await f.install("beta");
  await event(f.events, "ready");
  expect(f.current().map(w => w.workflow.kind)).toEqual(["alpha", "beta"]);
});

it("tracks linked dependency target changes and tolerates cycles and repeated aliases", async () => {
  const f = await fixture(async root => {
    const target = path.join(root, "linked-package");
    await mkdir(target);
    await writeFile(path.join(target, "index.js"), "export const value = 1;");
    await symlink(target, path.join(root, "node_modules/linked-package"));
    await symlink(target, path.join(root, "node_modules/linked-alias"));
    await symlink(path.join(root, "node_modules"), path.join(target, "cycle"));
  });
  await f.initial.assertCurrent();
  await f.initial.assertCurrent();
  f.watch();
  await writeFile(path.join(f.root, "linked-package/index.js"), "export const value = 2;");
  await writeFile(f.entry, f.registry(["alpha"], "must-not-reload-dependency"));
  await event(f.events, "restart");
  expect(f.current()[0]!.title).toBe("first");
});

it("keeps last-good registration on invalid or missing registry and recovers after a valid save", async () => {
  const f = await fixture();
  const old = f.current();
  f.watch();
  await writeFile(f.entry, "export const invalid = ;");
  await event(f.events, "failed");
  expect(f.failed).toHaveBeenLastCalledWith(false, { kind: "source", code: "TS1109", message: "Expression expected.",
    file: "src/arkimux.workflows.ts", line: 1, column: 24 });
  expect(f.current()).toBe(old);
  f.events.length = 0;
  await rm(f.entry);
  await event(f.events, "failed");
  f.events.length = 0;
  await writeFile(f.entry, f.registry(["alpha"], "repaired"));
  await event(f.events, "ready");
  expect(f.current()[0]!.title).toBe("repaired");
});

it("does not publish runtime exceptions even when they pretend to be source diagnostics", async () => {
  const f = await fixture();
  f.watch({ prepare: async () => {
    throw Object.assign(new Error("PRIVATE_INTERNAL_STACK /private/server/token"), { name: "ProjectSourceError",
      diagnostic: { kind: "source", file: "src/arkimux.workflows.ts", code: "forged", message: "PRIVATE_INTERNAL_STACK" } });
  } });
  await writeFile(f.entry, f.registry(["alpha"], "broken-internal"));
  await event(f.events, "failed");
  expect(f.failed).toHaveBeenLastCalledWith(false, undefined);
  expect(f.current()[0]!.title).toBe("first");
});

it.each([".env", "config/platform.json", "workflows/alpha/src/workflow.ts", "workflows/alpha/prompts/prompt.md", "node_modules/changed.js"])(
  "requires restart for a mixed registry and %s edit", async file => {
    const f = await fixture();
    f.watch();
    const absolute = path.join(f.root, file);
    await mkdir(path.dirname(absolute), { recursive: true });
    const existing = await readFile(absolute, "utf8").catch(() => "");
    await writeFile(absolute, `${existing}\n`);
    // An implementation-only save must not initiate a candidate.
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(f.events).toEqual([]);
    await writeFile(f.entry, f.registry(["alpha"], "must-not-apply"));
    await event(f.events, "restart");
    expect(f.current()[0]!.title).toBe("first");
  },
);

it("discards a prepared generation superseded while preparation is pending", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered = false;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.watch({ prepare: async () => { if (!entered) { entered = true; await waiting; } } });
  await writeFile(f.entry, f.registry(["alpha"], "superseded"));
  await vi.waitFor(() => expect(entered).toBe(true));
  await writeFile(f.entry, f.registry(["alpha"], "latest"));
  await new Promise(resolve => setTimeout(resolve, 100));
  release();
  await event(f.events, "ready");
  expect(f.current()[0]!.title).toBe("latest");
  expect(f.events.filter(value => value === "ready")).toHaveLength(1);
  expect(f.released).toHaveBeenCalledTimes(2);
});

it("rechecks source under the activation gate after active work has delayed publication", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered = false;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.watch({ activate: async () => { entered = true; await waiting; } });
  await writeFile(f.entry, f.registry(["alpha"], "must-not-apply"));
  await vi.waitFor(() => expect(entered).toBe(true));
  await writeFile(path.join(f.root, ".env"), "RELOAD_PRIVATE_SENTINEL=changed");
  release();
  await event(f.events, "restart");
  expect(f.current()[0]!.title).toBe("first");
});

it("rejects a different validator object even when its parse behavior matches", async () => {
  const f = await fixture();
  f.watch();
  await writeFile(f.entry, f.registry(["alpha"]).replace("inputValidator: input0", "inputValidator: {parse: value => value}"));
  await event(f.events, "failed");
  expect(f.current()[0]!.title).toBe("first");
});

it("closes during preparation, releases the unused candidate, and never publishes it", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered = false;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  f.watch({ prepare: async () => { entered = true; await waiting; } });
  await writeFile(f.entry, f.registry(["alpha"], "not-after-close"));
  await vi.waitFor(() => expect(entered).toBe(true));
  const closed = f.source.close();
  release();
  await closed;
  expect(f.current()[0]!.title).toBe("first");
  expect(f.released).toHaveBeenCalledOnce();
  await f.source.close();
});
