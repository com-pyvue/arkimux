import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentExecutionToolMetrics,
  PiAgentExtensionProvider,
  PreparedPiAgentExtension,
} from "@com-pyvue/agent-execution-core";
import {
  GUARDED_REPOSITORY_TOOL_NAMES,
  prepareGuardedRepositoryExtension,
} from "./guardedRepositoryTools.ts";

function numberField(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

export function summarizeGuardedRepositoryToolAudit(
  content: string,
): AgentExecutionToolMetrics | undefined {
  const metrics: AgentExecutionToolMetrics = {
    nativeToolCalls: 0,
    toolCallUnit: "guarded-repository-operation",
    repositorySearchCalls: 0,
    fileReadCalls: 0,
    repositoryResultBytes: 0,
    rejectedRepositoryCalls: 0,
  };
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof entry.tool !== "string"
        || !GUARDED_REPOSITORY_TOOL_NAMES.includes(
          entry.tool as typeof GUARDED_REPOSITORY_TOOL_NAMES[number],
        )
      ) {
        continue;
      }
      metrics.nativeToolCalls += 1;
      if (["repo_list", "repo_search"].includes(entry.tool)) {
        metrics.repositorySearchCalls = (metrics.repositorySearchCalls ?? 0) + 1;
      }
      if (["repo_read", "repo_batch_read"].includes(entry.tool)) {
        metrics.fileReadCalls = (metrics.fileReadCalls ?? 0) + 1;
      }
      if (entry.status === "rejected") {
        metrics.rejectedRepositoryCalls = (metrics.rejectedRepositoryCalls ?? 0) + 1;
      }
      if (entry.status === "complete") {
        metrics.repositoryResultBytes = (metrics.repositoryResultBytes ?? 0)
          + (numberField(entry, "resultBytes") ?? 0);
      }
    } catch {
      // Audit metrics are diagnostic; one malformed record must not fail discovery.
    }
  }
  return metrics.nativeToolCalls === 0 ? undefined : metrics;
}

export class GuardedRepositoryPiExtensionProvider implements PiAgentExtensionProvider {
  async prepare(context: {
    cwd: string;
    agentDirectory: string;
    artifactPrefix: string;
  }): Promise<PreparedPiAgentExtension> {
    const auditPath = `${context.artifactPrefix}.repository-tools.jsonl`;
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    await fs.writeFile(auditPath, "", "utf8");
    const extensionPath = await prepareGuardedRepositoryExtension(context.agentDirectory);

    return {
      arguments: [
        "--extension", extensionPath,
        "--tools", GUARDED_REPOSITORY_TOOL_NAMES.join(","),
      ],
      environment: {
        CODE_CAPABILITIES_SNAPSHOT_ROOT: context.cwd,
        CODE_CAPABILITIES_REPOSITORY_TOOL_AUDIT: auditPath,
      },
      artifacts: { repositoryToolAuditPath: auditPath },
      collectToolMetrics: async () => fs.readFile(auditPath, "utf8")
        .then(summarizeGuardedRepositoryToolAudit)
        .catch(() => undefined),
      dispose: async () => undefined,
    };
  }
}
