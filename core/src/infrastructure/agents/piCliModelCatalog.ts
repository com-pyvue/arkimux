import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentExecutionParameterOption } from "../../application/agentProviderEditor.ts";
import { resolveCliExecutable } from "./cliExecutableResolver.ts";

export interface PiCliModelCatalogOptions {
  cwd: string;
  environment?: NodeJS.ProcessEnv;
  command?: string;
}

export interface PiCliProviderModelCatalogOptions extends PiCliModelCatalogOptions {
  modelProvider: string;
}

export async function loadPiCliModelOptions(
  options: PiCliProviderModelCatalogOptions,
): Promise<readonly AgentExecutionParameterOption[]> {
  return loadPiCliModelOptionsForProvider(options, options.modelProvider);
}

export async function loadPiCliOpenAiCodexModelOptions(
  options: PiCliModelCatalogOptions,
): Promise<readonly AgentExecutionParameterOption[]> {
  return loadPiCliModelOptionsForProvider(options, "openai-codex");
}

/**
 * Order text models for a connection probe. Stable models are preferred over
 * preview models, then lower catalog cost is preferred within each group.
 */
export async function loadPiCliProbeModels(
  options: PiCliProviderModelCatalogOptions,
): Promise<readonly string[]> {
  const catalog = await loadPiCliModelCatalog(options, options.modelProvider);
  return catalog.sort((left, right) => (
    Number(isPreviewModel(left.id)) - Number(isPreviewModel(right.id))
    || left.estimatedCost - right.estimatedCost
    || left.id.localeCompare(right.id)
  )).map(({ id }) => id);
}

/** Select the preferred text model declared by the installed Pi provider catalog. */
export async function loadPiCliProbeModel(
  options: PiCliProviderModelCatalogOptions,
): Promise<string | undefined> {
  return (await loadPiCliProbeModels(options))[0];
}

async function loadPiCliModelOptionsForProvider(
  options: PiCliModelCatalogOptions,
  modelProvider: string,
): Promise<readonly AgentExecutionParameterOption[]> {
  const environment = options.environment ?? process.env;
  const command = options.command
    ?? environment.AGENT_EXECUTION_PI_COMMAND
    ?? environment.PI_COMMAND
    ?? environment.SYSTEM_MODEL_BUILDER_PI_COMMAND
    ?? "pi";
  const executable = await resolveCliExecutable(command, options.cwd, environment);
  if (!executable) return [];

  try {
    const executablePath = await fs.realpath(executable.command);
    const catalogPath = await findPiAiCatalog(executablePath, modelProvider);
    if (!catalogPath) return [];
    return parseModelCatalog(JSON.parse(await fs.readFile(catalogPath, "utf8")), modelProvider)
      .map(({ id, label }) => ({ value: id, label }));
  } catch {
    return [];
  }
}

async function findPiAiCatalog(executablePath: string, modelProvider: string): Promise<string | undefined> {
  let current = path.dirname(executablePath);
  while (true) {
    const candidate = path.join(
      current,
      "node_modules",
      "@earendil-works",
      "pi-ai",
      "dist",
      "providers",
      "data",
      `${modelProvider}.json`,
    );
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  }
}

interface PiModelCatalogEntry {
  id: string;
  label: string;
  estimatedCost: number;
}

async function loadPiCliModelCatalog(
  options: PiCliModelCatalogOptions,
  modelProvider: string,
): Promise<PiModelCatalogEntry[]> {
  const environment = options.environment ?? process.env;
  const command = options.command
    ?? environment.AGENT_EXECUTION_PI_COMMAND
    ?? environment.PI_COMMAND
    ?? environment.SYSTEM_MODEL_BUILDER_PI_COMMAND
    ?? "pi";
  const executable = await resolveCliExecutable(command, options.cwd, environment);
  if (!executable) return [];
  try {
    const catalogPath = await findPiAiCatalog(await fs.realpath(executable.command), modelProvider);
    return catalogPath
      ? parseModelCatalog(JSON.parse(await fs.readFile(catalogPath, "utf8")), modelProvider)
      : [];
  } catch {
    return [];
  }
}

function parseModelCatalog(value: unknown, modelProvider: string): PiModelCatalogEntry[] {
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap((apiModels) => {
    if (!isRecord(apiModels)) return [];
    return Object.values(apiModels).flatMap((candidate) => {
      if (!isRecord(candidate)
        || candidate.provider !== modelProvider
        || typeof candidate.id !== "string"
        || candidate.id.length === 0
        || (candidate.input !== undefined && (
          !Array.isArray(candidate.input) || !candidate.input.includes("text")
        ))) return [];
      const cost = isRecord(candidate.cost)
        ? finiteCost(candidate.cost.input) + finiteCost(candidate.cost.output)
        : Number.POSITIVE_INFINITY;
      return [{
        id: candidate.id,
        label: typeof candidate.name === "string" && candidate.name.length > 0
          ? candidate.name
          : candidate.id,
        estimatedCost: cost,
      }];
    });
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function finiteCost(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function isPreviewModel(model: string): boolean {
  return /(?:^|[-_.])(preview|experimental|beta|alpha|rc)(?:$|[-_.])/i.test(model);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
