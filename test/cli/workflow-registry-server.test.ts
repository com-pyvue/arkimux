import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLocalDevelopmentServer } from "../../local/src/developmentServer.ts";
import { bootstrapLocalOperator } from "../../apps/hosts/api/src/localOperatorBootstrap.ts";
import type { LocalWorkflowRegistration } from "../../local/src/index.ts";

// Source tests have no bundled sibling config/web directories. Keep the real HTTP,
// authorization, file stores and dispatcher, replacing config paths and omitting static assets.
vi.mock("../../local/src/staticWeb.ts", () => ({ mountLocalWebApplication: vi.fn() }));
vi.mock("../../apps/hosts/api/src/localFilesystemHost.ts", async importOriginal => {
  const original = await importOriginal<typeof import("../../apps/hosts/api/src/localFilesystemHost.ts")>();
  return { ...original, createLocalFilesystemAgentExecutionApiHost: (options: Parameters<typeof original.createLocalFilesystemAgentExecutionApiHost>[0]) =>
    original.createLocalFilesystemAgentExecutionApiHost({ ...options,
      applicationConfigurationRoot: path.resolve("apps/config/application-hosts"),
      platformConfigurationDirectory: path.resolve("apps/config/platform-configurations"),
      platformStoreConfigurationRoot: path.resolve("apps/config"),
    }) };
});

const roots: string[] = [], hosts: Awaited<ReturnType<typeof createLocalDevelopmentServer>>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function gate() {
  let release!: () => void;
  return { promise: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
}
function fixture(kind: string, generation = "first") {
  const workflow = { kind, version: 1 }, execute = vi.fn(async () => {});
  const registration: LocalWorkflowRegistration = { workflow, title: `${kind}-${generation}`, agentSlots: [], inputExample: {},
    validateInput: value => value, execute,
    reserve: vi.fn(async request => ({ executionId: request.requestedExecutionId ?? `${kind}-${generation}` })),
    runConfigurationValidator: { workflow, validate: (value, expectedId) => {
      const definition = value as { workflow: typeof workflow; configurationId: string; generation: string };
      if (definition.generation !== generation || (expectedId && expectedId !== definition.configurationId)) throw new Error("Wrong configuration generation.");
      return definition;
    } },
  };
  return { registration, execute };
}
async function setup(onWorkflowRoleChanged?: (roleId: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "registry-server-")); roots.push(root);
  await bootstrapLocalOperator(["--repository-root", root, "--subject-id", "fixture-subject", "--user-id", "local-developer",
    "--role-family", "arkimux-workflow-developer", "--role-preset", "local-workflow-developer",
    "--permission", "workflow:weather:start", "--permission", "workflow:weather:configure"], root, {});
  const first = fixture("weather"), prepareBuild = vi.fn(async () => { throw new Error("No retained construction in this fixture."); });
  const admission = { workflowIds: [], prepareBuild }, background = vi.fn();
  const host = await createLocalDevelopmentServer({ repositoryRoot: root, subjectId: "fixture-subject", workflows: [first.registration],
    retainedAdmission: admission, workflowReload: true, onWorkflowRoleChanged,
    port: 0, environment: { PATH: "" }, onBackgroundError: background });
  hosts.push(host);
  const request = (route: string, body?: object) => fetch(`${host.url}${route}`, body === undefined ? undefined
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const catalog = async () => (await (await request("/api/v1/workflows")).json()).items as { workflow: { kind: string }; title: string; allowedRoleIds: string[] }[];
  const configuration = (kind: string, generation: string, id = `${kind}-${generation}-v1`) => ({ definition: { workflow: { kind, version: 1 }, configurationId: id, generation } });
  const publish = (kind: string, generation: string) => request(`/api/v1/workflows/${kind}/1/run-configurations`, configuration(kind, generation));
  const submit = async (kind: string, generation: string, executionId = `${kind}-run`) => {
    const workflow = (await catalog()).find(value => value.workflow.kind === kind)!;
    return request("/api/v1/runs", { workflow: { kind, version: 1 }, roleId: workflow.allowedRoleIds[0],
      runConfigurationId: `${kind}-${generation}-v1`, input: {}, requestedExecutionId: executionId });
  };
  const replace = async (registrations: LocalWorkflowRegistration[]) => {
    const candidate = await host.workflowReload!.prepareCandidate(registrations, admission);
    return host.workflowReload!.activateCandidate(candidate);
  };
  return { root, first, host, request, catalog, configuration, publish, submit, replace, admission, prepareBuild, background };
}

describe("workflow registry reload through the Local HTTP host", () => {
  it("replaces catalog, configuration validation and exact workflow permissions at the same address", async () => {
    const f = await setup(), address = f.host.url;
    expect((await f.catalog()).map(value => value.title)).toEqual(["weather-first"]);
    expect((await f.publish("weather", "first")).status).toBe(200);
    expect((await f.publish("vendor", "first")).status).toBe(403);
    const weather = fixture("weather", "second"), vendor = fixture("vendor");
    expect(await f.replace([weather.registration, vendor.registration])).toBe(true);
    expect(f.host.url).toBe(address);
    expect((await f.catalog()).map(value => value.title)).toEqual(["vendor-first", "weather-second"]);
    expect(await (await f.request("/arkimux/workflow-registry")).json()).toEqual({ revision: 2, status: "ready" });
    expect((await f.request("/api/v1/workflows/weather/1/run-configurations/validation", f.configuration("weather", "first"))).status).toBe(400);
    expect((await f.publish("weather", "second")).status).toBe(200);
    expect((await f.publish("vendor", "first")).status).toBe(200);
    const assignmentRoot = path.join(f.root, ".arkimux/local/configuration/assignments/local-developer");
    expect(await readdir(assignmentRoot)).toEqual(["arkimux-workflow-developer-v2.json"]);
    await f.replace([vendor.registration]);
    expect((await f.catalog()).map(value => value.workflow.kind)).toEqual(["vendor"]);
    expect((await f.request("/api/v1/workflows/weather/1/run-configurations/validation", f.configuration("weather", "second"))).status).toBe(403);
    const role = JSON.parse(await readFile(path.join(f.root, ".arkimux/local/configuration/roles/arkimux-workflow-developer-v3.json"), "utf8"));
    expect(role.permissions).toContain("workflow:vendor:start");
    expect(role.permissions).not.toContain("workflow:weather:start");
    expect(f.prepareBuild).not.toHaveBeenCalled();
    expect(f.background).not.toHaveBeenCalled();
  });

  it("leaves the last-good workflow runnable after rejecting an invalid candidate before its first Run", async () => {
    const f = await setup(), invalid = fixture("vendor");
    invalid.registration.runConfigurationValidator.workflow = { kind: "different", version: 1 };
    await expect(f.host.workflowReload!.prepareCandidate([invalid.registration], f.admission)).rejects.toThrow("identities differ");
    f.host.workflowReload!.failed();
    expect(await (await f.request("/arkimux/workflow-registry")).json()).toMatchObject({ revision: 1, status: "error" });
    expect((await f.publish("weather", "first")).status).toBe(200);
    expect((await f.submit("weather", "first")).status).toBe(202);
    await vi.waitFor(() => expect(f.first.execute).toHaveBeenCalledOnce());
    expect((await f.catalog()).map(value => value.title)).toEqual(["weather-first"]);
    expect(f.background).not.toHaveBeenCalled();
  });

  it("returns only safe source diagnostic fields over HTTP and clears them after a successful reload", async () => {
    const f = await setup();
    const diagnostic = { kind: "source" as const, code: "TS1109", message: "Expression expected.",
      file: "src/workflow-registry.ts", line: 7, column: 12 };
    const reported = { ...diagnostic, stack: "SECRET_STACK", raw: "SECRET_SOURCE" };
    f.host.workflowReload!.failed(false, reported);
    const status = await (await f.request("/arkimux/workflow-registry")).json();
    expect(status).toMatchObject({ revision: 1, status: "error", restartRequired: false });
    expect(status.diagnostic).toEqual(diagnostic);
    expect(JSON.stringify(status)).not.toContain("SECRET");
    expect((await f.publish("weather", "first")).status).toBe(200);
    expect((await f.submit("weather", "first")).status).toBe(202);
    await vi.waitFor(() => expect(f.first.execute).toHaveBeenCalledOnce());
    expect((await f.catalog()).map(value => value.title)).toEqual(["weather-first"]);
    await f.replace([fixture("weather", "second").registration]);
    expect(await (await f.request("/arkimux/workflow-registry")).json()).toEqual({ revision: 2, status: "ready" });
    expect(f.background).not.toHaveBeenCalled();
  });

  it("reports waiting while real queued execution is active, then publishes after it finishes", async () => {
    const f = await setup(), entered = gate(), finish = gate();
    f.first.execute.mockImplementationOnce(async () => { entered.release(); await finish.promise; });
    expect((await f.publish("weather", "first")).status).toBe(200);
    expect((await f.submit("weather", "first")).status).toBe(202);
    await entered.promise;
    const replacement = f.replace([fixture("vendor").registration]);
    try {
      await vi.waitFor(async () => expect(await (await f.request("/arkimux/workflow-registry")).json()).toMatchObject({ revision: 1, status: "waiting" }));
      expect((await f.catalog()).map(value => value.title)).toEqual(["weather-first"]);
    } finally { finish.release(); }
    expect(await replacement).toBe(true);
    expect((await f.catalog()).map(value => value.title)).toEqual(["vendor-first"]);
    expect(f.background).not.toHaveBeenCalled();
  });

  it("keeps reservation and queued execution on the original generation while a submit request is paused", async () => {
    const f = await setup(), entered = gate(), finish = gate(), replacementWorkflow = fixture("weather", "second");
    const originalReserve = f.first.registration.reserve;
    f.first.registration.reserve = async request => { entered.release(); await finish.promise; return originalReserve(request); };
    expect((await f.publish("weather", "first")).status).toBe(200);
    const submitted = f.submit("weather", "first"); await entered.promise;
    const replacement = f.replace([replacementWorkflow.registration]);
    try { await vi.waitFor(() => expect(f.host.workflowReload!.status().status).toBe("waiting")); }
    finally { finish.release(); }
    expect((await submitted).status).toBe(202);
    expect(await replacement).toBe(true);
    expect(f.first.execute).toHaveBeenCalledOnce();
    expect(replacementWorkflow.execute).not.toHaveBeenCalled();
    expect(f.background).not.toHaveBeenCalled();
  });

  it("gates API access until the CLI role callback finishes and then publishes matching permissions", async () => {
    const roleChanged = vi.fn(async (_roleId: string) => {});
    const f = await setup(roleChanged), entered = gate(), finish = gate();
    expect(roleChanged).toHaveBeenLastCalledWith("arkimux-workflow-developer-v1");
    roleChanged.mockImplementationOnce(async () => { entered.release(); await finish.promise; });
    const replacement = f.replace([fixture("vendor").registration]);
    await entered.promise;
    let answered = false;
    const catalog = f.catalog().then(value => { answered = true; return value; });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(answered).toBe(false);
      expect(f.host.workflowReload!.status().revision).toBe(1);
    } finally { finish.release(); }
    expect(await replacement).toBe(true);
    expect(await catalog).toMatchObject([{ workflow: { kind: "vendor" }, allowedRoleIds: ["arkimux-workflow-developer-v2"] }]);
    expect(roleChanged).toHaveBeenLastCalledWith("arkimux-workflow-developer-v2");
  });

  it("restores old permissions and leaves the original registry usable when the CLI role callback fails", async () => {
    const roleChanged = vi.fn(async (_roleId: string) => {}), f = await setup(roleChanged);
    roleChanged.mockRejectedValueOnce(new Error("The owned process record could not be updated."));
    await expect(f.replace([fixture("vendor").registration])).rejects.toThrow();
    expect(f.host.workflowReload!.status()).toMatchObject({ revision: 1, status: "error" });
    expect(f.host.workflowReload!.status().restartRequired).not.toBe(true);
    expect(await f.catalog()).toMatchObject([{ workflow: { kind: "weather" }, allowedRoleIds: ["arkimux-workflow-developer-v1"] }]);
    expect(await readdir(path.join(f.root, ".arkimux/local/configuration/assignments/local-developer"))).toEqual(["arkimux-workflow-developer-v1.json"]);
    expect((await f.publish("vendor", "first")).status).toBe(403);
    expect((await f.publish("weather", "first")).status).toBe(200);
    expect((await f.submit("weather", "first")).status).toBe(202);
    await vi.waitFor(() => expect(f.first.execute).toHaveBeenCalledOnce());
  });

  it("restores the CLI role when a candidate becomes invalid after its permissions changed", async () => {
    const roleChanged = vi.fn(async (_roleId: string) => {}), f = await setup(roleChanged);
    const candidate = await f.host.workflowReload!.prepareCandidate([fixture("vendor").registration], f.admission);
    let checks = 0;
    candidate.validate = async () => { if (++checks === 2) throw new Error("The source changed during role reconciliation."); };
    await expect(f.host.workflowReload!.activateCandidate(candidate)).rejects.toThrow("source changed");
    expect(roleChanged.mock.calls.map(([role]) => role)).toEqual([
      "arkimux-workflow-developer-v1", "arkimux-workflow-developer-v2", "arkimux-workflow-developer-v1",
    ]);
    expect(await f.catalog()).toMatchObject([{ workflow: { kind: "weather" }, allowedRoleIds: ["arkimux-workflow-developer-v1"] }]);
    expect((await f.publish("vendor", "first")).status).toBe(403);
  });
});
