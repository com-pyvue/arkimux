import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { arkimuxCliUsage, runArkiMuxCli } from "../../cli/src/cli.ts";
import { describeLocalStartupFailure, waitForOwnedWorkflowApi } from "../../cli/src/localStartup.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ArkiMux CLI contract", () => {
  it("exposes the frozen CLI-first commands", () => {
    expect(arkimuxCliUsage()).toContain("arkimux create <project-name>");
    expect(arkimuxCliUsage()).toContain("arkimux local start");
    expect(arkimuxCliUsage()).toContain("arkimux local stop");
    expect(arkimuxCliUsage()).toContain("arkimux local migrate");
    expect(arkimuxCliUsage()).toContain("arkimux project validate");
  });

  it("rejects Node 23 before reading a project", async () => {
    await expect(runArkiMuxCli(["project", "validate"], "/not-an-arkimux-project", { nodeVersion: "23.11.1" }))
      .rejects.toThrow("ArkiMux requires Node.js >=24.0.0; current runtime is 23.11.1.");
  });

  it("validates a generated project without writes or provider calls", async () => {
    const root = await validGeneratedProject();
    const before = await projectFileContents(root);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));

    const result = await runArkiMuxCli(["project", "validate"], root, { nodeVersion: "24.0.0" });

    expect(result).toMatchObject({ kind: "project-validate", projectRoot: root });
    expect(result.message).toBe(`ArkiMux project is valid: ${root}.`);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await projectFileContents(root)).toEqual(before);
  });

  it("compares lockfile dependency maps without depending on JSON key order", async () => {
    const root = await validGeneratedProject({ reverseLockOrder: true });
    await expect(runArkiMuxCli(["project", "validate"], root, { nodeVersion: "24.0.0" })).resolves.toMatchObject({
      kind: "project-validate",
    });
  });

  it.each([
    ["workspace dependency", { dependency: "workspace:*" }, /exact version or a generator-owned/],
    ["parent file dependency", { dependency: "file:../local" }, /exact version or a generator-owned/],
    ["missing vendor tarball", { dependency: "file:vendor/missing.tgz" }, /dependency tarball for zod/],
    ["mismatched lockfile", { lockCliVersion: "0.1.0-alpha.8" }, /physical @com-pyvue\/arkimux@0.1.0-alpha.9/],
    ["escaping registry", { workflowRegistry: "../workflows.ts" }, /must stay inside the project/],
  ])("rejects %s during offline project validation", async (_label, mutation, expected) => {
    const root = await validGeneratedProject(mutation);
    await expect(runArkiMuxCli(["project", "validate"], root, { nodeVersion: "24.0.0" })).rejects.toThrow(expected);
  });

  it("defines one ArkiMux project that can contain several workflows", async () => {
    const manifest = JSON.parse(await readFile(path.resolve("cli/scaffold/.arkimux/project.json"), "utf8"));
    const gitignore = await readFile(path.resolve("cli/scaffold/gitignore"), "utf8");

    expect(manifest).toMatchObject({
      schemaVersion: 2,
      kind: "arkimux-project",
      workflowRegistry: "src/arkimux.workflows.ts",
    });
    expect(gitignore).toContain(".arkimux/local/");
    expect(gitignore).not.toMatch(/^\.arkimux\/$/m);
  });

  it.each(["Decision Brief", "-demo", "demo_1", "demo-"])("rejects invalid project name %s", async (name) => {
    const root = await temporaryRoot();
    await expect(runArkiMuxCli(["create", name], root, { nodeVersion: "24.0.0" }, fakeModuleUrl(root))).rejects.toThrow(/Project name|requires a project name/);
    expect(await readdir(root)).toEqual([]);
  });

  it("names the created ArkiMux project separately from its included workflow", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "projects");
    const packageRoot = path.join(root, "candidate");
    await mkdir(cwd);
    await prepareMinimalCandidatePackage(packageRoot);

    const result = await runArkiMuxCli(
      ["create", "my-agent-app"],
      cwd,
      { nodeVersion: "24.0.0" },
      new URL(`file://${path.join(packageRoot, "dist/cli.js")}`).href,
    );

    expect(result.message.split("\n")).toEqual([
      `Created ArkiMux project at ${path.join(cwd, "my-agent-app")}.`,
      "Included workflows: weather-advisor@1, graph-invocation@1",
      "Next: cd my-agent-app && cp .env.example .env",
      "Set WEATHER_API_URL in .env (for example https://wttr.in), then run npm run dev.",
    ]);
    const generated = JSON.parse(await readFile(path.join(result.projectRoot!, "package.json"), "utf8"));
    expect(generated.generatorVersion).toBe("0.1.0-alpha.8");
    expect(JSON.parse(await readFile(path.join(result.projectRoot!, "package-lock.json"), "utf8")).lockfileVersion).toBe(3);
    expect(await readFile(path.join(result.projectRoot!, ".agents/skills/arkimux-workflow-debugger/SKILL.md"), "utf8"))
      .toContain("name: arkimux-workflow-debugger");
  });

  it("pins the project-local CLI and exposes npm lifecycle commands", async () => {
    const scaffold = JSON.parse(await readFile(path.resolve("cli/scaffold/package.json"), "utf8"));
    expect(scaffold.devDependencies["@com-pyvue/arkimux"]).toBe("__CLI_VERSION__");
    expect(scaffold.scripts.dev).toBe("arkimux local start");
    expect(scaffold.scripts["dev:stop"]).toBe("arkimux local stop");
    // Existing V1 aliases remain available.
    expect(scaffold.scripts.start).toBe("arkimux local start");
    expect(scaffold.scripts.stop).toBe("arkimux local stop");
  });

  it("rejects a non-empty target without changing it", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "demo");
    await mkdir(target);
    await writeFile(path.join(target, "owned.txt"), "keep");
    await expect(runArkiMuxCli(["create", "demo"], root, { nodeVersion: "24.0.0" }, fakeModuleUrl(root))).rejects.toThrow("not empty");
    expect(await readFile(path.join(target, "owned.txt"), "utf8")).toBe("keep");
  });

  it("retains an actionable record when project installation cannot start", async () => {
    const root = await temporaryRoot();
    const packageRoot = path.join(root, "candidate");
    await mkdir(path.join(root, "projects"));
    await prepareMinimalCandidatePackage(packageRoot);

    await expect(runArkiMuxCli(
      ["create", "my-agent-app"],
      path.join(root, "projects"),
      { nodeVersion: "24.0.0", environment: { PATH: "" } },
      fakeModuleUrl(packageRoot),
    )).rejects.toThrow(/npm install failed.*\.arkimux-create-failed\.json/);

    const failure = JSON.parse(await readFile(path.join(root, "projects/my-agent-app/.arkimux-create-failed.json"), "utf8"));
    expect(failure).toMatchObject({
      schemaVersion: 1,
      command: "npm install --package-lock-only --ignore-scripts --include=optional --no-audit --no-fund",
      status: null,
    });
    expect(failure.cleanup).toContain("Remove");
    expect(failure.cleanup).toContain("run arkimux create my-agent-app again");
  });

  it("rejects local commands outside a generated project", async () => {
    const root = await temporaryRoot();
    await expect(runArkiMuxCli(["local", "stop"], root, { nodeVersion: "24.0.0" })).rejects.toThrow("not an ArkiMux project");
  });

  it("requires an explicit migration before starting an older project", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, ".arkimux"));
    await writeFile(path.join(root, ".arkimux/project.json"), JSON.stringify({ schemaVersion: 1, kind: "workflow-project" }));

    await expect(runArkiMuxCli(["local", "start"], root, { nodeVersion: "24.0.0" })).rejects.toThrow(
      "Run arkimux local migrate before arkimux local start",
    );
  });

  it("does not silently start empty when legacy local data exists", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, ".arkimux"));
    await mkdir(path.join(root, ".agent-execution"));
    await writeFile(path.join(root, ".arkimux/project.json"), JSON.stringify({ schemaVersion: 2, kind: "arkimux-project" }));

    await expect(runArkiMuxCli(["local", "start"], root, { nodeVersion: "24.0.0" })).rejects.toThrow(
      "Legacy ArkiMux local data was found in .agent-execution",
    );
  });

  it.each([false, true])("reaches Local bootstrap without a provider login check (Codex installed: %s)", async (codexInstalled) => {
    const root = await currentProjectRoot();
    const binRoot = path.join(root, "node_modules/.bin");
    const marker = path.join(root, "provider-was-called");
    await mkdir(binRoot, { recursive: true });
    await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(binRoot, "tsx"), "not invoked by startup\n");
    await writeFile(path.join(binRoot, "agent-execution-local"), [
      `#!${process.execPath}`,
      "process.stderr.write('isolated bootstrap reached');",
      "process.exitCode = 17;",
    ].join("\n"), { mode: 0o755 });
    const forbiddenProviderCall = [
      "import {writeFileSync} from 'node:fs';",
      `writeFileSync(${JSON.stringify(marker)}, 'unexpected provider check');`,
      "process.exitCode = 2;",
    ].join("\n");
    await writeFile(path.join(root, "scripts/preflight.ts"), forbiddenProviderCall);
    if (codexInstalled) {
      await writeFile(path.join(binRoot, "codex"), `#!${process.execPath}\n${forbiddenProviderCall}`, { mode: 0o755 });
    }

    // Stop at a controlled bootstrap failure. No server or real provider runs.
    await expect(runArkiMuxCli(["local", "start"], root, {
      nodeVersion: "24.0.0",
      environment: { PATH: path.dirname(process.execPath) },
    })).rejects.toThrow("Local setup could not complete. Check this project's local storage and try again.");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates the legacy project manifest with the bundled current logic", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, ".arkimux"));
    await mkdir(path.join(root, ".agent-execution/local-store/file/runs"), { recursive: true });
    await writeFile(path.join(root, ".arkimux/project.json"), JSON.stringify({
      schemaVersion: 1,
      kind: "workflow-project",
      projectName: "my-agent-app",
      workflowRegistry: "src/arkimux.workflows.ts",
    }));
    await writeFile(path.join(root, ".agent-execution/local-store/file/runs/proof.json"), "migrated run");

    const result = await runArkiMuxCli(["local", "migrate"], root, { nodeVersion: "24.0.0" });
    const manifest = JSON.parse(await readFile(path.join(root, ".arkimux/project.json"), "utf8"));

    expect(result.kind).toBe("local-migrate");
    expect(result.message).toContain("Updated the project manifest to arkimux-project@2");
    expect(manifest).toEqual({
      schemaVersion: 2,
      kind: "arkimux-project",
      projectName: "my-agent-app",
      workflowRegistry: "src/arkimux.workflows.ts",
    });
    expect(await readFile(path.join(root, ".arkimux/local/runs/proof.json"), "utf8")).toBe("migrated run");
    await expect(readFile(path.join(root, ".agent-execution/local-store/file/runs/proof.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const [backupName] = await readdir(path.join(root, ".arkimux/local/legacy-backup"));
    expect(backupName).toBeDefined();
    expect(JSON.parse(await readFile(path.join(
      root,
      ".arkimux/local/legacy-backup",
      backupName!,
      "project-manifest/project.json",
    ), "utf8"))).toMatchObject({ schemaVersion: 1, kind: "workflow-project" });
  });

  it("does not upgrade the project manifest while migrated data is stranded", async () => {
    const root = await temporaryRoot();
    const migrationId = "2026-09-01T00-00-00-000Z-stranded";
    const stagingRoot = path.join(root, ".arkimux", `.local-migration-${migrationId}`);
    const manifest = {
      schemaVersion: 1,
      kind: "workflow-project",
      projectName: "my-agent-app",
      workflowRegistry: "src/arkimux.workflows.ts",
    };
    await mkdir(path.join(root, ".arkimux"), { recursive: true });
    await writeFile(path.join(root, ".arkimux/project.json"), `${JSON.stringify(manifest)}\n`);
    await mkdir(path.join(
      stagingRoot,
      "legacy-backup",
      migrationId,
      ".agent-execution/local-store/file/runs",
    ), { recursive: true });
    await writeFile(path.join(
      stagingRoot,
      "legacy-backup",
      migrationId,
      ".agent-execution/local-store/file/runs/proof.json",
    ), "expected run");
    await mkdir(path.join(stagingRoot, "runs"), { recursive: true });
    await writeFile(path.join(stagingRoot, "runs/proof.json"), "different run");

    await expect(runArkiMuxCli(["local", "migrate"], root, { nodeVersion: "24.0.0" }))
      .rejects.toThrow("does not match its complete legacy backup");

    expect(JSON.parse(await readFile(path.join(root, ".arkimux/project.json"), "utf8"))).toEqual(manifest);
    await expect(readFile(path.join(stagingRoot, "runs/proof.json"), "utf8")).resolves.toBe("different run");
    await expect(readFile(path.join(root, ".arkimux/local/runs/proof.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to stop a live PID that is not this project's server", async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, ".arkimux"));
    await mkdir(path.join(root, ".arkimux/local/processes"), { recursive: true });
    await writeFile(path.join(root, ".arkimux/project.json"), JSON.stringify({ schemaVersion: 2, kind: "arkimux-project" }));
    await writeFile(path.join(root, ".arkimux/local/processes/local-server.json"), JSON.stringify({
      schemaVersion: 1,
      projectRoot: root,
      pid: process.pid,
      token: "not-used-by-this-process",
      roleId: "local-role-v1",
      url: "http://127.0.0.1:8787",
      startedAt: new Date().toISOString(),
      command: "not-this-process",
      log: ".arkimux/local/processes/local-server.log",
    }));
    await expect(runArkiMuxCli(["local", "stop"], root, { nodeVersion: "24.0.0" })).rejects.toThrow("Refusing to stop");
  });

  it.each(["correct", "debug", "wrong-token", "wrong-project"])("checks private server ownership: %s", async mode => {
    if (process.platform === "win32") return;
    const root = await currentProjectRoot();
    const entry = path.join(root, "node_modules/@com-pyvue/arkimux/dist/local-server.js");
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "setInterval(() => {}, 1000); process.send({ ready: true });\n");
    const token = randomUUID();
    const args = [entry, "--port", "29871", ...(mode === "debug" ? ["--debug-session"] : []), "--project-root", root, "--process-token", token];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = once(child, "exit");
    try {
      await once(child, "message");
      const recordPath = path.join(root, ".arkimux/local/processes/local-server.json");
      await mkdir(path.dirname(recordPath), { recursive: true });
      await writeFile(recordPath, JSON.stringify({ schemaVersion: 1, projectRoot: root, pid: child.pid,
        token: mode === "wrong-token" ? randomUUID() : token, roleId: "fixture", url: "http://127.0.0.1:29871",
        startedAt: new Date().toISOString(), log: ".arkimux/local/processes/local-server.log",
        command: [process.execPath, ...args].join(" ").replace(mode === "wrong-project" ? `--project-root ${root}` : "DO_NOT_REPLACE", "--project-root /different-project") }));
      if (mode === "correct" || mode === "debug") {
        expect(await runArkiMuxCli(["local", "stop"], root, { nodeVersion: "24.0.0" })).toMatchObject({ kind: "local-stop" });
        await exited;
        await expect(readFile(recordPath)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        await expect(runArkiMuxCli(["local", "stop"], root, { nodeVersion: "24.0.0" })).rejects.toThrow("Refusing to stop");
        expect(child.exitCode).toBeNull();
        expect(await readFile(recordPath, "utf8")).toContain(String(child.pid));
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("fails closed when the local process record contains invalid JSON", async () => {
    const root = await currentProjectRoot();
    const recordPath = path.join(root, ".arkimux/local/processes/local-server.json");
    await writeFile(recordPath, "{not-json");

    await expect(runArkiMuxCli(["local", "stop"], root, { nodeVersion: "24.0.0" })).rejects.toThrow(
      "contains invalid JSON",
    );
    expect(await readFile(recordPath, "utf8")).toBe("{not-json");
  });

  it("fails closed when the local process record has missing ownership fields", async () => {
    const root = await currentProjectRoot();
    const recordPath = path.join(root, ".arkimux/local/processes/local-server.json");
    await writeFile(recordPath, JSON.stringify({ schemaVersion: 1, projectRoot: root, pid: process.pid }));

    await expect(runArkiMuxCli(["local", "stop"], root, { nodeVersion: "24.0.0" })).rejects.toThrow(
      "is invalid",
    );
    await expect(readFile(recordPath, "utf8")).resolves.toContain(String(process.pid));
  });

  it("fails closed when the local process record cannot be read as a file", async () => {
    const root = await currentProjectRoot();
    const recordPath = path.join(root, ".arkimux/local/processes/local-server.json");
    await mkdir(recordPath);

    await expect(runArkiMuxCli(["local", "stop"], root, { nodeVersion: "24.0.0" })).rejects.toThrow(
      "Could not read local process record",
    );
    await expect(readdir(recordPath)).resolves.toEqual([]);
  });

  it("does not accept an unrelated healthy workflow API as the newly spawned server", async () => {
    const root = await temporaryRoot();
    const child = new FakeChild(process.pid);
    let requests = 0;
    const healthyUnrelatedServer = async () => {
      requests += 1;
      return new Response(JSON.stringify({
        items: [{ workflow: { kind: "decision-brief", version: 1 } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const readiness = waitForOwnedWorkflowApi({
      url: "http://127.0.0.1:8787",
      child: child as unknown as ChildProcess,
      token: "00000000-0000-4000-8000-000000000001",
      projectRoot: root,
      timeoutMs: 20,
      pollIntervalMs: 1,
      fetchImpl: healthyUnrelatedServer,
    });
    child.exitCode = 1;
    child.emit("exit", 1, null);

    await expect(readiness).rejects.toThrow("exited before proving readiness");
    expect(requests).toBe(0);
  });

  it("accepts readiness only when token, PID, project, URL, and workflow match", async () => {
    const root = await temporaryRoot();
    const child = new FakeChild(process.pid);
    const token = "00000000-0000-4000-8000-000000000002";
    const url = "http://127.0.0.1:8787";
    const readiness = waitForOwnedWorkflowApi({
      url,
      child: child as unknown as ChildProcess,
      token,
      projectRoot: root,
      timeoutMs: 20,
      pollIntervalMs: 1,
      fetchImpl: async () => new Response(JSON.stringify({
        items: [{ workflow: { kind: "decision-brief", version: 1 } }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    child.emit("message", { kind: "arkimux-local-ready", token, pid: process.pid, projectRoot: root, url });

    await expect(readiness).resolves.toBe(url);
  });

  it("authorizes the owned child after an initial authorization request was lost", async () => {
    const root = await temporaryRoot();
    const child = new FakeChild(process.pid);
    const token = "00000000-0000-4000-8000-000000000006";
    const url = "http://127.0.0.1:8787";
    const canonicalRoot = await realpath(root);
    child.emit("message", {
      kind: "arkimux-local-awaiting-authorization",
      token,
      pid: process.pid,
      projectRoot: root,
      url,
    });
    child.onSend = (message) => {
      queueMicrotask(() => child.emit("message", {
        kind: "arkimux-local-ready",
        token,
        pid: process.pid,
        projectRoot: canonicalRoot,
        url,
      }));
      expect(message).toEqual({
        kind: "arkimux-local-start-authorized",
        token,
        pid: process.pid,
        projectRoot: canonicalRoot,
        url,
      });
    };

    const readiness = waitForOwnedWorkflowApi({
      url,
      child: child as unknown as ChildProcess,
      token,
      projectRoot: root,
      timeoutMs: 50,
      pollIntervalMs: 1,
      fetchImpl: async () => new Response(JSON.stringify({
        items: [{ workflow: { kind: "decision-brief", version: 1 } }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      authorizeStart: true,
    });
    child.emit("message", {
      kind: "arkimux-local-awaiting-authorization",
      token,
      pid: process.pid,
      projectRoot: root,
      url,
    });
    await expect(readiness).resolves.toBe(url);
    expect(child.sentMessages).toHaveLength(1);
  });

  it.each([
    ["http://127.0.0.1:49152", true],
    ["http://127.0.0.1:0", false],
    ["http://127.0.0.1:65536", false],
    ["http://example.com:49152", false],
    ["http://127.0.0.1:49152/path", false],
  ])("checks the assigned debug URL %s before making any HTTP request", async (boundUrl, accepted) => {
    const root = await temporaryRoot();
    const child = new FakeChild(process.pid);
    const identity = { token: randomUUID(), pid: process.pid, projectRoot: root };
    const fetchImpl = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({
      items: [{ workflow: { kind: "decision-brief", version: 1 } }],
    })));
    const readiness = waitForOwnedWorkflowApi({
      ...identity, child: child as unknown as ChildProcess,
      url: "http://127.0.0.1:0", automaticPort: true, authorizeStart: true,
      timeoutMs: 100, fetchImpl,
    });
    child.emit("message", { ...identity, kind: "arkimux-local-awaiting-authorization", url: "http://127.0.0.1:0" });
    child.emit("message", { ...identity, kind: "arkimux-local-ready", url: boundUrl });
    if (accepted) {
      await expect(readiness).resolves.toBe(boundUrl);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${boundUrl}/api/v1/workflows`);
    } else {
      await expect(readiness).rejects.toThrow("does not match");
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("keeps the private server behind authorization and parent-disconnect guards", async () => {
    await expect(readFile(path.resolve("cli/scaffold/scripts/serve-local.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    const source = await readFile(path.resolve("cli/src/localServer.ts"), "utf8");
    const authorization = source.indexOf("await waitForStartAuthorization(");
    const listen = source.indexOf("await createLocalDevelopmentServer({");

    expect(authorization).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(authorization);
    expect(source).toContain('process.once("disconnect", closeIfParentDisconnects)');
    expect(source).toContain("activeServer?.close()");
    expect(source).toContain('process.once("SIGTERM", close)');
    expect(source).toContain("activeServer.recover()");
    expect(source).toContain("setInterval(sendAuthorizationRequest, 100)");
    expect(source).toContain("The ArkiMux CLI did not authorize local startup within 30 seconds");
  });

  it("uses the same startup deadline for a health request that never completes", async () => {
    const root = await temporaryRoot();
    const child = new FakeChild(process.pid);
    const token = "00000000-0000-4000-8000-000000000004";
    const url = "http://127.0.0.1:8787";
    const startedAt = Date.now();
    const readiness = waitForOwnedWorkflowApi({
      url,
      child: child as unknown as ChildProcess,
      token,
      projectRoot: root,
      timeoutMs: 30,
      pollIntervalMs: 1,
      fetchImpl: async () => new Promise<Response>(() => undefined),
    });
    child.emit("message", { kind: "arkimux-local-ready", token, pid: process.pid, projectRoot: root, url });

    await expect(readiness).rejects.toThrow("did not become ready");
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("uses the same startup deadline when the health response body never completes", async () => {
    const root = await temporaryRoot();
    const child = new FakeChild(process.pid);
    const token = "00000000-0000-4000-8000-000000000005";
    const url = "http://127.0.0.1:8787";
    const startedAt = Date.now();
    const readiness = waitForOwnedWorkflowApi({
      url,
      child: child as unknown as ChildProcess,
      token,
      projectRoot: root,
      timeoutMs: 30,
      pollIntervalMs: 1,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => new Promise<never>(() => undefined),
      }) as unknown as Response,
    });
    child.emit("message", { kind: "arkimux-local-ready", token, pid: process.pid, projectRoot: root, url });

    await expect(readiness).rejects.toThrow("did not become ready");
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it.each([
    ["token", { token: "00000000-0000-4000-8000-000000000099" }],
    ["PID", { pid: process.pid + 1 }],
    ["project root", { projectRoot: "/not-the-project" }],
    ["URL", { url: "http://127.0.0.1:9999" }],
  ])("rejects a startup IPC message with the wrong %s", async (_field, changed) => {
    const root = await temporaryRoot();
    const child = new FakeChild(process.pid);
    const token = "00000000-0000-4000-8000-000000000003";
    const url = "http://127.0.0.1:8787";
    const readiness = waitForOwnedWorkflowApi({
      url,
      child: child as unknown as ChildProcess,
      token,
      projectRoot: root,
      timeoutMs: 20,
      pollIntervalMs: 1,
      fetchImpl: async () => new Response(null, { status: 200 }),
    });
    child.emit("message", {
      kind: "arkimux-local-ready",
      token,
      pid: process.pid,
      projectRoot: root,
      url,
      ...changed,
    });

    await expect(readiness).rejects.toThrow("does not match the newly spawned process and project");
  });

  it("reports an occupied port as a clear startup failure", () => {
    expect(describeLocalStartupFailure({
      error: new Error("Local server exited before proving readiness (status 1)."),
      port: 8799,
      logPath: "/tmp/local-server.log",
      logOutput: "Error: listen EADDRINUSE: address already in use 127.0.0.1:8799",
    }).message).toBe([
      "Local server could not start.",
      "Port 8799 is already in use.",
      "Stop the existing ArkiMux server or start this project with another port.",
    ].join("\n"));
  });
});

class FakeChild extends EventEmitter {
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  connected = true;
  readonly sentMessages: unknown[] = [];
  onSend?: (message: unknown) => void;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  disconnect(): void {
    this.connected = false;
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sentMessages.push(message);
    this.onSend?.(message);
    callback?.(null);
    return true;
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-cli-test-"));
  temporaryRoots.push(root);
  return root;
}

async function currentProjectRoot(): Promise<string> {
  const root = await temporaryRoot();
  await mkdir(path.join(root, ".arkimux/local/processes"), { recursive: true });
  await writeFile(path.join(root, ".arkimux/project.json"), JSON.stringify({
    schemaVersion: 2,
    kind: "arkimux-project",
  }));
  return root;
}

async function validGeneratedProject(mutation: {
  dependency?: string;
  lockCliVersion?: string;
  workflowRegistry?: string;
  reverseLockOrder?: boolean;
} = {}): Promise<string> {
  const root = await temporaryRoot();
  const workflowRegistry = mutation.workflowRegistry ?? "src/arkimux.workflows.ts";
  const dependencies = { zod: mutation.dependency ?? "4.4.3" };
  const devDependencies = { "@com-pyvue/arkimux": "0.1.0-alpha.9", typescript: "5.9.3" };
  const lockedDevDependencies = mutation.reverseLockOrder
    ? { typescript: "5.9.3", "@com-pyvue/arkimux": "0.1.0-alpha.9" }
    : devDependencies;
  await mkdir(path.join(root, ".arkimux"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, ".arkimux/project.json"), JSON.stringify({
    schemaVersion: 2,
    kind: "arkimux-project",
    projectName: "my-agent-app",
    workflowRegistry,
  }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "my-agent-app",
    private: true,
    scripts: {
      dev: "arkimux local start",
      "dev:stop": "arkimux local stop",
      validate: "npm run typecheck && arkimux project validate && npm test",
    },
    dependencies,
    devDependencies,
  }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      "": { dependencies, devDependencies: lockedDevDependencies },
      "node_modules/@com-pyvue/arkimux": { version: mutation.lockCliVersion ?? "0.1.0-alpha.9" },
    },
  }));
  await writeFile(path.join(root, "src/arkimux.workflows.ts"), [
    "export const workflowDeclarations = [];",
    "export async function loadProjectWorkflows() {",
    "  return [];",
    "}",
  ].join("\n"));
  return root;
}

async function projectFileContents(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else result[path.relative(root, absolute)] = await readFile(absolute, "utf8");
    }
  }
  await visit(root);
  return result;
}

function fakeModuleUrl(root: string): string {
  return new URL(`file://${path.join(root, "dist/cli.js")}`).href;
}

async function prepareMinimalCandidatePackage(packageRoot: string): Promise<void> {
  const packageFiles = ["core.tgz", "local.tgz", "run-contract.tgz"];
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await mkdir(path.join(packageRoot, "scaffold"), { recursive: true });
  await mkdir(path.join(packageRoot, "scaffold/.agents/skills/arkimux-workflow-debugger"), { recursive: true });
  await mkdir(path.join(packageRoot, "packages"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "@com-pyvue/arkimux", version: "0.1.0-alpha.8",
  }));
  await writeFile(path.join(packageRoot, "scaffold/package.json"), JSON.stringify({
    name: "__PROJECT_NAME__",
    private: true,
    generatorVersion: "__CLI_VERSION__",
  }));
  await writeFile(path.join(packageRoot, "scaffold/.agents/skills/arkimux-workflow-debugger/SKILL.md"), [
    "---",
    "name: arkimux-workflow-debugger",
    "description: Test fixture for hidden scaffold directory copying.",
    "---",
  ].join("\n"));
  await writeFile(path.join(packageRoot, "packages/candidate-packages.json"), JSON.stringify({
    schemaVersion: 1,
    packages: [
      { name: "@com-pyvue/agent-execution-core", version: "0.0.0", file: packageFiles[0], integrity: "sha512-test" },
      { name: "@com-pyvue/agent-execution-local", version: "0.0.0", file: packageFiles[1], integrity: "sha512-test" },
      { name: "@com-pyvue/agent-execution-run-contract", version: "0.0.0", file: packageFiles[2], integrity: "sha512-test" },
    ],
  }));
  await Promise.all(packageFiles.map((file) => writeFile(path.join(packageRoot, "packages", file), "test package")));
}
