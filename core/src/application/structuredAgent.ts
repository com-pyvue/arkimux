import type {
  AgentExecutionMetrics,
  AgentExecutionProviderRegistry,
  AgentExecutionResult,
  AgentRunPolicy,
} from "./agentProvider.ts";
import type { RunEvent } from "./runEvent.ts";
import type { RunEventSink } from "./runLifecycle.ts";
import { publicErrorMessage } from "./externalError.ts";

export interface StructuredAgentRequest {
  stageId: string;
  logicalAgentId: string;
  label: string;
  attempt?: number;
  cwd: string;
  prompt: string;
  artifactPrefix: string;
  policy: AgentRunPolicy;
}

export interface StructuredAgentDependencies {
  executionProviders: AgentExecutionProviderRegistry;
  events: RunEventSink<RunEvent>;
}

export async function runStructuredAgent(
  dependencies: StructuredAgentDependencies,
  request: StructuredAgentRequest,
): Promise<unknown> {
  const providerId = request.policy.execution.provider;
  const attempt = request.attempt ?? 1;
  await dependencies.events.emit({
    type: "agent-started",
    at: now(),
    stageId: request.stageId,
    logicalAgentId: request.logicalAgentId,
    providerId,
    label: request.label,
    attempt,
  });
  let result: AgentExecutionResult;
  try {
    result = await dependencies.executionProviders.get(providerId).run({
      cwd: request.cwd,
      prompt: request.prompt,
      artifactPrefix: request.artifactPrefix,
      label: request.label,
      attempt,
      timeoutMs: request.policy.timeoutMs,
      authProviderId: request.policy.execution.authProvider,
      parameters: request.policy.execution.parameters,
    });
  } catch (error) {
    const message = publicErrorMessage(error, "The agent request failed. Inspect its runtime diagnostics before retrying.");
    const metrics = executionMetricsFromError(error);
    if (metrics?.status === "timed-out") {
      await dependencies.events.emit({
        type: "agent-timed-out",
        at: now(),
        stageId: request.stageId,
        logicalAgentId: request.logicalAgentId,
        providerId,
        message,
        metrics,
      });
    } else {
      const failedMetrics = metrics === undefined
        ? undefined
        : { ...metrics, status: "failed" as const };
      await dependencies.events.emit({
        type: "agent-failed",
        at: now(),
        stageId: request.stageId,
        logicalAgentId: request.logicalAgentId,
        providerId,
        message,
        ...(failedMetrics ? { metrics: failedMetrics } : {}),
      });
    }
    throw error;
  }
  await dependencies.events.emit({
    type: "agent-completed",
    at: now(),
    stageId: request.stageId,
    logicalAgentId: request.logicalAgentId,
    providerId,
    metrics: result.metrics,
  });
  return parseStructuredJsonOutput(request.label, result.output);
}

export function parseStructuredJsonOutput(label: string, output: string): unknown {
  const trimmed = output.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    throw new Error(`${label} did not return valid JSON: ${(error as Error).message}`);
  }
}

function executionMetricsFromError(error: unknown): AgentExecutionMetrics | undefined {
  if (typeof error !== "object" || error === null || !("metrics" in error)) return undefined;
  const metrics = (error as { metrics?: unknown }).metrics;
  return typeof metrics === "object" && metrics !== null
    ? metrics as AgentExecutionMetrics
    : undefined;
}

function now(): string {
  return new Date().toISOString();
}
