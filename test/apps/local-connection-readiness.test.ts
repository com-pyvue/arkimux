import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentExecutionPreflightResult,
  AgentExecutionProvider,
  TrustedRunCommand,
  WorkflowRunConfigurationStore,
} from "@com-pyvue/agent-execution-core";
import { FileRunStateV3Store } from "@com-pyvue/agent-execution-core";
import type { AuthorizedApplicationPrincipal } from "../../apps/packages/application-host/src/index.ts";
import {
  CodedWorkflowRegistry,
  RunApplicationService,
  createRunRouter,
  type CodedWorkflowRegistration,
  type GenericRunConfiguration,
} from "../../apps/packages/run/api/src/index.ts";
import { RunApiClient } from "../../apps/packages/run/contract/src/index.ts";
import { agentExecutionUiConfiguration } from "../../apps/packages/ui-profile/contract/src/index.ts";
import { createAgentExecutionApiHost } from "../../apps/hosts/api/src/apiHost.ts";
import { resolveLocalFileStorePaths } from "../../local/src/localStorePaths.ts";
import { createDecisionBriefLocalRegistration } from "../fixtures/local-v1-scaffold/workflows/decision-brief/src/local-registration.ts";

// Exercise the real registration, reservation, and execution checks without
// reading a developer's credentials or invoking a real provider CLI.
const fakeProvider = vi.hoisted(() => ({
  providerId: "codex-cli",
  preflight: vi.fn<AgentExecutionProvider["preflight"]>(),
  run: vi.fn<AgentExecutionProvider["run"]>(),
}));

vi.mock("@com-pyvue/agent-execution-core", async () => {
  const core = await import("@com-pyvue/agent-execution-core");
  return {
    ...core,
    createAgentProviderConfigProvider: (options: Parameters<typeof core.createAgentProviderConfigProvider>[0]) =>
      core.createAgentProviderConfigProvider({ ...options, environment: {} }),
    createAgentExecutionProviderRegistry: () => ({
      get(providerId: string) {
        if (providerId !== fakeProvider.providerId) throw new Error(`Unexpected fixture provider ${providerId}.`);
        return fakeProvider;
      },
    }),
  };
});

vi.mock("@com-pyvue/agent-execution-local", async () => ({
  ...await import("../../local/src/localStorePaths.ts"),
  createLocalAgentAuthProviderRegistry: async () => ({
    get() { throw new Error("The fake provider must not access real authentication providers."); },
  }),
}));

const temporaryRoots: string[] = [];
const scaffoldRoot = fileURLToPath(new URL("../fixtures/local-v1-scaffold/", import.meta.url));
const workflow = { kind: "decision-brief", version: 1 };
const runConfigurationId = "decision-brief-codex-native-v1";
const preflightRequest = { workflow, roleId: "local-developer", runConfigurationId };
const input = {
  schemaVersion: 1,
  decision: "Choose a runtime",
  constraints: ["Preserve the public result contract"],
  evidence: ["The project UI is available before provider login"],
};
const submitRequest = { ...preflightRequest, input, requestedExecutionId: "connection-readiness-run" };
const permissions = ["runs:read-own", "workflow:decision-brief:start"];
const principal: AuthorizedApplicationPrincipal = {
  user: {
    schemaVersion: 1,
    userId: "local-user",
    status: "active",
    identity: { providerId: "local-cli", subjectId: "local-subject" },
    registeredAt: "2026-09-03T00:00:00.000Z",
  },
  roles: [{ schemaVersion: 1, roleId: "local-developer", permissions }],
  permissions,
};

afterEach(async () => {
  fakeProvider.preflight.mockReset();
  fakeProvider.run.mockReset();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function readiness(reason?: "provider-unavailable" | "session-missing"): AgentExecutionPreflightResult {
  const message = reason === "provider-unavailable"
    ? "Codex CLI is unavailable. Install the configured provider before running."
    : reason === "session-missing"
      ? "Codex login is missing. Log in, then retry the run."
      : undefined;
  return {
    providerId: "codex-cli",
    available: reason === undefined,
    auth: {
      authProviderId: "codex-native-session",
      kind: "runtime-native",
      available: reason === undefined,
      status: reason === undefined ? "ready" : "unavailable",
      ...(reason === undefined ? {} : { reason }),
      ...(reason === "session-missing" ? { remediation: [{ kind: "login", label: "Log in to Codex" }] } : {}),
    },
    ...(message === undefined ? {} : { message }),
  };
}

async function fixture(connectionPreflight?: (configuration: GenericRunConfiguration) => Promise<{ available: boolean; agents: Array<{ slotId: string; providerId: string; authProviderId: string; available: boolean; message?: string }> }>) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "arkimux-connection-readiness-"));
  temporaryRoots.push(repositoryRoot);
  for (const relative of [
    "workflows/decision-brief/fixtures/example-input.json",
    "config/agent-providers.default.json",
  ]) {
    const destination = path.join(repositoryRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    const sourceRoot = relative.startsWith("config/") ? fileURLToPath(new URL("../../cli/scaffold/", import.meta.url)) : scaffoldRoot;
    await writeFile(destination, await readFile(path.join(sourceRoot, relative)));
  }
  const configuration = JSON.parse(await readFile(path.join(
    scaffoldRoot,
    "workflows/decision-brief/run-configurations/codex-native-v1.json",
  ), "utf8")) as GenericRunConfiguration;
  const resolvedConfiguration = { configuration, contentHash: "a".repeat(64) };
  const registration = await createDecisionBriefLocalRegistration(repositoryRoot);
  const reserve = vi.spyOn(registration, "reserve");
  const execute = vi.spyOn(registration, "execute");
  const workflows = new CodedWorkflowRegistry([registration as CodedWorkflowRegistration]);
  const commands: TrustedRunCommand<unknown>[] = [];
  const dispatch = vi.fn(async (command: TrustedRunCommand<unknown>) => { commands.push(command); });
  const runConfigurations: WorkflowRunConfigurationStore<GenericRunConfiguration> = {
    publish: async () => resolvedConfiguration,
    resolve: async () => resolvedConfiguration,
    lifecycleStatus: async () => "active",
    archive: async () => undefined,
    restore: async () => undefined,
    list: async () => ({ items: [resolvedConfiguration] }),
  };
  const unusedQueries = {
    open: async (): Promise<never> => { throw new Error("Readiness must not open a run-scoped query store."); },
  };
  const service = new RunApplicationService({
    catalog: {
      get: async () => undefined,
      list: async () => ({ items: [] }),
      archive: async () => undefined,
      restore: async () => undefined,
    },
    artifacts: unusedQueries,
    results: unusedQueries,
    performance: unusedQueries,
    runConfigurations,
    dispatcher: { dispatch },
    workflows,
    connectionPreflight,
  });
  const host = createAgentExecutionApiHost({
    runRouter: createRunRouter({ service, authenticate: async () => principal }),
    uiConfiguration: agentExecutionUiConfiguration("workflow-development"),
    allowedBrowserOrigins: [],
  });
  const client = new RunApiClient({
    baseUrl: "http://local-readiness.test",
    fetch: async (request, init) => host.request(request, init),
  });
  return { repositoryRoot, client, host, reserve, execute, dispatch, commands, workflows };
}

it("blocks a stale Connection at the API before probing, reserving, or dispatching a run", async () => {
  const test = await fixture(async () => ({ available: false, agents: [{ slotId: "decision-author", providerId: "codex-cli", authProviderId: "archived-connection", available: false, message: "Connection is archived. Choose an active Connection in a new Run Configuration." }] }));
  const preflight = await test.host.request("/api/v1/workflows/preflight", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(preflightRequest) });
  expect(preflight.status).toBe(200);
  expect(await preflight.json()).toMatchObject({ available: false, agents: [{ available: false }] });
  // The public client's submit path must enforce the same check, not just the UI probe.
  const response = await test.host.request("/api/v1/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submitRequest) });
  expect(response.status).toBe(503);
  expect(await response.text()).toContain("Choose an active Connection");
  expect(fakeProvider.preflight).not.toHaveBeenCalled();
  expect(test.reserve).not.toHaveBeenCalled();
  expect(test.dispatch).not.toHaveBeenCalled();
});

async function expectNoRunStarted(test: Awaited<ReturnType<typeof fixture>>) {
  expect(test.reserve).not.toHaveBeenCalled();
  expect(test.dispatch).not.toHaveBeenCalled();
  expect(test.execute).not.toHaveBeenCalled();
  expect(fakeProvider.run).not.toHaveBeenCalled();
  await expect(access(resolveLocalFileStorePaths(test.repositoryRoot).runs)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("Local UI connection and provider run readiness are separate", () => {
  it.each(["provider-unavailable", "session-missing"] as const)(
    "serves the project API but blocks %s before reservation, dispatch, or provider.run",
    async (reason) => {
      fakeProvider.preflight.mockResolvedValue(readiness(reason));
      const test = await fixture();

      const ui = await test.host.request("http://local-readiness.test/api/v1/ui-configuration");
      expect(ui.status).toBe(200);
      await expect(ui.json()).resolves.toMatchObject({ profile: "workflow-development" });
      await expect(test.client.listWorkflows()).resolves.toMatchObject({
        items: [expect.objectContaining({ workflow, allowedRoleIds: ["local-developer"] })],
      });
      await expect(test.client.listRuns()).resolves.toMatchObject({ items: [] });
      expect(fakeProvider.preflight).not.toHaveBeenCalled();

      await expect(test.client.preflightWorkflow(preflightRequest)).resolves.toMatchObject({
        available: false,
        agents: [{ slotId: "decision-author", providerId: "codex-cli", available: false, reason }],
      });
      await expect(test.client.submitRun(submitRequest)).rejects.toMatchObject({
        status: 503,
        code: "provider-unavailable",
        message: expect.stringContaining(readiness(reason).message!),
      });
      expect(fakeProvider.preflight).toHaveBeenCalledTimes(2);
      await expectNoRunStarted(test);
    },
  );

  it("rechecks provider readiness at submit after an earlier successful UI preflight", async () => {
    fakeProvider.preflight.mockResolvedValueOnce(readiness()).mockResolvedValue(readiness("session-missing"));
    const test = await fixture();
    await expect(test.client.preflightWorkflow(preflightRequest)).resolves.toMatchObject({ available: true });

    await expect(test.client.submitRun(submitRequest)).rejects.toMatchObject({ status: 503, code: "provider-unavailable" });

    expect(fakeProvider.preflight).toHaveBeenCalledTimes(2);
    await expectNoRunStarted(test);
  });

  it("allows the same run request to retry after login without a stale readiness result or reservation", async () => {
    fakeProvider.preflight.mockResolvedValueOnce(readiness("session-missing")).mockResolvedValue(readiness());
    const test = await fixture();
    await expect(test.client.submitRun(submitRequest)).rejects.toMatchObject({ status: 503, code: "provider-unavailable" });
    await expectNoRunStarted(test);

    await expect(test.client.submitRun(submitRequest)).resolves.toEqual({
      runRef: { executionId: submitRequest.requestedExecutionId },
    });

    expect(fakeProvider.preflight).toHaveBeenCalledTimes(2);
    expect(test.reserve).toHaveBeenCalledTimes(1);
    expect(test.dispatch).toHaveBeenCalledTimes(1);
    expect(test.commands[0]).toMatchObject({
      workflow,
      actor: { userId: "local-user", roleId: "local-developer" },
      runRef: { executionId: submitRequest.requestedExecutionId },
    });
    expect(test.execute).not.toHaveBeenCalled();
    expect(fakeProvider.run).not.toHaveBeenCalled();
  });

  it("rechecks login at execution and records failure without provider.run if login expires after dispatch", async () => {
    fakeProvider.preflight.mockResolvedValueOnce(readiness()).mockResolvedValue(readiness("session-missing"));
    const test = await fixture();
    await test.client.submitRun(submitRequest);
    expect(test.reserve).toHaveBeenCalledTimes(1);
    expect(test.dispatch).toHaveBeenCalledTimes(1);

    await expect(test.workflows.execute(test.commands[0]!)).rejects.toThrow("Codex login is missing");

    expect(fakeProvider.preflight).toHaveBeenCalledTimes(2);
    expect(test.execute).toHaveBeenCalledTimes(1);
    expect(fakeProvider.run).not.toHaveBeenCalled();
    const paths = resolveLocalFileStorePaths(test.repositoryRoot);
    const state = new FileRunStateV3Store({
      root: path.join(paths.runs, workflow.kind, submitRequest.requestedExecutionId, "state"),
      reservationRoot: paths.reservations,
      runRef: { executionId: submitRequest.requestedExecutionId },
    });
    await expect(state.get()).resolves.toMatchObject({
      status: { status: "failed", message: expect.stringContaining("Codex login is missing") },
    });
  });
});
