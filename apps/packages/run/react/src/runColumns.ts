import { useMemo, useState } from "react";
import type { RunSummaryField } from "@com-pyvue/agent-execution-run-contract";

export const configurableRunColumns = [
  { id: "status", label: "Status" },
  { id: "workflow", label: "Workflow" },
  { id: "user", label: "User" },
  { id: "role", label: "Role" },
  { id: "provider", label: "Provider" },
  { id: "model", label: "Model" },
  { id: "totalElapsedMs", label: "Total time" },
  { id: "createdAt", label: "Created" },
  { id: "inputTokens", label: "Input tokens" },
  { id: "cachedInputTokens", label: "Cached input tokens" },
  { id: "outputTokens", label: "Output tokens" },
  { id: "reasoningOutputTokens", label: "Reasoning tokens" },
  { id: "costs", label: "Cost" },
  { id: "toolCalls", label: "Tool calls" },
  { id: "searchCalls", label: "Search calls" },
  { id: "reasoningEffort", label: "Reasoning effort" },
  { id: "speed", label: "Speed" },
] as const;

export type ConfigurableRunColumnId = typeof configurableRunColumns[number]["id"];

export const defaultRunColumns: ConfigurableRunColumnId[] = ["status", "workflow", "user", "createdAt"];
export const workflowDevelopmentRunColumns: ConfigurableRunColumnId[] = [
  "status",
  "workflow",
  "provider",
  "model",
  "totalElapsedMs",
  "createdAt",
];
const validColumnIds = new Set<ConfigurableRunColumnId>(configurableRunColumns.map(({ id }) => id));
const summaryColumnIds = new Set<RunSummaryField>([
  "totalElapsedMs",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "costs",
  "toolCalls",
  "searchCalls",
  "provider",
  "model",
  "reasoningEffort",
  "speed",
]);

export function summaryFieldsForColumns(columns: readonly ConfigurableRunColumnId[]): RunSummaryField[] {
  return columns.filter((column): column is RunSummaryField => summaryColumnIds.has(column as RunSummaryField));
}

export function useRunColumnPreferences(
  sessionKey: string,
  defaults: readonly ConfigurableRunColumnId[] = defaultRunColumns,
) {
  const storageKey = useMemo(() => `agent-execution.run-columns.v2.${sessionKey}`, [sessionKey]);
  const [columns, setColumnsState] = useState<ConfigurableRunColumnId[]>(() => loadColumns(storageKey, defaults));
  const setColumns = (next: ConfigurableRunColumnId[]) => {
    const normalized = configurableRunColumns.map(({ id }) => id).filter((id) => next.includes(id));
    setColumnsState(normalized);
    browserStorage()?.setItem(storageKey, JSON.stringify(normalized));
  };
  return { columns, setColumns };
}

function loadColumns(storageKey: string, defaults: readonly ConfigurableRunColumnId[]): ConfigurableRunColumnId[] {
  try {
    const parsed = JSON.parse(browserStorage()?.getItem(storageKey) ?? "null") as unknown;
    if (
      Array.isArray(parsed)
      && parsed.every((value): value is ConfigurableRunColumnId => typeof value === "string" && validColumnIds.has(value as ConfigurableRunColumnId))
      && new Set(parsed).size === parsed.length
    ) return parsed;
  } catch {
    // Invalid browser preferences are replaced by defaults.
  }
  return configurableRunColumns.map(({ id }) => id).filter((id) => defaults.includes(id));
}

function browserStorage(): Storage | undefined {
  const storage = Reflect.get(globalThis, "localStorage") as Partial<Storage> | undefined;
  return typeof storage?.getItem === "function" && typeof storage.setItem === "function"
    ? storage as Storage
    : undefined;
}
