import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { publishDefaultConfigurations } from "../../cli/src/defaultConfigurationPublication.ts";

const roots: string[] = [];
const url = "http://127.0.0.1:18843";
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const identity = (kind: string, version = 1) => ({ kind, version });
const definition = (kind: string, configurationId: string, version = 1) =>
  ({ schemaVersion: 1, configurationId, workflow: identity(kind, version), agents: {} });
const catalog = (...workflows: ReturnType<typeof identity>[]) => ({
  items: workflows.map(workflow => ({ workflow, title: workflow.kind, inputExample: {}, agentSlots: [], allowedRoleIds: [] })),
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
async function fixture(files: Record<string, unknown>) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "default-publication-")); roots.push(projectRoot);
  for (const [relative, value] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(projectRoot, relative)), { recursive: true });
    await writeFile(path.join(projectRoot, relative), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
  }
  return projectRoot;
}
async function snapshot(root: string, relative = ""): Promise<Record<string, string>> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const result: Record<string, string> = {};
  for (const entry of entries) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(result, await snapshot(root, file));
    else result[file] = (await readFile(path.join(root, file))).toString("base64");
  }
  return result;
}
function server(value: unknown, post = () => json({ ok: true })) {
  return vi.fn<typeof fetch>(async (input, init) => {
    if ((init?.method ?? "GET") === "GET") {
      expect(String(input)).toBe(url + "/api/v1/workflows");
      return json(value);
    }
    expect(init?.method).toBe("POST");
    return post();
  });
}
function posts(fetchImpl: ReturnType<typeof server>) {
  return fetchImpl.mock.calls.filter(([, init]) => init?.method === "POST");
}
const publish = (projectRoot: string, fetchImpl: typeof fetch, deadline = Date.now() + 5_000) =>
  publishDefaultConfigurations({ projectRoot, url, deadline, fetchImpl });

describe("default Run Configuration publication uses exact registered workflow identities", () => {
  it("posts only the active identity, skips a removed workflow and a different version, and preserves every file", async () => {
    const active = definition("counter", "counter-v1"), removed = definition("removed", "removed-v1");
    const oldVersion = definition("counter", "counter-old-v1", 2);
    const root = await fixture({
      "workflows/counter/run-configurations/counter-v1.json": active,
      "workflows/counter/run-configurations/counter-old-v1.json": oldVersion,
      "workflows/removed/run-configurations/removed-v1.json": removed,
      ".arkimux/local/runs/earlier-run/state.json": '{ "status": "waiting_for_input", "keep": true }\n',
      "workflows/removed/manifest.json": '{ "retained": "source stays" }\n',
    });
    const before = await snapshot(root), fetchImpl = server(catalog(identity("counter")));
    const warnings = await publish(root, fetchImpl);
    expect(fetchImpl.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
    expect(posts(fetchImpl)).toHaveLength(1);
    expect(String(posts(fetchImpl)[0]![0])).toBe(url + "/api/v1/workflows/counter/1/run-configurations");
    expect(JSON.parse(String(posts(fetchImpl)[0]![1]!.body))).toEqual({ definition: active });
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("counter@2 is not registered");
    expect(warnings.join("\n")).toContain("removed@1 is not registered");
    expect(warnings.join("\n")).toContain('"workflows/counter/run-configurations/counter-old-v1.json"');
    expect(warnings.join("\n")).toContain('"workflows/removed/run-configurations/removed-v1.json"');
    expect(warnings.join("\n")).not.toContain(root);
    expect(warnings.join("\n")).not.toContain(url);
    expect(await snapshot(root)).toEqual(before);
  });

  it("publishes multiple defaults for exact active IDs and uses definition identity rather than directory names", async () => {
    const first = definition("counter", "counter-one-v1", 3), second = definition("counter", "counter-two-v1", 3);
    const extra = definition("extra", "extra-v1");
    const root = await fixture({
      "workflows/counter/run-configurations/one.json": first,
      "workflows/counter/run-configurations/two.json": second,
      "workflows/directory-is-not-the-id/run-configurations/extra.json": extra,
      "workflows/counter/run-configurations/notes.txt": "Not a default JSON configuration.",
    });
    const fetchImpl = server(catalog(identity("counter", 3), identity("extra")));
    expect(await publish(root, fetchImpl)).toEqual([]);
    const requests = posts(fetchImpl).map(([input, init]) => ({ url: String(input), definition: JSON.parse(String(init!.body)).definition }));
    expect(requests).toHaveLength(3);
    expect(requests).toEqual(expect.arrayContaining([
      { url: url + "/api/v1/workflows/counter/3/run-configurations", definition: first },
      { url: url + "/api/v1/workflows/counter/3/run-configurations", definition: second },
      { url: url + "/api/v1/workflows/extra/1/run-configurations", definition: extra },
    ]));
  });

  it("skips valid defaults when an empty valid catalog has no matching workflow", async () => {
    const root = await fixture({ "workflows/removed/run-configurations/removed-v1.json": definition("removed", "removed-v1") });
    const fetchImpl = server(catalog());
    expect(await publish(root, fetchImpl)).toEqual([
      'Skipped default Run Configuration "workflows/removed/run-configurations/removed-v1.json": removed@1 is not registered.',
    ]);
    expect(posts(fetchImpl)).toEqual([]);
  });

  it.each([400, 403])("does not suppress HTTP %s for a registered workflow", async status => {
    const root = await fixture({ "workflows/counter/run-configurations/counter-v1.json": definition("counter", "counter-v1") });
    const fetchImpl = server(catalog(identity("counter")), () => new Response("Registered configuration rejected.", { status }));
    await expect(publish(root, fetchImpl)).rejects.toThrow(
      "Could not publish the default Run Configuration: HTTP " + status + " Registered configuration rejected.");
    expect(posts(fetchImpl)).toHaveLength(1);
  });

  it.each([403, 500])("fails before any POST when catalog GET returns HTTP %s", async status => {
    const root = await fixture({ "workflows/counter/run-configurations/counter-v1.json": definition("counter", "counter-v1") });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("Catalog unavailable.", { status }));
    await expect(publish(root, fetchImpl)).rejects.toThrow("Could not read the registered workflows: HTTP " + status);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(posts(fetchImpl)).toEqual([]);
  });

  it.each([
    null, {}, { items: {} }, { items: [{ workflow: { kind: "counter", version: 1 } }] },
    catalog(identity("counter", 0)), catalog(identity("../escape")), catalog(identity("counter", 1.5)),
  ])("rejects a malformed catalog without publishing or treating it as an empty registry: %j", async value => {
    const root = await fixture({ "workflows/counter/run-configurations/counter-v1.json": definition("counter", "counter-v1") });
    const fetchImpl = server(value);
    await expect(publish(root, fetchImpl)).rejects.toThrow("invalid workflow catalog");
    expect(posts(fetchImpl)).toEqual([]);
  });

  it("rejects invalid catalog JSON without any POST", async () => {
    const root = await fixture({ "workflows/counter/run-configurations/counter-v1.json": definition("counter", "counter-v1") });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{ broken"));
    await expect(publish(root, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(posts(fetchImpl)).toEqual([]);
  });

  it("rejects invalid default JSON instead of silently skipping the file", async () => {
    const relative = "workflows/removed/run-configurations/broken.json";
    const root = await fixture({ [relative]: "{ invalid JSON" }), fetchImpl = server(catalog());
    await expect(publish(root, fetchImpl)).rejects.toThrow('Invalid JSON in default Run Configuration "' + relative + '"');
    expect(posts(fetchImpl)).toEqual([]);
    expect(await readFile(path.join(root, relative), "utf8")).toBe("{ invalid JSON");
  });

  it.each([
    {}, { workflow: null }, { workflow: { kind: "counter" } }, { workflow: { kind: "", version: 1 } },
    { workflow: { kind: "../counter", version: 1 } }, { workflow: { kind: "counter", version: "1" } },
    { workflow: { kind: "counter", version: 0 } }, { workflow: { kind: "counter", version: 1.5 } },
  ])("rejects a malformed default workflow identity even when it would not match the catalog: %j", async value => {
    const root = await fixture({ "workflows/removed/run-configurations/invalid-v1.json": value }), fetchImpl = server(catalog());
    await expect(publish(root, fetchImpl)).rejects.toThrow("must declare a valid workflow ID and version");
    expect(posts(fetchImpl)).toEqual([]);
  });

  it("does not perform network work after the shared startup deadline has already expired", async () => {
    const root = await fixture({ "workflows/counter/run-configurations/counter-v1.json": definition("counter", "counter-v1") });
    const fetchImpl = server(catalog(identity("counter")));
    await expect(publish(root, fetchImpl, Date.now() - 1)).rejects.toThrow("startup deadline reached");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["fetch", "body"])("bounds a stalled catalog %s by the startup deadline and performs no POST", async phase => {
    const root = await fixture({ "workflows/counter/run-configurations/counter-v1.json": definition("counter", "counter-v1") });
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      signal = init?.signal ?? undefined;
      if (phase === "fetch") return new Promise<Response>(() => {});
      const response = json(catalog(identity("counter")));
      vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
      return response;
    });
    await expect(publish(root, fetchImpl, Date.now() + 100)).rejects.toThrow("startup deadline reached");
    expect(signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(posts(fetchImpl)).toEqual([]);
  });

  it("does not reset the startup deadline between catalog reading and publication", async () => {
    const root = await fixture({ "workflows/counter/run-configurations/counter-v1.json": definition("counter", "counter-v1") });
    const now = Date.now(); let clock = now;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      clock = now + 1_001;
      return json(catalog(identity("counter")));
    });
    await expect(publish(root, fetchImpl, now + 1_000)).rejects.toThrow("startup deadline reached");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(posts(fetchImpl)).toEqual([]);
  });

  it("bounds reading a registered POST failure body by the same startup deadline", async () => {
    const root = await fixture({ "workflows/counter/run-configurations/counter-v1.json": definition("counter", "counter-v1") });
    let postSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method !== "POST") return json(catalog(identity("counter")));
      postSignal = init.signal ?? undefined;
      const response = new Response("pending", { status: 400 });
      vi.spyOn(response, "text").mockImplementation(() => new Promise(() => {}));
      return response;
    });
    await expect(publish(root, fetchImpl, Date.now() + 100)).rejects.toThrow("startup deadline reached");
    expect(posts(fetchImpl)).toHaveLength(1);
    expect(postSignal?.aborted).toBe(true);
  });
});
