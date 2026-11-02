import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type {
  AgentExecutionArtifacts,
  AgentExecutionMetrics,
  AgentUsage,
} from "../../../core/src/index.ts";
import type { ProviderLiveCase, ProviderLiveSuite } from "./liveCaseConfig.ts";

export type EvidenceFailurePhase =
  | "configuration"
  | "executable-preflight"
  | "provider-preflight"
  | "provider-run"
  | "assertion";

export interface ProviderEvidenceInput {
  definition: ProviderLiveSuite;
  liveCase: ProviderLiveCase;
  status: "passed" | "failed";
  startedAt: string;
  elapsedMs: number;
  observedVersion?: string;
  metrics?: AgentExecutionMetrics;
  output?: string;
  credentialValues?: readonly string[];
  failure?: {
    phase: EvidenceFailurePhase;
    code: string;
  };
}

interface RedactedArtifactEvidence {
  role: keyof AgentExecutionArtifacts;
  available: boolean;
  bytes?: number;
  sha256?: string;
}

export async function providerEvidenceFor(
  input: ProviderEvidenceInput,
): Promise<Record<string, unknown>> {
  const { definition, liveCase, metrics } = input;
  const safeOutput = input.output === undefined
    ? undefined
    : redactCredentials(Buffer.from(input.output, "utf8"), input.credentialValues ?? []);
  return {
    schemaVersion: 1,
    evidenceKind: "agent-provider-live-conformance",
    conformanceSetId: definition.conformanceSetId,
    mode: definition.mode,
    arkimuxRevision: definition.arkimuxRevision,
    caseId: liveCase.caseId,
    required: liveCase.required,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: input.elapsedMs,
    host: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
    },
    execution: {
      executionProviderId: liveCase.executionProviderId,
      modelProvider: liveCase.modelProvider,
      model: liveCase.model,
      authKind: liveCase.auth.kind,
      authProviderId: liveCase.auth.authProviderId,
      ...(liveCase.auth.kind === "environment"
        ? { credentialTargetVariable: liveCase.auth.targetVariable }
        : {}),
      requiredRuntimeVersion: liveCase.runtime.requiredVersion,
      ...(input.observedVersion === undefined ? {} : {
        observedVersionSha256: sha256(input.observedVersion),
      }),
    },
    contract: {
      promptId: "exact-marker-no-tools-v1",
      timeoutMs: liveCase.timeoutMs,
      maxReportedCostUsd: liveCase.maxReportedCostUsd,
      maxNativeToolCalls: liveCase.maxNativeToolCalls,
      requiredUsageFields: liveCase.requiredUsageFields,
    },
    result: {
      ...(safeOutput === undefined ? {} : {
        canonicalOutputBytes: safeOutput.byteLength,
        canonicalOutputSha256: sha256(safeOutput),
      }),
      ...(metrics === undefined ? {} : {
        providerId: metrics.providerId,
        model: metrics.model,
        status: metrics.status,
        elapsedMs: metrics.elapsedMs,
        nativeToolCalls: metrics.nativeToolCalls,
        toolCallUnit: metrics.toolCallUnit,
        usage: redactedUsage(metrics.usage),
        artifacts: await redactedArtifacts(metrics.artifacts, input.credentialValues ?? []),
      }),
    },
    ...(input.failure === undefined ? {} : { failure: input.failure }),
  };
}

function redactedUsage(usage: AgentUsage | undefined): Record<string, unknown> | undefined {
  if (!usage) return undefined;
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.cachedInputTokens === undefined ? {} : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.reasoningOutputTokens === undefined ? {} : {
      reasoningOutputTokens: usage.reasoningOutputTokens,
    }),
    ...(usage.cost === undefined ? {} : {
      cost: {
        amount: usage.cost.amount,
        currency: usage.cost.currency,
        kind: usage.cost.kind,
      },
    }),
  };
}

async function redactedArtifacts(
  artifacts: AgentExecutionArtifacts,
  credentialValues: readonly string[],
): Promise<RedactedArtifactEvidence[]> {
  const roles = Object.keys(artifacts) as Array<keyof AgentExecutionArtifacts>;
  return await Promise.all(roles.map(async (role) => {
    const artifactPath = artifacts[role];
    if (typeof artifactPath !== "string") return { role, available: false };
    const content = await readFileWithRetry(artifactPath);
    const redacted = content === undefined ? undefined : redactCredentials(content, credentialValues);
    return redacted === undefined
      ? { role, available: false }
      : { role, available: true, bytes: redacted.byteLength, sha256: sha256(redacted) };
  }));
}

function redactCredentials(content: Buffer, credentialValues: readonly string[]): Buffer {
  let redacted = content.toString("utf8");
  for (const credential of credentialValues) {
    if (credential) redacted = redacted.split(credential).join("[REDACTED]");
  }
  return Buffer.from(redacted, "utf8");
}

async function readFileWithRetry(filePath: string): Promise<Buffer | undefined> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const content = await fs.readFile(filePath).catch(() => undefined);
    if (content !== undefined) return content;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return undefined;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
