import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileAgentTemplateStore,
  FileRoleAssignmentStore,
  FileRoleStore,
  FileRunConfigurationStore,
  FileUserStore,
  FileWorkflowRunConfigurationStore,
  AgentTemplateDefinitionConflictError,
  RoleDefinitionConflictError,
  RunConfigurationDefinitionConflictError,
  UserRegistrationConflictError,
  WorkflowRunConfigurationDefinitionConflictError,
} from "../../core/src/index.ts";

async function root(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "platform-stores-"));
}

describe("file platform stores", () => {
  it("registers users idempotently and rejects identity conflicts", async () => {
    const store = new FileUserStore(await root());
    const registration = {
      userId: "yuryp",
      displayName: "Yury",
      identity: { providerId: "local-cli", subjectId: "yuryp" },
      registeredAt: "2026-08-05T12:00:00.000Z",
    };
    expect(await store.register(registration)).toMatchObject({ userId: "yuryp", status: "active" });
    expect(await store.register(registration)).toMatchObject({ userId: "yuryp" });
    await expect(store.register({ ...registration, userId: "somebody-else" }))
      .rejects.toBeInstanceOf(UserRegistrationConflictError);
    await store.setStatus("yuryp", "disabled");
    expect((await store.get("yuryp"))?.status).toBe("disabled");
    await store.register({ ...registration, userId: "another", identity: { ...registration.identity, subjectId: "another" } });
    const firstPage = await store.list({ pageSize: 1 });
    expect(firstPage.items.map((user) => user.userId)).toEqual(["another"]);
    expect((await store.list({ pageSize: 1, cursor: firstPage.nextCursor })).items.map((user) => user.userId))
      .toEqual(["yuryp"]);
    expect((await store.list({ status: "disabled" })).items.map((user) => user.userId)).toEqual(["yuryp"]);
  });

  it("creates immutable roles and separate idempotent assignments", async () => {
    const directory = await root();
    const roles = new FileRoleStore(directory);
    const assignments = new FileRoleAssignmentStore(directory);
    await roles.create({ schemaVersion: 1, roleId: "runner", permissions: ["runs:read-own"] });
    await roles.create({ schemaVersion: 1, roleId: "runner", permissions: ["runs:read-own"] });
    await expect(roles.create({ schemaVersion: 1, roleId: "runner", permissions: ["runs:read-all"] }))
      .rejects.toBeInstanceOf(RoleDefinitionConflictError);
    await assignments.assign("yuryp", "runner");
    await assignments.assign("yuryp", "runner");
    expect(await assignments.isAssigned("yuryp", "runner")).toBe(true);
    expect((await roles.list()).items.map((role) => role.roleId)).toEqual(["runner"]);
    expect((await assignments.list({ userId: "yuryp" })).items).toEqual([{ userId: "yuryp", roleId: "runner" }]);
    await assignments.revoke("yuryp", "runner");
    expect(await assignments.isAssigned("yuryp", "runner")).toBe(false);
  });

  it("publishes immutable run configuration definitions", async () => {
    const store = new FileRunConfigurationStore<{ configurationId: string; value: number }>(await root());
    const definition = { configurationId: "fixture-v1", value: 1 };
    const published = await store.publish(definition);
    expect(await store.publish(definition)).toEqual(published);
    expect(await store.resolve("fixture-v1")).toEqual(published);
    expect((await store.list()).items).toEqual([published]);
    await store.archive("fixture-v1");
    expect(await store.resolve("fixture-v1")).toEqual(published);
    expect(await store.lifecycleStatus("fixture-v1")).toBe("archived");
    expect((await store.list()).items).toEqual([]);
    expect((await store.list({ lifecycleStatus: "archived" })).items).toEqual([published]);
    await store.restore("fixture-v1");
    expect(await store.lifecycleStatus("fixture-v1")).toBe("active");
    expect((await store.list()).items).toEqual([published]);
    await expect(store.publish({ ...definition, value: 2 }))
      .rejects.toBeInstanceOf(RunConfigurationDefinitionConflictError);
  });

  it("publishes immutable Agent Templates and only archives custom templates", async () => {
    const store = new FileAgentTemplateStore(await root());
    const custom = {
      schemaVersion: 1 as const,
      templateId: "custom-pi-v1",
      title: "Custom Pi",
      origin: "custom" as const,
      providerSchema: { executionProvider: "pi-cli", schemaVersion: 1 },
      policy: {
        timeoutMs: 120_000,
        execution: {
          provider: "pi-cli",
          authProvider: "pi-openai-codex-session",
          parameters: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" },
        },
      },
    };
    const published = await store.publish(custom);
    expect(await store.publish(custom)).toEqual(published);
    await expect(store.publish({ ...custom, title: "Changed" }))
      .rejects.toBeInstanceOf(AgentTemplateDefinitionConflictError);
    await store.archive(custom.templateId);
    expect(await store.lifecycleStatus(custom.templateId)).toBe("archived");
    expect((await store.list()).items).toEqual([]);
    expect((await store.list({ lifecycleStatus: "archived" })).items).toEqual([published]);
    await store.restore(custom.templateId);

    const platform = { ...custom, templateId: "platform-pi-v1", origin: "platform" as const };
    await store.publish(platform);
    await expect(store.archive(platform.templateId)).rejects.toThrow("cannot be archived");
  });

  it("scopes immutable run configurations by workflow identity", async () => {
    const store = new FileWorkflowRunConfigurationStore<{
      configurationId: string;
      workflow: { kind: string; version: number };
      value: number;
    }>(await root());
    const firstWorkflow = { kind: "fixture.first", version: 1 };
    const secondWorkflow = { kind: "fixture.second", version: 1 };
    const first = await store.publish({ configurationId: "default-v1", workflow: firstWorkflow, value: 1 });
    const second = await store.publish({ configurationId: "default-v1", workflow: secondWorkflow, value: 2 });

    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(second.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(await store.resolve(firstWorkflow, "default-v1")).toEqual(first);
    expect(await store.resolve(secondWorkflow, "default-v1")).toEqual(second);
    expect((await store.list(firstWorkflow)).items).toEqual([first]);
    expect((await store.list(secondWorkflow)).items).toEqual([second]);
    await expect(store.publish({ configurationId: "default-v1", workflow: firstWorkflow, value: 3 }))
      .rejects.toBeInstanceOf(WorkflowRunConfigurationDefinitionConflictError);
    await store.archive(firstWorkflow, "default-v1");
    expect((await store.list(firstWorkflow)).items).toEqual([]);
    expect((await store.list(secondWorkflow)).items).toEqual([second]);
  });
});
