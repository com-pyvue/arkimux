import type { ProviderParameterValue } from "../../application/agentProvider.ts";

export function codexConfigArguments(
  parameters: Record<string, ProviderParameterValue> | undefined,
): string[] {
  return Object.entries(parameters ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => ["--config", `${key}=${JSON.stringify(value)}`]);
}
