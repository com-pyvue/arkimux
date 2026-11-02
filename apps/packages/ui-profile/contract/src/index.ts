import { z } from "zod";

export const agentExecutionUiProfileSchema = z.enum([
  "workflow-development",
  "platform",
]);

export const agentExecutionUiFeatureSchema = z.enum([
  "runs",
  "run-comparison",
  "users",
  "roles",
  "agent-templates",
  "agent-authentication",
  "organizations",
  "environments",
  "workflows",
]);

export const agentExecutionUiConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  profile: agentExecutionUiProfileSchema,
  features: z.array(agentExecutionUiFeatureSchema),
}).strict();

export type AgentExecutionUiProfile = z.infer<typeof agentExecutionUiProfileSchema>;
export type AgentExecutionUiFeature = z.infer<typeof agentExecutionUiFeatureSchema>;
export type AgentExecutionUiConfiguration = z.infer<typeof agentExecutionUiConfigurationSchema>;

const featuresByProfile: Readonly<Record<AgentExecutionUiProfile, readonly AgentExecutionUiFeature[]>> = {
  "workflow-development": ["runs", "agent-authentication", "agent-templates", "workflows"],
  platform: [
    "users",
    "roles",
    "agent-templates",
    "agent-authentication",
    "organizations",
    "environments",
    "workflows",
    "run-comparison",
  ],
};

export function resolveAgentExecutionUiProfile(
  value: string | undefined,
  defaultProfile: AgentExecutionUiProfile,
): AgentExecutionUiProfile {
  return agentExecutionUiProfileSchema.parse(value ?? defaultProfile);
}

export function agentExecutionUiConfiguration(
  profile: AgentExecutionUiProfile,
): AgentExecutionUiConfiguration {
  return {
    schemaVersion: 1,
    profile,
    features: [...featuresByProfile[profile]],
  };
}

export function validateAgentExecutionUiConfiguration(
  value: unknown,
): AgentExecutionUiConfiguration {
  const parsed = agentExecutionUiConfigurationSchema.parse(value);
  const expected = agentExecutionUiConfiguration(parsed.profile);
  if (JSON.stringify(parsed.features) !== JSON.stringify(expected.features)) {
    throw new Error(`UI features do not match profile ${parsed.profile}.`);
  }
  return parsed;
}
