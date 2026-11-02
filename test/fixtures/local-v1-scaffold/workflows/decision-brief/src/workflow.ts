import {
  runStructuredAgent,
  type AgentExecutionProviderRegistry,
  type AgentRunPolicy,
  type RunEvent,
  type RunEventSink,
} from "@com-pyvue/agent-execution-core";
import { validateDecisionBriefResult, type DecisionBriefInput, type DecisionBriefResult } from "./contract.js";
import { decisionBriefPrompt } from "./prompt.js";

export async function runDecisionBriefWorkflow(dependencies: {
  cwd: string;
  artifactPrefix: string;
  policy: AgentRunPolicy;
  executionProviders: AgentExecutionProviderRegistry;
  events: RunEventSink<RunEvent>;
}, input: DecisionBriefInput): Promise<DecisionBriefResult> {
  return validateDecisionBriefResult(await runStructuredAgent({
    executionProviders: dependencies.executionProviders,
    events: dependencies.events,
  }, {
    stageId: "author-decision-brief",
    logicalAgentId: "decision-author",
    label: "Decision Brief author",
    cwd: dependencies.cwd,
    prompt: decisionBriefPrompt(input),
    artifactPrefix: dependencies.artifactPrefix,
    policy: dependencies.policy,
  }));
}
