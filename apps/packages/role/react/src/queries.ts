import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AssignRoleRequestDto,
  DefineRoleRequestDto,
  PageQueryDto,
  RoleApiClient,
  RoleAssignmentListQueryDto,
} from "@com-pyvue/agent-execution-role-contract";

export function useRoleList(client: RoleApiClient, query: PageQueryDto) {
  return useQuery({ queryKey: ["roles", query], queryFn: () => client.listRoles(query) });
}

export function useRoleAssignmentList(client: RoleApiClient, query: RoleAssignmentListQueryDto) {
  return useQuery({ queryKey: ["role-assignments", query], queryFn: () => client.listAssignments(query) });
}

export function useDefineRole(client: RoleApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: DefineRoleRequestDto) => client.defineRole(request),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["roles"] }),
  });
}

export function useAssignRole(client: RoleApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: AssignRoleRequestDto) => client.assignRole(request),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["role-assignments"] }),
  });
}

export function useRevokeRole(client: RoleApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, roleId }: AssignRoleRequestDto) => client.revokeRole(userId, roleId),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["role-assignments"] }),
  });
}
