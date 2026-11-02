import type { AgentRunPolicy } from "./agentProvider.ts";

export interface AgentPolicyProvider<TAgentId extends string, TContext = unknown> {
  resolve(agentId: TAgentId, context: TContext): Promise<AgentRunPolicy>;
}

export function createStaticAgentPolicyProvider<TAgentId extends string, TContext = unknown>(
  agents: Record<TAgentId, AgentRunPolicy>,
): AgentPolicyProvider<TAgentId, TContext> {
  const policies = structuredClone(agents);
  return {
    async resolve(agentId: TAgentId, _context: TContext): Promise<AgentRunPolicy> {
      return structuredClone(policies[agentId]);
    },
  };
}
