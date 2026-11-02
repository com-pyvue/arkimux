import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CompareRunConfigurationsRequestDto,
  PageQueryDto,
  PublishRunConfigurationRequestDto,
  RunConfigurationApiClient,
  ValidateRunConfigurationRequestDto,
  WorkflowIdentityDto,
} from "@com-pyvue/agent-execution-run-configuration-contract";

export function useRunConfigurationList(
  client: RunConfigurationApiClient,
  workflow: WorkflowIdentityDto,
  query: PageQueryDto,
) {
  return useQuery({
    queryKey: ["run-configuration-definitions", workflow, query],
    queryFn: () => client.listDefinitions(workflow, query),
  });
}

export function useRunConfigurationDetail(client: RunConfigurationApiClient, workflow: WorkflowIdentityDto, configurationId?: string) {
  return useQuery({
    queryKey: ["run-configuration-definition", workflow, configurationId],
    queryFn: () => client.getDefinition(workflow, configurationId!),
    enabled: configurationId !== undefined,
  });
}

export function useValidateRunConfiguration(client: RunConfigurationApiClient, workflow: WorkflowIdentityDto) {
  return useMutation({
    mutationFn: (request: ValidateRunConfigurationRequestDto) => client.validateDefinition(workflow, request),
  });
}

export function usePublishRunConfiguration(client: RunConfigurationApiClient, workflow: WorkflowIdentityDto) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: PublishRunConfigurationRequestDto) => client.publishDefinition(workflow, request),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["run-configuration-definitions", workflow] }),
  });
}

export function useArchiveRunConfiguration(client: RunConfigurationApiClient, workflow: WorkflowIdentityDto) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (configurationId: string) => client.archiveDefinition(workflow, configurationId),
    onSuccess: async (_, configurationId) => Promise.all([
      queryClient.invalidateQueries({ queryKey: ["run-configuration-definitions"] }),
      queryClient.invalidateQueries({ queryKey: ["run-configuration-definition", configurationId] }),
    ]),
  });
}

export function useRestoreRunConfiguration(client: RunConfigurationApiClient, workflow: WorkflowIdentityDto) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (configurationId: string) => client.restoreDefinition(workflow, configurationId),
    onSuccess: async (_, configurationId) => Promise.all([
      queryClient.invalidateQueries({ queryKey: ["run-configuration-definitions"] }),
      queryClient.invalidateQueries({ queryKey: ["run-configuration-definition", configurationId] }),
    ]),
  });
}

export function useCompareRunConfigurations(client: RunConfigurationApiClient, workflow: WorkflowIdentityDto) {
  return useMutation({
    mutationFn: (request: CompareRunConfigurationsRequestDto) => client.compareDefinitions(workflow, request),
  });
}
