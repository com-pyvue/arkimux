import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalDevelopmentServer } from "../../local/src/developmentServer.ts";
import { startLocalWorkflowDevelopmentServer } from "../../local/src/index.ts";

const hooks = vi.hoisted(() => ({ compose: vi.fn(), recover: vi.fn(), retained: vi.fn() }));
vi.mock("../../local/src/localRetainedServerRuntime.ts", () => ({ createLocalRetainedServerRuntime: hooks.retained }));
vi.mock("../../apps/hosts/api/src/localFilesystemHost.ts", () => ({ createLocalFilesystemAgentExecutionApiHost: hooks.compose }));
vi.mock("../../local/src/localStorePaths.ts", () => ({
  assertLegacyLocalStoreMigrated: vi.fn(),
  resolveLocalFileStorePaths: (projectRoot: string) => ({
    privacy: `${projectRoot}/.arkimux/local/privacy`, diagnostics: `${projectRoot}/.arkimux/local/diagnostics`,
  }),
}));
vi.mock("../../local/src/portableWorkflow.ts", () => ({ recoverPortableWorkflows: hooks.recover, createLocalPortableWorkflow: vi.fn() }));
vi.mock("../../local/src/staticWeb.ts", () => ({ mountLocalWebApplication: vi.fn() }));
vi.mock("../../local/src/resultViews.ts", () => ({ mountLocalResultViews: vi.fn() }));
vi.mock("../../apps/hosts/api/src/server.ts", () => ({ startAgentExecutionApiServer: ({ hostname, port }: { hostname: string; port: number }) =>
  createServer((_req, response) => response.end("ready")).listen(port, hostname) }));

const hosts: Awaited<ReturnType<typeof createLocalDevelopmentServer>>[] = [];
let testRoot: string;
beforeEach(async () => {
  testRoot = await mkdtemp(path.join(os.tmpdir(), "arkimux-local-server-test-"));
  hooks.compose.mockReset().mockResolvedValue({}); hooks.recover.mockReset().mockResolvedValue(undefined); hooks.retained.mockReset();
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.close()));
  await rm(testRoot, { recursive: true, force: true });
});
function options() {
  return { repositoryRoot: testRoot, subjectId: "test-developer", workflows: [], port: 0,
    machineTelemetryRoot: path.join(testRoot, "machine-telemetry"),
    environment: { ARKIMUX_DISABLE_TELEMETRY: "1" },
    resultViewSource: { snapshot: () => ({ revision: 0, status: "unavailable" as const, views: [] }), close: vi.fn().mockResolvedValue(undefined) } };
}

describe("private Local server lifecycle", () => {
  it("supplies the exact bound origin after an ephemeral port is assigned", async () => {
    const host = await createLocalDevelopmentServer(options()); hosts.push(host);
    const getOrigin = hooks.compose.mock.calls[0]![0].localServerOrigin;
    expect(getOrigin()).toBe(host.url);
    expect(getOrigin()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(getOrigin()).not.toBe("http://127.0.0.1:0");
  });
  it("composes retained registrations, skips their legacy recovery, and awaits store teardown", async () => {
    const retained = { workflows: [], retainedRunIds: vi.fn().mockResolvedValue(new Set(["saved-run"])),
      recover: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined),
      inputRequests: { list: vi.fn(), submit: vi.fn() } };
    hooks.retained.mockResolvedValue(retained);
    const host = await createLocalDevelopmentServer({ ...options(), retainedAdmission: { workflowIds: [], prepareBuild: vi.fn() } });
    hosts.push(host);
    expect(hooks.compose).toHaveBeenCalledWith(expect.objectContaining({ inputRequests: retained.inputRequests }));
    expect(retained.recover).not.toHaveBeenCalled();
    await host.recover();
    expect(retained.recover).toHaveBeenCalledTimes(1);
    expect(hooks.recover).toHaveBeenCalledWith([], new Set(["saved-run"]));
    await host.close();
    expect(retained.close).toHaveBeenCalledTimes(1);
  });

  it("releases the retained runtime when startup fails", async () => {
    const retained = { workflows: [], close: vi.fn().mockResolvedValue(undefined) };
    hooks.retained.mockResolvedValue(retained); hooks.compose.mockRejectedValue(new Error("startup failed"));
    await expect(createLocalDevelopmentServer({ ...options(), retainedAdmission: { workflowIds: [], prepareBuild: vi.fn() } })).rejects.toThrow("startup failed");
    expect(retained.close).toHaveBeenCalledTimes(1);
  });

  it("still closes renderer resources when retained shutdown fails", async () => {
    const retained = { workflows: [], close: vi.fn().mockRejectedValue(new Error("store cleanup failed")) };
    hooks.retained.mockResolvedValue(retained);
    const input = options();
    const host = await createLocalDevelopmentServer({ ...input, retainedAdmission: { workflowIds: [], prepareBuild: vi.fn() } });
    await expect(host.close()).rejects.toThrow("store cleanup failed");
    expect(input.resultViewSource.close).toHaveBeenCalledTimes(1);
    expect(host.server.listening).toBe(false);
  });

  it("leaves recovery to its owner and closes the listener and renderers once", async () => {
    const input = options(), host = await createLocalDevelopmentServer(input); hosts.push(host);
    expect(host.url).not.toContain(":0");
    expect(await (await fetch(host.url)).text()).toBe("ready");
    expect(hooks.recover).not.toHaveBeenCalled();
    await Promise.all([host.recover(), host.recover()]);
    expect(hooks.recover).toHaveBeenCalledTimes(1);
    await Promise.all([host.close(), host.close()]);
    expect(host.server.listening).toBe(false);
    expect(input.resultViewSource.close).toHaveBeenCalledTimes(1);
    await expect(host.recover()).rejects.toThrow("closing");
  });

  it("preserves automatic recovery for the existing public server API", async () => {
    const input = options(), host = await startLocalWorkflowDevelopmentServer(input);
    try { expect(hooks.recover).toHaveBeenCalledTimes(1); }
    finally { await new Promise<void>(resolve => host.server.close(() => resolve())); }
    await vi.waitFor(() => expect(input.resultViewSource.close).toHaveBeenCalledTimes(1));
  });

  it("cleans renderer resources when application composition fails", async () => {
    hooks.compose.mockRejectedValue(new Error("configuration unavailable"));
    const input = options();
    await expect(createLocalDevelopmentServer(input)).rejects.toThrow("configuration unavailable");
    expect(input.resultViewSource.close).toHaveBeenCalledTimes(1);
  });

  it("cleans renderer resources when the port is occupied", async () => {
    const first = await createLocalDevelopmentServer(options()); hosts.push(first);
    const input = { ...options(), port: Number(new URL(first.url).port) };
    await expect(createLocalDevelopmentServer(input)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(input.resultViewSource.close).toHaveBeenCalledTimes(1);
    expect(await (await fetch(first.url)).text()).toBe("ready");
  });

  it("preserves both startup and cleanup errors", async () => {
    const startError = new Error("invalid configuration"), cleanupError = new Error("cleanup failed");
    hooks.compose.mockRejectedValue(startError);
    const input = options(); input.resultViewSource.close.mockRejectedValue(cleanupError);
    await expect(createLocalDevelopmentServer(input)).rejects.toMatchObject({ errors: [startError, cleanupError] });
  });

  it("returns recovery failures to its owner without disabling shutdown", async () => {
    hooks.recover.mockRejectedValue(new Error("saved Run unavailable"));
    const host = await createLocalDevelopmentServer(options()); hosts.push(host);
    await expect(host.recover()).rejects.toThrow("saved Run unavailable");
    await expect(host.recover()).rejects.toThrow("saved Run unavailable");
    expect(hooks.recover).toHaveBeenCalledTimes(1);
    await host.close();
  });

  it("awaits renderer cleanup and reports its failure to shutdown", async () => {
    const input = options();
    input.resultViewSource.close.mockRejectedValue(new Error("cleanup failed"));
    const host = await createLocalDevelopmentServer(input);
    await expect(host.close()).rejects.toThrow("cleanup failed");
    expect(host.server.listening).toBe(false);
    await expect(host.close()).rejects.toThrow("cleanup failed");
    expect(input.resultViewSource.close).toHaveBeenCalledTimes(1);
  });
});
