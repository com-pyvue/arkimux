import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DirectRunDispatcher,
  FileRoleAssignmentStore,
  FileRoleStore,
  FileWorkflowRunConfigurationStore,
  FileUserStore,
  RoleAssignmentService,
  RunSubmissionService,
  UserRegistrationService,
  defineRole,
  type TrustedRunCommand,
} from "../../core/src/index.ts";

async function stores() {
  const root = await mkdtemp(path.join(os.tmpdir(), "platform-services-"));
  return {
    users: new FileUserStore(root),
    roles: new FileRoleStore(root),
    assignments: new FileRoleAssignmentStore(root),
    configurations: new FileWorkflowRunConfigurationStore<{
      configurationId: string;
      workflow: { kind: string; version: number };
    }>(path.join(root, "run-configurations")),
  };
}

describe("platform application services", () => {
  it("registers, defines, and assigns without exposing adapter files", async () => {
    const platform = await stores();
    const registration = new UserRegistrationService(
      platform.users,
      () => new Date("2026-08-05T12:00:00.000Z"),
    );
    const user = await registration.register({
      requestedUserId: "yuryp",
      identity: { providerId: "local-cli", subjectId: "yuryp" },
    });
    const role = await defineRole(platform.roles, {
      roleId: "runner",
      permissions: ["workflow:fixture.workflow:start"],
    });
    await new RoleAssignmentService(platform.users, platform.roles, platform.assignments)
      .assign(user.userId, role.roleId);
    expect(await platform.assignments.isAssigned("yuryp", "runner")).toBe(true);
  });

  it("authorizes, reserves, and dispatches a compact trusted command", async () => {
    const platform = await stores();
    await platform.users.register({
      userId: "yuryp",
      identity: { providerId: "local-cli", subjectId: "yuryp" },
      registeredAt: "2026-08-05T12:00:00.000Z",
    });
    await defineRole(platform.roles, {
      roleId: "runner",
      permissions: ["workflow:fixture.workflow:start"],
    });
    await platform.assignments.assign("yuryp", "runner");
    await platform.configurations.publish({
      configurationId: "fixture-v1",
      workflow: { kind: "fixture.workflow", version: 1 },
    });
    const dispatched: TrustedRunCommand<{ value: number }>[] = [];
    const reserve = vi.fn(async () => ({ executionId: "run-01" }));
    const service = new RunSubmissionService({
      workflow: { kind: "fixture.workflow", version: 1 },
      users: platform.users,
      roles: platform.roles,
      assignments: platform.assignments,
      runConfigurations: platform.configurations,
      configurationWorkflow: (configuration) => configuration.workflow,
      reserve,
      dispatcher: new DirectRunDispatcher<{ value: number }>(async (command) => {
        dispatched.push(command);
      }),
    });
    await expect(service.submit({
      userId: "yuryp",
      roleId: "runner",
      input: { value: 42 },
      runConfigurationId: "fixture-v1",
    })).resolves.toEqual({ executionId: "run-01" });
    expect(reserve).toHaveBeenCalledOnce();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      runRef: { executionId: "run-01" },
      actor: { userId: "yuryp", roleId: "runner" },
      input: { value: 42 },
      runConfiguration: { configurationId: "fixture-v1" },
    });
  });

  it("rejects an unassigned role before reserving a run", async () => {
    const platform = await stores();
    await platform.users.register({
      userId: "yuryp",
      identity: { providerId: "local-cli", subjectId: "yuryp" },
      registeredAt: "2026-08-05T12:00:00.000Z",
    });
    await defineRole(platform.roles, {
      roleId: "runner",
      permissions: ["workflow:fixture.workflow:start"],
    });
    const reserve = vi.fn(async () => ({ executionId: "run-01" }));
    const service = new RunSubmissionService({
      workflow: { kind: "fixture.workflow", version: 1 },
      users: platform.users,
      roles: platform.roles,
      assignments: platform.assignments,
      runConfigurations: platform.configurations,
      configurationWorkflow: (configuration) => configuration.workflow,
      reserve,
      dispatcher: new DirectRunDispatcher(async () => undefined),
    });
    await expect(service.submit({
      userId: "yuryp",
      roleId: "runner",
      input: {},
      runConfigurationId: "fixture-v1",
    })).rejects.toThrow("is not assigned");
    expect(reserve).not.toHaveBeenCalled();
  });

  it("rejects archived run configurations before reserving a run", async () => {
    const platform = await stores();
    await platform.users.register({
      userId: "yuryp",
      identity: { providerId: "local-cli", subjectId: "yuryp" },
      registeredAt: "2026-08-05T12:00:00.000Z",
    });
    await defineRole(platform.roles, { roleId: "runner", permissions: ["workflow:fixture.workflow:start"] });
    await platform.assignments.assign("yuryp", "runner");
    await platform.configurations.publish({
      configurationId: "fixture-v1",
      workflow: { kind: "fixture.workflow", version: 1 },
    });
    await platform.configurations.archive({ kind: "fixture.workflow", version: 1 }, "fixture-v1");
    const reserve = vi.fn(async () => ({ executionId: "run-01" }));
    const service = new RunSubmissionService({
      workflow: { kind: "fixture.workflow", version: 1 },
      users: platform.users,
      roles: platform.roles,
      assignments: platform.assignments,
      runConfigurations: platform.configurations,
      configurationWorkflow: (configuration) => configuration.workflow,
      reserve,
      dispatcher: new DirectRunDispatcher(async () => undefined),
    });
    await expect(service.submit({
      userId: "yuryp",
      roleId: "runner",
      input: {},
      runConfigurationId: "fixture-v1",
    })).rejects.toThrow("is archived");
    expect(reserve).not.toHaveBeenCalled();
  });
});
