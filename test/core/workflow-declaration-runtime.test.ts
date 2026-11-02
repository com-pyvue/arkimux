import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLocalPortableWorkflow } from "../../local/src/portableWorkflow.ts";
import { definePortableWorkflowManifest, runConfigurationContentHash } from "../../core/src/index.ts";
import { ExternalProviderError } from "../../core/src/application/externalError.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "declared-runtime-")); roots.push(root);
  await mkdir(path.join(root, "workflows/probe"), { recursive: true });
  await mkdir(path.join(root, "config"));
  const environment = { schemaVersion: 1 as const, variables: [] };
  await writeFile(path.join(root, "workflows/probe/environment.json"), JSON.stringify(environment));
  await writeFile(path.join(root, "config/agent-providers.default.json"), JSON.stringify({ schemaVersion: 1,
    executionProviders: Object.fromEntries(["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"].map(id => [id, {
      command: path.join(root, `absent-${id}`), heartbeatIntervalMs: 15_000, environmentAllowlist: [],
    }])), authProviders: { "fixture-session": { kind: "runtime-native", runtime: "codex-cli" } },
  }));
  const input = z.object({}).strict();
  const output = z.object({ schemaVersion: z.number().int().positive() }).strict();
  const workflow = { kind: "probe", version: 1 };
  const manifest = definePortableWorkflowManifest({ schemaVersion: 1, workflowId: "probe", workflowMode: "arkimux-portable",
    workflowContractVersion: "1", requiredCapabilities: ["typed-results@1"],
    executionRequirements: { schemaVersion: 1, run: { maxDurationSeconds: 10 }, operations: {} }, sourceBindings: [],
  });
  const definition = (version: number) => ({ workflow, workflowContractVersion: "1", resultKind: "probe.result", input, output,
    execute: async () => ({ schemaVersion: version }),
  });
  const options = { repositoryRoot: root, workflow, title: "Probe", description: "Fixture", input, inputExample: {},
    environment, environmentFile: "workflows/probe/environment.json", agentSlots: [],
    maxDurationMs: 10_000, finalizationReserveMs: 1000, manifest, resultSchemaVersion: 2,
  };
  return { root, options, definition };
}
it("rejects environment mismatch before reading .env or invoking the factory", async () => {
  const { root, options, definition } = await fixture();
  // A directory makes any attempt to read .env fail; mismatch must be detected first.
  await mkdir(path.join(root, ".env"));
  const define = vi.fn(() => definition(2));
  await expect(createLocalPortableWorkflow({ ...options, define, environment: { schemaVersion: 1, variables: [
    { name: "UNDECLARED", required: true, secret: false, type: "string" },
  ] } })).rejects.toThrow("environment options differ");
  expect(define).not.toHaveBeenCalled();
});
it("requires the environment source path for a manifest-backed workflow", async () => {
  const { options, definition } = await fixture();
  await expect(createLocalPortableWorkflow({ ...options, environmentFile: undefined, define: () => definition(2) })).rejects.toThrow("requires environmentFile");
});
it.each([1, 2])("publishes only outputs matching declared version 2 (actual version %i)", async version => {
  const { root, options, definition } = await fixture();
  const workflow = await createLocalPortableWorkflow({ ...options, define: () => definition(version) });
  const configuration = { schemaVersion: 1, configurationId: "probe-v1", workflow: options.workflow, agents: {} };
  const contentHash = runConfigurationContentHash(configuration);
  const actor = { userId: "fixture", roleId: "fixture" };
  const runRef = await workflow.reserve({ workflow: options.workflow, input: {}, actor,
    resolvedConfiguration: { configuration, contentHash }, requestedExecutionId: "version-test" });
  const execute = workflow.execute({ runRef, workflow: options.workflow, input: {}, actor,
    runConfiguration: { configurationId: configuration.configurationId, contentHash } });
  const resultFile = path.join(root, ".arkimux/local/runs/version-test/probe.result.json");
  if (version === 2) {
    await execute;
    expect(JSON.parse(await readFile(resultFile, "utf8")).payload).toEqual({ schemaVersion: 2 });
  } else {
    await expect(execute).rejects.toThrow("The workflow attempt failed.");
    await expect(readFile(resultFile)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

it.each([false, true])("publishes safe portable Run status and failure events, external=%s", async external => {
  const { root, options, definition } = await fixture();
  const failure = external ? new ExternalProviderError("weather", "HTTP 503 [unavailable]. Retry after 12 seconds. opaque-secret",
    { code: "503", secretValues: ["opaque-secret"] }) : new TypeError("private failure /private/runtime opaque-secret");
  const base = definition(2);
  const workflow = await createLocalPortableWorkflow({ ...options, define: () => ({ ...base, execute: async context => {
    await context.steps.run({ schemaVersion: 1, id: "weather", definitionVersion: "1", input: options.input, output: options.input,
      execute: async () => { throw failure; } }, {});
    return { schemaVersion: 2 };
  } }) });
  const configuration = { schemaVersion: 1, configurationId: "probe-v1", workflow: options.workflow, agents: {} };
  const contentHash = runConfigurationContentHash(configuration), actor = { userId: "fixture", roleId: "fixture" };
  const runRef = await workflow.reserve({ workflow: options.workflow, input: {}, actor,
    resolvedConfiguration: { configuration, contentHash }, requestedExecutionId: "failure-test" });
  await expect(workflow.execute({ runRef, workflow: options.workflow, input: {}, actor,
    runConfiguration: { configurationId: configuration.configurationId, contentHash } })).rejects.toThrow();
  const runRoot = path.join(root, ".arkimux/local/runs/failure-test");
  const state = JSON.parse(await readFile(path.join(runRoot, "state/run-status.json"), "utf8"));
  expect(state).toMatchObject({ status: "failed", message: external ? failure.message
    : "The workflow failed. Inspect its runtime diagnostics before retrying." });
  const events = await readFile(path.join(runRoot, "artifacts/events.jsonl"), "utf8");
  if (external) expect(events).toContain("Retry after 12 seconds");
  expect(JSON.stringify(state) + events).not.toMatch(/opaque-secret|private failure|private\/runtime|TypeError/);
});
