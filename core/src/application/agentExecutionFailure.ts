import type { AgentExecutionMetrics } from "./agentProvider.ts";
import { ExternalProviderError, type ExternalProviderErrorOptions } from "./externalError.ts";

/** ArkiMux classifications, independent of provider-native diagnostic codes. */
export type AgentExecutionFailureCode = "agent_cancelled" | "agent_timed_out" | "agent_provider_failed";

export class AgentProviderFailure extends ExternalProviderError {
  readonly failureCode: AgentExecutionFailureCode;

  constructor(provider: string, message: string, options: ExternalProviderErrorOptions & {
    status?: AgentExecutionMetrics["status"];
    failureCode?: AgentExecutionFailureCode;
  } = {}) {
    const { status, failureCode, ...externalOptions } = options;
    super(provider, message, externalOptions);
    this.name = "AgentProviderFailure";
    this.failureCode = failureCode ?? (status === "timed-out" ? "agent_timed_out" : "agent_provider_failed");
  }
}

/** Cancellation before dispatch has no provider diagnostic or fabricated metrics. */
export class AgentExecutionCancelledError extends Error {
  readonly failureCode = "agent_cancelled" as const;

  constructor() {
    super("Agent execution was cancelled.");
    this.name = "AgentExecutionCancelledError";
  }
}
