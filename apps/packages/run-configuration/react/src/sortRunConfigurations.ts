import type { RunConfigurationDefinitionDto } from "@com-pyvue/agent-execution-run-configuration-contract";

export function newestRunConfigurationsFirst<
  T extends Pick<RunConfigurationDefinitionDto, "configurationId" | "createdAt">,
>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => {
    const leftCreatedAt = timestamp(left.createdAt);
    const rightCreatedAt = timestamp(right.createdAt);
    if (leftCreatedAt !== rightCreatedAt) return rightCreatedAt - leftCreatedAt;
    return left.configurationId.localeCompare(right.configurationId);
  });
}

function timestamp(value: string | undefined): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}
