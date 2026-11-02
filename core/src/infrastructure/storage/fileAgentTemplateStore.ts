import { promises as fs } from "node:fs";
import path from "node:path";
import {
  agentTemplateContentHash,
  assertAgentTemplateId,
  validateAgentTemplateDefinition,
  type AgentTemplateDefinition,
  type ResolvedAgentTemplate,
} from "../../application/agentTemplate.ts";
import type {
  AgentTemplateLifecycleStatus,
  AgentTemplateListQuery,
  AgentTemplateStore,
  Page,
} from "../../application/platformStore.ts";
import { isRecord } from "../../domain/validation.ts";
import { readJson, replaceJson, writeJsonExclusive } from "./filePlatformStoreSupport.ts";
import { pageByKey } from "./filePagination.ts";

export class AgentTemplateDefinitionConflictError extends Error {
  constructor(readonly templateId: string) {
    super(`Agent Template ${templateId} already exists with different content.`);
    this.name = "AgentTemplateDefinitionConflictError";
  }
}

export class FileAgentTemplateStore<
  TTemplate extends AgentTemplateDefinition = AgentTemplateDefinition,
> implements AgentTemplateStore<TTemplate> {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async publish(template: TTemplate): Promise<ResolvedAgentTemplate<TTemplate>> {
    const validated = validateAgentTemplateDefinition(template) as TTemplate;
    const resolved = resolveTemplate(validated);
    if (await writeJsonExclusive(this.definitionPath(validated.templateId), validated)) return resolved;
    const existing = await this.resolve(validated.templateId);
    if (!existing || existing.contentHash !== resolved.contentHash) {
      throw new AgentTemplateDefinitionConflictError(validated.templateId);
    }
    return existing;
  }

  async resolve(templateId: string): Promise<ResolvedAgentTemplate<TTemplate> | undefined> {
    assertAgentTemplateId(templateId);
    const value = await readJson(this.definitionPath(templateId));
    if (value === undefined) return undefined;
    return resolveTemplate(validateAgentTemplateDefinition(value, templateId) as TTemplate);
  }

  async lifecycleStatus(templateId: string): Promise<AgentTemplateLifecycleStatus | undefined> {
    if (!await this.resolve(templateId)) return undefined;
    const metadata = await readJson(this.lifecyclePath(templateId));
    if (metadata === undefined) return "active";
    return validateLifecycleMetadata(metadata, templateId).status;
  }

  async archive(templateId: string, options: { allowPlatformTemplate?: boolean } = {}): Promise<void> {
    const template = await this.resolve(templateId);
    if (!template) throw new Error(`Agent Template ${templateId} does not exist.`);
    if (template.template.origin === "platform" && options.allowPlatformTemplate !== true) {
      throw new Error(`Platform Agent Template ${templateId} cannot be archived.`);
    }
    await this.setLifecycleStatus(templateId, "archived");
  }

  async restore(templateId: string): Promise<void> {
    const template = await this.resolve(templateId);
    if (!template) throw new Error(`Agent Template ${templateId} does not exist.`);
    await this.setLifecycleStatus(templateId, "active");
  }

  async list(query: AgentTemplateListQuery = {}): Promise<Page<ResolvedAgentTemplate<TTemplate>>> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
      throw error;
    }
    const definitions = await Promise.all(names.filter((name) => !name.startsWith(".")).map(async (templateId) => {
      const resolved = await this.resolve(templateId);
      if (!resolved) return undefined;
      return { resolved, lifecycleStatus: await this.lifecycleStatus(templateId) };
    }));
    const requestedStatus = query.lifecycleStatus ?? "active";
    const filtered = definitions
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .filter(({ lifecycleStatus }) => requestedStatus === "all" || lifecycleStatus === requestedStatus)
      .map(({ resolved }) => resolved);
    return pageByKey(filtered, ({ template }) => template.templateId, query);
  }

  private async setLifecycleStatus(templateId: string, status: AgentTemplateLifecycleStatus): Promise<void> {
    await replaceJson(this.lifecyclePath(templateId), {
      schemaVersion: 1,
      templateId,
      status,
      updatedAt: new Date().toISOString(),
    });
  }

  private definitionPath(templateId: string): string {
    return path.join(this.root, templateId, "definition.json");
  }

  private lifecyclePath(templateId: string): string {
    return path.join(this.root, templateId, "lifecycle.json");
  }
}

function validateLifecycleMetadata(
  value: unknown,
  expectedTemplateId: string,
): { status: AgentTemplateLifecycleStatus } {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.templateId !== expectedTemplateId) {
    throw new Error(`Agent Template ${expectedTemplateId} lifecycle metadata is invalid.`);
  }
  if (value.status !== "active" && value.status !== "archived") {
    throw new Error(`Agent Template ${expectedTemplateId} lifecycle status is invalid.`);
  }
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error(`Agent Template ${expectedTemplateId} lifecycle updatedAt is invalid.`);
  }
  return { status: value.status };
}

function resolveTemplate<TTemplate extends AgentTemplateDefinition>(
  template: TTemplate,
): ResolvedAgentTemplate<TTemplate> {
  return { template, contentHash: agentTemplateContentHash(template) };
}
