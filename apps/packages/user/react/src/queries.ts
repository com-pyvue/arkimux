import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  RegisterCurrentUserRequestDto,
  SetUserStatusRequestDto,
  UserApiClient,
  UserListQueryDto,
} from "@com-pyvue/agent-execution-user-contract";

export function useUserList(client: UserApiClient, query: UserListQueryDto) {
  return useQuery({
    queryKey: ["users", query],
    queryFn: () => client.listUsers(query),
  });
}

export function useCurrentUserRegistration(client: UserApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: RegisterCurrentUserRequestDto) => client.registerCurrentUser(request),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useSetUserStatus(client: UserApiClient) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, request }: { userId: string; request: SetUserStatusRequestDto }) => (
      client.setUserStatus(userId, request)
    ),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ["users"] }),
  });
}
