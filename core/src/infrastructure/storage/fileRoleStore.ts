import { promises as fs } from "node:fs";
import path from "node:path";
import type { Page, PageQuery, RoleStore } from "../../application/platformStore.ts";
import { RoleDefinitionConflictError } from "../../application/roleAdministration.ts";
import { assertSafeIdentifier } from "../../domain/identifiers.ts";
import { validateRole, type Role } from "../../domain/role.ts";
import { readJson, writeJsonExclusive } from "./filePlatformStoreSupport.ts";
import { pageByKey } from "./filePagination.ts";

export { RoleDefinitionConflictError } from "../../application/roleAdministration.ts";

export class FileRoleStore implements RoleStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async get(roleId: string): Promise<Role | undefined> {
    assertSafeIdentifier(roleId, "Role ID");
    const value = await readJson(this.rolePath(roleId));
    return value === undefined ? undefined : validateRole(value);
  }

  async create(input: Role): Promise<void> {
    const role = validateRole(input);
    if (await writeJsonExclusive(this.rolePath(role.roleId), role)) return;
    const existing = await this.get(role.roleId);
    if (!existing || JSON.stringify(existing) !== JSON.stringify(role)) {
      throw new RoleDefinitionConflictError(role.roleId);
    }
  }

  async list(query: PageQuery = {}): Promise<Page<Role>> {
    let names: string[];
    try {
      names = await fs.readdir(path.join(this.root, "roles"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
      throw error;
    }
    const roles = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const value = await readJson(path.join(this.root, "roles", name));
      if (value === undefined) throw new Error(`Role record disappeared while listing: ${name}.`);
      return validateRole(value);
    }));
    return pageByKey(roles, (role) => role.roleId, query);
  }

  private rolePath(roleId: string): string {
    return path.join(this.root, "roles", `${roleId}.json`);
  }
}
