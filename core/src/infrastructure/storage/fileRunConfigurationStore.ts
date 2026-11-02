import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Page,
  RunConfigurationLifecycleStatus,
  RunConfigurationListQuery,
  RunConfigurationStore,
} from "../../application/platformStore.ts";
import {
  runConfigurationContentHash,
  type ResolvedRunConfiguration,
} from "../../application/runConfiguration.ts";
import { assertRunConfigurationId } from "../../domain/runConfigurationReference.ts";
import { isRecord } from "../../domain/validation.ts";
import { readJson, replaceJson, writeJsonExclusive } from "./filePlatformStoreSupport.ts";
import { pageByKey } from "./filePagination.ts";

export class RunConfigurationDefinitionConflictError extends Error {
  constructor(readonly configurationId: string) {
    super(`Run configuration ${configurationId} already exists with different content.`);
    this.name = "RunConfigurationDefinitionConflictError";
  }
}

export class FileRunConfigurationStore<
  TConfiguration extends { configurationId: string } = { configurationId: string },
> implements RunConfigurationStore<TConfiguration> {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async publish(configuration: TConfiguration): Promise<ResolvedRunConfiguration<TConfiguration>> {
    const validated = validateDefinition<TConfiguration>(configuration);
    const resolved = resolveDefinition(validated);
    if (await writeJsonExclusive(this.definitionPath(validated.configurationId), validated)) return resolved;
    const existing = await this.resolve(validated.configurationId);
    if (!existing || existing.contentHash !== resolved.contentHash) {
      throw new RunConfigurationDefinitionConflictError(validated.configurationId);
    }
    return existing;
  }

  async resolve(configurationId: string): Promise<ResolvedRunConfiguration<TConfiguration> | undefined> {
    assertRunConfigurationId(configurationId);
    const value = await readJson(this.definitionPath(configurationId));
    if (value === undefined) return undefined;
    const configuration = validateDefinition<TConfiguration>(value, configurationId);
    return resolveDefinition(configuration);
  }

  async lifecycleStatus(configurationId: string): Promise<RunConfigurationLifecycleStatus | undefined> {
    if (!await this.resolve(configurationId)) return undefined;
    const metadata = await readJson(this.lifecyclePath(configurationId));
    if (metadata === undefined) return "active";
    return validateLifecycleMetadata(metadata, configurationId).status;
  }

  async archive(configurationId: string): Promise<void> {
    if (!await this.resolve(configurationId)) {
      throw new Error(`Run configuration ${configurationId} does not exist.`);
    }
    await replaceJson(this.lifecyclePath(configurationId), {
      schemaVersion: 1,
      configurationId,
      status: "archived",
      updatedAt: new Date().toISOString(),
    });
  }

  async restore(configurationId: string): Promise<void> {
    if (!await this.resolve(configurationId)) {
      throw new Error(`Run configuration ${configurationId} does not exist.`);
    }
    await replaceJson(this.lifecyclePath(configurationId), {
      schemaVersion: 1,
      configurationId,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
  }

  async list(query: RunConfigurationListQuery = {}): Promise<Page<ResolvedRunConfiguration<TConfiguration>>> {
    let names: string[];
    try {
      names = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
      throw error;
    }
    const definitions = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      const configurationId = name.slice(0, -".json".length);
      const resolved = await this.resolve(configurationId);
      if (resolved === undefined) throw new Error(`Run configuration disappeared while listing: ${name}.`);
      const lifecycleStatus = await this.lifecycleStatus(configurationId);
      return { resolved, lifecycleStatus };
    }));
    const requestedStatus = query.lifecycleStatus ?? "active";
    const filtered = definitions
      .filter(({ lifecycleStatus }) => requestedStatus === "all" || lifecycleStatus === requestedStatus)
      .map(({ resolved }) => resolved);
    return pageByKey(filtered, (definition) => definition.configuration.configurationId, query);
  }

  private definitionPath(configurationId: string): string {
    return path.join(this.root, `${configurationId}.json`);
  }

  private lifecyclePath(configurationId: string): string {
    return path.join(this.root, ".lifecycle", `${configurationId}.json`);
  }
}

function validateLifecycleMetadata(
  value: unknown,
  expectedConfigurationId: string,
): { status: RunConfigurationLifecycleStatus } {
  if (!isRecord(value)) throw new Error("Run configuration lifecycle metadata must be an object.");
  if (value.schemaVersion !== 1) throw new Error("Run configuration lifecycle metadata schemaVersion must be 1.");
  if (value.configurationId !== expectedConfigurationId) {
    throw new Error(`Run configuration lifecycle metadata ID mismatch for ${expectedConfigurationId}.`);
  }
  if (value.status !== "active" && value.status !== "archived") {
    throw new Error(`Run configuration ${expectedConfigurationId} lifecycle status is invalid.`);
  }
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error(`Run configuration ${expectedConfigurationId} lifecycle updatedAt is invalid.`);
  }
  return { status: value.status };
}

function validateDefinition<TConfiguration extends { configurationId: string }>(
  value: unknown,
  expectedId?: string,
): TConfiguration {
  if (!isRecord(value)) throw new Error("Run configuration definition must be an object.");
  assertRunConfigurationId(value.configurationId);
  if (expectedId !== undefined && value.configurationId !== expectedId) {
    throw new Error(`Run configuration definition ID mismatch: expected ${expectedId}, found ${value.configurationId}.`);
  }
  return structuredClone(value) as TConfiguration;
}

function resolveDefinition<TConfiguration>(configuration: TConfiguration): ResolvedRunConfiguration<TConfiguration> {
  return {
    configuration,
    contentHash: runConfigurationContentHash(configuration),
  };
}
