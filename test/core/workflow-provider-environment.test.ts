import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it, expect, vi } from "vitest";
import { z } from "zod";
import { createLocalPortableWorkflow } from "../../local/src/portableWorkflow.ts";
import { runConfigurationContentHash } from "../../core/src/index.ts";

it("keeps workflow-only values out of the actual provider subprocess even if allowlisted", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-provider-env-"));
  const capture = path.join(root, "capture.jsonl");
  try {
    await mkdir(path.join(root, "config"));
    const executable = path.join(root, "fake-codex.mjs");
    await writeFile(executable, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),endpoint:process.env.LJ2_WORKFLOW_ENDPOINT??null,other:process.env.LJ2_UNDECLARED_VALUE??null})+'\\n');\nconsole.log(process.argv.includes('--version')?'codex-cli 0.145.0':'Logged in using ChatGPT');\n`, { mode: 0o700 });
    await writeFile(path.join(root, "config/agent-providers.default.json"), JSON.stringify({ schemaVersion: 1,
      executionProviders: { "codex-cli": { command: executable, heartbeatIntervalMs: 15_000,
        environmentAllowlist: ["PATH", "TMPDIR", "LJ2_WORKFLOW_ENDPOINT"], parentHome: path.join(root, "fake-home") },
        ...Object.fromEntries(["pi-cli", "claude-code-cli", "kimi-code-cli"].map(id => [id, {
          command: path.join(root, `absent-${id}`), heartbeatIntervalMs: 15_000, environmentAllowlist: [],
        }])),
      },
      authProviders: { "codex-native-session": { kind: "runtime-native", runtime: "codex-cli" } },
    }));
    await writeFile(path.join(root, ".env"), "LJ2_WORKFLOW_ENDPOINT=https://workflow.invalid\nLJ2_UNDECLARED_VALUE=not-visible\n");
    vi.stubEnv("LJ2_WORKFLOW_ENDPOINT", "https://ambient.invalid");
    const input = z.object({}).strict();
    let receivedArgumentCount = -1;
    const workflow = await createLocalPortableWorkflow({ repositoryRoot: root, workflow: { kind: "test", version: 1 },
      title: "test", description: "test", input, inputExample: {},
      environment: { schemaVersion: 1, variables: [{ name: "LJ2_WORKFLOW_ENDPOINT", required: true, secret: false, type: "url" }] },
      define() { receivedArgumentCount = arguments.length; return { workflow: { kind: "test", version: 1 }, workflowContractVersion: "1",
        input, output: input, resultKind: "test.result", execute: async () => ({}) }; },
      agentSlots: [{ slotId: "agent", title: "agent", description: "agent", prompt: "fixture" }], maxDurationMs: 10_000, finalizationReserveMs: 1000,
    });
    await workflow.preflight!({ resolvedConfiguration: { configuration: { schemaVersion: 1, configurationId: "test-v1",
      workflow: { kind: "test", version: 1 }, agents: { agent: { timeoutMs: 1000, execution: { provider: "codex-cli",
        authProvider: "codex-native-session", parameters: {} } } } } } } as never);
    expect(receivedArgumentCount).toBe(0);
    const rows = (await readFile(capture, "utf8")).trim().split("\n").map(s => JSON.parse(s));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) { expect(row.endpoint).toBeNull(); expect(row.other).toBeNull(); }
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

it("keeps the classified CLI preflight explanation in a normal Run failure without invoking the provider", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-preflight-error-"));
  const capture = path.join(root, "capture.jsonl");
  try {
    await mkdir(path.join(root, "config"));
    const executable = path.join(root, "fake-codex.mjs");
    await writeFile(executable, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(capture)}, JSON.stringify(process.argv.slice(2))+'\\n');\nif (process.argv.includes('--version')) console.log('codex-cli 0.145.0');\nelse { console.error('Account authorization denied [workspace]. Visit https://provider.test/help and retry after 30 seconds.'); process.exitCode=1; }\n`, { mode: 0o700 });
    await writeFile(path.join(root, "config/agent-providers.default.json"), JSON.stringify({ schemaVersion: 1,
      executionProviders: { "codex-cli": { command: executable, heartbeatIntervalMs: 15_000,
        environmentAllowlist: ["PATH", "TMPDIR"], parentHome: path.join(root, "fake-home") },
        ...Object.fromEntries(["pi-cli", "claude-code-cli", "kimi-code-cli"].map(id => [id, {
          command: path.join(root, `absent-${id}`), heartbeatIntervalMs: 15_000, environmentAllowlist: [],
        }])),
      }, authProviders: { "codex-native-session": { kind: "runtime-native", runtime: "codex-cli" } },
    }));
    const input = z.object({}).strict();
    const executeDefinition = vi.fn(async () => ({}));
    const workflowRef = { kind: "test", version: 1 };
    const workflow = await createLocalPortableWorkflow({ repositoryRoot: root, workflow: workflowRef,
      title: "test", description: "test", input, inputExample: {},
      environment: { schemaVersion: 1, variables: [] },
      define: () => ({ workflow: workflowRef, workflowContractVersion: "1", input, output: input,
        resultKind: "test.result", execute: executeDefinition }),
      agentSlots: [{ slotId: "agent", title: "agent", description: "agent", prompt: "fixture" }],
      maxDurationMs: 10_000, finalizationReserveMs: 1000,
    });
    const configuration = { schemaVersion: 1, configurationId: "test-v1", workflow: workflowRef,
      agents: { agent: { timeoutMs: 1000, execution: { provider: "codex-cli", authProvider: "codex-native-session", parameters: {} } } } };
    const contentHash = runConfigurationContentHash(configuration), actor = { userId: "fixture", roleId: "fixture" };
    const runRef = await workflow.reserve({ workflow: workflowRef, input: {}, actor,
      resolvedConfiguration: { configuration, contentHash }, requestedExecutionId: "preflight-failure" });
    await expect(workflow.execute({ runRef, workflow: workflowRef, input: {}, actor,
      runConfiguration: { configurationId: configuration.configurationId, contentHash } })).rejects.toThrow("retry after 30 seconds");
    const state = JSON.parse(await readFile(path.join(root, ".arkimux/local/runs/preflight-failure/state/run-status.json"), "utf8"));
    expect(state).toMatchObject({ status: "failed", message: expect.stringContaining("Account authorization denied [workspace]") });
    expect(state.message).toContain("https://provider.test/help");
    expect(executeDefinition).not.toHaveBeenCalled();
    const commands: string[][] = (await readFile(capture, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(commands.some(command => command[0] === "login")).toBe(true);
    expect(commands.every(command => command.includes("--version") || command.join(" ") === "login status")).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
