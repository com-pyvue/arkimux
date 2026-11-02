import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { realpathSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrateLegacyLocalStore } from "../../local/src/localStoreMigration.ts";
import { resolveLocalFileStorePaths } from "../../local/src/localStorePaths.ts";
import { describeLocalStartupFailure, waitForOwnedWorkflowApi } from "./localStartup.ts";
import { publishDefaultConfigurations } from "./defaultConfigurationPublication.ts";
import { validateProjectSource } from "./projectSourceGuard.ts";
import { captureLocalDebugger, withoutDebuggerEnvironment, type LocalDebugger } from "../../local/src/localDebugger.ts";
import { runHeadlessDebuggerCommand, type HeadlessDebuggerClient } from "./headlessDebuggerCommand.ts";
import mockDebuggerImageSource from "./dockerMockDebuggerImageSource.json" with { type: "json" };
import { createProject } from "./createProject.ts";

const minimumNode = { major: 24, minor: 0 };
const legacyProcessRecordRelativePath = ".agent-execution/processes/local-server.json";
const legacyLocalDataRelativePath = ".agent-execution";

export interface ArkiMuxCliResult {
  kind: "create" | "local-start" | "local-debug" | "local-stop" | "local-migrate" | "project-validate" | "debug-stdio" | "help";
  message: string;
  /** Protocol commands own stdout and return their process exit status. */
  exitCode?: number;
  projectRoot?: string;
  url?: string;
}

export interface ArkiMuxCliDependencies {
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  nodeVersion?: string;
  /** Foreground debug readiness is reported before the session finishes. */
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

interface LocalProcessRecord {
  schemaVersion: 1;
  projectRoot: string;
  pid: number;
  token: string;
  roleId: string;
  url: string;
  startedAt: string;
  command: string;
  log: string;
}

export function arkimuxCliUsage(): string {
  return [
    "Usage:",
    "  arkimux create <project-name>",
    "  arkimux local start [--port <port>] [--inspect-port <port>]",
    "  arkimux local debug [--port <port>]",
    "  arkimux local stop",
    "  arkimux local migrate",
    "  arkimux project validate",
    "  arkimux debug stdio --project PATH",
    "",
    "Creates an ArkiMux project with Weather Advisor.",
  ].join("\n");
}

export async function runArkiMuxCli(
  args: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  dependencies: ArkiMuxCliDependencies = {},
  moduleUrl: string = import.meta.url,
): Promise<ArkiMuxCliResult> {
  assertSupportedNode(dependencies.nodeVersion ?? process.versions.node);
  const command = args[0];
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { kind: "help", message: arkimuxCliUsage() };
  }
  const packageRoot = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..");
  if (command === "debug") {
    const exitCode = await runHeadlessDebuggerCommand(args.slice(1), cwd, packageRoot, async (options) => {
      let selectedVersion: 1 | 2 | undefined;
      let selectedClient: Promise<HeadlessDebuggerClient> | undefined;
      const selectClient = (schemaVersion: 1 | 2): Promise<HeadlessDebuggerClient> => {
        if (selectedVersion !== undefined && selectedVersion !== schemaVersion) throw new Error("Debugger protocol version changed after selection.");
        selectedVersion ??= schemaVersion;
        return selectedClient ??= schemaVersion === 2
          ? import("./dockerMockDebuggerCoordinator.ts").then(({ createPreparedDockerMockDebuggerCoordinator }) =>
              createPreparedDockerMockDebuggerCoordinator({
                projectRoot: options.projectRoot,
                hostRequirements: { node: "24" },
                imageSource: mockDebuggerImageSource as { kind: "registry"; imageReference: string },
                onChange: options.onChange,
              }))
          : Promise.all([
              import("../../local/src/headlessDebugger.ts"),
              import("./prepareHeadlessDebugger.ts"),
            ]).then(([{ createHeadlessDebugger }, { prepareHeadlessDebuggerSession }]) =>
              createHeadlessDebugger({ ...options, prepareSession: prepareHeadlessDebuggerSession }));
      };
      return {
        async request(method, params, schemaVersion = 1) {
          return (await selectClient(schemaVersion)).request(method, params, schemaVersion);
        },
        async close() {
          if (selectedClient) await (await selectedClient).close();
        },
      };
    });
    return { kind: "debug-stdio", message: "", exitCode };
  }
  if (command === "create") {
    const projectName = args[1];
    if (!projectName || projectName.startsWith("-")) {
      throw new Error("arkimux create requires a project name.\n\n" + arkimuxCliUsage());
    }
    rejectUnknownOptions(args.slice(2), []);
    return createProject({ cwd, projectName, packageRoot, environment: dependencies.environment ?? process.env });
  }
  if (command === "local") {
    const action = args[1];
    if (action === "start" || action === "debug") {
      rejectUnknownOptions(args.slice(2), action === "debug" ? ["--port"] : ["--port", "--inspect-port"]);
      return startLocal({
        cwd,
        packageRoot,
        port: action === "debug" && option(args.slice(2), "--port") === undefined
          ? 0 : parsePort(option(args.slice(2), "--port")),
        inspectPort: option(args.slice(2), "--inspect-port") === undefined ? undefined : parsePort(option(args.slice(2), "--inspect-port")),
        environment: dependencies.environment ?? process.env,
        now: dependencies.now ?? (() => new Date()),
        debug: action === "debug" ? captureLocalDebugger(dependencies.environment ?? process.env) : undefined,
        onProgress: dependencies.onProgress ?? console.log,
        signal: dependencies.signal,
      });
    }
    if (action === "stop") {
      rejectUnknownOptions(args.slice(2), []);
      return stopLocal(cwd);
    }
    if (action === "migrate") {
      rejectUnknownOptions(args.slice(2), []);
      return migrateLocal(cwd);
    }
  }
  if (command === "project" && args[1] === "validate") {
    rejectUnknownOptions(args.slice(2), []);
    return validateProject(cwd, packageRoot);
  }
  throw new Error(`Unknown command ${args.join(" ")}.\n\n${arkimuxCliUsage()}`);
}

interface GeneratedProjectPackage {
  name?: unknown;
  private?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
}

interface GeneratedProjectLock {
  lockfileVersion?: unknown;
  packages?: Record<string, Record<string, unknown>>;
}

async function validateProject(cwd: string, packageRoot: string): Promise<ArkiMuxCliResult> {
  const { projectRoot, manifest } = await resolveProject(cwd);
  await regularProjectFile(projectRoot, ".arkimux/project.json", "project manifest");
  const projectName = requiredProjectName(manifest.projectName);
  const workflowRegistry = requiredProjectRelativePath(manifest.workflowRegistry, "workflowRegistry");
  const projectPackagePath = await regularProjectFile(projectRoot, "package.json", "project package manifest");
  const projectLockPath = await regularProjectFile(projectRoot, "package-lock.json", "project lockfile");
  const projectPackage = await readValidationJson<GeneratedProjectPackage>(projectPackagePath, "project package manifest");
  const projectLock = await readValidationJson<GeneratedProjectLock>(projectLockPath, "project lockfile");
  const cliPackage = await readValidationJson<{ name?: unknown; version?: unknown }>(path.join(packageRoot, "package.json"), "installed ArkiMux package manifest");

  if (projectPackage.name !== projectName) {
    throw new Error(`Project manifest name ${projectName} does not match package.json name ${String(projectPackage.name)}.`);
  }
  if (projectPackage.private !== true) throw new Error("Generated ArkiMux projects must set private to true in package.json.");
  const cliVersion = exactSemver(cliPackage.version, "installed ArkiMux package version");
  if (cliPackage.name !== "@com-pyvue/arkimux") throw new Error("The active project validator is not installed from @com-pyvue/arkimux.");
  if (projectPackage.devDependencies?.["@com-pyvue/arkimux"] !== cliVersion) {
    throw new Error(`package.json must pin @com-pyvue/arkimux exactly to ${cliVersion}. Run npm install with that exact version.`);
  }
  if (projectPackage.scripts?.validate !== "npm run typecheck && arkimux project validate && npm test") {
    throw new Error("package.json must define validate as: npm run typecheck && arkimux project validate && npm test");
  }
  if (projectPackage.scripts?.dev !== "arkimux local start" || projectPackage.scripts?.["dev:stop"] !== "arkimux local stop") {
    throw new Error("package.json must define dev as 'arkimux local start' and dev:stop as 'arkimux local stop'.");
  }
  validateExactDependencyMap(projectPackage.dependencies, "dependencies");
  validateExactDependencyMap(projectPackage.devDependencies, "devDependencies");
  await validateVendorTarballs(projectRoot, projectPackage.dependencies);
  await validateVendorTarballs(projectRoot, projectPackage.devDependencies);
  validateProjectLock(projectLock, projectPackage, cliVersion);

  const registryPath = await regularProjectFile(projectRoot, workflowRegistry, "workflow registry");
  const registrySource = await readFile(registryPath, "utf8");
  if (!/export\s+(?:async\s+)?function\s+loadProjectWorkflows\b/.test(registrySource)) {
    throw new Error(`${workflowRegistry} must export the loadProjectWorkflows function.`);
  }
  await rejectCheckoutFallbacks(projectRoot, ["package.json", "package-lock.json", workflowRegistry]);
  if (workflowRegistry !== "src/arkimux.workflows.ts") throw new Error("workflowRegistry must be src/arkimux.workflows.ts.");
  const inspected = await validateProjectSource(projectRoot);

  return {
    kind: "project-validate",
    projectRoot,
    message: [`ArkiMux project is valid: ${projectRoot}.`, ...inspected.workflows.map(w =>
      `${w.manifest.workflowId}: ${w.manifest.workflowMode}, contract ${w.manifest.workflowContractVersion}, SHA-256 ${w.digest}`)].join("\n"),
  };
}

async function validateVendorTarballs(projectRoot: string, value: Record<string, unknown> | undefined): Promise<void> {
  for (const [name, specification] of Object.entries(value ?? {})) {
    if (typeof specification === "string" && specification.startsWith("file:vendor/")) {
      await regularProjectFile(projectRoot, specification.slice("file:".length), `dependency tarball for ${name}`);
    }
  }
}

function requiredProjectName(value: unknown): string {
  if (typeof value !== "string") throw new Error(".arkimux/project.json must define projectName.");
  assertProjectName(value);
  return value;
}

function requiredProjectRelativePath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`.arkimux/project.json must define ${field}.`);
  if (path.isAbsolute(value) || value.includes("\\")) throw new Error(`${field} must be a portable project-relative path.`);
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) {
    throw new Error(`${field} must stay inside the project and use a normalized relative path.`);
  }
  return value;
}

function exactSemver(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${label} must be an exact semantic version.`);
  }
  return value;
}

function validateExactDependencyMap(value: Record<string, unknown> | undefined, label: string): void {
  if (!value) return;
  for (const [name, specification] of Object.entries(value)) {
    if (typeof specification !== "string") throw new Error(`${label}.${name} must be a string.`);
    if (/^file:vendor\/[A-Za-z0-9@._+-]+\.tgz$/.test(specification)) continue;
    try {
      exactSemver(specification, `${label}.${name}`);
    } catch {
      throw new Error(`${label}.${name} must use an exact version or a generator-owned file:vendor tarball.`);
    }
  }
}

function validateProjectLock(lock: GeneratedProjectLock, projectPackage: GeneratedProjectPackage, cliVersion: string): void {
  if (!Number.isInteger(lock.lockfileVersion) || Number(lock.lockfileVersion) < 3 || !lock.packages) {
    throw new Error("package-lock.json must be an npm lockfileVersion 3 or newer lockfile.");
  }
  const root = lock.packages[""];
  if (!root) throw new Error("package-lock.json does not contain the generated project root package.");
  for (const field of ["dependencies", "devDependencies"] as const) {
    const expected = projectPackage[field] ?? {};
    const actual = root[field];
    if (!sameRecord(actual, expected)) {
      throw new Error(`package-lock.json ${field} do not match package.json. Run npm install and retry.`);
    }
  }
  const lockedCli = lock.packages["node_modules/@com-pyvue/arkimux"];
  if (!lockedCli || lockedCli.version !== cliVersion || lockedCli.link === true) {
    throw new Error(`package-lock.json must contain physical @com-pyvue/arkimux@${cliVersion}. Run npm install and retry.`);
  }
}

function sameRecord(actual: unknown, expected: Record<string, unknown>): boolean {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return Object.keys(expected).length === 0;
  const sort = (value: Record<string, unknown>) => Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(sort(actual as Record<string, unknown>)) === JSON.stringify(sort(expected));
}

async function regularProjectFile(projectRoot: string, relative: string, label: string): Promise<string> {
  const file = path.resolve(projectRoot, relative);
  const relation = path.relative(projectRoot, file);
  if (relation === "" || relation === ".." || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
    throw new Error(`${label} must stay inside the project.`);
  }
  const info = await lstat(file).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`${label} ${relative} must be a regular project file.`);
  return file;
}

async function rejectCheckoutFallbacks(projectRoot: string, relativeFiles: string[]): Promise<void> {
  for (const relative of relativeFiles) {
    const source = await readFile(path.join(projectRoot, relative), "utf8");
    if (/\b(?:workspace|link):|file:(?:\.\.\/|\/)|\/agent-execution-platform(?:\/|\b)/.test(source)) {
      throw new Error(`${relative} contains a workspace, parent-directory, absolute-file, or Platform-checkout fallback.`);
    }
  }
}

async function readValidationJson<T>(file: string, label: string): Promise<T> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${label} ${file}: ${errorMessage(error)}`);
  }
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    throw new Error(`${label} ${file} contains invalid JSON: ${errorMessage(error)}`);
  }
}

async function startLocal(input: {
  cwd: string;
  packageRoot: string;
  port: number;
  inspectPort?: number;
  environment: NodeJS.ProcessEnv;
  now: () => Date;
  debug?: LocalDebugger;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<ArkiMuxCliResult> {
  const { projectRoot } = await resolveProject(input.cwd);
  await assertNoLegacyLocalData(projectRoot);
  const localPaths = resolveLocalFileStorePaths(projectRoot);
  const processRecordPath = path.join(localPaths.processes, "local-server.json");
  const existing = await readProcessRecord(processRecordPath);
  if (existing && ownedProcessIsAlive(existing)) {
    if (input.debug) throw new Error("This project's Local server is already running. Run arkimux local stop before starting ArkiMux Local Debug.");
    return { kind: "local-start", projectRoot, url: existing.url, message: `ArkiMux local API is already running at ${existing.url}.` };
  }
  if (existing && processIsAlive(existing.pid)) {
    throw new Error(`PID ${existing.pid} is active but is not this project's recorded ArkiMux server. Remove ${processRecordPath} after checking the process.`);
  }
  if (existing) await unlinkIfExists(processRecordPath);
  const bin = (name: string) => path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  await assertExecutable(bin("agent-execution-local"), "Run npm install in the generated project.");
  await assertExecutable(bin("tsx"), "Run npm install in the generated project.");
  // Startup proves the owned Local API/UI is available, not that an agent is
  // authenticated. Workflow submission and execution retain their preflights.
  const bootstrap = run(bin("agent-execution-local"), [
    "bootstrap",
    "--repository-root", projectRoot,
    "--subject-id", "local-developer",
    "--user-id", "local-developer",
    "--role-family", "arkimux-workflow-developer",
    "--role-preset", "local-workflow-developer",
    "--permission", "workflow:decision-brief:configure",
    "--permission", "workflow:decision-brief:start",
    "--permission", "workflow:weather-advisor:configure",
    "--permission", "workflow:weather-advisor:start",
  ], projectRoot, input.debug ? withoutDebuggerEnvironment(input.environment) : input.environment);
  if (bootstrap.status !== 0) throw new Error("Local setup could not complete. Check this project's local storage and try again.");
  const roleId = /assigned role ([a-z0-9-]+)\.?/i.exec(bootstrap.stdout)?.[1];
  if (!roleId) throw new Error("Local setup did not return a usable operator role. Reinstall the ArkiMux CLI and try again.");

  const serverEntry = path.join(input.packageRoot, "dist/local-server.js");
  await assertExecutable(serverEntry, "Reinstall the ArkiMux CLI package; its private server entry is missing.");
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  const loader = pathToFileURL(projectRequire.resolve("tsx")).href;

  const processDirectory = path.dirname(processRecordPath);
  await mkdir(processDirectory, { recursive: true });
  const logPath = path.join(localPaths.processes, "local-server.log");
  const log = await open(logPath, "a");
  const logStartOffset = (await log.stat()).size;
  const token = randomUUID();
  const startupDeadline = Date.now() + 30_000;
  const serverArgs = [...(input.inspectPort ? [`--inspect=127.0.0.1:${input.inspectPort}`] : []),
    "--import", loader, serverEntry, "--port", String(input.port), ...(input.debug ? ["--debug-session"] : []),
    "--project-root", projectRoot, "--process-token", token];
  const child = spawn(process.execPath, serverArgs, {
    cwd: projectRoot,
    detached: process.platform !== "win32",
    env: { ...(input.debug ? { ...withoutDebuggerEnvironment(input.environment), ...input.debug.environment } : input.environment), ARKIMUX_LOCAL_PROCESS_TOKEN: token },
    stdio: ["ignore", log.fd, log.fd, "ipc"],
  });
  if (!input.debug) child.unref();
  let stopRequested = false;
  let stopCompletion: Promise<void> | undefined;
  const stopDebug = () => { stopRequested = true; stopCompletion ??= terminateSpawnedChild(child, true); };
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (input.debug) {
    process.once("SIGINT", stopDebug); process.once("SIGTERM", stopDebug);
    input.signal?.addEventListener("abort", stopDebug, { once: true });
    if (input.signal?.aborted) stopDebug();
  }
  let url = `http://127.0.0.1:${input.port}`;
  const record: LocalProcessRecord | undefined = child.pid ? {
    schemaVersion: 1,
    projectRoot,
    pid: child.pid,
    token,
    roleId,
    url,
    startedAt: input.now().toISOString(),
    command: [process.execPath, ...serverArgs].join(" "),
    log: path.relative(projectRoot, logPath).split(path.sep).join("/"),
  } : undefined;
  try {
    if (!record) throw new Error("Local server process did not report a PID.");
    writeJsonExclusive(processRecordPath, record);
    url = await waitForOwnedWorkflowApi({
      url,
      child,
      token,
      projectRoot,
      deadline: startupDeadline,
      authorizeStart: true,
      automaticPort: input.port === 0,
    });
    if (record.url !== url) {
      const current = await readProcessRecord(processRecordPath);
      if (!current || current.pid !== record.pid || current.token !== record.token) {
        throw new Error("Local server ownership changed during startup.");
      }
      record.url = url;
      // The child may have reconciled its registry-specific Local role while
      // starting. Preserve that role when recording the OS-selected port.
      record.roleId = current.roleId;
      await writeJsonAtomic(processRecordPath, { ...current, url });
    }
    const configurationMessages = await publishDefaultConfigurations({ projectRoot, url, deadline: startupDeadline });
    const ready: ArkiMuxCliResult = {
      kind: "local-start",
      projectRoot,
      url,
      message: [
        ...configurationMessages,
        `ArkiMux local API: ${url}`,
        `ArkiMux Local UI: ${url}/connections`,
        "Open Connections to set up and test your agent connection.",
        "Project workflows are registered. Provider readiness is checked before each run.",
      ].join("\n"),
    };
    if (!input.debug) return ready;
    input.onProgress?.(`${ready.message}\nDebugger active. Submit Runs in the UI or API. Stop this IDE session to stop this project's server. Run deadlines still apply while paused.`);
    const outcome = await ended;
    await stopCompletion;
    await removeProcessRecordIfOwned(processRecordPath, record);
    if (!stopRequested && (outcome.code !== 0 || outcome.signal)) throw new Error("The debug server exited unexpectedly. Check the Local server log.");
    return { ...ready, kind: "local-debug", message: "ArkiMux Local Debug stopped." };
  } catch (error) {
    await terminateSpawnedChild(child, Boolean(input.debug));
    let cleanupError: unknown;
    if (record) {
      try {
        await removeProcessRecordIfOwned(processRecordPath, record);
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
    }
    const startupError = await localStartupError(error, input.port, logPath, logStartOffset);
    if (cleanupError) {
      throw new Error(`${startupError.message}\n${errorMessage(cleanupError)}`);
    }
    throw startupError;
  } finally {
    if (input.debug) {
      process.off("SIGINT", stopDebug); process.off("SIGTERM", stopDebug);
      input.signal?.removeEventListener("abort", stopDebug);
    }
    await log.close();
  }
}

async function stopLocal(cwd: string): Promise<ArkiMuxCliResult> {
  const { projectRoot, legacyManifest } = await resolveProject(cwd, { allowLegacy: true });
  const currentRecordPath = path.join(resolveLocalFileStorePaths(projectRoot).processes, "local-server.json");
  const legacyRecordPath = path.join(projectRoot, legacyProcessRecordRelativePath);
  const [currentRecord, legacyRecord] = await Promise.all([
    readProcessRecord(currentRecordPath),
    readProcessRecord(legacyRecordPath),
  ]);
  if (currentRecord && legacyRecord) {
    throw new Error("Both current and legacy local process records exist. Inspect them before stopping either process.");
  }
  const recordPath = currentRecord ? currentRecordPath : legacyRecord ? legacyRecordPath : currentRecordPath;
  const record = currentRecord ?? legacyRecord;
  const migrationRequired = legacyManifest || await pathExists(path.join(projectRoot, legacyLocalDataRelativePath));
  if (!record) {
    return {
      kind: "local-stop",
      projectRoot,
      message: migrationRequired
        ? "ArkiMux local API is already stopped. Next: arkimux local migrate"
        : "ArkiMux local API is already stopped.",
    };
  }
  if (path.resolve(record.projectRoot) !== projectRoot) throw new Error("The local process record belongs to another project.");
  if (processIsAlive(record.pid) && !ownedProcessIsAlive(record)) {
    throw new Error(`Refusing to stop PID ${record.pid}: it is not this project's recorded ArkiMux server.`);
  }
  if (ownedProcessIsAlive(record)) {
    process.kill(record.pid, "SIGTERM");
    await waitForExit(record.pid, 5_000);
    if (processIsAlive(record.pid)) process.kill(record.pid, "SIGKILL");
  }
  await unlinkIfExists(recordPath);
  return {
    kind: "local-stop",
    projectRoot,
    message: `Stopped this project's ArkiMux local API (${record.url}).${migrationRequired ? "\nNext: arkimux local migrate" : ""}`,
  };
}

async function migrateLocal(cwd: string): Promise<ArkiMuxCliResult> {
  const { projectRoot, manifest, legacyManifest } = await resolveProject(cwd, { allowLegacy: true });
  const manifestPath = path.join(projectRoot, ".arkimux/project.json");
  const legacyManifestBytes = legacyManifest ? await readFile(manifestPath) : undefined;
  const legacyManifestMode = legacyManifest ? (await stat(manifestPath)).mode & 0o777 : undefined;
  const currentRecordPath = path.join(resolveLocalFileStorePaths(projectRoot).processes, "local-server.json");
  for (const recordPath of [currentRecordPath, path.join(projectRoot, legacyProcessRecordRelativePath)]) {
    const record = await readProcessRecord(recordPath);
    if (record && processIsAlive(record.pid)) {
      throw new Error("ArkiMux local API is running. Run arkimux local stop before arkimux local migrate.");
    }
  }
  const result = await migrateLegacyLocalStore(projectRoot);
  if (await pathExists(path.join(projectRoot, legacyLocalDataRelativePath))) {
    throw new Error("Migration did not retire .agent-execution. The project manifest was not changed.");
  }
  if (legacyManifest) {
    const backupRoot = result.backupRoot ?? path.join(
      projectRoot,
      ".arkimux/local/legacy-backup",
      `manifest-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    );
    const manifestBackup = path.join(backupRoot, "project-manifest/project.json");
    await mkdir(path.dirname(manifestBackup), { recursive: true, mode: 0o700 });
    await writeFile(manifestBackup, legacyManifestBytes!, { flag: "wx", mode: legacyManifestMode });
    await chmod(manifestBackup, legacyManifestMode!);
    await writeJsonAtomic(manifestPath, {
      ...manifest,
      schemaVersion: 2,
      kind: "arkimux-project",
    });
  }
  return {
    kind: "local-migrate",
    projectRoot,
    message: [
      legacyManifest ? "Updated the project manifest to arkimux-project@2." : "The project manifest is already current.",
      legacyManifest ? "Backed up the previous project manifest under .arkimux/local/legacy-backup/." : undefined,
      result.message,
    ].filter((line): line is string => line !== undefined).join("\n"),
  };
}

async function terminateSpawnedChild(child: ReturnType<typeof spawn>, ownProcessGroup = false): Promise<void> {
  if (child.connected) {
    try {
      child.disconnect();
    } catch {
      // The child closed its IPC channel while startup failure was being handled.
    }
  }
  if (!child.pid) return;
  const cleanupTarget = ownProcessGroup && process.platform !== "win32" ? -child.pid : child.pid;
  if (!processIsAlive(cleanupTarget)) return;
  try {
    process.kill(child.pid, "SIGTERM");
  } catch {
    if (!ownProcessGroup) return;
  }
  await waitForExit(cleanupTarget, 2_000);
  if (processIsAlive(cleanupTarget)) {
    try {
      process.kill(cleanupTarget, "SIGKILL");
    } catch {
      // The process exited between the liveness check and the signal.
    }
  }
}

async function localStartupError(
  error: unknown,
  port: number,
  logPath: string,
  logStartOffset: number,
): Promise<Error> {
  const output = await readFile(logPath).catch(() => Buffer.alloc(0));
  const currentAttempt = Buffer.isBuffer(output)
    ? output.subarray(Math.min(logStartOffset, output.length)).toString("utf8")
    : String(output).slice(logStartOffset);
  return describeLocalStartupFailure({ error, port, logPath, logOutput: currentAttempt });
}

interface ProjectManifest extends Record<string, unknown> {
  schemaVersion?: number;
  kind?: string;
}

async function resolveProject(
  cwd: string,
  options: { allowLegacy?: boolean } = {},
): Promise<{ projectRoot: string; manifest: ProjectManifest; legacyManifest: boolean }> {
  const projectRoot = path.resolve(cwd);
  const manifest = await readJson<ProjectManifest>(path.join(projectRoot, ".arkimux/project.json")).catch(() => undefined);
  if (manifest?.schemaVersion === 2 && manifest.kind === "arkimux-project") {
    return { projectRoot, manifest, legacyManifest: false };
  }
  if (manifest?.schemaVersion === 1 && manifest.kind === "workflow-project") {
    if (options.allowLegacy) return { projectRoot, manifest, legacyManifest: true };
    throw new Error(`Current directory ${projectRoot} uses the old ArkiMux project format. Run arkimux local migrate before arkimux local start.`);
  }
  throw new Error(`Current directory ${projectRoot} is not an ArkiMux project.`);
}

async function assertNoLegacyLocalData(projectRoot: string): Promise<void> {
  if (await pathExists(path.join(projectRoot, legacyLocalDataRelativePath))) {
    throw new Error("Legacy ArkiMux local data was found in .agent-execution. Run arkimux local migrate before arkimux local start.");
  }
}

function run(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv) {
  return spawnSync(command, args, { cwd, env: environment, encoding: "utf8" });
}

function assertSupportedNode(version: string): void {
  const [major = 0, minor = 0] = version.replace(/^v/, "").split(".").map(Number);
  if (major < minimumNode.major || (major === minimumNode.major && minor < minimumNode.minor)) {
    throw new Error(`ArkiMux requires Node.js >=24.0.0; current runtime is ${version}.`);
  }
}

function assertProjectName(value: string): void {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(value) || value.endsWith("-")) {
    throw new Error("Project name must start with a lowercase letter, contain only lowercase letters, numbers, and hyphens, and not end with a hyphen.");
  }
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 8787 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be an integer from 1 to 65535.");
  return port;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function rejectUnknownOptions(args: string[], allowed: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!allowed.includes(value)) throw new Error(`Unknown option ${value}.`);
    index += 1;
  }
}

async function pathExists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => undefined)) !== undefined;
}

async function assertExecutable(file: string, remediation: string): Promise<void> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new Error(`Required executable ${file} is missing. ${remediation}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownedProcessIsAlive(record: LocalProcessRecord): boolean {
  if (!processIsAlive(record.pid)) return false;
  if (process.platform === "win32") return true;
  const inspected = spawnSync("ps", ["-ww", "-p", String(record.pid), "-o", "command="], { encoding: "utf8" });
  if (inspected.status !== 0 || typeof inspected.stdout !== "string") return false;
  const liveCommand = inspected.stdout.trim();
  if (liveCommand !== record.command) return false;
  // Retain safe stopping of a server launched before the CLI ownership change.
  if (liveCommand.includes(path.join(record.projectRoot, "scripts/serve-local.ts"))) return true;
  return liveCommand.includes(`${path.sep}dist${path.sep}local-server.js --port `)
    && liveCommand.endsWith(` --project-root ${record.projectRoot} --process-token ${record.token}`);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) await delay(100);
}

async function readProcessRecord(file: string): Promise<LocalProcessRecord | undefined> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw new Error(`Could not read local process record ${file}: ${errorMessage(error)}`);
  }
  let record: LocalProcessRecord;
  try {
    record = JSON.parse(source) as LocalProcessRecord;
  } catch (error) {
    throw new Error(`Local process record ${file} contains invalid JSON: ${errorMessage(error)}`);
  }
  if (!isLocalProcessRecord(record)) {
    throw new Error(`Local process record ${file} is invalid. Inspect or remove it only after checking the recorded process.`);
  }
  return record;
}

function isLocalProcessRecord(value: unknown): value is LocalProcessRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<LocalProcessRecord>;
  return record.schemaVersion === 1
    && typeof record.projectRoot === "string"
    && Number.isInteger(record.pid)
    && Number(record.pid) > 0
    && typeof record.token === "string"
    && record.token.length > 0
    && typeof record.roleId === "string"
    && record.roleId.length > 0
    && typeof record.url === "string"
    && record.url.length > 0
    && typeof record.startedAt === "string"
    && record.startedAt.length > 0
    && typeof record.command === "string"
    && record.command.length > 0
    && typeof record.log === "string"
    && record.log.length > 0;
}

async function removeProcessRecordIfOwned(file: string, expected: LocalProcessRecord): Promise<void> {
  const actual = await readProcessRecord(file);
  if (!actual) return;
  if (actual.pid !== expected.pid
    || actual.token !== expected.token
    || path.resolve(actual.projectRoot) !== path.resolve(expected.projectRoot)) return;
  await unlinkIfExists(file);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

function writeJsonExclusive(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function unlinkIfExists(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (isDirectEntry(process.argv[1], import.meta.url)) {
  runArkiMuxCli().then((result) => {
    if (result.kind === "debug-stdio") process.exitCode = result.exitCode ?? 1;
    else console.log(result.message);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function isDirectEntry(argvEntry: string | undefined, moduleUrl: string): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return path.resolve(argvEntry) === path.resolve(fileURLToPath(moduleUrl));
  }
}
