import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileRunCatalogStore,
  FileRunPerformanceV2Store,
} from "@com-pyvue/agent-execution-core";
import { CodedWorkflowRegistry } from "../../apps/packages/run/api/src/index.ts";
import { RoleApiClient } from "../../apps/packages/role/contract/src/index.ts";
import { RunApiClient } from "../../apps/packages/run/contract/src/index.ts";
import {
  RunConfigurationDefinitionValidatorRegistry,
  type RunConfigurationDefinition,
} from "../../apps/packages/run-configuration/api/src/index.ts";
import { RunConfigurationApiClient } from "../../apps/packages/run-configuration/contract/src/index.ts";
import { UserApiClient } from "../../apps/packages/user/contract/src/index.ts";
import { createLocalFilesystemAgentExecutionApiHost } from "../../apps/hosts/api/src/index.ts";
import { bootstrapLocalOperator } from "../../apps/hosts/api/src/bootstrapLocalOperator.ts";
import { LocalFrameworkDiagnostics } from "../../local/src/localFrameworkDiagnostics.ts";

const timestamp = "2026-08-05T12:00:00.000Z";
const hash = "a".repeat(64);

describe("local filesystem Run API host", () => {
  it("compares persisted V3 Codex/Pi runs through configured adapters", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "run-api-filesystem-"));
    const repositoryRoot = path.join(root, "repository");
    const applicationConfigurationRoot = path.join(root, "application-hosts");
    const platformConfigurationRoot = path.join(root, "platform-configurations");
    const runsRoot = path.join(repositoryRoot, "runs");
    await Promise.all([
      mkdir(applicationConfigurationRoot, { recursive: true }),
      mkdir(platformConfigurationRoot, { recursive: true }),
      mkdir(runsRoot, { recursive: true }),
    ]);
    await writeJson(path.join(applicationConfigurationRoot, "local-filesystem-apps-v1.json"), {
      schemaVersion: 1,
      configurationId: "local-filesystem-apps-v1",
      platformConfigurationId: "local-platform-v3",
      http: { allowedBrowserOrigins: ["http://localhost:5173"] },
      authentication: {
        adapterId: "local-fixed-identity@1",
        options: { providerId: "local-cli", subjectIdEnvironmentVariable: "FIXTURE_SUBJECT" },
      },
      runDispatch: { adapterId: "local-workflow-dispatch@1", options: {} },
      queryStores: {
        runCatalog: { adapterId: "file-run-catalog@1", options: { outputRoot: runsRoot } },
        runArtifacts: { adapterId: "file-run-artifacts-query@1", options: {} },
        publishedResults: { adapterId: "file-published-results-query@1", options: {} },
        runPerformance: { adapterId: "file-run-performance-query@1", options: {} },
      },
    });
    await writeJson(path.join(platformConfigurationRoot, "local-platform-v3.json"), {
      schemaVersion: 3,
      configurationId: "local-platform-v3",
      stores: {
        users: { adapterId: "file-users@1", options: { root: ".access", relativeTo: "repository" } },
        roles: { adapterId: "file-roles@1", options: { root: ".access", relativeTo: "repository" } },
        roleAssignments: { adapterId: "file-role-assignments@1", options: { root: ".access", relativeTo: "repository" } },
        agentTemplates: { adapterId: "file-agent-templates@1", options: { root: "agent-templates", relativeTo: "configuration" } },
        workflowRunConfigurations: { adapterId: "file-workflow-run-configurations@1", options: { root: "workflow-run-configurations", relativeTo: "configuration" } },
        organizations: { adapterId: "file-organizations@1", options: { root: ".control", relativeTo: "repository" } },
        environments: { adapterId: "file-environments@1", options: { root: ".control", relativeTo: "repository" } },
        workflowReleases: { adapterId: "file-workflow-releases@1", options: { root: ".control", relativeTo: "repository" } },
        workflowDeployments: { adapterId: "file-workflow-deployments@1", options: { root: ".control", relativeTo: "repository" } },
        deploymentHealth: { adapterId: "file-deployment-health@1", options: { root: ".control", relativeTo: "repository" } },
        meterRecords: { adapterId: "file-meter-records@1", options: { root: ".control", relativeTo: "repository" } },
        runProjections: { adapterId: "file-run-projections@1", options: { root: ".control", relativeTo: "repository" } },
      },
    });
    await writeJson(path.join(platformConfigurationRoot, "workflow-run-configurations", "fixture.workflow", "1", "fixture-v1", "definition.json"), {
      configurationId: "fixture-v1",
      workflow: { kind: "fixture.workflow", version: 1 },
    });
    await expect(bootstrapLocalOperator([
      "--repository-root", repositoryRoot,
      "--application-configuration-root", applicationConfigurationRoot,
      "--platform-configuration-directory", platformConfigurationRoot,
      "--platform-store-configuration-root", platformConfigurationRoot,
      "--application-configuration-id", "local-filesystem-apps-v1",
      "--subject-id", "owner-subject",
      "--user-id", "owner",
      "--role-id", "runner",
      "--permission", "runs:read-own",
      "--permission", "roles:admin",
      "--permission", "agent-templates:admin",
      "--permission", "workflow:fixture.workflow:configure",
      "--permission", "users:admin",
      "--permission", "workflow:fixture.workflow:start",
    ], root, { FIXTURE_SUBJECT: "owner-subject" })).resolves.toContain("owner");
    await writePersistedRun(
      runsRoot,
      "run-v3-codex",
      "codex-cli",
      "gpt-5.6-luna",
      1_000,
    );
    await writePersistedRun(runsRoot, "run-v3-pi", "pi-cli", "gpt-5.3-codex-spark", 600);
    const runConfigurationValidators = new RunConfigurationDefinitionValidatorRegistry([{
      workflow: { kind: "fixture.workflow", version: 1 },
      validate: validateFixtureRunConfiguration,
    }]);
    const host = await createLocalFilesystemAgentExecutionApiHost({
      repositoryRoot,
      applicationConfigurationRoot,
      platformConfigurationDirectory: platformConfigurationRoot,
      platformStoreConfigurationRoot: platformConfigurationRoot,
      applicationConfigurationId: "local-filesystem-apps-v1",
      workflows: new CodedWorkflowRegistry(),
      runConfigurationValidators,
      environment: { FIXTURE_SUBJECT: "owner-subject" },
    });
    const registrationHost = await createLocalFilesystemAgentExecutionApiHost({
      repositoryRoot,
      applicationConfigurationRoot,
      platformConfigurationDirectory: platformConfigurationRoot,
      platformStoreConfigurationRoot: platformConfigurationRoot,
      applicationConfigurationId: "local-filesystem-apps-v1",
      workflows: new CodedWorkflowRegistry(),
      runConfigurationValidators,
      environment: { FIXTURE_SUBJECT: "new-user-subject" },
    });
    await expect(bootstrapLocalOperator([
      "--repository-root", repositoryRoot,
      "--application-configuration-root", applicationConfigurationRoot,
      "--platform-configuration-directory", platformConfigurationRoot,
      "--platform-store-configuration-root", platformConfigurationRoot,
      "--application-configuration-id", "local-filesystem-apps-v1",
      "--subject-id", "observer-subject",
      "--user-id", "portal-observer",
      "--role-id", "agent-execution-run-observer-v1",
    ], root, { FIXTURE_SUBJECT: "observer-subject" })).resolves.toContain("portal-observer");
    const observerHost = await createLocalFilesystemAgentExecutionApiHost({
      repositoryRoot,
      applicationConfigurationRoot,
      platformConfigurationDirectory: platformConfigurationRoot,
      platformStoreConfigurationRoot: platformConfigurationRoot,
      applicationConfigurationId: "local-filesystem-apps-v1",
      workflows: new CodedWorkflowRegistry(),
      runConfigurationValidators,
      environment: { FIXTURE_SUBJECT: "observer-subject" },
    });
    const diagnostics = new LocalFrameworkDiagnostics({ projectRoot: repositoryRoot });
    const workflowDevelopmentHost = await createLocalFilesystemAgentExecutionApiHost({
      localFrameworkDiagnostics: diagnostics,
      repositoryRoot,
      applicationConfigurationRoot,
      platformConfigurationDirectory: platformConfigurationRoot,
      platformStoreConfigurationRoot: platformConfigurationRoot,
      applicationConfigurationId: "local-filesystem-apps-v1",
      workflows: new CodedWorkflowRegistry(),
      runConfigurationValidators,
      environment: {
        FIXTURE_SUBJECT: "observer-subject",
        AGENT_EXECUTION_UI_PROFILE: "workflow-development",
      },
    });
    await expect((await workflowDevelopmentHost.request("http://api.test/api/v1/ui-configuration")).json()).resolves.toEqual({
      schemaVersion: 1,
      profile: "workflow-development",
      features: ["runs", "agent-authentication", "agent-templates", "workflows"],
    });
    expect((await workflowDevelopmentHost.request("http://api.test/api/v1/users")).status).toBe(404);
    expect((await workflowDevelopmentHost.request("http://api.test/api/v1/runs")).status).toBe(200);
    // Exercise the real class through composition, not a plain object mock.
    const diagnosticsUrl = "http://api.test/api/v1/local/diagnostics";
    expect(await (await workflowDevelopmentHost.request(diagnosticsUrl)).json()).toEqual({ items: [] });
    const diagnosticInput = { arkimuxVersion: "0.1.0", component: "local-server" as const,
      operation: "resource-cleanup", errorCode: "resource-cleanup-failed", retryable: true, error: new Error("fixture cleanup failure") };
    const diagnostic = await diagnostics.record(diagnosticInput);
    expect(await (await workflowDevelopmentHost.request(diagnosticsUrl)).json()).toMatchObject({ items: [{ diagnosticId: diagnostic.diagnosticId }] });
    expect(await (await workflowDevelopmentHost.request(`${diagnosticsUrl}/${diagnostic.diagnosticId}`)).json()).toEqual(diagnostic);
    expect((await workflowDevelopmentHost.request(`${diagnosticsUrl}/${diagnostic.diagnosticId}`, { method: "DELETE" })).status).toBe(204);
    expect(await diagnostics.list()).toEqual([]);
    await diagnostics.record(diagnosticInput);
    expect((await workflowDevelopmentHost.request(diagnosticsUrl, { method: "DELETE" })).status).toBe(204);
    expect(await diagnostics.list()).toEqual([]);
    const registrationClient = new UserApiClient({
      baseUrl: "http://api.test",
      fetch: (input, init) => registrationHost.request(input, init),
    });
    await expect(registrationClient.registerCurrentUser({ requestedUserId: "new-user" })).resolves.toMatchObject({
      user: { userId: "new-user", identity: { providerId: "local-cli", subjectId: "new-user-subject" } },
    });
    expect((await new FileRunCatalogStore(runsRoot).list({ userId: "owner" })).items).toHaveLength(2);
    expect(await new FileRunPerformanceV2Store(
      path.join(runsRoot, "abcdef123", "run-v3-codex", "state"),
      { executionId: "run-v3-codex" },
    ).get({ executionId: "run-v3-codex" })).toMatchObject({ totalElapsedMs: 1_000 });

    const runs = new RunApiClient({
      baseUrl: "http://api.test",
      fetch: (input, init) => host.request(input, init),
    });
    await expect(runs.listRuns()).resolves.toMatchObject({ items: expect.any(Array), pagination: {} });
    await expect(new RunApiClient({
      baseUrl: "http://api.test",
      fetch: (input, init) => observerHost.request(input, init),
    }).listRuns()).resolves.toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ actor: expect.objectContaining({ userId: "owner" }) }),
    ]) });
    await expect(runs.compareRuns({ executionIds: ["run-v3-codex", "run-v3-pi"] })).resolves.toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({ provider: "codex-cli", model: "gpt-5.6-luna", durationMs: 1_000 }),
        expect.objectContaining({ provider: "pi-cli", model: "gpt-5.3-codex-spark", durationMs: 600 }),
      ]),
    });

    const list = await host.request("http://api.test/api/v1/runs");
    const listed = await list.json() as { items?: unknown[]; error?: unknown };
    expect({ status: list.status, error: listed.error }).toEqual({ status: 200, error: undefined });
    expect(listed.items).toHaveLength(2);
    const comparison = await host.request("http://api.test/api/v1/run-comparisons", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ executionIds: ["run-v3-codex", "run-v3-pi"] }),
    });
    expect(comparison.status).toBe(200);
    expect(comparison.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const rows = (await comparison.json() as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "codex-cli", model: "gpt-5.6-luna", durationMs: 1_000 }),
      expect.objectContaining({ provider: "pi-cli", model: "gpt-5.3-codex-spark", durationMs: 600 }),
    ]));
    const users = new UserApiClient({
      baseUrl: "http://api.test",
      fetch: (input, init) => host.request(input, init),
    });
    await expect(users.registerCurrentUser({ requestedUserId: "owner" })).resolves.toMatchObject({
      user: { userId: "owner", identity: { providerId: "local-cli", subjectId: "owner-subject" } },
    });
    await expect(users.listUsers()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ userId: "new-user" }),
        expect.objectContaining({ userId: "owner" }),
      ]),
    });
    const roles = new RoleApiClient({
      baseUrl: "http://api.test",
      fetch: (input, init) => host.request(input, init),
    });
    await expect(roles.listRoles()).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ roleId: "agent-execution-run-observer-v1", permissions: ["runs:read-all"] }),
        expect.objectContaining({ roleId: "runner" }),
      ]),
    });
    await expect(roles.defineRole({
      roleId: "fixture-observer-v1",
      permissions: ["workflow:fixture.workflow:start", "runs:read-own", "runs:read-own"],
    })).resolves.toMatchObject({
      role: {
        roleId: "fixture-observer-v1",
        permissions: ["runs:read-own", "workflow:fixture.workflow:start"],
      },
    });
    await roles.assignRole({ userId: "new-user", roleId: "fixture-observer-v1" });
    await expect(roles.listAssignments({ userId: "new-user" })).resolves.toMatchObject({
      items: [{ userId: "new-user", roleId: "fixture-observer-v1" }],
    });
    await expect(roles.revokeRole("new-user", "fixture-observer-v1")).resolves.toMatchObject({ revoked: true });
    await expect(roles.revokeRole("new-user", "fixture-observer-v1")).resolves.toMatchObject({ revoked: false });
    await expect(roles.revokeRole("owner", "runner")).rejects.toMatchObject({ status: 409, code: "conflict" });
    const runConfigurations = new RunConfigurationApiClient({
      baseUrl: "http://api.test",
      fetch: (input, init) => host.request(input, init),
    });
    const workflow = { kind: "fixture.workflow", version: 1 } as const;
    await expect(runConfigurations.listDefinitions(workflow)).resolves.toMatchObject({
      items: [expect.objectContaining({ configurationId: "fixture-v1", contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) })],
    });
    await expect(runConfigurations.publishDefinition(workflow, {
      definition: { configurationId: "fixture-v2", workflow: { kind: "fixture.workflow", version: 1 } },
    })).resolves.toMatchObject({ definition: { configurationId: "fixture-v2" } });
    await expect(runConfigurations.compareDefinitions(workflow, { configurationIds: ["fixture-v1", "fixture-v2"] }))
      .resolves.toMatchObject({ items: [
        expect.objectContaining({ configurationId: "fixture-v1" }),
        expect.objectContaining({ configurationId: "fixture-v2" }),
      ] });
    await users.setUserStatus("new-user", { status: "disabled" });
    expect((await registrationHost.request("http://api.test/api/v1/runs")).status).toBe(403);
  });
});

async function writePersistedRun(
  root: string,
  executionId: string,
  providerId: string,
  model: string,
  elapsedMs: number,
) {
  const runRoot = path.join(root, "abcdef123", executionId);
  const state = path.join(runRoot, "state");
  await mkdir(state, { recursive: true });
  await Promise.all([
    writeJson(path.join(state, "run-manifest.json"), {
      schemaVersion: 3,
      runRef: { executionId },
      workflow: { kind: "fixture.workflow", version: 1 },
      createdAt: timestamp,
      actor: { userId: "owner", roleId: "runner" },
      runConfiguration: { configurationId: "fixture-v1", contentHash: hash },
    }),
    writeJson(path.join(state, "run-status.json"), { status: "complete", updatedAt: timestamp }),
    writeJson(path.join(state, "run-heartbeat.json"), {
      status: "complete",
      lastEventType: "run-completed",
      updatedAt: timestamp,
    }),
    writeJson(path.join(state, "run-config.resolved.json"), {
      schemaVersion: 3,
      configurationId: "fixture-v1",
      contentHash: hash,
      workflow: { kind: "fixture.workflow", version: 1 },
      agents: {
        discovery: {
          timeoutMs: 1_000,
          execution: { provider: providerId, authProvider: "fixture", parameters: { model, thinking: "high" } },
        },
      },
    }),
    writeJson(path.join(state, "performance.json"), performance(executionId, providerId, model, elapsedMs)),
  ]);
}

function validateFixtureRunConfiguration(
  value: unknown,
  expectedConfigurationId?: string,
): RunConfigurationDefinition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Fixture run configuration must be an object.");
  }
  const candidate = value as Record<string, unknown>;
  const workflow = candidate.workflow as Record<string, unknown> | undefined;
  if (
    typeof candidate.configurationId !== "string"
    || workflow?.kind !== "fixture.workflow"
    || workflow.version !== 1
    || Object.keys(candidate).some((key) => !["configurationId", "workflow"].includes(key))
  ) {
    throw new Error("Fixture run configuration is invalid.");
  }
  if (expectedConfigurationId !== undefined && candidate.configurationId !== expectedConfigurationId) {
    throw new Error(`Expected configuration ${expectedConfigurationId}.`);
  }
  return {
    configurationId: candidate.configurationId,
    workflow: { kind: "fixture.workflow", version: 1 },
  };
}

function performance(executionId: string, providerId: string, model: string, elapsedMs: number) {
  const completedAt = new Date(Date.parse(timestamp) + elapsedMs).toISOString();
  return {
    schemaVersion: 1,
    runRef: { executionId },
    workflow: { kind: "fixture.workflow", version: 1 },
    startedAt: timestamp,
    completedAt,
    totalElapsedMs: elapsedMs,
    stages: [{ stageId: "discovery", status: "complete", elapsedMs }],
    agentAttempts: [{
      stageId: "discovery",
      logicalAgentId: "discovery",
      metrics: {
        providerId,
        attempt: 1,
        model,
        reasoningEffort: "high",
        status: "complete",
        elapsedMs,
        artifacts: {
          eventsPath: "events.jsonl",
          stderrPath: "stderr.log",
          lastMessagePath: "last-message.txt",
          heartbeatPath: "heartbeat.json",
        },
        nativeToolCalls: 4,
        toolCallUnit: "guarded-repository-operation",
        repositorySearchCalls: 2,
      },
    }],
  };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
}
