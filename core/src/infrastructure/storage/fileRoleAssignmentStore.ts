import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Page,
  RoleAssignment,
  RoleAssignmentListQuery,
  RoleAssignmentStore,
} from "../../application/platformStore.ts";
import { assertSafeIdentifier } from "../../domain/identifiers.ts";
import { writeJsonExclusive } from "./filePlatformStoreSupport.ts";
import { pageByKey } from "./filePagination.ts";

export class FileRoleAssignmentStore implements RoleAssignmentStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async isAssigned(userId: string, roleId: string): Promise<boolean> {
    const assignmentPath = this.assignmentPath(userId, roleId);
    try {
      await fs.access(assignmentPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async assign(userId: string, roleId: string): Promise<void> {
    const assignmentPath = this.assignmentPath(userId, roleId);
    await writeJsonExclusive(assignmentPath, { userId, roleId });
  }

  async revoke(userId: string, roleId: string): Promise<void> {
    await fs.rm(this.assignmentPath(userId, roleId), { force: true });
  }

  async list(query: RoleAssignmentListQuery = {}): Promise<Page<RoleAssignment>> {
    if (query.userId !== undefined) assertSafeIdentifier(query.userId, "Role assignment query user ID");
    if (query.roleId !== undefined) assertSafeIdentifier(query.roleId, "Role assignment query role ID");
    const assignmentsRoot = path.join(this.root, "assignments");
    let userIds: string[];
    try {
      userIds = await fs.readdir(assignmentsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
      throw error;
    }
    const assignments = (await Promise.all(userIds.map(async (userId) => {
      if (query.userId !== undefined && userId !== query.userId) return [];
      const directory = path.join(assignmentsRoot, userId);
      const names = await fs.readdir(directory);
      return names.filter((name) => name.endsWith(".json")).map((name) => ({
        userId,
        roleId: name.slice(0, -".json".length),
      }));
    }))).flat().filter((assignment) => (
      query.roleId === undefined || assignment.roleId === query.roleId
    ));
    for (const assignment of assignments) {
      assertSafeIdentifier(assignment.userId, "Stored role assignment user ID");
      assertSafeIdentifier(assignment.roleId, "Stored role assignment role ID");
    }
    return pageByKey(assignments, assignmentKey, query);
  }

  private assignmentPath(userId: string, roleId: string): string {
    assertSafeIdentifier(userId, "Role assignment user ID");
    assertSafeIdentifier(roleId, "Role assignment role ID");
    return path.join(this.root, "assignments", userId, `${roleId}.json`);
  }
}

function assignmentKey(assignment: RoleAssignment): string {
  return `${assignment.userId}/${assignment.roleId}`;
}
