import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_CASES_FILE_VARIABLE,
  LIVE_MODE_VARIABLE,
  loadProviderLiveSuite,
  managedV2ProviderReleaseProfile,
  parseProviderLiveSuite,
  providerConfigForLiveCase,
  selectedLiveEnvironment,
  type ProviderLiveCase,
} from "../live/liveCaseConfig.ts";
import { providerEvidenceFor } from "../live/liveEvidence.ts";

const temporaryDirectories: string[] = [];
type EnvironmentProviderLiveCase = ProviderLiveCase & {
  auth: Extract<ProviderLiveCase["auth"], { kind: "environment" }>;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("live provider case safety", () => {
  it("requires an explicit case file before any provider call", async () => {
    await expect(loadProviderLiveSuite({})).rejects.toThrow(
      `${LIVE_CASES_FILE_VARIABLE} must point to an explicit live-case JSON file`,
    );
  });

  it("accepts the exact Managed V2 provider release profile", () => {
    const definition = releaseDefinition();
    expect(parseProviderLiveSuite(definition, repositoryFixturePath())).toMatchObject({
      mode: "release",
      requiredCaseIds: Object.keys(managedV2ProviderReleaseProfile.cases),
    });
  });

  it("rejects a partial provider set in release mode", () => {
    const definition = releaseDefinition();
    definition.requiredCaseIds = definition.requiredCaseIds.slice(0, 1);
    definition.cases = definition.cases.slice(0, 1);
    expect(() => parseProviderLiveSuite(definition, repositoryFixturePath())).toThrow(
      `release mode requires the exact ${managedV2ProviderReleaseProfile.profileId} cases`,
    );
  });

  it("rejects release cases that change the provider, credential target, or CLI pin", () => {
    const definition = releaseDefinition();
    const target = definition.cases.find(({ caseId }) => caseId === "pi-anthropic-api-key")!;
    target.auth.targetVariable = "WRONG_KEY";
    expect(() => parseProviderLiveSuite(definition, repositoryFixturePath())).toThrow(
      "release case pi-anthropic-api-key must match its checked-in provider, API-key target, and CLI version profile",
    );
  });

  it("requires Claude's native budget to enforce the reported-cost threshold", () => {
    const definition = liveDefinition(claudeCase());
    definition.cases[0]!.parameters["max-budget-usd"] = 0.06;
    expect(() => parseProviderLiveSuite(definition, repositoryFixturePath())).toThrow(
      "parameters.max-budget-usd must be positive and no greater than maxReportedCostUsd",
    );
  });

  it("isolates API-key cases from native session homes", () => {
    const testCase = codexCase();
    const root = path.join(os.tmpdir(), "arkimux-live-isolated-contract");
    const environment = selectedLiveEnvironment(testCase, root, {
      PATH: "/safe/bin",
      HOME: "/native/home",
      CODEX_HOME: "/native/codex",
      OPENAI_PROVIDER_TEST_KEY: "selected-secret",
      UNRELATED_SECRET: "must-not-pass",
    });
    expect(environment).toMatchObject({
      PATH: "/safe/bin",
      HOME: path.join(root, "home"),
      CODEX_HOME: path.join(root, "codex"),
      OPENAI_PROVIDER_TEST_KEY: "selected-secret",
    });
    expect(environment).not.toHaveProperty("UNRELATED_SECRET");
    expect(providerConfigForLiveCase(testCase, root).executionProviders["codex-cli"])
      .toMatchObject({ parentHome: path.join(root, "codex") });
  });

  it("checks every configured credential before suite execution", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arkimux-live-config-contract-"));
    temporaryDirectories.push(directory);
    const definitionPath = path.join(directory, "cases.json");
    await fs.writeFile(definitionPath, JSON.stringify(liveDefinition(codexCase())), "utf8");
    await expect(loadProviderLiveSuite({
      [LIVE_CASES_FILE_VARIABLE]: definitionPath,
      [LIVE_MODE_VARIABLE]: "live",
    })).rejects.toThrow("Configured live provider credentials are missing");
  });

  it("requires a release case file to live inside the tracked repository", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arkimux-release-config-contract-"));
    temporaryDirectories.push(directory);
    const definitionPath = path.join(directory, "release.json");
    const definition = releaseDefinition();
    await fs.writeFile(definitionPath, JSON.stringify(definition), "utf8");
    const environment: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      [LIVE_CASES_FILE_VARIABLE]: definitionPath,
      [LIVE_MODE_VARIABLE]: "release",
    };
    for (const testCase of definition.cases) {
      environment[testCase.auth.sourceVariable] = "fixture-secret";
    }
    await expect(loadProviderLiveSuite(environment)).rejects.toThrow(
      "requires its case file to be tracked in this repository",
    );
  });

  it("keeps raw output, artifact contents, paths, and credentials out of evidence", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "arkimux-live-evidence-contract-"));
    temporaryDirectories.push(directory);
    const secret = "provider-secret-that-must-not-be-retained";
    const artifactPath = path.join(directory, "native-output-with-sensitive-path.jsonl");
    await fs.writeFile(artifactPath, `raw ${secret}\n`, "utf8");
    const definition = parseProviderLiveSuite(
      liveDefinition(serializableCase(codexCase())),
      repositoryFixturePath(),
    );
    const liveCase = definition.cases[0]!;
    const evidence = await providerEvidenceFor({
      definition,
      liveCase,
      status: "passed",
      startedAt: "2026-08-29T00:00:00.000Z",
      elapsedMs: 10,
      observedVersion: "codex-cli 0.145.0",
      output: `ARKIMUX_PROVIDER_CONFORMANCE_OK ${secret}`,
      credentialValues: [secret],
      metrics: {
        providerId: "codex-cli",
        model: liveCase.model,
        status: "complete",
        elapsedMs: 10,
        nativeToolCalls: 0,
        toolCallUnit: "shell-command",
        artifacts: {
          eventsPath: artifactPath,
          stderrPath: artifactPath,
          lastMessagePath: artifactPath,
          heartbeatPath: artifactPath,
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(artifactPath);
    expect(serialized).not.toContain("OPENAI_PROVIDER_TEST_KEY");
    expect(serialized).toContain("OPENAI_API_KEY");
  });
});

function liveDefinition(testCase: ReturnType<typeof serializableCase>) {
  return {
    schemaVersion: 1 as const,
    mode: "live" as const,
    conformanceSetId: "provider-live-contract",
    arkimuxRevision: "working-tree",
    evidenceDirectory: "./evidence",
    requiredCaseIds: [testCase.caseId],
    cases: [testCase],
  };
}

function releaseDefinition() {
  const cases = [codexCase(), piOpenAiCase(), piAnthropicCase(), claudeCase()]
    .map(serializableCase);
  return {
    schemaVersion: 1 as const,
    mode: "release" as const,
    conformanceSetId: managedV2ProviderReleaseProfile.profileId,
    arkimuxRevision: "a".repeat(40),
    evidenceDirectory: "./evidence",
    requiredCaseIds: cases.map(({ caseId }) => caseId),
    cases,
  };
}

function codexCase(): EnvironmentProviderLiveCase {
  return environmentCase({
    caseId: "codex-openai-api-key",
    executionProviderId: "codex-cli",
    modelProvider: "openai",
    model: "gpt-5.6-luna",
    requiredVersion: "0.145.0",
    authProviderId: "codex-openai-api-key",
    sourceVariable: "OPENAI_PROVIDER_TEST_KEY",
    targetVariable: "OPENAI_API_KEY",
    parameters: { model: "gpt-5.6-luna", model_reasoning_effort: "low" },
  });
}

function piOpenAiCase(): EnvironmentProviderLiveCase {
  return environmentCase({
    caseId: "pi-openai-api-key",
    executionProviderId: "pi-cli",
    modelProvider: "openai",
    model: "gpt-5.6-luna",
    requiredVersion: "0.84.3",
    authProviderId: "pi-openai-api-key",
    sourceVariable: "OPENAI_PROVIDER_TEST_KEY",
    targetVariable: "OPENAI_API_KEY",
    parameters: { provider: "openai", model: "gpt-5.6-luna", thinking: "low" },
  });
}

function piAnthropicCase(): EnvironmentProviderLiveCase {
  return environmentCase({
    caseId: "pi-anthropic-api-key",
    executionProviderId: "pi-cli",
    modelProvider: "anthropic",
    model: "claude-sonnet-4-5",
    requiredVersion: "0.84.3",
    authProviderId: "pi-anthropic-api-key",
    sourceVariable: "ANTHROPIC_PROVIDER_TEST_KEY",
    targetVariable: "ANTHROPIC_API_KEY",
    parameters: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "low" },
  });
}

function claudeCase(): EnvironmentProviderLiveCase {
  return environmentCase({
    caseId: "claude-anthropic-api-key",
    executionProviderId: "claude-code-cli",
    modelProvider: "anthropic",
    model: "haiku",
    requiredVersion: "2.1.241",
    authProviderId: "claude-code-anthropic-api-key",
    sourceVariable: "ANTHROPIC_PROVIDER_TEST_KEY",
    targetVariable: "ANTHROPIC_API_KEY",
    parameters: {
      model: "haiku",
      effort: "low",
      "permission-mode": "plan",
      "max-budget-usd": 0.05,
    },
  });
}

function environmentCase(input: {
  caseId: string;
  executionProviderId: ProviderLiveCase["executionProviderId"];
  modelProvider: string;
  model: string;
  requiredVersion: string;
  authProviderId: string;
  sourceVariable: string;
  targetVariable: string;
  parameters: ProviderLiveCase["parameters"];
}): EnvironmentProviderLiveCase {
  return {
    caseId: input.caseId,
    required: true,
    executionProviderId: input.executionProviderId,
    modelProvider: input.modelProvider,
    model: input.model,
    runtime: { command: `/absolute/${input.executionProviderId}`, requiredVersion: input.requiredVersion },
    auth: {
      kind: "environment",
      authProviderId: input.authProviderId,
      sourceVariable: input.sourceVariable,
      targetVariable: input.targetVariable,
    },
    parameters: input.parameters,
    timeoutMs: 30_000,
    maxReportedCostUsd: 0.05,
    maxNativeToolCalls: 0,
    requiredUsageFields: ["inputTokens", "outputTokens"],
  };
}

function serializableCase(testCase: EnvironmentProviderLiveCase) {
  return JSON.parse(JSON.stringify(testCase)) as EnvironmentProviderLiveCase;
}

function repositoryFixturePath(): string {
  return path.resolve("test/provider-conformance/live/cases.contract-fixture.json");
}
