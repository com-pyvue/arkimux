import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RunApiClient, RunListQueryDto } from "@com-pyvue/agent-execution-run-contract";

export const runQueryKeys = {
  root: ["runs"] as const,
  list: (query: RunListQueryDto) => ["runs", "list", query] as const,
  filterOptions: ["runs", "filter-options"] as const,
  workflows: ["runs", "workflows"] as const,
  detail: (executionId: string) => ["runs", executionId, "detail"] as const,
  artifacts: (executionId: string) => ["runs", executionId, "artifacts"] as const,
  artifactContent: (executionId: string, key: string) => ["runs", executionId, "artifacts", key] as const,
  input: (executionId: string) => ["runs", executionId, "input"] as const,
  inputRequests: (executionId: string) => ["runs", executionId, "input-requests"] as const,
  results: (executionId: string) => ["runs", executionId, "results"] as const,
  result: (executionId: string, resultId: string) => ["runs", executionId, "results", resultId] as const,
  performance: (executionId: string) => ["runs", executionId, "performance"] as const,
  configuration: (executionId: string) => ["runs", executionId, "resolved-configuration"] as const,
  comparison: (executionIds: readonly string[]) => ["runs", "comparison", [...executionIds].sort()] as const,
};

export function useRunList(client: RunApiClient, query: RunListQueryDto) {
  return useQuery({
    queryKey: runQueryKeys.list(query),
    queryFn: () => client.listRuns(query),
    refetchInterval: ({ state }) => runListRefetchInterval(state.data?.items.map((run) => run.status?.status)),
    refetchIntervalInBackground: false,
  });
}

export function useRunFilterOptions(client: RunApiClient) {
  return useQuery({ queryKey: runQueryKeys.filterOptions, queryFn: () => client.getRunFilterOptions() });
}

export function useWorkflows(client: RunApiClient, enabled = true) {
  return useQuery({ queryKey: runQueryKeys.workflows, queryFn: () => client.listWorkflows(), enabled });
}

export function useArchiveRun(client: RunApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (executionId: string) => client.archiveRun(executionId),
    onSuccess: async ({ run }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.root }),
        queryClient.setQueryData(runQueryKeys.detail(run.runRef.executionId), { run }),
      ]);
    },
  });
}

export function useRestoreRun(client: RunApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (executionId: string) => client.restoreRun(executionId),
    onSuccess: async ({ run }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.root }),
        queryClient.setQueryData(runQueryKeys.detail(run.runRef.executionId), { run }),
      ]);
    },
  });
}

export function useRunDetail(client: RunApiClient, executionId: string | undefined, active = true) {
  const queryClient = useQueryClient();
  const previousStatus = useRef<string | undefined>(undefined);
  const query = useQuery({
    queryKey: runQueryKeys.detail(executionId ?? "not-selected"),
    queryFn: () => client.getRun(executionId!),
    enabled: executionId !== undefined && active,
    refetchInterval: ({ state }) => runDetailRefetchInterval(state.data?.run.status?.status),
    refetchIntervalInBackground: false,
  });
  const status = query.data?.run.status?.status;
  useEffect(() => {
    if (executionId && terminal(status) && !terminal(previousStatus.current)) {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.artifacts(executionId) }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.input(executionId) }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.inputRequests(executionId) }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.results(executionId) }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.performance(executionId) }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.configuration(executionId) }),
      ]);
    }
    previousStatus.current = status;
  }, [executionId, queryClient, status]);
  return query;
}

export function useRunArtifacts(client: RunApiClient, executionId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: runQueryKeys.artifacts(executionId ?? "not-selected"),
    queryFn: () => client.listArtifacts(executionId!),
    enabled: executionId !== undefined && enabled,
  });
}

export function useRunArtifactContent(
  client: RunApiClient,
  executionId: string | undefined,
  key: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: runQueryKeys.artifactContent(executionId ?? "not-selected", key ?? "not-selected"),
    queryFn: () => client.getArtifactContent(executionId!, key!),
    enabled: executionId !== undefined && key !== undefined && enabled,
  });
}

export function useRunInput(client: RunApiClient, executionId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: runQueryKeys.input(executionId ?? "not-selected"),
    queryFn: () => client.getInput(executionId!),
    enabled: executionId !== undefined && enabled,
  });
}

export function useRunInputRequests(client: RunApiClient, executionId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: runQueryKeys.inputRequests(executionId ?? "not-selected"),
    queryFn: () => client.listInputRequests(executionId!),
    enabled: executionId !== undefined && enabled,
    refetchInterval: ({ state }) => state.data?.items.some(item => item.status === "pending") ? 2_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function useSubmitRunInput(client: RunApiClient, executionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestId, submission }: { requestId: string; submission: Parameters<RunApiClient["submitInputResponse"]>[2] }) =>
      client.submitInputResponse(executionId, requestId, submission),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.inputRequests(executionId) }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(executionId) }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.performance(executionId) }),
      ]);
    },
  });
}

export function useRunResults(client: RunApiClient, executionId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: runQueryKeys.results(executionId ?? "not-selected"),
    queryFn: () => client.listResults(executionId!),
    enabled: executionId !== undefined && enabled,
  });
}

export function useRunResult(
  client: RunApiClient,
  executionId: string | undefined,
  resultId: string | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: runQueryKeys.result(executionId ?? "not-selected", resultId ?? "not-selected"),
    queryFn: () => client.getResult(executionId!, resultId!),
    enabled: executionId !== undefined && resultId !== undefined && enabled,
  });
}

export function useRunPerformance(client: RunApiClient, executionId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: runQueryKeys.performance(executionId ?? "not-selected"),
    queryFn: () => client.getPerformance(executionId!),
    enabled: executionId !== undefined && enabled,
  });
}

export function useResolvedConfiguration(client: RunApiClient, executionId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: runQueryKeys.configuration(executionId ?? "not-selected"),
    queryFn: () => client.getResolvedConfiguration(executionId!),
    enabled: executionId !== undefined && enabled,
  });
}

export function useRunComparison(client: RunApiClient, executionIds: readonly string[], enabled: boolean) {
  return useQuery({
    queryKey: runQueryKeys.comparison(executionIds),
    queryFn: () => client.compareRuns({ executionIds: [...executionIds] }),
    enabled: enabled && executionIds.length >= 2,
  });
}

function terminal(status: string | undefined): boolean {
  return status === "complete" || status === "failed" || status === "cancelled";
}

export function runDetailRefetchInterval(status: string | undefined): 2_000 | false {
  return terminal(status) ? false : 2_000;
}

export function runListRefetchInterval(statuses: readonly (string | undefined)[] | undefined): 2_000 | false {
  return statuses?.some((status) => !terminal(status)) ? 2_000 : false;
}
