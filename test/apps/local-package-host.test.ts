import { access, chmod, mkdtemp, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { isDirectCliEntry, localCliUsage, runLocalCli } from "../../local/src/cli.ts";
import { migrateLegacyLocalStore } from "../../local/src/localStoreMigration.ts";
import { resolveLocalFileStorePaths } from "../../local/src/localStorePaths.ts";
import { mountLocalWebApplication } from "../../local/src/staticWeb.ts";
import { bootstrapLocalOperator } from "../../apps/hosts/api/src/localOperatorBootstrap.ts";

describe("published local portal host", () => {
  it("resolves every local store below the project .arkimux/local directory", () => {
    const root = path.resolve("/tmp", "arkimux-project");
    expect(resolveLocalFileStorePaths(root)).toEqual({
      root: path.join(root, ".arkimux/local"),
      configuration: path.join(root, ".arkimux/local/configuration"),
      platform: path.join(root, ".arkimux/local/configuration"),
      runs: path.join(root, ".arkimux/local/runs"),
      deployments: path.join(root, ".arkimux/local/configuration/deployments"),
      reservations: path.join(root, ".arkimux/local/runs/.reservations"),
      agentAuthProviders: path.join(root, ".arkimux/local/configuration/agent-auth-providers"),
      credentials: path.join(root, ".arkimux/local/credentials"),
      processes: path.join(root, ".arkimux/local/processes"),
      privacy: path.join(root, ".arkimux/local/privacy"),
      diagnostics: path.join(root, ".arkimux/local/diagnostics"),
      legacyBackup: path.join(root, ".arkimux/local/legacy-backup"),
    });
  });

  it("serves API routes, static assets, and browser-route fallbacks from one origin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-execution-local-web-"));
    await mkdir(path.join(root, "assets"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "index.html"), "<main>local portal</main>"),
      writeFile(path.join(root, "assets", "app.js"), "console.log('portal')"),
    ]);
    const app = new Hono();
    app.get("/api/v1/health", (context) => context.json({ status: "ok" }));
    mountLocalWebApplication(app, root);

    await expect((await app.request("http://local.test/api/v1/health")).json()).resolves.toEqual({ status: "ok" });
    await expect((await app.request("http://local.test/assets/app.js")).text()).resolves.toContain("portal");
    const connections = await app.request("http://local.test/connections");
    expect(connections.status).toBe(200);
    await expect(connections.text()).resolves.toContain("local portal");
    await expect((await app.request("http://local.test/runs/example")).text()).resolves.toContain("local portal");
    expect((await app.request("http://local.test/api/v1/missing")).status).toBe(404);
  });

  it("exposes explicit serve and bootstrap commands", async () => {
    await expect(runLocalCli(["--help"])).resolves.toEqual({
      kind: "help",
      message: localCliUsage(),
    });
    expect(localCliUsage()).toContain("agent-execution-local serve");
    expect(localCliUsage()).toContain("agent-execution-local bootstrap");
    expect(localCliUsage()).toContain("--role-family");
    expect(localCliUsage()).toContain("--role-preset");
    expect(localCliUsage()).toContain("agent-execution-local migrate");
    await expect(runLocalCli(["unknown"])).rejects.toThrow("Unknown command unknown");
  });

  it("composes platform-owned local permissions with workflow-specific role permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-execution-local-role-preset-"));
    const identity = [
      "--repository-root", root,
      "--subject-id", "local-subject",
      "--user-id", "local-user",
      "--role-family", "fixture-workflow-developer",
    ];
    await expect(bootstrapLocalOperator([
      ...identity,
      "--permission", "agent-templates:admin",
      "--permission", "runs:archive-all",
      "--permission", "runs:read-all",
      "--permission", "workflow:fixture:configure",
      "--permission", "workflow:fixture:start",
    ], root, {})).resolves.toContain("fixture-workflow-developer-v1");

    const args = [
      ...identity,
      "--role-preset", "local-workflow-developer",
      "--permission", "workflow:fixture:configure",
      "--permission", "workflow:fixture:start",
    ];

    await expect(bootstrapLocalOperator(args, root, {}))
      .resolves.toContain("fixture-workflow-developer-v2");
    await expect(bootstrapLocalOperator(args, root, {}))
      .resolves.toContain("fixture-workflow-developer-v2");

    const role = JSON.parse(await readFile(path.join(
      root,
      ".arkimux/local/configuration/roles/fixture-workflow-developer-v2.json",
    ), "utf8")) as { permissions: string[] };
    expect(role.permissions).toEqual([
      "agent-auth-providers:admin",
      "agent-templates:admin",
      "runs:archive-all",
      "runs:read-all",
      "runs:respond-own",
      "workflow:fixture:configure",
      "workflow:fixture:start",
    ]);
    expect(await readdir(path.join(
      root,
      ".arkimux/local/configuration/assignments/local-user",
    ))).toEqual(["fixture-workflow-developer-v2.json"]);
  });

  it("rejects unknown local role presets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-execution-local-role-preset-"));
    await expect(bootstrapLocalOperator([
      "--repository-root", root,
      "--subject-id", "local-subject",
      "--user-id", "local-user",
      "--role-family", "fixture-workflow-developer",
      "--role-preset", "missing-preset",
    ], root, {})).rejects.toThrow("Unknown local role preset missing-preset");
  });

  it("versions immutable local role families and keeps only the current assignment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-execution-local-role-family-"));
    const base = [
      "--repository-root", root,
      "--subject-id", "local-subject",
      "--user-id", "local-user",
      "--role-family", "fixture-workflow-developer",
      "--permission", "runs:read-all",
      "--permission", "workflow:fixture:start",
    ];

    await expect(bootstrapLocalOperator(base, root, {}))
      .resolves.toContain("fixture-workflow-developer-v1");
    await expect(bootstrapLocalOperator(base, root, {}))
      .resolves.toContain("fixture-workflow-developer-v1");
    await expect(bootstrapLocalOperator([
      ...base,
      "--permission", "runs:archive-all",
    ], root, {})).resolves.toContain("fixture-workflow-developer-v2");

    const platformRoot = path.join(root, ".arkimux/local/configuration");
    expect(await readdir(path.join(platformRoot, "roles"))).toEqual(expect.arrayContaining([
      "fixture-workflow-developer-v1.json",
      "fixture-workflow-developer-v2.json",
    ]));
    expect(await readdir(path.join(platformRoot, "assignments/local-user"))).toEqual([
      "fixture-workflow-developer-v2.json",
    ]);
  });

  it("moves the current project-local store into one .arkimux namespace and retains an exact backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-current-local-migration-"));
    const legacy = path.join(root, ".agent-execution");
    await Promise.all([
      writeFixture(root, ".agent-execution/local-store/file/platform/users/user.json", "user"),
      writeFixture(root, ".agent-execution/local-store/file/platform/workflow-deployments/weather/v1.json", "published"),
      writeFixture(root, ".agent-execution/local-store/file/credentials/values/provider.key", "secret"),
      writeFixture(root, ".agent-execution/local-store/file/runs/weather/run.json", "run"),
      writeFixture(root, ".agent-execution/local-store/file/deployments/weather/receipt.json", "deployment"),
      writeFixture(root, ".agent-execution/processes/local-server.log", "stopped"),
      writeFixture(root, ".agent-execution/private-note.txt", "retained only in backup"),
    ]);
    await chmod(path.join(legacy, "local-store/file/credentials"), 0o700);
    await chmod(path.join(legacy, "local-store/file/credentials/values/provider.key"), 0o600);

    const migrated = await migrateLegacyLocalStore(root);

    expect(migrated).toMatchObject({ migrated: true, files: 6 });
    await expect(readFile(path.join(root, ".arkimux/local/configuration/users/user.json"), "utf8"))
      .resolves.toBe("user");
    await expect(readFile(path.join(root, ".arkimux/local/credentials/values/provider.key"), "utf8"))
      .resolves.toBe("secret");
    await expect(readFile(path.join(root, ".arkimux/local/runs/weather/run.json"), "utf8"))
      .resolves.toBe("run");
    await expect(readFile(path.join(root, ".arkimux/local/configuration/deployments/weather/receipt.json"), "utf8"))
      .resolves.toBe("deployment");
    await expect(readFile(path.join(root, ".arkimux/local/configuration/deployments/workflow-deployments/weather/v1.json"), "utf8"))
      .resolves.toBe("published");
    await expect(readFile(path.join(root, ".arkimux/local/processes/local-server.log"), "utf8"))
      .resolves.toBe("stopped");
    expect((await stat(path.join(root, ".arkimux/local/credentials"))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(root, ".arkimux/local/credentials/values/provider.key"))).mode & 0o777).toBe(0o600);
    await expect(access(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(migrated.backupRoot!, ".agent-execution/private-note.txt"), "utf8"))
      .resolves.toBe("retained only in backup");
    await expect(migrateLegacyLocalStore(root)).resolves.toMatchObject({ migrated: false, files: 0 });
  });

  it("recovers a verified storage migration interrupted after all legacy sources were retired", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-local-migration-recovery-"));
    const migrationId = "2026-09-01T00-00-00-000Z-deadbeef";
    const staging = `.arkimux/.local-migration-${migrationId}`;
    const backup = `${staging}/legacy-backup/${migrationId}/.agent-execution`;
    await Promise.all([
      writeFixture(root, `${backup}/local-store/file/platform/users/user.json`, "user"),
      writeFixture(root, `${backup}/local-store/file/platform/workflow-deployments/weather/v1.json`, "published"),
      writeFixture(root, `${backup}/local-store/file/runs/weather/run.json`, "run"),
      writeFixture(root, `${backup}/private-note.txt`, "backup only"),
      writeFixture(root, `${staging}/configuration/users/user.json`, "user"),
      writeFixture(root, `${staging}/configuration/deployments/workflow-deployments/weather/v1.json`, "published"),
      writeFixture(root, `${staging}/runs/weather/run.json`, "run"),
    ]);

    const migrated = await migrateLegacyLocalStore(root);

    expect(migrated).toMatchObject({ migrated: true, files: 3 });
    expect(migrated.message).toContain("Recovered an interrupted local-storage migration");
    await expect(readFile(path.join(root, ".arkimux/local/configuration/users/user.json"), "utf8"))
      .resolves.toBe("user");
    await expect(readFile(path.join(root, ".arkimux/local/runs/weather/run.json"), "utf8"))
      .resolves.toBe("run");
    await expect(readFile(path.join(migrated.backupRoot!, ".agent-execution/private-note.txt"), "utf8"))
      .resolves.toBe("backup only");
    await expect(access(path.join(root, staging))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(migrateLegacyLocalStore(root)).resolves.toMatchObject({ migrated: false, files: 0 });
  });

  it("fails closed when an interrupted storage migration still has a legacy source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-local-migration-incomplete-"));
    const migrationId = "2026-09-01T00-00-00-000Z-incomplete";
    const staging = `.arkimux/.local-migration-${migrationId}`;
    const backup = `${staging}/legacy-backup/${migrationId}/.agent-execution`;
    await Promise.all([
      writeFixture(root, `${backup}/local-store/file/runs/weather/run.json`, "run"),
      writeFixture(root, `${staging}/runs/weather/run.json`, "run"),
      writeFixture(root, ".agent-execution-runs-v3/other/run.json", "not retired"),
    ]);

    await expect(migrateLegacyLocalStore(root)).rejects.toThrow("legacy source data still exists");
    await expect(readFile(path.join(root, staging, "runs/weather/run.json"), "utf8"))
      .resolves.toBe("run");
    await expect(readFile(path.join(root, ".agent-execution-runs-v3/other/run.json"), "utf8"))
      .resolves.toBe("not retired");
    await expect(access(path.join(root, ".arkimux/local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when more than one interrupted storage migration exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-local-migration-ambiguous-"));
    await Promise.all([
      mkdir(path.join(root, ".arkimux/.local-migration-first"), { recursive: true }),
      mkdir(path.join(root, ".arkimux/.local-migration-second"), { recursive: true }),
    ]);

    await expect(migrateLegacyLocalStore(root)).rejects.toThrow("multiple staging directories exist");
    await expect(access(path.join(root, ".arkimux/.local-migration-first"))).resolves.toBeUndefined();
    await expect(access(path.join(root, ".arkimux/.local-migration-second"))).resolves.toBeUndefined();
    await expect(access(path.join(root, ".arkimux/local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to merge old and new local data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-local-migration-collision-"));
    await Promise.all([
      writeFixture(root, ".agent-execution/local-store/file/runs/weather/old.json", "old"),
      writeFixture(root, ".arkimux/local/runs/weather/new.json", "new"),
    ]);

    await expect(migrateLegacyLocalStore(root)).rejects.toThrow("already contains data");
    await expect(readFile(path.join(root, ".agent-execution/local-store/file/runs/weather/old.json"), "utf8"))
      .resolves.toBe("old");
    await expect(readFile(path.join(root, ".arkimux/local/runs/weather/new.json"), "utf8"))
      .resolves.toBe("new");
  });

  it("refuses migration while the recorded local server process is alive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-live-local-migration-"));
    await writeFixture(root, ".agent-execution/processes/local-server.json", `${JSON.stringify({ pid: process.pid })}\n`);

    await expect(migrateLegacyLocalStore(root)).rejects.toThrow(
      `local server process ${process.pid} is still running`,
    );
    await expect(access(path.join(root, ".agent-execution/processes/local-server.json"))).resolves.toBeUndefined();
    await expect(access(path.join(root, ".arkimux/local"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates legacy local stores only after copied files are verified", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-execution-local-migration-"));
    await Promise.all([
      writeFixture(root, ".agent-execution-platform/users/user.json", "user"),
      writeFixture(root, ".agent-execution-runs-v3/workflow/run.json", "run"),
      writeFixture(root, ".agent-execution-deployments/workflow/receipt.json", "deployment"),
    ]);

    const migrated = await migrateLegacyLocalStore(root);
    expect(migrated).toMatchObject({ migrated: true, files: 3 });
    await expect(readFile(path.join(root, ".arkimux/local/configuration/users/user.json"), "utf8"))
      .resolves.toBe("user");
    await expect(readFile(path.join(root, ".arkimux/local/runs/workflow/run.json"), "utf8"))
      .resolves.toBe("run");
    await expect(readFile(path.join(root, ".arkimux/local/configuration/deployments/workflow/receipt.json"), "utf8"))
      .resolves.toBe("deployment");
    await expect(access(path.join(root, ".agent-execution-platform"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks normal startup until legacy local stores are explicitly migrated", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-execution-local-guard-"));
    await writeFixture(root, ".agent-execution-runs-v3/run.json", "run");
    await expect(runLocalCli([
      "bootstrap",
      "--repository-root", root,
      "--subject-id", "subject",
      "--user-id", "user",
      "--role-id", "role",
    ], root)).rejects.toThrow("arkimux local migrate");
  });

  it("moves flat run configurations into workflow-scoped storage without changing definition bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-execution-local-config-migration-"));
    const legacyRoot = ".arkimux/local/configuration/run-configurations";
    const definition = `${JSON.stringify({
      schemaVersion: 3,
      configurationId: "balanced-v1",
      workflow: { kind: "decision.brief", version: 1 },
      agents: {},
    }, null, 2)}\n`;
    const lifecycle = `${JSON.stringify({
      schemaVersion: 1,
      configurationId: "balanced-v1",
      status: "archived",
      updatedAt: "2026-08-19T00:00:00.000Z",
    }, null, 2)}\n`;
    await Promise.all([
      writeFixture(root, `${legacyRoot}/balanced-v1.json`, definition),
      writeFixture(root, `${legacyRoot}/.lifecycle/balanced-v1.json`, lifecycle),
    ]);

    await expect(runLocalCli([
      "bootstrap",
      "--repository-root", root,
      "--subject-id", "subject",
      "--user-id", "user",
      "--role-id", "role",
    ], root)).rejects.toThrow("arkimux local migrate");
    const migrated = await migrateLegacyLocalStore(root);
    expect(migrated).toMatchObject({ migrated: true, files: 2 });
    const destination = path.join(
      root,
      ".arkimux/local/configuration/workflow-run-configurations/decision.brief/1/balanced-v1",
    );
    await expect(readFile(path.join(destination, "definition.json"), "utf8")).resolves.toBe(definition);
    await expect(readFile(path.join(destination, "lifecycle.json"), "utf8")).resolves.toBe(`${JSON.stringify({
      schemaVersion: 1,
      configurationId: "balanced-v1",
      status: "archived",
      updatedAt: "2026-08-19T00:00:00.000Z",
      workflow: { kind: "decision.brief", version: 1 },
    }, null, 2)}\n`);
    await expect(access(path.join(root, legacyRoot))).rejects.toMatchObject({ code: "ENOENT" });
    expect(migrated.backupRoot).toContain(".arkimux/local/legacy-backup/");
    await expect(readFile(path.join(migrated.backupRoot!, "balanced-v1.json"), "utf8"))
      .resolves.toBe(definition);
  });

  it("migrates combined V1 authentication providers into separate credentials and V2 bindings", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-execution-local-auth-migration-"));
    const localRoot = ".arkimux/local";
    await Promise.all([
      writeFixture(root, `${localRoot}/configuration/agent-auth-providers/claude-key/definition.json`, `${JSON.stringify({
        schemaVersion: 1,
        authProviderId: "claude-key",
        displayName: "Claude key",
        kind: "api-key",
        executionProviderId: "claude-code-cli",
        modelProvider: "anthropic",
        targetVariable: "ANTHROPIC_API_KEY",
      }, null, 2)}\n`),
      writeFixture(root, `${localRoot}/configuration/agent-auth-providers/claude-key/metadata.json`, `${JSON.stringify({
        schemaVersion: 1,
        authProviderId: "claude-key",
        lifecycleStatus: "active",
        createdAt: "2026-08-22T00:00:00.000Z",
        updatedAt: "2026-08-22T00:00:00.000Z",
        credentialAvailable: true,
      }, null, 2)}\n`),
      writeFixture(root, `${localRoot}/credentials/claude-key.key`, "secret"),
    ]);
    await expect(runLocalCli(["bootstrap", "--repository-root", root, "--subject-id", "subject", "--user-id", "user", "--role-id", "role"], root))
      .rejects.toThrow("arkimux local migrate");
    await expect(migrateLegacyLocalStore(root)).resolves.toMatchObject({ migrated: true });
    await expect(readFile(path.join(root, localRoot, "configuration/agent-auth-providers/claude-key/definition.json"), "utf8"))
      .resolves.toContain('"schemaVersion": 2');
    await expect(readFile(path.join(root, localRoot, "credentials/definitions/claude-key/definition.json"), "utf8"))
      .resolves.toContain('"modelProvider": "anthropic"');
    await expect(readFile(path.join(root, localRoot, "credentials/values/claude-key.key"), "utf8"))
      .resolves.toBe("secret");
  });

  it("resumes V1 authentication migration after matching credential files were already installed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-execution-local-auth-credential-retry-"));
    const localRoot = ".arkimux/local";
    const providerDefinition = `${JSON.stringify({
      schemaVersion: 1,
      authProviderId: "claude-key",
      displayName: "Claude key",
      kind: "api-key",
      executionProviderId: "claude-code-cli",
      modelProvider: "anthropic",
      targetVariable: "ANTHROPIC_API_KEY",
    }, null, 2)}\n`;
    const providerMetadata = `${JSON.stringify({
      schemaVersion: 1,
      authProviderId: "claude-key",
      lifecycleStatus: "active",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      credentialAvailable: true,
    }, null, 2)}\n`;
    const credentialDefinition = `${JSON.stringify({
      schemaVersion: 1,
      credentialId: "claude-key",
      displayName: "Claude key credential",
      kind: "api-key",
      modelProvider: "anthropic",
    }, null, 2)}\n`;
    const credentialMetadata = `${JSON.stringify({
      schemaVersion: 1,
      credentialId: "claude-key",
      lifecycleStatus: "active",
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    }, null, 2)}\n`;
    await Promise.all([
      writeFixture(root, `${localRoot}/configuration/agent-auth-providers/claude-key/definition.json`, providerDefinition),
      writeFixture(root, `${localRoot}/configuration/agent-auth-providers/claude-key/metadata.json`, providerMetadata),
      writeFixture(root, `${localRoot}/credentials/claude-key.key`, "secret"),
      writeFixture(root, `${localRoot}/credentials/definitions/claude-key/definition.json`, credentialDefinition),
      writeFixture(root, `${localRoot}/credentials/definitions/claude-key/metadata.json`, credentialMetadata),
      writeFixture(root, `${localRoot}/credentials/values/claude-key.key`, "secret"),
      writeFixture(root, `${localRoot}/legacy-backup/0000-incomplete/agent-authentication-v1/agent-auth-providers/claude-key/definition.json`, "{incomplete"),
      writeFixture(root, `${localRoot}/legacy-backup/0000-incomplete/agent-authentication-v1/credentials/claude-key.key`, "secret"),
    ]);
    await chmod(path.join(root, localRoot, "credentials/claude-key.key"), 0o640);

    const migrated = await migrateLegacyLocalStore(root);

    expect(migrated).toMatchObject({ migrated: true, files: 4 });
    await expect(readFile(path.join(root, localRoot, "credentials/definitions/claude-key/metadata.json"), "utf8"))
      .resolves.toBe(credentialMetadata);
    await expect(readFile(path.join(root, localRoot, "credentials/values/claude-key.key"), "utf8"))
      .resolves.toBe("secret");
    expect((await stat(path.join(root, localRoot, "credentials/values/claude-key.key"))).mode & 0o777).toBe(0o640);
    await expect(access(path.join(root, localRoot, "credentials/claude-key.key")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(migrated.backupRoot!, "agent-auth-providers/claude-key/definition.json"), "utf8"))
      .resolves.toBe(providerDefinition);
    expect((await stat(path.join(migrated.backupRoot!, "credentials/claude-key.key"))).mode & 0o777).toBe(0o640);
    await expect(migrateLegacyLocalStore(root)).resolves.toMatchObject({ migrated: false, files: 0 });
  });

  it("finishes V1 authentication migration after the provider binding changed but the old key remains", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-execution-local-auth-binding-retry-"));
    const localRoot = ".arkimux/local";
    const originalDefinition = `${JSON.stringify({
      schemaVersion: 1,
      authProviderId: "claude-key",
      displayName: "Claude key",
      kind: "api-key",
      executionProviderId: "claude-code-cli",
      modelProvider: "anthropic",
      targetVariable: "ANTHROPIC_API_KEY",
    }, null, 2)}\n`;
    const originalMetadata = `${JSON.stringify({
      schemaVersion: 1,
      authProviderId: "claude-key",
      lifecycleStatus: "active",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-08-22T00:00:00.000Z",
      credentialAvailable: true,
    }, null, 2)}\n`;
    const finalDefinition = `${JSON.stringify({
      schemaVersion: 2,
      authProviderId: "claude-key",
      displayName: "Claude key",
      kind: "stored-credential",
      executionProviderId: "claude-code-cli",
      modelProvider: "anthropic",
      credentialId: "claude-key",
      targetVariable: "ANTHROPIC_API_KEY",
    }, null, 2)}\n`;
    const finalProviderMetadata = `${JSON.stringify({
      schemaVersion: 1,
      authProviderId: "claude-key",
      lifecycleStatus: "active",
      createdAt: "2026-08-22T00:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    }, null, 2)}\n`;
    const credentialDefinition = `${JSON.stringify({
      schemaVersion: 1,
      credentialId: "claude-key",
      displayName: "Claude key credential",
      kind: "api-key",
      modelProvider: "anthropic",
    }, null, 2)}\n`;
    const credentialMetadata = `${JSON.stringify({
      schemaVersion: 1,
      credentialId: "claude-key",
      lifecycleStatus: "active",
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T10:00:00.000Z",
    }, null, 2)}\n`;
    const previousBackup = `${localRoot}/legacy-backup/2026-09-01T10-00-00-000Z-prior/agent-authentication-v1`;
    await Promise.all([
      writeFixture(root, `${localRoot}/configuration/agent-auth-providers/claude-key/definition.json`, finalDefinition),
      writeFixture(root, `${localRoot}/configuration/agent-auth-providers/claude-key/metadata.json`, finalProviderMetadata),
      writeFixture(root, `${localRoot}/credentials/claude-key.key`, "secret"),
      writeFixture(root, `${localRoot}/credentials/definitions/claude-key/definition.json`, credentialDefinition),
      writeFixture(root, `${localRoot}/credentials/definitions/claude-key/metadata.json`, credentialMetadata),
      writeFixture(root, `${localRoot}/credentials/values/claude-key.key`, "secret"),
      writeFixture(root, `${previousBackup}/agent-auth-providers/claude-key/definition.json`, originalDefinition),
      writeFixture(root, `${previousBackup}/agent-auth-providers/claude-key/metadata.json`, originalMetadata),
      writeFixture(root, `${previousBackup}/credentials/claude-key.key`, "secret"),
    ]);
    await chmod(path.join(root, previousBackup, "credentials/claude-key.key"), 0o600);

    const migrated = await migrateLegacyLocalStore(root);

    expect(migrated).toMatchObject({ migrated: true, files: 4 });
    await expect(readFile(path.join(root, localRoot, "configuration/agent-auth-providers/claude-key/definition.json"), "utf8"))
      .resolves.toBe(finalDefinition);
    await expect(access(path.join(root, localRoot, "credentials/claude-key.key")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(migrated.backupRoot!, "agent-auth-providers/claude-key/definition.json"), "utf8"))
      .resolves.toBe(originalDefinition);
    await expect(readFile(path.join(migrated.backupRoot!, "agent-auth-providers/claude-key/metadata.json"), "utf8"))
      .resolves.toBe(originalMetadata);
    await expect(readFile(path.join(migrated.backupRoot!, "credentials/claude-key.key"), "utf8"))
      .resolves.toBe("secret");
    expect((await stat(path.join(migrated.backupRoot!, "credentials/claude-key.key"))).mode & 0o777).toBe(0o600);
    await expect(migrateLegacyLocalStore(root)).resolves.toMatchObject({ migrated: false, files: 0 });
  });

  it("recognizes an npm bin symlink as the direct CLI entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-execution-local-bin-"));
    const modulePath = path.join(root, "dist", "cli.js");
    const binPath = path.join(root, "node_modules", ".bin", "agent-execution-local");
    await mkdir(path.dirname(modulePath), { recursive: true });
    await mkdir(path.dirname(binPath), { recursive: true });
    await writeFile(modulePath, "");
    await symlink(modulePath, binPath);
    expect(isDirectCliEntry(binPath, new URL(`file://${modulePath}`).href)).toBe(true);
  });
});

async function writeFixture(root: string, relative: string, content: string): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
