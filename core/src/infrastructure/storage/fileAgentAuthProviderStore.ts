import { promises as fs } from "node:fs";
import path from "node:path";
import {
  agentAuthProviderContentHash,
  assertAgentAuthProviderId,
  validateAgentAuthProbeResult,
  validateAgentAuthProviderDefinition,
  type AgentAuthProbeResult,
  type AgentAuthProviderDefinition,
  type AgentAuthProviderLifecycleStatus,
  type AgentAuthProviderListQuery,
  type AgentAuthProviderStore,
  type ResolvedAgentAuthProviderDefinition,
} from "../../application/agentAuthentication.ts";
import type { Page } from "../../application/platformStore.ts";
import { isRecord } from "../../domain/validation.ts";
import { pageByKey } from "./filePagination.ts";
import { readJson, replaceJson, writeJsonExclusive } from "./filePlatformStoreSupport.ts";

export class AgentAuthProviderDefinitionConflictError extends Error {
  constructor(readonly authProviderId: string) {
    super(`Authentication provider ${authProviderId} already exists with different content.`);
    this.name = "AgentAuthProviderDefinitionConflictError";
  }
}

interface Metadata {
  lifecycleStatus: AgentAuthProviderLifecycleStatus;
  createdAt: string;
  updatedAt: string;
}

export class FileAgentAuthProviderStore implements AgentAuthProviderStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async create(definition: AgentAuthProviderDefinition): Promise<ResolvedAgentAuthProviderDefinition> {
    const validated = validateAgentAuthProviderDefinition(definition);
    const now = new Date().toISOString();
    const metadata: Metadata = {
      lifecycleStatus: "active",
      createdAt: now,
      updatedAt: now,
    };
    if (await writeJsonExclusive(this.definitionPath(validated.authProviderId), validated)) {
      await replaceJson(this.metadataPath(validated.authProviderId), { schemaVersion: 1, authProviderId: validated.authProviderId, ...metadata });
      return this.resolve(validated, metadata);
    }
    const existing = await this.get(validated.authProviderId);
    if (!existing || existing.contentHash !== agentAuthProviderContentHash(validated)) {
      throw new AgentAuthProviderDefinitionConflictError(validated.authProviderId);
    }
    return existing;
  }

  async get(authProviderId: string): Promise<ResolvedAgentAuthProviderDefinition | undefined> {
    assertAgentAuthProviderId(authProviderId);
    const definition = await readJson(this.definitionPath(authProviderId));
    if (definition === undefined) return undefined;
    const metadata = await readJson(this.metadataPath(authProviderId));
    return this.resolve(
      validateAgentAuthProviderDefinition(definition, authProviderId),
      validateMetadata(metadata, authProviderId),
    );
  }

  async list(query: AgentAuthProviderListQuery = {}): Promise<Page<ResolvedAgentAuthProviderDefinition>> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
      throw error;
    }
    const requestedStatus = query.lifecycleStatus ?? "active";
    const records = (await Promise.all(names.filter((name) => !name.startsWith(".")).map((name) => this.get(name))))
      .filter((item): item is ResolvedAgentAuthProviderDefinition => item !== undefined)
      .filter((item) => requestedStatus === "all" || item.lifecycleStatus === requestedStatus)
      .filter((item) => query.executionProviderId === undefined || item.definition.executionProviderId === query.executionProviderId);
    return pageByKey(records, ({ definition }) => definition.authProviderId, query);
  }

  async setLifecycleStatus(authProviderId: string, lifecycleStatus: AgentAuthProviderLifecycleStatus): Promise<void> {
    const current = await this.required(authProviderId);
    await this.writeMetadata(authProviderId, {
      ...metadataOf(current),
      lifecycleStatus,
      updatedAt: new Date().toISOString(),
    });
  }

  async getLatestProbe(authProviderId: string): Promise<AgentAuthProbeResult | undefined> {
    assertAgentAuthProviderId(authProviderId);
    const value = await readJson(this.probePath(authProviderId));
    return value === undefined ? undefined : validateAgentAuthProbeResult(value, authProviderId);
  }

  async recordProbe(result: AgentAuthProbeResult): Promise<void> {
    const validated = validateAgentAuthProbeResult(result);
    await replaceJson(this.probePath(validated.authProviderId), validated);
  }

  private async required(authProviderId: string): Promise<ResolvedAgentAuthProviderDefinition> {
    const current = await this.get(authProviderId);
    if (!current) throw new Error(`Authentication provider ${authProviderId} does not exist.`);
    return current;
  }

  private async writeMetadata(authProviderId: string, metadata: Metadata): Promise<void> {
    await replaceJson(this.metadataPath(authProviderId), { schemaVersion: 1, authProviderId, ...metadata });
  }

  private resolve(definition: AgentAuthProviderDefinition, metadata: Metadata): ResolvedAgentAuthProviderDefinition {
    return { definition, contentHash: agentAuthProviderContentHash(definition), ...metadata };
  }

  private definitionPath(authProviderId: string): string {
    return path.join(this.root, authProviderId, "definition.json");
  }

  private metadataPath(authProviderId: string): string {
    return path.join(this.root, authProviderId, "metadata.json");
  }

  private probePath(authProviderId: string): string {
    return path.join(this.root, authProviderId, "latest-probe.json");
  }
}

function validateMetadata(value: unknown, expectedId: string): Metadata {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.authProviderId !== expectedId) {
    throw new Error(`Authentication provider ${expectedId} metadata is invalid.`);
  }
  if (value.lifecycleStatus !== "active" && value.lifecycleStatus !== "archived") {
    throw new Error(`Authentication provider ${expectedId} lifecycle status is invalid.`);
  }
  for (const key of ["createdAt", "updatedAt"] as const) {
    if (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key] as string))) {
      throw new Error(`Authentication provider ${expectedId} ${key} is invalid.`);
    }
  }
  return {
    lifecycleStatus: value.lifecycleStatus,
    createdAt: value.createdAt as string,
    updatedAt: value.updatedAt as string,
  };
}

function metadataOf(value: ResolvedAgentAuthProviderDefinition): Metadata {
  return {
    lifecycleStatus: value.lifecycleStatus,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
