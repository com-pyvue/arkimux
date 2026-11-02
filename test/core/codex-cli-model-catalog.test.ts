import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCodexCliProbeParameters } from "../../core/src/infrastructure/agents/codexCliModelCatalog.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "catalog-identifier", model: "recommended-model", hidden: false, isDefault: true,
    defaultReasoningEffort: "medium", supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Low" }, { reasoningEffort: "medium", description: "Medium" },
    ], inputModalities: ["text", "image"], ...overrides,
  };
}

type Scenario = {
  pages?: unknown[];
  mode?: "rpc-error" | "initialize-error" | "invalid-json" | "wrong-id" | "interaction" | "stall" | "stdout-flood" | "stderr-flood" | "early-exit";
  message?: string;
  descendant?: boolean;
  ignoreTerm?: boolean;
};

async function fixture(scenario: Scenario = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-model-catalog-"));
  roots.push(root);
  const command = path.join(root, "codex");
  await fs.writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const scenario = ${JSON.stringify(scenario)};
fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
fs.writeFileSync('pids.json', JSON.stringify([process.pid]));
if (scenario.ignoreTerm) process.on('SIGTERM', () => {});
if (scenario.descendant) {
  const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {});setInterval(() => {}, 1000)"], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.writeFileSync('pids.json', JSON.stringify([process.pid, descendant.pid]));
}
let page = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync('requests.jsonl', JSON.stringify(request) + '\\n');
  if (request.method === 'initialized') return;
  if (request.method === 'initialize') {
    if (scenario.mode === 'initialize-error') return send({ id: request.id, error: { code: -32000, message: scenario.message } });
    return send({ id: request.id, result: {} });
  }
  if (request.method !== 'model/list') throw new Error('Forbidden method');
  if (scenario.mode === 'rpc-error') return send({ id: request.id, error: { code: -32000, message: scenario.message, data: { private: 'not-a-diagnostic' } } });
  if (scenario.mode === 'invalid-json') return process.stdout.write('not-json-secret\\n');
  if (scenario.mode === 'wrong-id') return send({ id: request.id + 1, result: {} });
  if (scenario.mode === 'interaction') return send({ id: 999, method: 'requestPermission', params: { secret: 'do-not-echo' } });
  if (scenario.mode === 'stdout-flood') return process.stdout.write('x'.repeat(3 * 1024 * 1024));
  if (scenario.mode === 'stderr-flood') return process.stderr.write('x'.repeat(70_000));
  if (scenario.mode === 'early-exit') { process.stderr.write('error: catalog unavailable\\n'); return process.exit(1); }
  if (scenario.mode === 'stall') return;
  const pages = scenario.pages ?? [];
  send({ id: request.id, result: pages[page++] ?? { data: [], nextCursor: null } });
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const options = { command, cwd: root, environment: { PATH: path.dirname(process.execPath) }, timeoutMs: 3_000 };
  return {
    root, options,
    read: async (file: string) => JSON.parse(await fs.readFile(path.join(root, file), "utf8")),
    requests: async () => (await fs.readFile(path.join(root, "requests.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
  };
}

async function assertStopped(pids: number[]) {
  for (const pid of pids) {
    let alive = true;
    for (let tries = 0; tries < 50 && alive; tries++) {
      try { process.kill(pid, 0); await new Promise((resolve) => setTimeout(resolve, 10)); }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
        alive = false;
      }
    }
    expect(alive, `Process ${pid} was left running`).toBe(false);
  }
}

describe("Codex CLI connection probe model catalog", () => {
  it("selects the visible catalog default and advertised low effort with metadata requests only", async () => {
    const cli = await fixture({ pages: [{ data: [model({ isDefault: false, model: "other-model" }), model()], nextCursor: null }] });
    await expect(loadCodexCliProbeParameters(cli.options)).resolves.toEqual({
      model: "recommended-model", model_reasoning_effort: "low",
    });
    expect(await cli.read("args.json")).toEqual(["app-server", "--stdio", "-c", "mcp_servers={}"]);
    expect(await cli.requests()).toEqual([
      { id: 1, method: "initialize", params: { clientInfo: { name: "arkimux_connection_probe", version: "1" } } },
      { method: "initialized" },
      { id: 2, method: "model/list", params: { includeHidden: false, limit: 100 } },
    ]);
    await assertStopped(await cli.read("pids.json"));
  });

  it("uses a changed catalog default without a hardcoded model or cached choice", async () => {
    const first = await fixture({ pages: [{ data: [model({ model: "first-recommendation" })] }] });
    const second = await fixture({ pages: [{ data: [model({ model: "new-recommendation" })] }] });
    expect((await loadCodexCliProbeParameters(first.options)).model).toBe("first-recommendation");
    expect((await loadCodexCliProbeParameters(second.options)).model).toBe("new-recommendation");
  });

  it("reads all pages before selecting and accepts a legacy model without modalities", async () => {
    const cli = await fixture({ pages: [
      { data: [model({ isDefault: false })], nextCursor: "page-two" },
      { data: [model({ inputModalities: undefined })], nextCursor: null },
    ] });
    expect((await loadCodexCliProbeParameters(cli.options)).model).toBe("recommended-model");
    expect((await cli.requests()).at(-1)).toMatchObject({ method: "model/list", params: { cursor: "page-two", includeHidden: false, limit: 100 } });
  });

  it("uses the supported catalog effort when low is not advertised", async () => {
    const cli = await fixture({ pages: [{ data: [model({
      defaultReasoningEffort: "new-effort", supportedReasoningEfforts: [{ reasoningEffort: "new-effort" }],
    })] }] });
    expect(await loadCodexCliProbeParameters(cli.options)).toEqual({ model: "recommended-model", model_reasoning_effort: "new-effort" });
  });

  it.each(["", "opaque cursor / with whitespace"])("preserves the opaque page cursor %j", async (cursor) => {
    const cli = await fixture({ pages: [{ data: [], nextCursor: cursor }, { data: [model()] }] });
    await expect(loadCodexCliProbeParameters(cli.options)).resolves.toMatchObject({ model: "recommended-model" });
    expect((await cli.requests()).at(-1).params.cursor).toBe(cursor);
  });

  it.each([
    { name: "no default", data: [model({ isDefault: false })], error: "no visible default" },
    { name: "hidden-only default", data: [model({ hidden: true })], error: "no visible default" },
    { name: "multiple defaults", data: [model(), model({ model: "second" })], error: "more than one visible default" },
    { name: "malformed flags", data: [model({ isDefault: "yes" })], error: "malformed model entry" },
    { name: "malformed identifier", data: [model({ model: "" })], error: "invalid default model identifier" },
    { name: "missing identifier", data: [model({ model: undefined })], error: "invalid default model identifier" },
    { name: "no text modality", data: [model({ inputModalities: ["audio"] })], error: "text input support" },
    { name: "malformed modalities", data: [model({ inputModalities: null })], error: "text input support" },
    { name: "missing efforts", data: [model({ supportedReasoningEfforts: undefined })], error: "usable reasoning efforts" },
    { name: "malformed effort", data: [model({ supportedReasoningEfforts: ["low"] })], error: "usable reasoning efforts" },
    { name: "unsupported default effort", data: [model({ supportedReasoningEfforts: [{ reasoningEffort: "high" }] })], error: "supported default reasoning effort" },
  ])("rejects $name without inheriting personal settings", async ({ data, error }) => {
    const cli = await fixture({ pages: [{ data }] });
    await expect(loadCodexCliProbeParameters(cli.options)).rejects.toThrow(error);
    expect((await cli.requests()).every((request) => ["initialize", "initialized", "model/list"].includes(request.method))).toBe(true);
    await assertStopped(await cli.read("pids.json"));
  });

  it("ignores a hidden default when a visible default exists", async () => {
    const cli = await fixture({ pages: [{ data: [model({ hidden: true, model: "hidden" }), model()] }] });
    expect((await loadCodexCliProbeParameters(cli.options)).model).toBe("recommended-model");
  });

  it("does not accept a default before checking later pages for ambiguity", async () => {
    const cli = await fixture({ pages: [{ data: [model()], nextCursor: "more" }, { data: [model({ model: "another" })] }] });
    await expect(loadCodexCliProbeParameters(cli.options)).rejects.toThrow("more than one visible default");
  });

  it.each([
    { name: "non-array data", pages: [{ data: {} }], error: "malformed model catalog" },
    { name: "invalid cursor", pages: [{ data: [], nextCursor: 3 }], error: "malformed model catalog" },
    { name: "repeated cursor", pages: [{ data: [], nextCursor: "same" }, { data: [], nextCursor: "same" }], error: "repeated page cursor" },
    { name: "too many pages", pages: Array.from({ length: 26 }, (_, index) => ({ data: [], nextCursor: `page-${index}` })), error: "page limit" },
    { name: "oversized page", pages: [{ data: Array.from({ length: 101 }, () => model({ isDefault: false })) }], error: "malformed model catalog" },
  ])("bounds $name", async ({ pages, error }) => {
    const cli = await fixture({ pages });
    await expect(loadCodexCliProbeParameters(cli.options)).rejects.toThrow(error);
    await assertStopped(await cli.read("pids.json"));
  });

  it.each(["rpc-error", "initialize-error"] as const)("shows a safely extracted %s without raw data or private values", async (mode) => {
    const cli = await fixture({ mode, message: "The model catalog is unavailable for person@example.com. Token 'sk-secret-123' at '/Users/private/customer/config'." });
    let error: unknown;
    try { await loadCodexCliProbeParameters({ ...cli.options, environment: { ...cli.options.environment, CATALOG_AUTH_VALUE: "sk-secret-123" } }); } catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(Error);
    const text = (error as Error).message;
    expect(text).toContain("Codex model discovery failed: The model catalog is unavailable");
    expect(text).not.toMatch(/sk-secret|not-a-diagnostic|"code"/);
    expect(text).toContain("person@example.com");
    expect(text).toContain("/Users/private/customer/config");
  });

  it.each([
    ["invalid-json", "invalid JSON"], ["wrong-id", "unexpected protocol response"],
    ["interaction", "requested interaction"], ["stdout-flood", "output limit"], ["stderr-flood", "output limit"],
  ] as const)("rejects %s and stops the process", async (mode, message) => {
    const cli = await fixture({ mode });
    await expect(loadCodexCliProbeParameters(cli.options)).rejects.toThrow(message);
    await assertStopped(await cli.read("pids.json"));
  });

  it("times out and terminates an unresponsive process and its descendants", async () => {
    const cli = await fixture({ mode: "stall", descendant: true, ignoreTerm: true });
    // Include process startup in the budget: 300 ms can expire before Node
    // writes the PID fixture under load, never exercising descendant cleanup.
    await expect(loadCodexCliProbeParameters(cli.options)).rejects.toThrow("timed out");
    const pids = await cli.read("pids.json");
    expect(pids).toHaveLength(2);
    await assertStopped(pids);
  }, 10_000);

  it("cleans up descendants after successful discovery", async () => {
    const cli = await fixture({ pages: [{ data: [model()] }], descendant: true });
    await expect(loadCodexCliProbeParameters(cli.options)).resolves.toMatchObject({ model: "recommended-model" });
    await assertStopped(await cli.read("pids.json"));
  });

  it("does not hang if the server exits while a descendant retains the pipes", async () => {
    const cli = await fixture({ mode: "early-exit", descendant: true });
    await expect(loadCodexCliProbeParameters(cli.options)).rejects.toThrow("catalog unavailable");
    await assertStopped(await cli.read("pids.json"));
  });

  it("reports a missing executable without exposing its path", async () => {
    await expect(loadCodexCliProbeParameters({ command: "/missing/private/codex", cwd: os.tmpdir(), environment: {}, timeoutMs: 300 }))
      .rejects.toThrow("could not start the configured CLI");
  });

  it("rejects invalid timeouts before starting a process", async () => {
    await expect(loadCodexCliProbeParameters({ command: "never-run", cwd: os.tmpdir(), environment: {}, timeoutMs: 0 }))
      .rejects.toThrow("positive timeout");
  });
});
