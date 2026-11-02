import type { Permission } from "@com-pyvue/agent-execution-core";

export interface LocalRolePreset {
  roleId: string;
  permissions: readonly Permission[];
}

export interface LocalPermissionPreset {
  presetId: string;
  permissions: readonly Permission[];
}

export const localPermissionPresets = {
  "local-run-observer": {
    presetId: "local-run-observer",
    permissions: ["runs:read-all"],
  },
  "local-workflow-developer": {
    presetId: "local-workflow-developer",
    permissions: [
      "runs:read-all",
      "runs:archive-all",
      "runs:respond-own",
      "agent-templates:admin",
      "agent-auth-providers:admin",
    ],
  },
  "local-platform-admin": {
    presetId: "local-platform-admin",
    permissions: [
      "runs:read-all",
      "runs:archive-all",
      "users:admin",
      "roles:admin",
      "agent-templates:admin",
      "agent-auth-providers:admin",
      "organizations:read",
      "organizations:admin",
      "environments:read",
      "environments:admin",
      "workflows:publish",
      "workflow-deployments:read",
      "workflow-deployments:admin",
      "run-projections:read",
      "run-projections:write",
      "deployment-health:write",
      "meter-records:read",
      "meter-records:write",
    ],
  },
} as const satisfies Record<string, LocalPermissionPreset>;

export const localRolePresets = {
  "agent-execution-run-observer-v1": {
    roleId: "agent-execution-run-observer-v1",
    permissions: localPermissionPresets["local-run-observer"].permissions,
  },
  "agent-execution-platform-admin-v1": {
    roleId: "agent-execution-platform-admin-v1",
    permissions: localPermissionPresets["local-platform-admin"].permissions,
  },
} as const satisfies Record<string, LocalRolePreset>;

export function localRolePreset(roleId: string): LocalRolePreset | undefined {
  return localRolePresets[roleId as keyof typeof localRolePresets];
}

export function localPermissionPreset(presetId: string): LocalPermissionPreset | undefined {
  return localPermissionPresets[presetId as keyof typeof localPermissionPresets];
}
