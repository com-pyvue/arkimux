import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
  createAgentAuthProviderRegistry,
  createAgentExecutionProviderRegistry,
  probeCliExecutable,
  resolveCliExecutable,
  validateAgentRunPolicy,
  type AgentExecutionMetrics,
  type AgentExecutionProvider,
  type AgentUsage,
} from "../../../core/src/index.ts";
import {
  loadProviderLiveSuite,
  providerConfigForLiveCase,
  selectedLiveEnvironment,
  type ProviderLiveCase,
  type ProviderLiveSuite,
  type RequiredUsageField,
} from "./liveCaseConfig.ts";
import {
  providerEvidenceFor,
  type EvidenceFailurePhase,
} from "./liveEvidence.ts";

const SAFE_PROMPT = [
  "Reply with exactly ARKIMUX_PROVIDER_CONFORMANCE_OK.",
  "Do not use tools, inspect files, run commands, or add any other text.",
].join(" ");
const EXPECTED_OUTPUT = "ARKIMUX_PROVIDER_CONFORMANCE_OK";
const MAX_CANONICAL_OUTPUT_BYTES = 1_024;
const suite = await loadProviderLiveSuite();
const temporaryRoots: string[] = [];
const preparedCases = new Map<string, PreparedLiveCase>();

beforeAll(async () => {
  for (const liveCase of suite.cases) {
    preparedCases.set(liveCase.caseId, await preflightLiveCase(liveCase));
  }
}, Math.max(60_000, suite.cases.length * 25_000));

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => (
    fs.rm(root, { recursive: true, force: true })
  )));
});

describe(`live agent-provider conformance: ${suite.conformanceSetId} (${suite.mode})`, () => {
  for (const liveCase of suite.cases) {
    test(
      liveCase.caseId,
      async () => executeLiveCase(suite, liveCase),
      liveCase.timeoutMs + 55_000,
    );
  }
});

async function executeLiveCase(
  definition: ProviderLiveSuite,
  liveCase: ProviderLiveCase,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const prepared = preparedCases.get(liveCase.caseId);
  if (!prepared) throw safeFailure("configuration", "Suite preflight did not prepare this case.");
  let phase: EvidenceFailurePhase = "provider-run";
  let metrics: AgentExecutionMetrics | undefined;
  let output: string | undefined;

  try {
    try {
      const result = await prepared.provider.run({
        cwd: prepared.root,
        prompt: SAFE_PROMPT,
        timeoutMs: liveCase.timeoutMs,
        authProviderId: liveCase.auth.authProviderId,
        artifactPrefix: prepared.artifactPrefix,
        label: `provider-conformance-${liveCase.caseId}`,
        attempt: 1,
        parameters: liveCase.parameters,
      });
      metrics = result.metrics;
      output = result.output;
    } catch (error) {
      metrics = metricsFromError(error);
      throw safeFailure(
        phase,
        `${liveCase.executionProviderId} invocation failed with ${safeErrorName(error)}. Raw provider output is not copied into conformance evidence.`,
      );
    }

    phase = "assertion";
    assertLiveResult(liveCase, output, metrics);
    const evidence = await providerEvidenceFor({
      definition,
      liveCase,
      status: "passed",
      startedAt,
      elapsedMs: Date.now() - startedMs,
      observedVersion: prepared.observedVersion,
      metrics,
      output,
      credentialValues: selectedCredentialValues(liveCase),
    });
    await writeEvidence(definition, liveCase, evidence);
  } catch (error) {
    const failure = error instanceof SafeLiveFailure
      ? error
      : safeFailure(phase, `Unexpected ${safeErrorName(error)} during ${phase}.`);
    const evidence = await providerEvidenceFor({
      definition,
      liveCase,
      status: "failed",
      startedAt,
      elapsedMs: Date.now() - startedMs,
      observedVersion: prepared.observedVersion,
      metrics,
      output,
      credentialValues: selectedCredentialValues(liveCase),
      failure: { phase: failure.phase, code: failure.code },
    });
    await writeEvidence(definition, liveCase, evidence);
    throw failure;
  }
}

interface PreparedLiveCase {
  root: string;
  artifactPrefix: string;
  observedVersion?: string;
  provider: AgentExecutionProvider;
}

async function preflightLiveCase(liveCase: ProviderLiveCase): Promise<PreparedLiveCase> {
  validateAgentRunPolicy({
    timeoutMs: liveCase.timeoutMs,
    execution: {
      provider: liveCase.executionProviderId,
      authProvider: liveCase.auth.authProviderId,
      parameters: liveCase.parameters,
    },
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `arkimux-provider-${liveCase.caseId}-`));
  temporaryRoots.push(root);
  const isolatedHomeRoot = path.join(root, "isolated-home");
  await Promise.all(["home", "codex", "claude", "pi", "kimi"].map((name) => (
    fs.mkdir(path.join(isolatedHomeRoot, name), { recursive: true, mode: 0o700 })
  )));
  const environment = selectedLiveEnvironment(liveCase, isolatedHomeRoot);
  const executableEnvironment = { ...environment };
  if (liveCase.auth.kind === "environment") {
    delete executableEnvironment[liveCase.auth.sourceVariable];
  }
  const executable = await resolveCliExecutable(
    liveCase.runtime.command,
    root,
    executableEnvironment,
  );
  if (!executable) {
    throw safeFailure(
      "executable-preflight",
      `Configured command for ${liveCase.executionProviderId} is not executable. No provider calls were made.`,
    );
  }
  const executableProbe = await probeCliExecutable(
    executable.command,
    root,
    executableEnvironment,
    5_000,
    liveCase.runtime.requiredVersion,
  );
  if (!executableProbe.available) {
    throw safeFailure(
      "executable-preflight",
      `Configured ${liveCase.executionProviderId} version does not match the case definition. No provider calls were made.`,
    );
  }
  const providerConfig = providerConfigForLiveCase(liveCase, isolatedHomeRoot);
  const provider = createAgentExecutionProviderRegistry(
    providerConfig,
    createAgentAuthProviderRegistry(providerConfig, environment),
    environment,
  ).get(liveCase.executionProviderId);
  const preflight = await provider.preflight({
    cwd: root,
    authProviderId: liveCase.auth.authProviderId,
    parameters: liveCase.parameters,
  });
  if (!preflight.available) {
    throw safeFailure(
      "provider-preflight",
      `Configured ${liveCase.executionProviderId} authentication is unavailable. No provider calls were made.`,
    );
  }
  return {
    root,
    artifactPrefix: path.join(root, "artifacts", "attempt-1"),
    observedVersion: executableProbe.versionOutput,
    provider,
  };
}

function assertLiveResult(
  liveCase: ProviderLiveCase,
  output: string | undefined,
  metrics: AgentExecutionMetrics | undefined,
): asserts metrics is AgentExecutionMetrics {
  if (!metrics) throw safeFailure("assertion", "Provider returned no normalized metrics.");
  if (output?.trim() !== EXPECTED_OUTPUT) {
    throw safeFailure("assertion", "Provider did not return the exact conformance marker.");
  }
  if (Buffer.byteLength(output) > MAX_CANONICAL_OUTPUT_BYTES) {
    throw safeFailure("assertion", "Canonical provider output exceeded the live-smoke byte limit.");
  }
  if (metrics.providerId !== liveCase.executionProviderId) {
    throw safeFailure("assertion", "Normalized provider ID did not match the configured provider.");
  }
  if (metrics.model !== liveCase.model) {
    throw safeFailure("assertion", "Normalized model did not match the configured model.");
  }
  if (metrics.status !== "complete") {
    throw safeFailure("assertion", `Normalized provider status was ${metrics.status}, not complete.`);
  }
  if (metrics.nativeToolCalls > liveCase.maxNativeToolCalls) {
    throw safeFailure(
      "assertion",
      `Provider used ${metrics.nativeToolCalls} native tools; case limit is ${liveCase.maxNativeToolCalls}.`,
    );
  }
  for (const field of liveCase.requiredUsageFields) assertUsageField(metrics.usage, field);
  const cost = metrics.usage?.cost?.amount;
  if (cost !== undefined && cost > liveCase.maxReportedCostUsd) {
    throw safeFailure(
      "assertion",
      `Provider-reported cost exceeded the configured USD ceiling ${liveCase.maxReportedCostUsd}.`,
    );
  }
}

function assertUsageField(usage: AgentUsage | undefined, field: RequiredUsageField): void {
  if (!usage) throw safeFailure("assertion", `Required usage field ${field} was unavailable.`);
  if (field === "cost") {
    if (typeof usage.cost?.amount !== "number" || !Number.isFinite(usage.cost.amount)) {
      throw safeFailure("assertion", "Required usage field cost was unavailable.");
    }
    return;
  }
  const value = usage[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw safeFailure("assertion", `Required usage field ${field} was unavailable.`);
  }
}

async function writeEvidence(
  definition: ProviderLiveSuite,
  liveCase: ProviderLiveCase,
  evidence: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(definition.evidenceDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(definition.evidenceDirectory, `${liveCase.caseId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(temporary, target);
}

function metricsFromError(error: unknown): AgentExecutionMetrics | undefined {
  if (typeof error !== "object" || error === null || !("metrics" in error)) return undefined;
  const metrics = (error as { metrics?: unknown }).metrics;
  if (typeof metrics !== "object" || metrics === null) return undefined;
  return metrics as AgentExecutionMetrics;
}

function selectedCredentialValues(liveCase: ProviderLiveCase): string[] {
  if (liveCase.auth.kind !== "environment") return [];
  const credential = process.env[liveCase.auth.sourceVariable];
  return credential ? [credential] : [];
}

class SafeLiveFailure extends Error {
  readonly code: string;

  constructor(readonly phase: EvidenceFailurePhase, message: string) {
    super(message);
    this.name = "ProviderLiveConformanceFailure";
    this.code = `${phase}-failed`;
  }
}

function safeFailure(phase: EvidenceFailurePhase, message: string): SafeLiveFailure {
  return new SafeLiveFailure(phase, message);
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}
