import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FileRoleAssignmentStore, FileRoleStore, FileUserStore, defineRole,
  type RoleAssignmentStore,
} from "@com-pyvue/agent-execution-core";
import {
  LocalWorkflowPermissionTransitionError,
  reconcileLocalWorkflowPermissions,
} from "../../apps/hosts/api/src/localOperatorBootstrap.ts";
import { localPermissionPresets } from "../../apps/hosts/api/src/localRolePresets.ts";
import { authenticateApplicationRequest } from "../../apps/packages/application-host/src/index.ts";
import { RunApplicationService } from "../../apps/packages/run/api/src/services.ts";
import { CodedWorkflowRegistry } from "../../apps/packages/run/api/src/workflowRegistry.ts";

const userId = "local-developer";
const family = "arkimux-workflow-developer";
const weather = { kind: "weather-advisor", version: 1 };
const vendor = { kind: "vendor-evaluation", version: 1 };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "arkimux-workflow-permissions-"));
  const stores = {
    users: new FileUserStore(root),
    roles: new FileRoleStore(root),
    roleAssignments: new FileRoleAssignmentStore(root),
  };
  for (const id of [userId, "other-user"]) {
    await stores.users.register({ userId: id, identity: { providerId: "local-cli", subjectId: id },
      registeredAt: "2026-09-15T00:00:00.000Z" });
  }
  const assigned = async (id = userId) => (await stores.roleAssignments.list({ userId: id })).items.map(({ roleId }) => roleId);
  const authenticate = (id = userId) => authenticateApplicationRequest({}, {
    authenticate: async () => ({ providerId: "local-cli", subjectId: id }),
  }, { users: stores.users, roles: stores.roles, assignments: stores.roleAssignments });
  return { stores, assigned, authenticate };
}

function wrappedAssignments(store: RoleAssignmentStore, overrides: Partial<RoleAssignmentStore>): RoleAssignmentStore {
  return {
    list: store.list.bind(store), isAssigned: store.isAssigned.bind(store),
    assign: store.assign.bind(store), revoke: store.revoke.bind(store), ...overrides,
  };
}

describe("Local workflow permission reconciliation", () => {
  it("versions exact workflow permissions, keeps the preset, and reuses matching immutable roles", async () => {
    const { stores, assigned, authenticate } = await fixture();
    const first = await reconcileLocalWorkflowPermissions(stores, [weather]);
    expect(first).toEqual({ roleId: `${family}-v1` });
    const second = await reconcileLocalWorkflowPermissions(stores, [weather, vendor, { ...weather, version: 2 }]);
    expect(second).toEqual({ roleId: `${family}-v2` });
    expect(await assigned()).toEqual([second.roleId]);
    const principal = await authenticate();
    expect(principal.permissions).toEqual(expect.arrayContaining([
      ...localPermissionPresets["local-workflow-developer"].permissions,
      "workflow:weather-advisor:start", "workflow:weather-advisor:configure",
      "workflow:vendor-evaluation:start", "workflow:vendor-evaluation:configure",
    ]));
    expect(principal.permissions).toHaveLength(localPermissionPresets["local-workflow-developer"].permissions.length + 4);
    expect(await reconcileLocalWorkflowPermissions(stores, [weather])).toEqual(first);
    expect(await assigned()).toEqual([first.roleId]);
    expect(await stores.roles.get(second.roleId)).toBeDefined();
    await reconcileLocalWorkflowPermissions(stores, []);
    expect((await authenticate()).permissions).toEqual([...localPermissionPresets["local-workflow-developer"].permissions].sort());
  });

  it("preserves unrelated assignments, other users, and malformed family lookalikes", async () => {
    const { stores, assigned } = await fixture();
    const first = await reconcileLocalWorkflowPermissions(stores, [weather]);
    for (const roleId of ["separate-reader", `${family}-v01`, `${family}-v2-extra`]) {
      await defineRole(stores.roles, { roleId, permissions: ["runs:read-own"] });
      await stores.roleAssignments.assign(userId, roleId);
    }
    await stores.roleAssignments.assign("other-user", first.roleId);
    const second = await reconcileLocalWorkflowPermissions(stores, [vendor]);
    expect(await assigned()).toEqual([`${family}-v01`, second.roleId, `${family}-v2-extra`, "separate-reader"]);
    expect(await assigned("other-user")).toEqual([first.roleId]);
  });

  it("reconciles interrupted transitions at startup, including duplicate or missing family assignments", async () => {
    const { stores, assigned } = await fixture();
    const first = await reconcileLocalWorkflowPermissions(stores, [weather]);
    const second = await reconcileLocalWorkflowPermissions(stores, [vendor]);
    await stores.roleAssignments.assign(userId, first.roleId); // Simulated crash before the old role was removed.
    expect(await reconcileLocalWorkflowPermissions(stores, [vendor])).toEqual(second);
    expect(await assigned()).toEqual([second.roleId]);
    await stores.roleAssignments.revoke(userId, second.roleId); // Interrupted restoration can leave neither assigned.
    expect(await reconcileLocalWorkflowPermissions(stores, [weather])).toEqual(first);
    expect(await assigned()).toEqual([first.roleId]);
  });

  it("reads all assignment and role pages when reconciling a family", async () => {
    const { stores, assigned } = await fixture();
    const first = await reconcileLocalWorkflowPermissions(stores, [weather]);
    const second = await reconcileLocalWorkflowPermissions(stores, [vendor]);
    await stores.roleAssignments.assign(userId, first.roleId);
    const paged = {
      ...stores,
      roles: { get: stores.roles.get.bind(stores.roles), create: stores.roles.create.bind(stores.roles),
        list: (query = {}) => stores.roles.list({ ...query, pageSize: 1 }) },
      roleAssignments: wrappedAssignments(stores.roleAssignments, {
        list: (query = {}) => stores.roleAssignments.list({ ...query, pageSize: 1 }),
      }),
    };
    expect(await reconcileLocalWorkflowPermissions(paged, [vendor])).toEqual(second);
    expect(await assigned()).toEqual([second.roleId]);
  });

  it("leaves assignments unchanged when a role cannot be prepared", async () => {
    const { stores, assigned } = await fixture();
    const first = await reconcileLocalWorkflowPermissions(stores, [weather]);
    const roles = { get: stores.roles.get.bind(stores.roles), list: stores.roles.list.bind(stores.roles),
      create: async () => { throw new Error("private role storage failure"); } };
    await expect(reconcileLocalWorkflowPermissions({ ...stores, roles }, [vendor]))
      .rejects.toMatchObject({ restartRequired: false });
    expect(await assigned()).toEqual([first.roleId]);
  });

  it.each(["assign", "revoke"] as const)("restores the prior family after %s throws after persisting", async (operation) => {
    const { stores, assigned } = await fixture();
    const first = await reconcileLocalWorkflowPermissions(stores, [weather]);
    let fail = true;
    const assignments = wrappedAssignments(stores.roleAssignments, {
      [operation]: async (id: string, roleId: string) => {
        await stores.roleAssignments[operation](id, roleId);
        if (fail) { fail = false; throw new Error("private filesystem details"); }
      },
    });
    await expect(reconcileLocalWorkflowPermissions({ ...stores, roleAssignments: assignments }, [vendor]))
      .rejects.toMatchObject({ restartRequired: false, message: "Local workflow permissions could not be updated. Previous workflows remain available." });
    expect(await assigned()).toEqual([first.roleId]);
  });

  it("restores an empty previous family after a failed first assignment", async () => {
    const { stores, assigned } = await fixture();
    const assignments = wrappedAssignments(stores.roleAssignments, {
      assign: async (id, roleId) => {
        await stores.roleAssignments.assign(id, roleId);
        throw new Error("failed after creation");
      },
    });
    await expect(reconcileLocalWorkflowPermissions({ ...stores, roleAssignments: assignments }, [weather]))
      .rejects.toMatchObject({ restartRequired: false });
    expect(await assigned()).toEqual([]);
  });

  it("requires restart when restoration cannot remove an added assignment", async () => {
    const { stores, assigned } = await fixture();
    const first = await reconcileLocalWorkflowPermissions(stores, [weather]);
    const assignments = wrappedAssignments(stores.roleAssignments, {
      revoke: async () => { throw new Error("private storage fault"); },
    });
    const error = await reconcileLocalWorkflowPermissions({ ...stores, roleAssignments: assignments }, [vendor]).catch(error => error);
    expect(error).toBeInstanceOf(LocalWorkflowPermissionTransitionError);
    expect(error).toMatchObject({ restartRequired: true });
    expect(error.message).not.toContain("private");
    expect(await assigned()).toEqual([first.roleId, `${family}-v2`]);
    // A later startup reconciles to the current valid registry before it listens.
    await reconcileLocalWorkflowPermissions(stores, [weather]);
    expect(await assigned()).toEqual([first.roleId]);
  });

  it("does not require restart when restoration writes succeed but their acknowledgements fail", async () => {
    const { stores, assigned } = await fixture();
    const first = await reconcileLocalWorkflowPermissions(stores, [weather]);
    const assignments = wrappedAssignments(stores.roleAssignments, {
      revoke: async (id, roleId) => {
        await stores.roleAssignments.revoke(id, roleId);
        throw new Error("write acknowledgement lost");
      },
    });
    await expect(reconcileLocalWorkflowPermissions({ ...stores, roleAssignments: assignments }, [vendor]))
      .rejects.toMatchObject({ restartRequired: false });
    expect(await assigned()).toEqual([first.roleId]);
  });

  it("keeps disabled users disabled and rejects authentication after reconciliation", async () => {
    const { stores, authenticate } = await fixture();
    await stores.users.setStatus(userId, "disabled");
    const before = await stores.users.get(userId);
    await reconcileLocalWorkflowPermissions(stores, [weather]);
    expect(await stores.users.get(userId)).toEqual(before);
    await expect(authenticate()).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("does not create a missing Local developer or change unrelated users", async () => {
    const { stores } = await fixture();
    const before = await stores.users.list();
    await expect(reconcileLocalWorkflowPermissions({ ...stores, users: { get: async () => undefined } }, [weather]))
      .rejects.toMatchObject({ restartRequired: false });
    expect(await stores.users.list()).toEqual(before);
    expect((await stores.roles.list()).items).toEqual([]);
  });

  it("rejects invalid workflow identities before changing roles or assignments", async () => {
    const { stores, assigned } = await fixture();
    const first = await reconcileLocalWorkflowPermissions(stores, [weather]);
    await expect(reconcileLocalWorkflowPermissions(stores, [{ kind: "invalid*", version: 1 }])).rejects.toThrow();
    expect(await assigned()).toEqual([first.roleId]);
    expect((await stores.roles.list()).items).toHaveLength(1);
  });

  it("keeps existing Run read and response authorization after its workflow and original role are removed", async () => {
    const { stores, authenticate } = await fixture();
    const original = await reconcileLocalWorkflowPermissions(stores, [weather]);
    await reconcileLocalWorkflowPermissions(stores, [vendor]);
    const principal = await authenticate();
    expect(principal.roles.map(role => role.roleId)).not.toContain(original.roleId);
    expect(principal.permissions).not.toContain("workflow:weather-advisor:start");
    const runRef = { executionId: "waiting-weather-run" };
    const receipt = { schemaVersion: 1 as const, submissionId: "answer-1", requestId: "request-1",
      acceptedAt: "2026-09-15T00:00:00.000Z", acceptedBodySha256: "a".repeat(64),
      resumeCommandId: "resume-1", responderId: userId };
    const submit = vi.fn(async () => ({ schemaVersion: 1 as const, runRef, receipt }));
    const unreachable = async (): Promise<never> => { throw new Error("Unrelated service operation called"); };
    const service = new RunApplicationService({
      catalog: { get: async () => ({ runRef, workflow: weather, actor: { userId, roleId: original.roleId },
        createdAt: "2026-09-15T00:00:00.000Z" }), list: unreachable, archive: unreachable, restore: unreachable },
      inputRequests: { list: async () => ({ schemaVersion: 1, runRef, items: [] }), submit },
      workflows: new CodedWorkflowRegistry(), dispatcher: { dispatch: unreachable },
      artifacts: { open: unreachable }, results: { open: unreachable }, performance: { open: unreachable },
      runConfigurations: { publish: unreachable, resolve: unreachable, lifecycleStatus: unreachable,
        archive: unreachable, restore: unreachable, list: unreachable },
    });
    await expect(service.listInputRequests(principal, runRef)).resolves.toMatchObject({ runRef });
    const response = { submissionId: "answer-1", expectedRevision: 1, response: { confirmed: true } };
    await expect(service.submitInputResponse(principal, runRef, "request-1", response)).resolves.toMatchObject({ receipt });
    expect(submit).toHaveBeenCalledOnce();
    const other = await authenticate("other-user");
    await expect(service.submitInputResponse(other, runRef, "request-1", response)).rejects.toMatchObject({ status: 403 });
    const readOnly = { ...principal, permissions: principal.permissions.filter(permission => permission !== "runs:respond-own") };
    await expect(service.submitInputResponse(readOnly, runRef, "request-1", response)).rejects.toMatchObject({ status: 403 });
    expect(submit).toHaveBeenCalledOnce();
  });
});
