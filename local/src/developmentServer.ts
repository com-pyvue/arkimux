/** Private package entry used by the ArkiMux CLI, not a project integration API. */
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { CodedWorkflowRegistry } from "../../apps/packages/run/api/src/index.ts";
import { RunConfigurationDefinitionValidatorRegistry } from "../../apps/packages/run-configuration/api/src/index.ts";
import { createLocalFilesystemAgentExecutionApiHost } from "../../apps/hosts/api/src/localFilesystemHost.ts";
import { startAgentExecutionApiServer } from "../../apps/hosts/api/src/server.ts";
import { mountLocalWebApplication } from "./staticWeb.ts";
import { mountLocalResultViews } from "./resultViews.ts";
import { recoverPortableWorkflows } from "./portableWorkflow.ts";
import { assertLegacyLocalStoreMigrated } from "./localStorePaths.ts";
import type { StartLocalWorkflowDevelopmentServerOptions } from "./index.ts";
import { createLocalRetainedServerRuntime, type RetainedServerAdmissionOptions } from "./localRetainedServerRuntime.ts";
import type { LocalDebugger } from "./localDebugger.ts";
import { LocalRegistryUnavailable, LocalWorkflowRegistryReload } from "./workflowRegistryReload.ts";
import { reconcileLocalWorkflowPermissions } from "../../apps/hosts/api/src/localOperatorBootstrap.ts";
import type { LocalWorkflowRegistration } from "./index.ts";
import { LocalEventTelemetry } from "./localEventTelemetry.ts";
import { LocalFrameworkDiagnostics } from "./localFrameworkDiagnostics.ts";
import { createLocalFrameworkErrorReporter } from "./localFrameworkErrorReporter.ts";
import { createBrowserDiagnosticReceiver } from "./localBrowserDiagnostics.ts";
import localPackage from "../package.json" with { type: "json" };
export { assertLocalWorkflowDeclarations } from "./workflowDeclarations.ts";

/** Created before project loading so startup failures use the same reporter. */
export function createLocalFrameworkReporting(options: { repositoryRoot: string; machineTelemetryRoot?: string; environment?: NodeJS.ProcessEnv }) {
  let reportInternal: ((error: unknown) => Promise<void>) | undefined;
  const telemetry = new LocalEventTelemetry({ projectRoot: options.repositoryRoot, machineRoot: options.machineTelemetryRoot,
    arkimuxVersion: localPackage.version, environment: options.environment,
    onInternalError: error => reportInternal?.(error) ?? Promise.resolve() });
  const diagnostics = new LocalFrameworkDiagnostics({ projectRoot: options.repositoryRoot });
  const reporter = createLocalFrameworkErrorReporter({ diagnostics, version: localPackage.version });
  reportInternal = error => reporter.report(error, "telemetry");
  return { telemetry, diagnostics, ...reporter };
}

/** Compose the existing Local API without starting recovery implicitly. The
 * process owner decides when recovery starts and awaits close during shutdown. */
export async function createLocalDevelopmentServer(options: StartLocalWorkflowDevelopmentServerOptions & {
  /** Private CLI integration only. Omitted by the existing public server wrapper. */
  retainedAdmission?: RetainedServerAdmissionOptions;
  /** Test-only isolation of OS-user telemetry state. */
  machineTelemetryRoot?: string;
  debuggerSession?: LocalDebugger;
  /** CLI-owned watched registry; omitted by the public server wrapper. */
  workflowReload?: boolean;
  registrySourceClose?(): Promise<void>;
  validateRegistryCandidate?(): Promise<void>;
  onWorkflowRoleChanged?(roleId: string): Promise<void>;
  frameworkReporting?: ReturnType<typeof createLocalFrameworkReporting>;
}) {
  let rendererClose: Promise<void> | undefined;
  const closeRenderers = () => rendererClose ??= Promise.resolve().then(() => options.resultViewSource?.close());
  let server: ReturnType<typeof startAgentExecutionApiServer> | undefined;
  let retained: Awaited<ReturnType<typeof createLocalRetainedServerRuntime>> | undefined;
  let reload: LocalWorkflowRegistryReload | undefined;
  let recoveryActive = false;
  const reporting = options.frameworkReporting ?? createLocalFrameworkReporting(options);
  const { telemetry: usageTelemetry, diagnostics: frameworkDiagnostics } = reporting;
  const usageSession = usageTelemetry;
  let usageFlushTimer: ReturnType<typeof setInterval> | undefined;
  let usageFlushPending = false;
  let resourcesClose: Promise<void> | undefined;
  const closeResources = () => resourcesClose ??= (async () => {
    reload?.stop();
    clearInterval(usageFlushTimer);
    await usageSession.stop().catch(error => reporting.report(error, "telemetry"));
    // Release candidate holds while storage is still open, after owned workers
    // finish/cancel. Hold releases do not delete persisted Run references.
    const closeRuntime = async () => {
      try {
        await options.registrySourceClose?.();
        if (reload) { await retained?.stopComputing(); await reload.close(); }
      } finally { await retained?.close(); }
    };
    const results = await Promise.allSettled([closeRuntime(), closeRenderers()]);
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map(r => r.reason);
    if (errors.length) {
      const error = errors.length === 1 ? errors[0] : new AggregateError(errors, "Local server resource cleanup failed.");
      await reporting.report(error, "resource-cleanup");
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Local server resource cleanup failed.");
  })();
  try {
    await assertLegacyLocalStoreMigrated(options.repositoryRoot);
    if (options.retainedAdmission) retained = await createLocalRetainedServerRuntime({
      projectRoot: options.repositoryRoot, workflows: options.workflows, admission: options.retainedAdmission,
      debuggerSession: options.debuggerSession,
      onRunSettled: event => usageSession.settled(event),
      onFrameworkError: reporting.report,
    });
    const workflows = retained?.workflows ?? options.workflows;
    let permissionStores: Parameters<typeof reconcileLocalWorkflowPermissions>[0] | undefined;
    if (options.workflowReload) reload = new LocalWorkflowRegistryReload({
      isIdle: () => !recoveryActive && (retained?.isIdle() ?? true),
      async reconcile(registrations) {
        try {
          if (!permissionStores) throw new Error("Local permission stores are unavailable.");
          await reconcileLocalWorkflowPermissions(permissionStores, registrations.map(w => w.workflow), options.onWorkflowRoleChanged);
        } catch (error) { await reporting.report(error, "registry"); throw error; }
      },
    });
    const packageRoot = path.dirname(fileURLToPath(import.meta.url));
    const hostname = options.hostname ?? "127.0.0.1";
    let localServerOrigin: string | undefined;
    const api = await createLocalFilesystemAgentExecutionApiHost({
      localServerOrigin: () => localServerOrigin,
      repositoryRoot: path.resolve(options.repositoryRoot),
      applicationConfigurationRoot: path.join(packageRoot, "config", "application-hosts"),
      platformConfigurationDirectory: path.join(packageRoot, "config", "platform-configurations"),
      platformStoreConfigurationRoot: path.join(packageRoot, "config"),
      workflows: reload?.workflows ?? new CodedWorkflowRegistry(workflows),
      inputRequests: retained?.inputRequests,
      corrections: retained?.corrections,
      runConfigurationValidators: reload?.validators ?? new RunConfigurationDefinitionValidatorRegistry(
        workflows.map(({ runConfigurationValidator }) => runConfigurationValidator),
      ),
      environment: { ...options.environment, AGENT_EXECUTION_LOCAL_SUBJECT: options.subjectId,
        AGENT_EXECUTION_UI_PROFILE: "workflow-development" },
      onBackgroundError: error => { void reporting.report(error, "background"); options.onBackgroundError?.(error); },
      onFrameworkError: reporting.report,
      localUsageTelemetry: {
        requestDeletion: () => usageTelemetry.requestDeletion(),
        status: async () => ({ ...await usageTelemetry.status(), localSessionId: await usageSession.currentId() }),
        async choose(choice) {
          const status = await usageTelemetry.choose(choice);
          return { ...status, localSessionId: await usageSession.currentId() };
        },
      },
      localSession: { begin: action => usageSession.begin(action),
        finish: (ticket, succeeded, executionId) => usageSession.finish(ticket, succeeded, executionId),
        fetched: executionId => usageSession.fetched(executionId) },
      localFrameworkDiagnostics: {
        list: () => frameworkDiagnostics.list(), get: id => frameworkDiagnostics.get(id),
        delete: id => frameworkDiagnostics.delete(id), clear: () => frameworkDiagnostics.clear(),
        receiveBrowser: createBrowserDiagnosticReceiver(reporting.report),
      },
      ...(reload ? { onPlatformStores: (stores: Parameters<typeof reconcileLocalWorkflowPermissions>[0]) => { permissionStores = stores; } } : {}),
    });
    const prepareCandidate = async (registrations: readonly LocalWorkflowRegistration[], admission: RetainedServerAdmissionOptions) => {
      if (!reload || !retained) throw new Error("Workflow reload is not enabled.");
      const prepared = await retained.prepareCandidate(registrations, admission);
      try { return reload.prepareCandidate(prepared); }
      catch (error) { await prepared.release(); throw error; }
    };
    if (reload) {
      const initial = await prepareCandidate(options.workflows, options.retainedAdmission!);
      initial.validate = options.validateRegistryCandidate;
      await reload.activateCandidate(initial);
    }
    const app = reload ? new Hono() : api;
    if (reload) {
      app.onError(async (error, context) => {
        await reporting.report(error, "api");
        return context.json({ error: { code: "internal-error", message: "The request could not be completed. Please try again." } }, 500);
      });
      app.get("/arkimux/workflow-registry", c => c.json(reload!.status()));
      app.use("/api/*", async (c, next) => {
        try { await reload!.withRequest(next); }
        catch (error) {
          if (!(error instanceof LocalRegistryUnavailable)) throw error;
          return c.json({ error: { code: "service-unavailable", message: error.message } }, 503);
        }
      });
      app.route("/", api);
    }
    mountLocalResultViews(app, options.resultViews ?? [], options.resultViewSource);
    mountLocalWebApplication(app, path.join(packageRoot, "web"));
    server = startAgentExecutionApiServer({ app, hostname, port: options.port ?? 8787 });
    server.once("close", () => { void closeResources().catch((error: Error) => options.onBackgroundError?.(error)); });
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local server has no TCP address.");
    localServerOrigin = `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${address.port}`;
    const listeningServer = server;
    await usageTelemetry.start().catch(error => reporting.report(error, "telemetry"));
    usageFlushTimer = setInterval(() => {
      if (usageFlushPending) return;
      usageFlushPending = true;
      void usageTelemetry.flush().catch(error => reporting.report(error, "telemetry")).finally(() => { usageFlushPending = false; });
    }, 5_000);
    usageFlushTimer.unref();
    let closing: Promise<void> | undefined;
    let recovery: Promise<void> | undefined;
    return {
      server: listeningServer,
      url: `http://${hostname}:${address.port}`,
      workflowReload: reload ? {
        prepareCandidate,
        activateCandidate: reload.activateCandidate.bind(reload),
        validating: reload.validating.bind(reload),
        failed: reload.failed.bind(reload),
        status: reload.status.bind(reload),
      } : undefined,
      recover(): Promise<void> {
        if (closing) return Promise.reject(new Error("Local server is closing."));
        if (!retained) return recovery ??= recoverPortableWorkflows(options.workflows).catch(async error => { await reporting.report(error, "recovery"); throw error; });
        return recovery ??= (async () => {
          recoveryActive = true;
          // Legacy recovery must never substitute current source for a retained Run.
          const skip = await retained?.retainedRunIds();
          if (closing) return;
          try { await Promise.all([retained?.recover(), recoverPortableWorkflows(options.workflows, skip)]); }
          finally { recoveryActive = false; }
        })().catch(async error => { await reporting.report(error, "recovery"); throw error; });
      },
      close(): Promise<void> {
        return closing ??= (async () => {
          const listenerClosed = new Promise<void>((resolve, reject) => listeningServer.close(error => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else resolve();
          }));
          // Abort admissions before waiting for their HTTP requests to finish.
          const results = await Promise.allSettled([listenerClosed, closeResources()]);
          const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map(r => r.reason);
          if (errors.length === 1) throw errors[0];
          if (errors.length) throw new AggregateError(errors, "Local server shutdown failed.");
        })();
      },
    };
  } catch (error) {
    await reporting.report(error, "startup");
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    try { await closeResources(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Local server startup and resource cleanup failed."); }
    throw error;
  }
}
