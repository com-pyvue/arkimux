import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FilePlatformConfigurationProvider,
  createFilePlatformStoreAdapterRegistry,
  type RunCatalogStore,
} from "@com-pyvue/agent-execution-core";
import {
  ApplicationBoundaryError,
  CanonicalV3FileRunCatalogStore,
  CanonicalV3FileRunLocator,
  DefaultApplicationAuthenticationAdapterRegistry,
  DefaultApplicationQueryAdapterRegistry,
  DefaultRunDispatchAdapterRegistry,
  FileApplicationHostConfigurationProvider,
  applicationHostConfigurationContentHash,
  authenticateApplicationRequest,
  composeApplicationHost,
  createFileApplicationQueryAdapterFactories,
  createLocalAuthenticationAdapterFactory,
  createLocalRunDispatchAdapterFactory,
  openAuthorizedRunStore,
  redactApplicationHostConfiguration,
  scopeRunCatalogQuery,
  validateApplicationHostConfiguration,
  type AgentExecutionApplicationHostConfiguration,
  type AuthorizedApplicationPrincipal,
} from "../../apps/packages/application-host/src/index.ts";
import {
  agentExecutionUiConfiguration,
  resolveAgentExecutionUiProfile,
  validateAgentExecutionUiConfiguration,
} from "../../apps/packages/ui-profile/contract/src/index.ts";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "application-host-"));
}

function applicationConfiguration(outputRoot = "runs"): AgentExecutionApplicationHostConfiguration {
  return {
    schemaVersion: 1,
    configurationId: "local-filesystem-apps-v1",
    platformConfigurationId: "local-platform-v1",
    http: { allowedBrowserOrigins: ["http://localhost:5173"] },
    authentication: {
      adapterId: "local-fixed-identity@1",
      options: {
        providerId: "local-cli",
        subjectIdEnvironmentVariable: "AGENT_EXECUTION_LOCAL_SUBJECT",
      },
    },
    runDispatch: { adapterId: "local-workflow-dispatch@1", options: {} },
    queryStores: {
      runCatalog: { adapterId: "file-run-catalog@1", options: { outputRoot } },
      runArtifacts: { adapterId: "file-run-artifacts-query@1", options: {} },
      publishedResults: { adapterId: "file-published-results-query@1", options: {} },
      runPerformance: { adapterId: "file-run-performance-query@1", options: {} },
    },
  };
}

describe("application-host configuration", () => {
  it("derives exact UI features from the selected runtime profile", () => {
    expect(agentExecutionUiConfiguration(resolveAgentExecutionUiProfile(undefined, "workflow-development"))).toEqual({
      schemaVersion: 1,
      profile: "workflow-development",
      features: ["runs", "agent-authentication", "agent-templates", "workflows"],
    });
    expect(agentExecutionUiConfiguration(resolveAgentExecutionUiProfile("platform", "workflow-development"))).toMatchObject({
      profile: "platform",
      features: expect.arrayContaining(["users", "organizations", "run-comparison"]),
    });
    expect(() => resolveAgentExecutionUiProfile("unknown", "platform")).toThrow();
    expect(() => validateAgentExecutionUiConfiguration({
      schemaVersion: 1,
      profile: "workflow-development",
      features: ["runs", "users"],
    })).toThrow("UI features do not match profile workflow-development.");
  });

  it("accepts exact origins, rejects loose documents, and redacts sensitive options", () => {
    const configuration = applicationConfiguration();
    expect(validateApplicationHostConfiguration(configuration)).toEqual(configuration);
    expect(() => validateApplicationHostConfiguration({
      ...configuration,
      http: { allowedBrowserOrigins: ["http://localhost:5173/path"] },
    })).toThrow(/exact HTTP\(S\) origin/);
    expect(() => validateApplicationHostConfiguration({ ...configuration, extra: true })).toThrow();
    const withSecret = structuredClone(configuration);
    withSecret.authentication.options.apiKey = "secret-value";
    expect(redactApplicationHostConfiguration(withSecret).authentication.options.apiKey).toBe("[redacted]");
    expect(applicationHostConfigurationContentHash(configuration)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a changed immutable configuration after first resolution", async () => {
    const root = await temporaryRoot();
    const configuration = applicationConfiguration();
    const file = path.join(root, `${configuration.configurationId}.json`);
    await writeFile(file, JSON.stringify(configuration), "utf8");
    const provider = new FileApplicationHostConfigurationProvider(root);
    await provider.resolve(configuration.configurationId, {});
    await writeFile(file, JSON.stringify({
      ...configuration,
      http: { allowedBrowserOrigins: ["http://localhost:4173"] },
    }), "utf8");
    await expect(provider.resolve(configuration.configurationId, {})).rejects.toThrow(/changed after process resolution/);
  });
});

describe("application-host composition", () => {
  it("queries a deduplicated V3-only corpus and prefers the first configured root", async () => {
    const repositoryRoot = await temporaryRoot();
    const nativeRoot = path.join(repositoryRoot, "native");
    const migratedRoot = path.join(repositoryRoot, "migrated");

    const writeRun = async (
      root: string,
      executionId: string,
      schemaVersion: 2 | 3,
      createdAt: string,
      marker: string,
    ) => {
      const runRoot = path.join(root, executionId);
      await mkdir(path.join(runRoot, "state"), { recursive: true });
      await writeFile(path.join(runRoot, "state", "run-manifest.json"), JSON.stringify({
        schemaVersion,
        runRef: { executionId },
        workflow: { kind: "fixture.workflow", version: 1 },
        createdAt,
        actor: { userId: "operator", roleId: "runner" },
        runConfiguration: { configurationId: "fixture-v1", contentHash: "a".repeat(64) },
      }), "utf8");
      await writeFile(path.join(runRoot, "marker.json"), JSON.stringify({ marker }), "utf8");
    };

    await writeRun(nativeRoot, "duplicate-run", 3, "2026-08-05T12:00:00.000Z", "native");
    await writeRun(migratedRoot, "duplicate-run", 3, "2026-08-05T12:00:00.000Z", "migrated");
    await writeRun(migratedRoot, "migrated-run", 3, "2026-08-04T12:00:00.000Z", "migrated-only");
    await writeRun(nativeRoot, "legacy-run", 2, "2026-08-06T12:00:00.000Z", "legacy");

    const locator = new CanonicalV3FileRunLocator([nativeRoot, migratedRoot]);
    expect((await locator.resolve({ executionId: "duplicate-run" }))?.sourceRoot).toBe(nativeRoot);
    expect(await locator.resolve({ executionId: "legacy-run" })).toBeUndefined();
    expect(await Promise.all([
      locator.resolve({ executionId: "duplicate-run" }),
      locator.resolve({ executionId: "migrated-run" }),
    ])).toEqual([
      expect.objectContaining({ runRef: { executionId: "duplicate-run" } }),
      expect.objectContaining({ runRef: { executionId: "migrated-run" } }),
    ]);

    const page = await new CanonicalV3FileRunCatalogStore(locator).list({ pageSize: 10 });
    expect(page.items.map(({ runRef }) => runRef.executionId)).toEqual([
      "duplicate-run",
      "migrated-run",
    ]);
  });

  it("preflights exact local adapters and exposes only query capabilities", async () => {
    const repositoryRoot = await temporaryRoot();
    const applicationConfigurationRoot = path.join(repositoryRoot, "application-configurations");
    const platformConfigurationRoot = path.join(repositoryRoot, "platform-root");
    const platformConfigurationDirectory = path.join(platformConfigurationRoot, "platform-configurations");
    const outputRoot = path.join(repositoryRoot, "runs");
    await Promise.all([
      mkdir(applicationConfigurationRoot, { recursive: true }),
      mkdir(platformConfigurationDirectory, { recursive: true }),
      mkdir(outputRoot, { recursive: true }),
    ]);
    const application = applicationConfiguration("runs");
    await writeFile(
      path.join(applicationConfigurationRoot, `${application.configurationId}.json`),
      JSON.stringify(application),
      "utf8",
    );
    await writeFile(
      path.join(platformConfigurationDirectory, "local-platform-v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        configurationId: "local-platform-v1",
        stores: Object.fromEntries([
          ["users", "file-users@1", ".access"],
          ["roles", "file-roles@1", ".access"],
          ["roleAssignments", "file-role-assignments@1", ".access"],
          ["runConfigurations", "file-run-configurations@1", ".run-configurations"],
        ].map(([role, adapterId, root]) => [role, {
          adapterId,
          options: { root, relativeTo: "repository" },
        }])),
      }),
      "utf8",
    );
    const executed: unknown[] = [];
    const host = await composeApplicationHost(application.configurationId, {
      applicationConfigurations: new FileApplicationHostConfigurationProvider(applicationConfigurationRoot),
      platformConfigurations: new FilePlatformConfigurationProvider({
        configurationDirectory: platformConfigurationDirectory,
      }),
      platformStoreAdapters: createFilePlatformStoreAdapterRegistry(),
      authenticationAdapters: new DefaultApplicationAuthenticationAdapterRegistry([
        createLocalAuthenticationAdapterFactory(),
      ]),
      runDispatchAdapters: new DefaultRunDispatchAdapterRegistry([
        createLocalRunDispatchAdapterFactory(),
      ]),
      queryAdapters: new DefaultApplicationQueryAdapterRegistry(createFileApplicationQueryAdapterFactories()),
      workflows: { execute: async (command) => { executed.push(command); } },
      repositoryRoot,
      applicationConfigurationRoot,
      platformConfigurationRoot,
      environment: { AGENT_EXECUTION_LOCAL_SUBJECT: "operator-subject" },
    });

    expect(await host.authentication.authenticate({ userId: "caller-cannot-select-this" })).toEqual({
      providerId: "local-cli",
      subjectId: "operator-subject",
    });
    expect((await host.queryStores.runCatalog.list({})).items).toEqual([]);

    const runRoot = path.join(outputRoot, "target", "run-01");
    await mkdir(path.join(runRoot, "state"), { recursive: true });
    await writeFile(path.join(runRoot, "state", "run-manifest.json"), JSON.stringify({
      schemaVersion: 3,
      runRef: { executionId: "run-01" },
      workflow: { kind: "fixture.workflow", version: 1 },
      createdAt: "2026-08-05T12:00:00.000Z",
      actor: { userId: "operator", roleId: "runner" },
      runConfiguration: { configurationId: "fixture-v1", contentHash: "a".repeat(64) },
    }), "utf8");
    await writeFile(path.join(runRoot, "result.json"), JSON.stringify({
      envelopeSchemaVersion: 1,
      resultKind: "fixture.result",
      runRef: { executionId: "run-01" },
      payload: { schemaVersion: 1 },
    }), "utf8");

    expect(await host.queryStores.runCatalog.get({ executionId: "run-01" })).toMatchObject({
      runRef: { executionId: "run-01" },
    });
    const artifacts = await host.queryStores.runArtifacts.open({ executionId: "run-01" });
    const results = await host.queryStores.publishedResults.open({ executionId: "run-01" });
    const performance = await host.queryStores.runPerformance.open({ executionId: "run-01" });
    expect("writeJson" in artifacts).toBe(false);
    expect("publish" in results).toBe(false);
    expect("complete" in performance).toBe(false);
    expect(await results.list()).toEqual([{
      runRef: { executionId: "run-01" },
      resultKind: "fixture.result",
      resultId: "result.json",
    }]);

    await host.runDispatch.dispatch({
      runRef: { executionId: "run-02" },
      actor: { userId: "operator", roleId: "runner" },
      workflow: { kind: "fixture.workflow", version: 1 },
      input: {},
      runConfiguration: { configurationId: "fixture-v1", contentHash: "a".repeat(64) },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(executed).toHaveLength(1);

    expect(() => host.queryStores.runCatalog).not.toThrow();
    expect(() => new DefaultApplicationQueryAdapterRegistry(createFileApplicationQueryAdapterFactories())
      .resolve("run-catalog", "missing@1")).toThrow(/not installed/);
    const queryRegistry = new DefaultApplicationQueryAdapterRegistry(createFileApplicationQueryAdapterFactories());
    expect(() => queryRegistry.resolve("run-artifacts", "file-run-catalog@1")).toThrow(/has role run-catalog/);
    expect(() => queryRegistry.resolve("run-catalog", "file-run-catalog@1")
      .validateConfig({ outputRoot: "runs", unknown: true })).toThrow(/unknown options/);
    expect(() => queryRegistry.resolve("run-catalog", "file-run-catalog@2")
      .validateConfig({ outputRoots: ["native", "native"] })).toThrow(/unique/);
  });
});

describe("application authorization", () => {
  const principal: AuthorizedApplicationPrincipal = {
    user: {
      schemaVersion: 1,
      userId: "owner",
      status: "active",
      identity: { providerId: "local", subjectId: "owner" },
      registeredAt: "2026-08-05T12:00:00.000Z",
    },
    roles: [{ schemaVersion: 1, roleId: "reader", permissions: ["runs:read-own"] }],
    permissions: ["runs:read-own"],
  };

  it("resolves current roles and forces own-run scope", async () => {
    const resolved = await authenticateApplicationRequest(
      {},
      { authenticate: async () => ({ providerId: "local", subjectId: "owner" }) },
      {
        users: { findByIdentity: async () => principal.user },
        assignments: {
          isAssigned: async () => true,
          list: async () => ({ items: [{ userId: "owner", roleId: "reader" }] }),
        },
        roles: {
          get: async () => principal.roles[0],
          list: async () => ({ items: principal.roles }),
        },
      },
    );
    expect(resolved.permissions).toEqual(["runs:read-own"]);
    expect(scopeRunCatalogQuery(resolved, {})).toMatchObject({ userId: "owner" });
    expect(() => scopeRunCatalogQuery(resolved, { userId: "somebody-else" }))
      .toThrow(ApplicationBoundaryError);
    await expect(authenticateApplicationRequest(
      {},
      { authenticate: async () => ({ providerId: "local", subjectId: "owner" }) },
      {
        users: { findByIdentity: async () => ({ ...principal.user, status: "disabled" }) },
        assignments: { isAssigned: async () => true, list: async () => ({ items: [] }) },
        roles: { get: async () => undefined, list: async () => ({ items: [] }) },
      },
    )).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });

  it("rejects unauthorized run access before opening a run-scoped store", async () => {
    const open = vi.fn(async () => ({ opened: true }));
    const catalog: RunCatalogStore = {
      list: async () => ({ items: [] }),
      archive: async () => undefined,
      restore: async () => undefined,
      get: async () => ({
        runRef: { executionId: "other-run" },
        workflow: { kind: "fixture.workflow", version: 1 },
        actor: { userId: "other-user", roleId: "reader" },
        createdAt: "2026-08-05T12:00:00.000Z",
      }),
    };
    await expect(openAuthorizedRunStore(
      principal,
      catalog,
      { executionId: "other-run" },
      open,
    )).rejects.toMatchObject({ code: "forbidden", status: 403 });
    expect(open).not.toHaveBeenCalled();
  });
});
