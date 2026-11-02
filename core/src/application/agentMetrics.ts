import type {
  AgentExecutionMetrics,
  AgentUsage,
  AuthAvailability,
} from "./agentProvider.ts";
import {
  nonNegativeInteger,
  nonNegativeNumber,
  positiveInteger,
  record,
  requiredString,
  safeIdentifier,
} from "./recordValidation.ts";
import { assertExactKeys } from "../domain/validation.ts";

const metricStatuses = new Set<AgentExecutionMetrics["status"]>(["complete", "failed", "timed-out"]);
const toolCallUnits = new Set<AgentExecutionMetrics["toolCallUnit"]>([
  "shell-command",
  "guarded-repository-operation",
  "native-tool-call",
]);

export function validateAgentExecutionMetrics(value: unknown): AgentExecutionMetrics {
  const metrics = record(value, "Agent execution metrics");
  const required = [
    "providerId",
    "status",
    "elapsedMs",
    "artifacts",
    "nativeToolCalls",
    "toolCallUnit",
  ];
  const optional = [
    "label",
    "attempt",
    "model",
    "reasoningEffort",
    "repositorySearchCalls",
    "fileReadCalls",
    "repositoryResultBytes",
    "rejectedRepositoryCalls",
    "usage",
  ];
  assertExactKeys(metrics, required, "Agent execution metrics", [...required, ...optional]);
  safeIdentifier(metrics.providerId, "Agent execution metrics.providerId");
  if (typeof metrics.status !== "string" || !metricStatuses.has(metrics.status as AgentExecutionMetrics["status"])) {
    throw new Error("Agent execution metrics.status is unsupported.");
  }
  nonNegativeInteger(metrics.elapsedMs, "Agent execution metrics.elapsedMs");
  nonNegativeInteger(metrics.nativeToolCalls, "Agent execution metrics.nativeToolCalls");
  if (typeof metrics.toolCallUnit !== "string" || !toolCallUnits.has(metrics.toolCallUnit as AgentExecutionMetrics["toolCallUnit"])) {
    throw new Error("Agent execution metrics.toolCallUnit is unsupported.");
  }
  if (metrics.attempt !== undefined) positiveInteger(metrics.attempt, "Agent execution metrics.attempt");
  for (const key of ["label", "model", "reasoningEffort"] as const) {
    if (metrics[key] !== undefined) requiredString(metrics[key], `Agent execution metrics.${key}`);
  }
  for (const key of [
    "repositorySearchCalls",
    "fileReadCalls",
    "repositoryResultBytes",
    "rejectedRepositoryCalls",
  ] as const) {
    if (metrics[key] !== undefined) nonNegativeInteger(metrics[key], `Agent execution metrics.${key}`);
  }
  validateAgentExecutionArtifacts(metrics.artifacts);
  if (metrics.usage !== undefined) validateAgentUsage(metrics.usage);
  return structuredClone(metrics) as unknown as AgentExecutionMetrics;
}

export function validateAuthAvailability(value: unknown): AuthAvailability {
  const auth = record(value, "Run event.auth");
  assertExactKeys(
    auth,
    ["authProviderId", "kind", "available"],
    "Run event.auth",
    [
      "authProviderId",
      "kind",
      "available",
      "status",
      "reason",
      "identity",
      "executable",
      "remediation",
      "message",
    ],
  );
  safeIdentifier(auth.authProviderId, "Run event.auth.authProviderId");
  if (!["runtime-native", "environment", "command", "stored-credential"].includes(auth.kind as string)) {
    throw new Error("Run event.auth.kind is unsupported.");
  }
  if (typeof auth.available !== "boolean") throw new Error("Run event.auth.available must be boolean.");
  if (auth.status !== undefined && !["ready", "unavailable", "indeterminate"].includes(auth.status as string)) {
    throw new Error("Run event.auth.status is unsupported.");
  }
  if (auth.reason !== undefined && ![
    "session-missing",
    "session-rejected",
    "plan-or-billing-required",
    "credential-invalid",
    "provider-unavailable",
    "unknown",
  ].includes(auth.reason as string)) {
    throw new Error("Run event.auth.reason is unsupported.");
  }
  if (auth.identity !== undefined) {
    const identity = record(auth.identity, "Run event.auth.identity");
    assertExactKeys(identity, [], "Run event.auth.identity", ["authMethod", "accountEmail", "reportedPlan"]);
    for (const key of ["authMethod", "accountEmail", "reportedPlan"] as const) {
      if (identity[key] !== undefined) requiredString(identity[key], `Run event.auth.identity.${key}`);
    }
  }
  if (auth.executable !== undefined) {
    const executable = record(auth.executable, "Run event.auth.executable");
    assertExactKeys(executable, ["path"], "Run event.auth.executable", ["path", "version"]);
    requiredString(executable.path, "Run event.auth.executable.path");
    if (executable.version !== undefined) requiredString(executable.version, "Run event.auth.executable.version");
  }
  if (auth.remediation !== undefined) {
    if (!Array.isArray(auth.remediation)) throw new Error("Run event.auth.remediation must be an array.");
    for (const [index, value] of auth.remediation.entries()) {
      const remediation = record(value, `Run event.auth.remediation[${index}]`);
      assertExactKeys(remediation, ["kind", "label"], `Run event.auth.remediation[${index}]`);
      if (!["login", "upgrade", "configure-api-key", "retry"].includes(remediation.kind as string)) {
        throw new Error(`Run event.auth.remediation[${index}].kind is unsupported.`);
      }
      requiredString(remediation.label, `Run event.auth.remediation[${index}].label`);
    }
  }
  if (auth.message !== undefined) requiredString(auth.message, "Run event.auth.message");
  return structuredClone({
    ...auth,
    status: auth.status ?? (auth.available ? "ready" : "unavailable"),
  }) as unknown as AuthAvailability;
}

function validateAgentUsage(value: unknown): AgentUsage {
  const usage = record(value, "Agent usage");
  const tokenFields = [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
  ] as const;
  assertExactKeys(usage, [], "Agent usage", [...tokenFields, "cost"]);
  for (const field of tokenFields) {
    if (usage[field] !== undefined) nonNegativeInteger(usage[field], `Agent usage.${field}`);
  }
  if (usage.cost !== undefined) {
    const cost = record(usage.cost, "Agent usage.cost");
    assertExactKeys(cost, ["amount", "currency", "kind"], "Agent usage.cost");
    nonNegativeNumber(cost.amount, "Agent usage.cost.amount");
    if (typeof cost.currency !== "string" || !/^[A-Z]{3}$/.test(cost.currency)) {
      throw new Error("Agent usage.cost.currency must be an uppercase ISO-4217 code.");
    }
    if (cost.kind !== "provider-estimate" && cost.kind !== "billed") {
      throw new Error("Agent usage.cost.kind must be provider-estimate or billed.");
    }
  }
  return structuredClone(usage) as unknown as AgentUsage;
}

function validateAgentExecutionArtifacts(value: unknown): void {
  const artifacts = record(value, "Agent execution artifacts");
  const required = ["eventsPath", "stderrPath", "lastMessagePath", "heartbeatPath"];
  assertExactKeys(
    artifacts,
    required,
    "Agent execution artifacts",
    [...required, "repositoryToolAuditPath"],
  );
  for (const key of [...required, "repositoryToolAuditPath"]) {
    if (artifacts[key] !== undefined) requiredString(artifacts[key], `Agent execution artifacts.${key}`);
  }
}
