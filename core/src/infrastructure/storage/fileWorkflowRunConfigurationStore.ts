import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Page,
  RunConfigurationLifecycleStatus,
  RunConfigurationListQuery,
  WorkflowRunConfigurationDefinition,
  WorkflowRunConfigurationStore,
} from "../../application/platformStore.ts";
import {
  runConfigurationContentHash,
  type ResolvedRunConfiguration,
} from "../../application/runConfiguration.ts";
import { assertRunConfigurationId } from "../../domain/runConfigurationReference.ts";
import { isRecord } from "../../domain/validation.ts";
import { validateWorkflowIdentity, type WorkflowIdentity } from "../../domain/workflowIdentity.ts";
import { readJson, replaceJson, writeJsonExclusive } from "./filePlatformStoreSupport.ts";
import { pageByKey } from "./filePagination.ts";

export class WorkflowRunConfigurationDefinitionConflictError extends Error {
  constructor(readonly workflow: WorkflowIdentity, readonly configurationId: string) {
    super(`Run configuration ${configurationId} already exists with different content for ${workflowKey(workflow)}.`);
    this.name = "WorkflowRunConfigurationDefinitionConflictError";
  }
}

export class FileWorkflowRunConfigurationStore<
  TConfiguration extends WorkflowRunConfigurationDefinition = WorkflowRunConfigurationDefinition,
> implements WorkflowRunConfigurationStore<TConfiguration> {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async publish(configuration: TConfiguration): Promise<ResolvedRunConfiguration<TConfiguration>> {
    const validated = validateDefinition(configuration) as TConfiguration;
    const resolved = resolveDefinition(validated);
    if (await writeJsonExclusive(this.definitionPath(validated.workflow, validated.configurationId), validated)) {
      return this.requiredResolved(validated.workflow, validated.configurationId);
    }
    const existing = await this.resolve(validated.workflow, validated.configurationId);
    if (!existing || existing.contentHash !== resolved.contentHash) {
      throw new WorkflowRunConfigurationDefinitionConflictError(
        validated.workflow,
        validated.configurationId,
      );
    }
    return existing;
  }

  async resolve(
    workflow: WorkflowIdentity,
    configurationId: string,
  ): Promise<ResolvedRunConfiguration<TConfiguration> | undefined> {
    const validatedWorkflow = validateWorkflowIdentity(workflow);
    assertRunConfigurationId(configurationId);
    const value = await readJson(this.definitionPath(validatedWorkflow, configurationId));
    if (value === undefined) return undefined;
    return resolveDefinition(
      validateDefinition(value, validatedWorkflow, configurationId) as TConfiguration,
      await definitionCreatedAt(this.definitionPath(validatedWorkflow, configurationId)),
    );
  }

  async lifecycleStatus(
    workflow: WorkflowIdentity,
    configurationId: string,
  ): Promise<RunConfigurationLifecycleStatus | undefined> {
    const validatedWorkflow = validateWorkflowIdentity(workflow);
    if (!await this.resolve(validatedWorkflow, configurationId)) return undefined;
    const metadata = await readJson(this.lifecyclePath(validatedWorkflow, configurationId));
    if (metadata === undefined) return "active";
    return validateLifecycleMetadata(metadata, validatedWorkflow, configurationId).status;
  }

  async archive(workflow: WorkflowIdentity, configurationId: string): Promise<void> {
    await this.setLifecycleStatus(workflow, configurationId, "archived");
  }

  async restore(workflow: WorkflowIdentity, configurationId: string): Promise<void> {
    await this.setLifecycleStatus(workflow, configurationId, "active");
  }

  async list(
    workflow: WorkflowIdentity,
    query: RunConfigurationListQuery = {},
  ): Promise<Page<ResolvedRunConfiguration<TConfiguration>>> {
    const validatedWorkflow = validateWorkflowIdentity(workflow);
    const root = this.workflowRoot(validatedWorkflow);
    let names: string[];
    try {
      names = await fs.readdir(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { items: [] };
      throw error;
    }
    const definitions = await Promise.all(names.filter((name) => !name.startsWith(".")).map(async (configurationId) => {
      const resolved = await this.resolve(validatedWorkflow, configurationId);
      if (!resolved) return undefined;
      return {
        resolved,
        lifecycleStatus: await this.lifecycleStatus(validatedWorkflow, configurationId),
      };
    }));
    const requestedStatus = query.lifecycleStatus ?? "active";
    const filtered = definitions
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .filter(({ lifecycleStatus }) => requestedStatus === "all" || lifecycleStatus === requestedStatus)
      .map(({ resolved }) => resolved);
    return pageByKey(filtered, ({ configuration }) => configuration.configurationId, query);
  }

  private async setLifecycleStatus(
    workflow: WorkflowIdentity,
    configurationId: string,
    status: RunConfigurationLifecycleStatus,
  ): Promise<void> {
    const validatedWorkflow = validateWorkflowIdentity(workflow);
    if (!await this.resolve(validatedWorkflow, configurationId)) {
      throw new Error(`Run configuration ${configurationId} does not exist for ${workflowKey(validatedWorkflow)}.`);
    }
    await replaceJson(this.lifecyclePath(validatedWorkflow, configurationId), {
      schemaVersion: 1,
      workflow: validatedWorkflow,
      configurationId,
      status,
      updatedAt: new Date().toISOString(),
    });
  }

  private async requiredResolved(
    workflow: WorkflowIdentity,
    configurationId: string,
  ): Promise<ResolvedRunConfiguration<TConfiguration>> {
    const resolved = await this.resolve(workflow, configurationId);
    if (!resolved) throw new Error(`Run configuration ${configurationId} was not persisted.`);
    return resolved;
  }

  private workflowRoot(workflow: WorkflowIdentity): string {
    return path.join(this.root, encodeURIComponent(workflow.kind), String(workflow.version));
  }

  private definitionPath(workflow: WorkflowIdentity, configurationId: string): string {
    return path.join(this.workflowRoot(workflow), configurationId, "definition.json");
  }

  private lifecyclePath(workflow: WorkflowIdentity, configurationId: string): string {
    return path.join(this.workflowRoot(workflow), configurationId, "lifecycle.json");
  }
}

function validateDefinition(
  value: unknown,
  expectedWorkflow?: WorkflowIdentity,
  expectedConfigurationId?: string,
): WorkflowRunConfigurationDefinition {
  if (!isRecord(value)) throw new Error("Workflow run configuration definition must be an object.");
  if (typeof value.configurationId !== "string") throw new Error("Run configuration configurationId is invalid.");
  assertRunConfigurationId(value.configurationId);
  const workflow = validateWorkflowIdentity(value.workflow);
  if (expectedConfigurationId !== undefined && value.configurationId !== expectedConfigurationId) {
    throw new Error(`Run configuration ID mismatch: expected ${expectedConfigurationId}, found ${value.configurationId}.`);
  }
  if (expectedWorkflow !== undefined && workflowKey(workflow) !== workflowKey(expectedWorkflow)) {
    throw new Error(`Run configuration workflow mismatch: expected ${workflowKey(expectedWorkflow)}, found ${workflowKey(workflow)}.`);
  }
  return structuredClone(value) as unknown as WorkflowRunConfigurationDefinition;
}

function validateLifecycleMetadata(
  value: unknown,
  workflow: WorkflowIdentity,
  configurationId: string,
): { status: RunConfigurationLifecycleStatus } {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.configurationId !== configurationId) {
    throw new Error(`Run configuration ${configurationId} lifecycle metadata is invalid.`);
  }
  const metadataWorkflow = validateWorkflowIdentity(value.workflow);
  if (workflowKey(metadataWorkflow) !== workflowKey(workflow)) {
    throw new Error(`Run configuration ${configurationId} lifecycle workflow is invalid.`);
  }
  if (value.status !== "active" && value.status !== "archived") {
    throw new Error(`Run configuration ${configurationId} lifecycle status is invalid.`);
  }
  if (typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
    throw new Error(`Run configuration ${configurationId} lifecycle updatedAt is invalid.`);
  }
  return { status: value.status };
}

function resolveDefinition<TConfiguration>(
  configuration: TConfiguration,
  createdAt?: string,
): ResolvedRunConfiguration<TConfiguration> {
  return {
    configuration,
    contentHash: runConfigurationContentHash(configuration),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

async function definitionCreatedAt(definitionPath: string): Promise<string> {
  const stats = await fs.stat(definitionPath);
  const timestamp = stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime;
  return timestamp.toISOString();
}

function workflowKey(workflow: WorkflowIdentity): string {
  return `${workflow.kind}@${workflow.version}`;
}
