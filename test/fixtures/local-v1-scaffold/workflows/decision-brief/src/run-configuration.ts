import type { AgentRunPolicy, WorkflowIdentity } from "@com-pyvue/agent-execution-core";

export interface DecisionBriefRunConfiguration {
  schemaVersion: 1;
  configurationId: string;
  workflow: WorkflowIdentity;
  agents: { "decision-author": AgentRunPolicy };
}

export function validateDecisionBriefRunConfiguration(
  value: unknown,
  expectedConfigurationId?: string,
): DecisionBriefRunConfiguration {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error("Decision Brief run configuration.schemaVersion must be 1.");
  if (typeof value.configurationId !== "string" || !/^[a-z][a-z0-9-]*-v[1-9][0-9]*$/.test(value.configurationId)) {
    throw new Error("Decision Brief run configuration.configurationId must be a versioned ID.");
  }
  if (expectedConfigurationId !== undefined && value.configurationId !== expectedConfigurationId) {
    throw new Error(`Decision Brief run configuration ID must be ${expectedConfigurationId}.`);
  }
  const workflow = isRecord(value.workflow) ? value.workflow : undefined;
  if (workflow?.kind !== "decision-brief" || workflow.version !== 1) {
    throw new Error("Decision Brief run configuration.workflow must be decision-brief@1.");
  }
  const agents = isRecord(value.agents) ? value.agents : undefined;
  const author = agents && isRecord(agents["decision-author"]) ? agents["decision-author"] : undefined;
  if (!author || !Number.isInteger(author.timeoutMs) || Number(author.timeoutMs) <= 0) {
    throw new Error("Decision Brief decision-author.timeoutMs must be a positive integer.");
  }
  const execution = isRecord(author.execution) ? author.execution : undefined;
  if (!execution || execution.provider !== "codex-cli") {
    throw new Error("Local V1 Decision Brief execution.provider must be codex-cli.");
  }
  if (execution.authProvider !== "codex-native-session") {
    throw new Error("Local V1 Decision Brief execution.authProvider must be codex-native-session.");
  }
  if (!isRecord(execution.parameters)) throw new Error("Decision Brief execution.parameters must be an object.");
  return structuredClone(value) as unknown as DecisionBriefRunConfiguration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
