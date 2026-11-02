import { promises as fs } from "node:fs";
import path from "node:path";

export const LEGACY_LOCAL_STORE_DIRECTORIES = [
  ".agent-execution-platform",
  ".agent-execution-runs-v3",
  ".agent-execution-deployments",
] as const;

export const CURRENT_LEGACY_LOCAL_STORE_DIRECTORY = ".agent-execution" as const;

export interface LocalFileStorePaths {
  root: string;
  configuration: string;
  /** @deprecated Use configuration. */
  platform: string;
  runs: string;
  deployments: string;
  reservations: string;
  agentAuthProviders: string;
  credentials: string;
  processes: string;
  privacy: string;
  diagnostics: string;
  legacyBackup: string;
}

/** Execution output can be isolated without redirecting project configuration or credentials. */
export function resolveLocalExecutionDataPaths(repositoryRoot: string, executionDataRoot?: string) {
  if (executionDataRoot !== undefined && !path.isAbsolute(executionDataRoot)) {
    throw new Error("Execution data root must be an absolute directory.");
  }
  const root = executionDataRoot === undefined ? resolveLocalFileStorePaths(repositoryRoot).root : path.resolve(executionDataRoot);
  const runs = path.join(root, "runs");
  return { root, runs, reservations: path.join(runs, ".reservations"), retained: path.join(root, "retained") };
}

export function resolveLocalFileStorePaths(repositoryRoot: string): LocalFileStorePaths {
  const root = path.resolve(repositoryRoot, ".arkimux", "local");
  const configuration = path.join(root, "configuration");
  const runs = path.join(root, "runs");
  return {
    root,
    configuration,
    platform: configuration,
    runs,
    deployments: path.join(configuration, "deployments"),
    reservations: path.join(runs, ".reservations"),
    agentAuthProviders: path.join(configuration, "agent-auth-providers"),
    credentials: path.join(root, "credentials"),
    processes: path.join(root, "processes"),
    privacy: path.join(root, "privacy"),
    diagnostics: path.join(root, "diagnostics"),
    legacyBackup: path.join(root, "legacy-backup"),
  };
}

export async function assertLegacyLocalStoreMigrated(repositoryRoot: string): Promise<void> {
  const currentLegacy = await pathExists(path.resolve(repositoryRoot, CURRENT_LEGACY_LOCAL_STORE_DIRECTORY));
  const legacy = await existingLegacyLocalStoreDirectories(repositoryRoot);
  const flat = await hasFlatRunConfigurations(repositoryRoot);
  const legacyAuthentication = await hasLegacyAgentAuthentication(repositoryRoot);
  if (!currentLegacy && legacy.length === 0 && !flat && !legacyAuthentication) return;
  throw new Error(
    `Legacy local-store data was found: ${[
      ...(currentLegacy ? [CURRENT_LEGACY_LOCAL_STORE_DIRECTORY] : []),
      ...legacy,
      ...(flat ? [".arkimux/local/configuration/run-configurations"] : []),
      ...(legacyAuthentication ? [".arkimux/local/credentials/*.key or agent-auth-providers@1"] : []),
    ].join(", ")}. `
      + "Run `arkimux local migrate` before starting the local server.",
  );
}

export async function hasLegacyAgentAuthentication(repositoryRoot: string): Promise<boolean> {
  const paths = resolveLocalFileStorePaths(repositoryRoot);
  try {
    if ((await fs.readdir(paths.credentials)).some((name) => name.endsWith(".key"))) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    for (const name of await fs.readdir(paths.agentAuthProviders)) {
      const candidate = path.join(paths.agentAuthProviders, name, "definition.json");
      try {
        const parsed = JSON.parse(await fs.readFile(candidate, "utf8")) as { schemaVersion?: unknown };
        if (parsed.schemaVersion === 1) return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return false;
}

async function hasFlatRunConfigurations(repositoryRoot: string): Promise<boolean> {
  const directory = path.resolve(
    repositoryRoot,
    ".arkimux",
    "local",
    "configuration",
    "run-configurations",
  );
  try {
    return (await fs.readdir(directory)).some((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function existingLegacyLocalStoreDirectories(
  repositoryRoot: string,
): Promise<Array<typeof LEGACY_LOCAL_STORE_DIRECTORIES[number]>> {
  const existing = await Promise.all(LEGACY_LOCAL_STORE_DIRECTORIES.map(async (directory) => (
    await pathExists(path.resolve(repositoryRoot, directory)) ? directory : undefined
  )));
  return existing.filter((directory): directory is typeof LEGACY_LOCAL_STORE_DIRECTORIES[number] => (
    directory !== undefined
  ));
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
