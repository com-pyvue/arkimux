/** Private CLI registry loader. No listener, provider call, or developer integration API. */
import { createHash } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { prepareDeclaredRetainedWorkflowBuild } from "./declaredRetainedWorkflowBuild.ts";
import { validateProjectSource } from "./projectSourceGuard.ts";
import { ProjectSourceError, projectSourceDiagnostic } from "./projectSourceDiagnostic.ts";
import type { InspectedProject } from "./projectDeclarations.ts";
import type { LocalWorkflowRegistration } from "../../local/src/index.ts";
import type { RetainedServerAdmissionOptions } from "../../local/src/localRetainedServerRuntime.ts";
import type { assertLocalWorkflowDeclarations } from "../../local/src/workflowDeclarations.ts";
import type { WorkflowRegistrySourceDiagnostic } from "../../local/src/workflowRegistryReload.ts";
import { observeFrameworkError, type FrameworkErrorObserver } from "../../apps/packages/application-host/src/frameworkErrors.ts";

export interface LoadedProjectWorkflowRegistry {
  workflows: readonly LocalWorkflowRegistration[];
  admission: RetainedServerAdmissionOptions;
  /** Recheck after preparation and again under the activation gate. */
  assertCurrent(): Promise<void>;
}

export interface ProjectWorkflowRegistryCallbacks<T extends { release(): Promise<void> }> {
  validating(): void;
  failed(restartRequired: boolean, diagnostic?: WorkflowRegistrySourceDiagnostic): void;
  prepareCandidate(workflows: readonly LocalWorkflowRegistration[], admission: RetainedServerAdmissionOptions): Promise<T>;
  /** Ownership transfers to the host, even when activation fails or is superseded. */
  activateCandidate(candidate: T & { validate(): Promise<void> }, isCurrent: () => boolean): Promise<boolean>;
}

class RegistryRestartRequired extends Error {
  readonly restartRequired = true;
  constructor() { super("Existing workflow source or project settings changed. Restart the Local server."); this.name = "RegistryRestartRequired"; }
}

type Digests = Readonly<Record<string, string>>;
const registryFile = "src/arkimux.workflows.ts";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const equal = (left: Digests, right: Digests) => JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());

export async function createProjectWorkflowRegistrySource(
  repositoryRoot: string,
  assertDeclarations: typeof assertLocalWorkflowDeclarations,
  onFrameworkError?: FrameworkErrorObserver,
) {
  const root = await realpath(repositoryRoot);
  const vite = await createServer({
    root, configFile: false, envFile: false, appType: "custom", logLevel: "silent",
    // The private loader controls invalidation. Vite must not silently reload a
    // dependency or .env after an implementation-only edit.
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { external: ["@com-pyvue/agent-execution-local", "@com-pyvue/agent-execution-core"] },
  });
  let closed = false;
  let stopWatching: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requested = 0;
  let pending = Promise.resolve();
  let initial: LoadedProjectWorkflowRegistry | undefined;
  let loadedRegistryDigest: string | undefined;
  let baseline: Digests | undefined;
  let settingsBaseline: Digests | undefined;
  let watching = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryInputs: Digests | undefined;
  let observedInputs: Record<string, string> | undefined;
  const observeSource = (file: string, digest: string) => {
    // Only files not owned by an accepted generation can trigger an automatic retry.
    if (observedInputs && file !== registryFile && !Object.hasOwn(baseline ?? {}, file)
      && !Object.hasOwn(observedInputs, file)) {
      if (Object.keys(observedInputs).length >= 2048) throw new Error("Pending reload inputs exceed their finite bound.");
      observedInputs[file] = digest;
    }
  };

  async function checkBaseline(): Promise<void> {
    if (closed) throw new Error("Workflow registry loader is closed.");
    if (baseline && !equal(baseline, await readDigests(root, Object.keys(baseline)))) throw new RegistryRestartRequired();
    if (settingsBaseline && !equal(settingsBaseline, await projectSettings(root))) throw new RegistryRestartRequired();
  }

  async function prepareLoad(): Promise<{ loaded: LoadedProjectWorkflowRegistry; sources: Digests; settings: Digests; registryDigest: string }> {
    await checkBaseline();
    const settings = await projectSettings(root);
    const inspected = await validateProjectSource(root, { includeRenderers: false, observeSource });
    if (!inspected.sourceDigests) throw new Error("Workflow source validation produced no byte identity.");
    const sources = await candidateSourceDigests(root, inspected);
    for (const [file, digest] of Object.entries(sources)) observeSource(file, digest);
    // Registry factories also read conventional workflow assets. Watch only new
    // workflow directories, never assets of an already accepted workflow.
    for (const workflow of inspected.workflows) {
      if (!observedInputs || Object.hasOwn(baseline ?? {}, workflow.declaration.manifest)) continue;
      for (const kind of ["prompts", "tools", "fixtures"]) {
        const directory = path.posix.join(path.posix.dirname(workflow.declaration.manifest), kind);
        observeSource(`directory:${directory}`, await pendingInputDigest(root, `directory:${directory}`));
      }
    }
    // Recheck before evaluation: changes discovered by this read must never be
    // pulled into the candidate's factories or environment resolution.
    await checkBaseline();
    if (!equal(settings, await projectSettings(root))) throw new RegistryRestartRequired();
    vite.moduleGraph.invalidateAll();
    const module = await vite.ssrLoadModule(`/${registryFile}`);
    if (typeof module.loadProjectWorkflows !== "function" || !Array.isArray(module.workflowDeclarations)) {
      throw new ProjectSourceError({ file: registryFile, code: "registry-exports",
        message: "Export a loadProjectWorkflows function and a workflowDeclarations array." });
    }
    const workflows: unknown = await module.loadProjectWorkflows(root);
    if (!Array.isArray(workflows)) throw new ProjectSourceError({ file: registryFile, code: "registry-result",
      message: "loadProjectWorkflows must return an array." });
    await assertDeclarations({ repositoryRoot: root, declarations: module.workflowDeclarations, workflows,
      loadModule: absoluteFile => vite.ssrLoadModule(`/${path.relative(root, absoluteFile).split(path.sep).join("/")}`) });
    const loaded: LoadedProjectWorkflowRegistry = {
      workflows,
      admission: {
        workflowIds: inspected.workflows.filter(workflow => workflow.declaration.construction).map(workflow => workflow.manifest.workflowId),
        async prepareBuild(store, workflowId, hostRequirements) {
          await loaded.assertCurrent();
          const build = await prepareDeclaredRetainedWorkflowBuild(store, { projectRoot: root, workflowId, hostRequirements });
          if (Object.entries(inspected.sourceDigests!).some(([file, digest]) => build.manifest.preparation?.inputFiles[file] !== digest)) {
            throw new Error("Retained build differs from the candidate source revision.");
          }
          await loaded.assertCurrent();
          return { buildSha256: build.manifest.buildSha256, manifest: build.workflow.manifest, declaration: build.workflow.declaration };
        },
      },
      async assertCurrent() {
        await checkBaseline();
        if (!equal(settings, await projectSettings(root))) throw new RegistryRestartRequired();
        const current = await validateProjectSource(root, { includeRenderers: false, observeSource });
        if (!current.sourceDigests || !equal(inspected.sourceDigests!, current.sourceDigests)
          || !equal(sources, await candidateSourceDigests(root, current))) {
          throw new Error("Project source changed while preparing workflow reload. Save the registry again.");
        }
      },
    };
    await loaded.assertCurrent();
    return { loaded, sources, settings, registryDigest: inspected.sourceDigests[registryFile] };
  }

  function accept(sources: Digests, settings: Digests) {
    // Removed workflows remain restart-only too, because old Runs/closures may
    // still refer to them. Newly accepted source joins the same protection set.
    baseline = { ...baseline, ...sources };
    settingsBaseline = settings;
  }

  return {
    async load(): Promise<LoadedProjectWorkflowRegistry> {
      if (initial) return initial;
      if (watching || closed) throw new Error("Workflow registry loader is not available for initial load.");
      const result = await prepareLoad();
      accept(result.sources, result.settings);
      loadedRegistryDigest = result.registryDigest;
      initial = result.loaded;
      return initial;
    },
    watch<T extends { release(): Promise<void> }>(callbacks: ProjectWorkflowRegistryCallbacks<T>): void {
      if (!initial || watching || closed) throw new Error("Load the registry once before starting its watcher.");
      watching = true;
      const schedule = () => {
        if (closed) return;
        retryInputs = undefined;
        const generation = ++requested;
        clearTimeout(timer);
        callbacks.validating();
        timer = setTimeout(() => {
          pending = pending.then(async () => {
            if (closed || generation !== requested) return;
            let candidate: T | undefined;
            let transferred = false;
            observedInputs = {};
            try {
              const result = await prepareLoad();
              if (closed || generation !== requested) return;
              candidate = await callbacks.prepareCandidate(result.loaded.workflows, result.loaded.admission);
              await result.loaded.assertCurrent();
              if (closed || generation !== requested) return;
              const prepared = Object.assign(candidate, { validate: result.loaded.assertCurrent });
              transferred = true;
              if (await callbacks.activateCandidate(prepared, () => !closed && generation === requested)) {
                accept(result.sources, result.settings);
                loadedRegistryDigest = result.registryDigest;
              }
            } catch (error) {
              await observeFrameworkError(onFrameworkError, error, "registry");
              if (!closed && generation === requested) {
                const restart = (error as { restartRequired?: boolean })?.restartRequired === true;
                retryInputs = restart ? undefined : { ...observedInputs };
                callbacks.failed(restart, projectSourceDiagnostic(error));
              }
            } finally {
              observedInputs = undefined;
              if (candidate && !transferred) await candidate.release();
            }
          }).catch(async error => {
            await observeFrameworkError(onFrameworkError, error, "registry");
            if (!closed && generation === requested) { retryInputs = undefined; callbacks.failed(true); }
          });
        }, 75);
      };
      // Poll only a failed candidate's observed new inputs. No unchanged-input
      // retries, and no expansion of implementation/.env/dependency hot reload.
      const pollRetry = async () => {
        const inputs = retryInputs;
        try {
          if (!closed && inputs && Object.keys(inputs).length) {
            for (const [file, digest] of Object.entries(inputs)) {
              const current = await pendingInputDigest(root, file);
              if (closed || inputs !== retryInputs) break;
              if (current === "invalid") {
                // Remember rejection without evaluating or reading the escaped
                // target. A later regular in-project replacement can still recover.
                if (digest !== "invalid") { retryInputs = { ...inputs, [file]: "invalid" }; break; }
                continue;
              }
              if (current !== digest) { schedule(); break; }
            }
          }
        } catch (error) {
          await observeFrameworkError(onFrameworkError, error, "registry");
          // A failed input probe is not authority to keep evaluating user code.
          if (inputs === retryInputs) retryInputs = undefined;
        } finally {
          if (!closed) { retryTimer = setTimeout(pollRetry, 150); retryTimer.unref(); }
        }
      };
      retryTimer = setTimeout(pollRetry, 150); retryTimer.unref();
      // Poll one pathname, not an inode replaced by an editor's atomic save.
      // Native directory watchers may exhaust macOS handles; this remains live
      // across unlink/recreate. New candidate inputs are observed separately only
      // while a registry update is pending after failure.
      const watchedFile = path.join(root, registryFile);
      const changed = () => schedule();
      watchFile(watchedFile, { interval: 75, persistent: false }, changed);
      stopWatching = () => unwatchFile(watchedFile, changed);
      // Startup/build preparation may take time before the watcher is installed.
      // Install it first, then detect any save in that gap without losing later saves.
      void fileDigest(path.join(root, registryFile)).then(digest => {
        if (!closed && digest !== loadedRegistryDigest) schedule();
      }).catch(async error => { await observeFrameworkError(onFrameworkError, error, "registry"); if (!closed) callbacks.failed(true); });
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      requested++;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      retryInputs = undefined;
      stopWatching?.();
      await pending;
      await vite.close();
    },
  };
}

async function pendingInputDigest(root: string, key: string): Promise<string> {
  const directory = key.startsWith("directory:");
  const relative = directory ? key.slice("directory:".length) : key;
  if (!/^(src|workflows)\//.test(relative) || relative.split("/").some(part => !part || part === "." || part === "..")
    || relative.includes("\\")) return "invalid";
  // Check the nearest existing ancestor too: a missing file below an escaping
  // directory link must not make the retry watcher read outside the project.
  let ancestor = path.join(root, relative);
  while (ancestor !== root) {
    try {
      const resolved = await realpath(ancestor);
      if (!resolved.startsWith(root + path.sep)) return "invalid";
      const resolvedRelative = path.relative(root, resolved).split(path.sep).join("/");
      if (!/^(src|workflows)(\/|$)/.test(resolvedRelative)) return "invalid";
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "invalid";
      ancestor = path.dirname(ancestor);
    }
  }
  try {
    if (!directory) return await fileDigest(path.join(root, relative));
    const files = await regularFiles(root, relative);
    return hash(JSON.stringify(Object.entries(await readDigests(root, files)).sort()));
  } catch { return "invalid"; }
}

async function readDigests(root: string, files: readonly string[]): Promise<Digests> {
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await fileDigest(path.join(root, file))])));
}

async function fileDigest(file: string): Promise<string> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error("Expected bounded regular project input.");
    return hash(await readFile(file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

async function candidateSourceDigests(root: string, inspected: InspectedProject): Promise<Digests> {
  const files = new Set(Object.keys(inspected.sourceDigests ?? {}).filter(file => file !== registryFile));
  for (const workflow of inspected.workflows) {
    for (const asset of workflow.declaration.construction?.assets ?? []) files.add(asset);
    const directory = path.posix.dirname(workflow.declaration.manifest);
    for (const kind of ["prompts", "tools", "fixtures"]) {
      for (const file of await regularFiles(root, path.posix.join(directory, kind))) files.add(file);
    }
  }
  if (files.size > 2048) throw new Error("Workflow reload source inventory exceeds its finite bound.");
  return readDigests(root, [...files]);
}

async function regularFiles(root: string, relative: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(path.join(root, relative), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: string[] = [];
  for (const entry of entries) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await regularFiles(root, file));
    else if (entry.isFile()) result.push(file);
    else throw new Error("Workflow reload inputs must not be symbolic links.");
    if (result.length > 2048) throw new Error("Workflow reload input inventory exceeds its finite bound.");
  }
  return result;
}

async function projectSettings(root: string): Promise<Digests> {
  const fixed = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "tsconfig.json", ".npmrc", ".env"];
  const names = await readdir(root);
  for (const name of names) if (/^\.env\./.test(name) || /^vite\.config\.[cm]?[jt]s$/.test(name)) fixed.push(name);
  const files = [...new Set([...fixed, ...await regularFiles(root, "config")])];
  return { ...await readDigests(root, files), "node_modules:inventory": await dependencyInventory(root) };
}

/** Dependency edits are restart-only. Metadata detects installs and in-place edits,
 * without repeatedly reading provider packages or copying dependency contents. */
async function dependencyInventory(root: string): Promise<string> {
  const records: string[] = [];
  const visited = new Set<string>();
  let count = 0;
  async function visit(absolute: string, relative: string) {
    let resolved: string;
    try { resolved = await realpath(absolute); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { records.push(`${relative}:missing`); return; } throw error; }
    records.push(`resolved:${resolved}`);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    let entries;
    try { entries = await readdir(absolute, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { records.push(`${relative}:missing`); return; } throw error; }
    await Promise.all(entries.map(async entry => {
      if ([".cache", ".vite", ".vite-temp"].includes(entry.name)) return;
      if (++count > 100_000) throw new Error("Dependency inventory exceeds its finite bound.");
      // Canonical keys make aliased/symlinked dependency traversal deterministic
      // regardless of which concurrent directory read reaches a target first.
      const file = path.join(resolved, entry.name), name = file;
      if (entry.isDirectory()) { records.push(`${name}:directory`); await visit(file, name); }
      else if (entry.isSymbolicLink()) {
        records.push(`${name}:link:${await readlink(file)}`);
        let target: string;
        try { target = await realpath(file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { records.push(`${name}:missing-target`); return; } throw error; }
        const info = await lstat(target);
        records.push(`${name}:target:${target}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
        if (info.isDirectory()) await visit(target, name);
      }
      else {
        const info = await lstat(file);
        records.push(`${name}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
      }
    }));
  }
  await visit(path.join(root, "node_modules"), "node_modules");
  return hash(records.sort().join("\n"));
}
