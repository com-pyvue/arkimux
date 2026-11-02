import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  agentCredentialContentHash,
  assertAgentCredentialId,
  validateAgentCredentialDefinition,
  type AgentAuthenticationLifecycleStatus,
  type AgentCredentialDefinition,
  type AgentCredentialListQuery,
  type AgentCredentialStore,
  type ResolvedAgentCredentialDefinition,
} from "../../application/agentAuthentication.ts";
import type { Page } from "../../application/platformStore.ts";
import { isRecord } from "../../domain/validation.ts";
import { pageByKey } from "./filePagination.ts";
import { readJson, replaceJson, writeJsonExclusive } from "./filePlatformStoreSupport.ts";

export class AgentCredentialDefinitionConflictError extends Error {
  constructor(readonly credentialId: string) {
    super(`Credential ${credentialId} already exists with different content.`);
    this.name = "AgentCredentialDefinitionConflictError";
  }
}

interface Metadata {
  lifecycleStatus: AgentAuthenticationLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Local-development-only plaintext credential storage.
 * Definitions and lifecycle are safe metadata. Secret values stay in mode-0600 files.
 * Production hosts must select a managed secret-store adapter instead.
 */
export class FilePlaintextAgentCredentialStore implements AgentCredentialStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async create(definition: AgentCredentialDefinition, value: string): Promise<ResolvedAgentCredentialDefinition> {
    const validated = validateAgentCredentialDefinition(definition);
    assertCredentialValue(value);
    const now = new Date().toISOString();
    const metadata: Metadata = { lifecycleStatus: "active", createdAt: now, updatedAt: now };
    if (await writeJsonExclusive(this.definitionPath(validated.credentialId), validated)) {
      await replaceJson(this.metadataPath(validated.credentialId), {
        schemaVersion: 1,
        credentialId: validated.credentialId,
        ...metadata,
      });
      await this.putValue(validated.credentialId, value);
      return await this.required(validated.credentialId);
    }
    const existing = await this.getDefinition(validated.credentialId);
    if (!existing || existing.contentHash !== agentCredentialContentHash(validated)) {
      throw new AgentCredentialDefinitionConflictError(validated.credentialId);
    }
    return existing;
  }

  async getDefinition(credentialId: string): Promise<ResolvedAgentCredentialDefinition | undefined> {
    assertAgentCredentialId(credentialId);
    const definition = await readJson(this.definitionPath(credentialId));
    if (definition === undefined) return undefined;
    const metadata = validateMetadata(await readJson(this.metadataPath(credentialId)), credentialId);
    return this.resolve(
      validateAgentCredentialDefinition(definition, credentialId),
      metadata,
      await this.hasValue(credentialId),
    );
  }

  async list(query: AgentCredentialListQuery = {}): Promise<Page<ResolvedAgentCredentialDefinition>> {
    let names: string[];
    try {
      names = await fs.readdir(this.definitionsRoot());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
      throw error;
    }
    const requestedStatus = query.lifecycleStatus ?? "active";
    const records = (await Promise.all(names.filter((name) => !name.startsWith(".")).map((name) => this.getDefinition(name))))
      .filter((item): item is ResolvedAgentCredentialDefinition => item !== undefined)
      .filter((item) => requestedStatus === "all" || item.lifecycleStatus === requestedStatus)
      .filter((item) => query.modelProvider === undefined || item.definition.modelProvider === query.modelProvider);
    return pageByKey(records, ({ definition }) => definition.credentialId, query);
  }

  async setLifecycleStatus(credentialId: string, lifecycleStatus: AgentAuthenticationLifecycleStatus): Promise<void> {
    const current = await this.required(credentialId);
    await replaceJson(this.metadataPath(credentialId), {
      schemaVersion: 1,
      credentialId,
      lifecycleStatus,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    });
  }

  async putValue(credentialId: string, value: string): Promise<void> {
    assertAgentCredentialId(credentialId);
    assertCredentialValue(value);
    const current = await this.required(credentialId);
    await fs.mkdir(this.valuesRoot(), { recursive: true, mode: 0o700 });
    await fs.chmod(this.valuesRoot(), 0o700).catch(() => undefined);
    const target = this.valuePath(credentialId);
    const temporary = path.join(this.valuesRoot(), `.${credentialId}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(temporary, 0o600).catch(() => undefined);
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600).catch(() => undefined);
      await replaceJson(this.metadataPath(credentialId), {
        schemaVersion: 1,
        credentialId,
        lifecycleStatus: current.lifecycleStatus,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      });
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async getValue(credentialId: string): Promise<string | undefined> {
    assertAgentCredentialId(credentialId);
    try {
      return await fs.readFile(this.valuePath(credentialId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async hasValue(credentialId: string): Promise<boolean> {
    return (await this.getValue(credentialId)) !== undefined;
  }

  async deleteValue(credentialId: string): Promise<void> {
    assertAgentCredentialId(credentialId);
    await fs.rm(this.valuePath(credentialId), { force: true });
  }

  private async required(credentialId: string): Promise<ResolvedAgentCredentialDefinition> {
    const current = await this.getDefinition(credentialId);
    if (!current) throw new Error(`Credential ${credentialId} does not exist.`);
    return current;
  }

  private resolve(
    definition: AgentCredentialDefinition,
    metadata: Metadata,
    valueAvailable: boolean,
  ): ResolvedAgentCredentialDefinition {
    return { definition, contentHash: agentCredentialContentHash(definition), ...metadata, valueAvailable };
  }

  private definitionsRoot(): string { return path.join(this.root, "definitions"); }
  private valuesRoot(): string { return path.join(this.root, "values"); }
  private definitionPath(credentialId: string): string { return path.join(this.definitionsRoot(), credentialId, "definition.json"); }
  private metadataPath(credentialId: string): string { return path.join(this.definitionsRoot(), credentialId, "metadata.json"); }
  private valuePath(credentialId: string): string { return path.join(this.valuesRoot(), `${credentialId}.key`); }
}

function validateMetadata(value: unknown, expectedId: string): Metadata {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.credentialId !== expectedId) {
    throw new Error(`Credential ${expectedId} metadata is invalid.`);
  }
  if (value.lifecycleStatus !== "active" && value.lifecycleStatus !== "archived") {
    throw new Error(`Credential ${expectedId} lifecycle status is invalid.`);
  }
  for (const key of ["createdAt", "updatedAt"] as const) {
    if (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key] as string))) {
      throw new Error(`Credential ${expectedId} ${key} is invalid.`);
    }
  }
  return {
    lifecycleStatus: value.lifecycleStatus,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
  };
}

function assertCredentialValue(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error("Credential value must be a non-empty string.");
  if (value.includes("\n") || value.includes("\r")) throw new Error("Credential value must be a single line.");
}
