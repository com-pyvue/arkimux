/** Private CLI process entry. Never generated into a developer project. */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createProjectResultViewSource } from "./projectRendererReload.ts";
import { createProjectWorkflowRegistrySource } from "./projectWorkflowReload.ts";
import { updateLocalRegistryRole, waitForLocalRegistryRecordUrl } from "./localRegistryProcessRecord.ts";
import type { createLocalDevelopmentServer } from "../../local/src/developmentServer.ts";
import { captureLocalDebugger, debuggerEnvironmentNames, withoutDebuggerEnvironment } from "../../local/src/localDebugger.ts";

const repositoryRoot = process.cwd();
const port = Number(option("--port") ?? "8787");
const token = requiredProcessToken();
if (!process.send || !process.connected) throw new Error("The local server must be started by arkimux local start.");
const projectRoot = await realpath(repositoryRoot);
if (option("--project-root") !== projectRoot || option("--process-token") !== token) {
  throw new Error("The local server command does not match its project and startup token.");
}
const expectedUrl = `http://127.0.0.1:${port}`;
await waitForStartAuthorization({ token, pid: process.pid, projectRoot, url: expectedUrl });
const debuggerSession = process.argv.includes("--debug-session") ? captureLocalDebugger(process.env) : undefined;
// IDE hooks were loaded at process startup. Keep their current child attachment
// identity privately; never let workflow/provider subprocesses inherit them.
if (debuggerSession) for (const name of debuggerEnvironmentNames) delete process.env[name];
let parentDisconnected = false;
let activeServer: Awaited<ReturnType<typeof createLocalDevelopmentServer>> | undefined;
let frameworkReporting: ReturnType<typeof import("../../local/src/developmentServer.ts").createLocalFrameworkReporting> | undefined;
let registrySource: Awaited<ReturnType<typeof createProjectWorkflowRegistrySource>> | undefined;
let stopping = false;
const reportError = (error: unknown) => {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
};
const close = () => {
  stopping = true;
  void activeServer?.close().catch(reportError).finally(() => {
    process.off("uncaughtExceptionMonitor", monitorFatal);
    if (process.connected) process.disconnect();
  });
};
const monitorFatal = (error: Error) => frameworkReporting?.reportFatal(error);
const closeIfParentDisconnects = () => {
  if (stopping) return;
  parentDisconnected = true;
  if (!debuggerSession) process.exitCode = 1;
  close();
};
process.once("disconnect", closeIfParentDisconnects);
process.once("SIGINT", close);
process.once("SIGTERM", close);
try {
  // Resolve from this project, not the CLI's install location. The private Local
  // entry shares its module state with the project's public Local factory.
  const { createLocalDevelopmentServer, assertLocalWorkflowDeclarations, createLocalFrameworkReporting } = await import(
    pathToFileURL(path.join(projectRoot, "node_modules/@com-pyvue/agent-execution-local/dist/development-server.js")).href
  ) as typeof import("../../local/src/developmentServer.ts");
  frameworkReporting = createLocalFrameworkReporting({ repositoryRoot: projectRoot, environment: withoutDebuggerEnvironment(process.env) });
  process.on("uncaughtExceptionMonitor", monitorFatal);
  registrySource = await createProjectWorkflowRegistrySource(projectRoot, assertLocalWorkflowDeclarations, frameworkReporting.report);
  const loaded = await registrySource.load();
  // Renderer load failures must not prevent the API or generic JSON view from starting.
  const resultViewSource = await createProjectResultViewSource(repositoryRoot).catch(async error => {
    await frameworkReporting?.report(error, "registry");
    console.warn("Workflow result reload could not start. Original JSON results remain available.");
    return undefined;
  });
  if (stopping || !process.connected) {
    await resultViewSource?.close();
    throw new Error("The local server was stopped during project preparation.");
  }
  activeServer = await createLocalDevelopmentServer({
    repositoryRoot,
    frameworkReporting,
    subjectId: "local-developer",
    workflows: loaded.workflows,
    resultViewSource,
    port,
    environment: withoutDebuggerEnvironment(process.env),
    debuggerSession,
    retainedAdmission: loaded.admission,
    workflowReload: true,
    validateRegistryCandidate: loaded.assertCurrent,
    onWorkflowRoleChanged: roleId => updateLocalRegistryRole({ projectRoot, pid: process.pid, token }, roleId),
    registrySourceClose: () => registrySource!.close(),
    onBackgroundError: (error) => console.error(error.stack ?? error.message),
  });
  if (parentDisconnected || stopping) {
    throw new Error("The local server was stopped before it proved readiness.");
  }
  const { url } = activeServer;
  await sendReady({
    kind: "arkimux-local-ready",
    token,
    pid: process.pid,
    projectRoot,
    url,
  });
  if (!debuggerSession) {
    process.off("disconnect", closeIfParentDisconnects);
    if (process.connected) process.disconnect();
  }
  console.log(JSON.stringify({ kind: "arkimux-local-ready", token, url, pid: process.pid, projectRoot }));
  if (port === 0) await waitForLocalRegistryRecordUrl({ projectRoot, pid: process.pid, token }, url, () => stopping);
  registrySource.watch(activeServer.workflowReload!);
  // Recovery is platform-owned background work; provider login is not a startup
  // requirement. Rejections are observed instead of disappearing from startup.
  void activeServer.recover().catch((error: Error) => console.error(error.stack ?? error.message));
} catch (error) {
  await frameworkReporting?.report(error, "startup");
  await activeServer?.close().catch(reportError);
  await registrySource?.close().catch(reportError);
  if (process.connected) process.disconnect();
  process.off("disconnect", closeIfParentDisconnects);
  process.off("SIGINT", close);
  process.off("SIGTERM", close);
  process.off("uncaughtExceptionMonitor", monitorFatal);
  throw error;
}

async function sendReady(message: {
  kind: "arkimux-local-ready";
  token: string;
  pid: number;
  projectRoot: string;
  url: string;
}): Promise<void> {
  if (!process.send || !process.connected) {
    await activeServer?.close();
    throw new Error("The ArkiMux CLI disconnected before the local server proved readiness.");
  }
  await new Promise<void>((resolve, reject) => {
    process.send!(message, (error) => error ? reject(error) : resolve());
  }).catch(async (error) => {
    await activeServer?.close();
    throw error;
  });
}

async function waitForStartAuthorization(expected: {
  token: string;
  pid: number;
  projectRoot: string;
  url: string;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let requestInterval: ReturnType<typeof setInterval> | undefined;
    let authorizationTimeout: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (message: unknown) => {
      if (!isStartAuthorization(message)) return;
      if (message.token !== expected.token
        || message.pid !== expected.pid
        || message.projectRoot !== expected.projectRoot
        || message.url !== expected.url) {
        finish(new Error("The local start authorization does not match this process and project."));
        return;
      }
      finish();
    };
    const onDisconnect = () => finish(new Error("The ArkiMux CLI disconnected before local startup was authorized."));
    const onSignal = () => finish(new Error("The local server was stopped before startup was authorized."));
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearInterval(requestInterval);
      clearTimeout(authorizationTimeout);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (error) reject(error);
      else resolve();
    };
    const sendAuthorizationRequest = () => {
      if (settled) return;
      if (!process.send || !process.connected) {
        finish(new Error("The ArkiMux CLI disconnected before local startup was authorized."));
        return;
      }
      process.send({
        kind: "arkimux-local-awaiting-authorization",
        ...expected,
      }, (error) => {
        if (error) finish(new Error(`Could not request local startup authorization: ${error.message}`));
      });
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    requestInterval = setInterval(sendAuthorizationRequest, 100);
    authorizationTimeout = setTimeout(() => finish(new Error(
      "The ArkiMux CLI did not authorize local startup within 30 seconds.",
    )), 30_000);
    sendAuthorizationRequest();
  });
}

function isStartAuthorization(value: unknown): value is {
  kind: "arkimux-local-start-authorized";
  token: string;
  pid: number;
  projectRoot: string;
  url: string;
} {
  return Boolean(value)
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "arkimux-local-start-authorized";
}

function requiredProcessToken(): string {
  const value = process.env.ARKIMUX_LOCAL_PROCESS_TOKEN;
  if (!value || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("ARKIMUX_LOCAL_PROCESS_TOKEN must contain the startup token created by arkimux local start.");
  }
  return value;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}
