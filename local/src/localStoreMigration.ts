import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  CURRENT_LEGACY_LOCAL_STORE_DIRECTORY,
  LEGACY_LOCAL_STORE_DIRECTORIES,
  resolveLocalFileStorePaths,
  hasLegacyAgentAuthentication,
} from "./localStorePaths.ts";

export interface LocalStoreMigrationResult {
  migrated: boolean;
  files: number;
  backupRoot?: string;
  message: string;
}

/**
 * Move all known project-local state into `.arkimux/local` before applying
 * older schema migrations inside that new storage root.
 */
export async function migrateLegacyLocalStore(repositoryRoot: string): Promise<LocalStoreMigrationResult> {
  const storage = await migrateStorageRoots(repositoryRoot);
  const configurations = await migrateFlatRunConfigurations(repositoryRoot);
  const authentication = await migrateLegacyAgentAuthentication(repositoryRoot);
  const results = [storage, configurations, authentication];
  const files = results.reduce((total, result) => total + result.files, 0);
  const migrated = results.some((result) => result.migrated);
  const backupRoot = storage.backupRoot ?? configurations.backupRoot ?? authentication.backupRoot;
  return {
    migrated,
    files,
    ...(backupRoot === undefined ? {} : { backupRoot }),
    message: migrated
      ? results.filter(({ migrated: changed }) => changed).map(({ message }) => message).join(" ")
      : "No legacy project-local storage or schema was found.",
  };
}

interface StorageMapping {
  label: string;
  source: string;
  destination: string;
}

async function migrateStorageRoots(repositoryRoot: string): Promise<LocalStoreMigrationResult> {
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const paths = resolveLocalFileStorePaths(resolvedRepositoryRoot);
  const recovered = await recoverStrandedStorageMigration(resolvedRepositoryRoot, paths.root);
  if (recovered !== undefined) return recovered;
  const currentLegacyRoot = path.join(resolvedRepositoryRoot, CURRENT_LEGACY_LOCAL_STORE_DIRECTORY);
  const sourceRoots: string[] = [];
  for (const candidate of [
    currentLegacyRoot,
    ...LEGACY_LOCAL_STORE_DIRECTORIES.map((name) => path.join(resolvedRepositoryRoot, name)),
  ]) {
    if (await pathExists(candidate)) sourceRoots.push(candidate);
  }
  if (sourceRoots.length === 0) {
    return { migrated: false, files: 0, message: "No legacy project-local storage roots were found." };
  }
  for (const source of sourceRoots) await assertDirectory(source, "Legacy local-storage root");
  if (sourceRoots.includes(currentLegacyRoot)) await assertNoLiveLocalServer(currentLegacyRoot);

  await assertEmptyMigrationTarget(paths.root);
  const migrationId = migrationIdentifier();
  const stagingRoot = path.join(resolvedRepositoryRoot, ".arkimux", `.local-migration-${migrationId}`);
  const stagedBackupRoot = path.join(stagingRoot, "legacy-backup", migrationId);
  const mappings = await collectStorageMappings(resolvedRepositoryRoot, currentLegacyRoot, stagingRoot);
  const movedSources: Array<{ source: string; backup: string }> = [];
  let files = 0;

  await fs.mkdir(path.dirname(stagingRoot), { recursive: true });
  await fs.mkdir(stagingRoot, { mode: 0o700 });
  try {
    for (const mapping of mappings) {
      if (await pathExists(mapping.destination)) {
        throw new Error(
          `Cannot migrate ${mapping.label}: more than one legacy source maps to ${relativeProjectPath(resolvedRepositoryRoot, mapping.destination)}. `
            + "Reconcile the duplicate local data before retrying.",
        );
      }
      files += await copyEntryVerified(mapping.source, mapping.destination);
    }
    await groupDeploymentConfiguration(stagingRoot);

    await fs.mkdir(stagedBackupRoot, { recursive: true, mode: 0o700 });
    for (const source of sourceRoots) {
      const backup = path.join(stagedBackupRoot, path.basename(source));
      await fs.rename(source, backup);
      movedSources.push({ source, backup });
    }
    await fs.rename(stagingRoot, paths.root);
  } catch (error) {
    for (const moved of movedSources.reverse()) {
      if (await pathExists(moved.backup)) await fs.rename(moved.backup, moved.source);
    }
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }

  const backupRoot = path.join(paths.legacyBackup, migrationId);
  return {
    migrated: true,
    files,
    backupRoot,
    message: `Migrated and verified ${files} active files. The complete previous storage roots remain recoverable at ${backupRoot}.`,
  };
}

async function recoverStrandedStorageMigration(
  repositoryRoot: string,
  targetRoot: string,
): Promise<LocalStoreMigrationResult | undefined> {
  const arkimuxRoot = path.join(repositoryRoot, ".arkimux");
  const stagingNames = (await directoryNames(arkimuxRoot))
    .filter((name) => name.startsWith(".local-migration-"))
    .sort();
  if (stagingNames.length === 0) return undefined;
  if (stagingNames.length > 1) {
    throw new Error(
      `Cannot safely resume local-storage migration: multiple staging directories exist (${stagingNames.join(", ")}). `
        + "Inspect and reconcile them before retrying.",
    );
  }

  const stagingName = stagingNames[0]!;
  const stagingRoot = path.join(arkimuxRoot, stagingName);
  await assertDirectory(stagingRoot, "Local-storage migration staging root");
  if (await pathExists(targetRoot)) {
    throw new Error(
      `Cannot safely resume local-storage migration: both ${stagingRoot} and ${targetRoot} exist. `
        + "Inspect and reconcile them before retrying.",
    );
  }

  const migrationId = stagingName.slice(".local-migration-".length);
  if (migrationId.length === 0) {
    throw new Error(`Cannot safely resume local-storage migration: ${stagingRoot} has no migration ID.`);
  }
  const stagedLegacyBackup = path.join(stagingRoot, "legacy-backup");
  await assertDirectory(stagedLegacyBackup, "Local-storage migration backup root");
  const backupIds = (await directoryNames(stagedLegacyBackup)).sort();
  if (backupIds.length !== 1 || backupIds[0] !== migrationId) {
    throw new Error(
      `Cannot safely resume local-storage migration: ${stagedLegacyBackup} does not contain exactly backup ${migrationId}.`,
    );
  }
  const stagedBackupRoot = path.join(stagedLegacyBackup, migrationId);
  await assertDirectory(stagedBackupRoot, "Local-storage migration backup");

  const knownSourceNames = [CURRENT_LEGACY_LOCAL_STORE_DIRECTORY, ...LEGACY_LOCAL_STORE_DIRECTORIES];
  const backedUpSourceNames = (await directoryNames(stagedBackupRoot)).sort();
  if (
    backedUpSourceNames.length === 0
    || backedUpSourceNames.some((name) => !knownSourceNames.includes(name as typeof knownSourceNames[number]))
  ) {
    throw new Error(
      `Cannot safely resume local-storage migration: ${stagedBackupRoot} does not contain a complete recognized legacy backup.`,
    );
  }
  for (const sourceName of backedUpSourceNames) {
    await assertDirectory(path.join(stagedBackupRoot, sourceName), "Local-storage migration source backup");
  }

  const remainingSources: string[] = [];
  for (const sourceName of knownSourceNames) {
    if (await pathExists(path.join(repositoryRoot, sourceName))) remainingSources.push(sourceName);
  }
  if (remainingSources.length > 0) {
    throw new Error(
      `Cannot safely resume local-storage migration: legacy source data still exists (${remainingSources.join(", ")}). `
        + "The interrupted migration is incomplete; inspect and reconcile it before retrying.",
    );
  }

  const recoveryCheckRoot = await fs.mkdtemp(path.join(os.tmpdir(), "arkimux-local-migration-recovery-"));
  try {
    const expectedRoot = path.join(recoveryCheckRoot, "local");
    const expectedMappings = await collectStorageMappings(
      stagedBackupRoot,
      path.join(stagedBackupRoot, CURRENT_LEGACY_LOCAL_STORE_DIRECTORY),
      expectedRoot,
    );
    for (const mapping of expectedMappings) {
      if (await pathExists(mapping.destination)) {
        throw new Error(
          `Cannot safely resume local-storage migration: backup entries conflict at ${relativeProjectPath(expectedRoot, mapping.destination)}.`,
        );
      }
      await copyEntryVerified(mapping.source, mapping.destination);
    }
    await groupDeploymentConfiguration(expectedRoot);
    const [expected, staged] = await Promise.all([
      storageContentSnapshot(expectedRoot),
      storageContentSnapshot(stagingRoot, new Set(["legacy-backup"])),
    ]);
    if (expected.digest !== staged.digest || expected.files !== staged.files) {
      throw new Error(
        `Cannot safely resume local-storage migration: active data in ${stagingRoot} does not match its complete legacy backup. `
          + "The project manifest was not changed.",
      );
    }
  } finally {
    await fs.rm(recoveryCheckRoot, { recursive: true, force: true });
  }

  await fs.rename(stagingRoot, targetRoot);
  for (const sourceName of knownSourceNames) {
    if (await pathExists(path.join(repositoryRoot, sourceName))) {
      throw new Error(
        `Local-storage migration recovery found new legacy data at ${sourceName}. The project manifest must not be changed.`,
      );
    }
  }
  const recovered = await storageContentSnapshot(targetRoot, new Set(["legacy-backup"]));
  const backupRoot = path.join(targetRoot, "legacy-backup", migrationId);
  return {
    migrated: true,
    files: recovered.files,
    backupRoot,
    message: `Recovered an interrupted local-storage migration and verified ${recovered.files} active files. The complete previous storage roots remain recoverable at ${backupRoot}.`,
  };
}

async function collectStorageMappings(
  repositoryRoot: string,
  currentLegacyRoot: string,
  stagingRoot: string,
): Promise<StorageMapping[]> {
  const mappings: StorageMapping[] = [];
  const add = async (label: string, source: string, relativeDestination: string): Promise<void> => {
    if (await pathExists(source)) {
      mappings.push({ label, source, destination: path.join(stagingRoot, relativeDestination) });
    }
  };
  const currentFileRoot = path.join(currentLegacyRoot, "local-store", "file");
  await add("current platform configuration", path.join(currentFileRoot, "platform"), "configuration");
  await add("current credentials", path.join(currentFileRoot, "credentials"), "credentials");
  await add("current runs", path.join(currentFileRoot, "runs"), "runs");
  await add("current deployments", path.join(currentFileRoot, "deployments"), path.join("configuration", "deployments"));
  await add("current process state", path.join(currentLegacyRoot, "processes"), "processes");
  await add("current local-server process record", path.join(currentLegacyRoot, "local-server.json"), path.join("processes", "local-server.json"));
  await add("current local-server log", path.join(currentLegacyRoot, "local-server.log"), path.join("processes", "local-server.log"));
  await add(
    LEGACY_LOCAL_STORE_DIRECTORIES[0],
    path.join(repositoryRoot, LEGACY_LOCAL_STORE_DIRECTORIES[0]),
    "configuration",
  );
  await add(
    LEGACY_LOCAL_STORE_DIRECTORIES[1],
    path.join(repositoryRoot, LEGACY_LOCAL_STORE_DIRECTORIES[1]),
    "runs",
  );
  await add(
    LEGACY_LOCAL_STORE_DIRECTORIES[2],
    path.join(repositoryRoot, LEGACY_LOCAL_STORE_DIRECTORIES[2]),
    path.join("configuration", "deployments"),
  );
  return mappings;
}

async function groupDeploymentConfiguration(stagingRoot: string): Promise<void> {
  const configuration = path.join(stagingRoot, "configuration");
  const deployments = path.join(configuration, "deployments");
  for (const name of ["workflow-deployments", "deployment-health", "meters"]) {
    const source = path.join(configuration, name);
    if (!(await pathExists(source))) continue;
    const destination = path.join(deployments, name);
    if (await pathExists(destination)) {
      throw new Error(
        `Cannot migrate deployment configuration: both ${source} and ${destination} contain ${name} data. `
          + "Reconcile the duplicate local data before retrying.",
      );
    }
    await fs.mkdir(deployments, { recursive: true });
    await fs.rename(source, destination);
  }
}

async function assertNoLiveLocalServer(currentLegacyRoot: string): Promise<void> {
  for (const processRecord of [
    path.join(currentLegacyRoot, "processes", "local-server.json"),
    path.join(currentLegacyRoot, "local-server.json"),
  ]) {
    if (!(await pathExists(processRecord))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(processRecord, "utf8"));
    } catch (error) {
      throw new Error(
        `Cannot safely migrate ${processRecord}: the local-server process record is unreadable. `
          + "Stop the local server and inspect or remove the stale record before retrying.",
        { cause: error },
      );
    }
    const pid = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).pid
      : undefined;
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
      throw new Error(
        `Cannot safely migrate ${processRecord}: it does not contain a valid process ID. `
          + "Stop the local server and inspect or remove the stale record before retrying.",
      );
    }
    if (isProcessAlive(Number(pid))) {
      throw new Error(
        `Cannot migrate project-local data while local server process ${pid} is still running. `
          + "Run `arkimux local stop` and retry `arkimux local migrate`.",
      );
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

async function assertEmptyMigrationTarget(target: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory()) {
    throw new Error(`Cannot migrate project-local data: ${target} already exists and is not a directory.`);
  }
  if ((await fs.readdir(target)).length !== 0) {
    throw new Error(
      `Cannot migrate project-local data because ${target} already contains data. `
        + "Move or reconcile the old and new local data before retrying.",
    );
  }
  await fs.rmdir(target);
}

async function migrateLegacyAgentAuthentication(repositoryRoot: string): Promise<LocalStoreMigrationResult> {
  if (!(await hasLegacyAgentAuthentication(repositoryRoot))) {
    return { migrated: false, files: 0, message: "No V1 authentication data was found." };
  }
  const paths = resolveLocalFileStorePaths(repositoryRoot);
  const providerNames = await directoryNames(paths.agentAuthProviders);
  const flatCredentialNames = (await directoryNames(paths.credentials))
    .filter((name) => name.endsWith(".key"))
    .map((name) => name.slice(0, -4));
  const authProviderIds = [...new Set([...providerNames, ...flatCredentialNames])]
    .filter((name) => name.length > 0 && !name.startsWith("."))
    .sort();
  const migrationId = migrationIdentifier();
  const backupRoot = path.join(paths.legacyBackup, migrationId, "agent-authentication-v1");
  let files = 0;
  let providers = 0;
  for (const authProviderId of authProviderIds) {
    const providerRoot = path.join(paths.agentAuthProviders, authProviderId);
    const definitionPath = path.join(providerRoot, "definition.json");
    const keyPath = path.join(paths.credentials, `${authProviderId}.key`);
    const legacyKey = await readFileOptional(keyPath);
    const definitionFile = await readJsonFileOptional(definitionPath);
    if (definitionFile === undefined) {
      if (legacyKey !== undefined) {
        throw new Error(
          `Cannot migrate V1 authentication configuration ${authProviderId}: its provider definition is missing. `
            + "Restore the provider definition from backup before retrying.",
        );
      }
      continue;
    }
    const currentDefinition = record(definitionFile.value, `Authentication provider ${authProviderId} definition`);
    if (currentDefinition.schemaVersion !== 1 && currentDefinition.schemaVersion !== 2) {
      if (legacyKey !== undefined) {
        throw new Error(
          `Cannot migrate V1 authentication configuration ${authProviderId}: its provider definition schema is unsupported.`,
        );
      }
      continue;
    }
    if (currentDefinition.schemaVersion === 2 && legacyKey === undefined) continue;

    const currentMetadataFile = await readJsonFile(path.join(providerRoot, "metadata.json"));
    const currentMetadata = authenticationMetadata(
      currentMetadataFile.value,
      authProviderId,
      "Authentication provider",
    );
    const displayName = nonEmptyString(
      currentDefinition.displayName,
      `Authentication provider ${authProviderId} displayName`,
    );
    const executionProviderId = nonEmptyString(
      currentDefinition.executionProviderId,
      `Authentication provider ${authProviderId} executionProviderId`,
    );
    const targetVariable = nonEmptyString(
      currentDefinition.targetVariable,
      `Authentication provider ${authProviderId} targetVariable`,
    );
    const modelProvider = typeof currentDefinition.modelProvider === "string"
      ? currentDefinition.modelProvider
      : executionProviderId === "claude-code-cli" ? "anthropic" : "openai";
    if (currentDefinition.schemaVersion === 2 && currentDefinition.credentialId !== authProviderId) {
      throw new Error(
        `Cannot resume V1 authentication migration for ${authProviderId}: the partial V2 binding uses credential ${String(currentDefinition.credentialId)}.`,
      );
    }

    const credentialRoot = path.join(paths.credentials, "definitions", authProviderId);
    const credentialDefinitionPath = path.join(credentialRoot, "definition.json");
    const credentialMetadataPath = path.join(credentialRoot, "metadata.json");
    const credentialValue = path.join(paths.credentials, "values", `${authProviderId}.key`);
    const installedKey = await readFileOptional(credentialValue);
    const secret = legacyKey?.bytes ?? installedKey?.bytes;
    const keyMode = legacyKey?.mode ?? installedKey?.mode;
    if (secret === undefined || keyMode === undefined) {
      throw new Error(
        `Cannot migrate V1 authentication configuration ${authProviderId}: its API key is missing. `
          + "Restore the key from backup before retrying.",
      );
    }

    const credentialDefinition = {
      schemaVersion: 1,
      credentialId: authProviderId,
      displayName: `${displayName} credential`,
      kind: "api-key",
      modelProvider,
    };
    const finalProviderDefinition = {
      schemaVersion: 2,
      authProviderId,
      displayName,
      kind: "stored-credential",
      executionProviderId,
      ...(currentDefinition.modelProvider === undefined ? {} : { modelProvider: currentDefinition.modelProvider }),
      credentialId: authProviderId,
      targetVariable,
    };
    if (currentDefinition.schemaVersion === 2) {
      assertJsonEqual(currentDefinition, finalProviderDefinition, definitionPath);
    }

    const now = new Date().toISOString();
    const existingCredentialMetadataFile = await readJsonFileOptional(credentialMetadataPath);
    const credentialMetadata = existingCredentialMetadataFile === undefined
      ? {
        schemaVersion: 1,
        credentialId: authProviderId,
        lifecycleStatus: "active",
        createdAt: now,
        updatedAt: now,
      }
      : credentialMetadataValue(existingCredentialMetadataFile.value, authProviderId);
    const finalProviderMetadata: Record<string, unknown> = currentDefinition.schemaVersion === 2
      && !Object.hasOwn(currentMetadataFile.value, "credentialAvailable")
      ? currentMetadataFile.value
      : {
        schemaVersion: 1,
        authProviderId,
        lifecycleStatus: currentMetadata.lifecycleStatus,
        createdAt: currentMetadata.createdAt,
        updatedAt: now,
      };

    const original = await findOriginalAuthenticationBackup(
      paths.legacyBackup,
      authProviderId,
      secret,
      finalProviderDefinition,
      currentMetadata,
    );
    await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await copyEntryVerified(
      original?.providerRoot ?? providerRoot,
      path.join(backupRoot, "agent-auth-providers", authProviderId),
    );
    await copyEntryVerified(
      original?.keyPath ?? (legacyKey === undefined ? credentialValue : keyPath),
      path.join(backupRoot, "credentials", `${authProviderId}.key`),
    );

    // Keep the flat V1 key as the migration marker until every final file is installed and verified.
    // A stopped process therefore leaves either a complete V2 provider or state this loop can resume.
    await installFileIdempotent(credentialDefinitionPath, jsonBytes(credentialDefinition));
    await installFileIdempotent(credentialMetadataPath, jsonBytes(credentialMetadata));
    await fs.mkdir(path.dirname(credentialValue), { recursive: true, mode: 0o700 });
    await fs.chmod(path.dirname(credentialValue), 0o700);
    await installFileIdempotent(credentialValue, secret, keyMode);
    await replaceFileAtomicVerified(
      path.join(providerRoot, "metadata.json"),
      jsonBytes(finalProviderMetadata),
      currentMetadataFile.mode,
    );
    await replaceFileAtomicVerified(
      definitionPath,
      jsonBytes(finalProviderDefinition),
      definitionFile.mode,
    );

    await assertJsonFileEqual(credentialDefinitionPath, credentialDefinition);
    await assertJsonFileEqual(credentialMetadataPath, credentialMetadata);
    await assertFileEqual(credentialValue, secret, keyMode);
    await assertJsonFileEqual(definitionPath, finalProviderDefinition);
    await assertJsonFileEqual(path.join(providerRoot, "metadata.json"), finalProviderMetadata);
    if (legacyKey !== undefined) await fs.rm(keyPath);
    files += 4;
    providers += 1;
  }
  return {
    migrated: providers > 0,
    files,
    ...(providers > 0 ? { backupRoot } : {}),
    message: providers > 0
      ? `Migrated ${providers} V1 authentication configurations into separate credentials and V2 authentication configurations.`
      : "No V1 authentication data was found.",
  };
}

interface ReadFileResult {
  bytes: Buffer;
  mode: number;
}

interface ReadJsonFileResult extends ReadFileResult {
  value: Record<string, unknown>;
}

async function directoryNames(directory: string): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readFileOptional(file: string): Promise<ReadFileResult | undefined> {
  try {
    const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
    return { bytes, mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJsonFile(file: string): Promise<ReadJsonFileResult> {
  const found = await readFileOptional(file);
  if (found === undefined) throw new Error(`Migration source is missing: ${file}`);
  let value: unknown;
  try {
    value = JSON.parse(found.bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Migration source is not valid JSON: ${file}`, { cause: error });
  }
  return { ...found, value: record(value, `Migration source ${file}`) };
}

async function readJsonFileOptional(file: string): Promise<ReadJsonFileResult | undefined> {
  if (!(await pathExists(file))) return undefined;
  return await readJsonFile(file);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function authenticationMetadata(
  value: unknown,
  expectedId: string,
  label: string,
): { lifecycleStatus: "active" | "archived"; createdAt: string; updatedAt: string } {
  const metadata = record(value, `${label} ${expectedId} metadata`);
  if (metadata.authProviderId !== expectedId || metadata.schemaVersion !== 1) {
    throw new Error(`${label} ${expectedId} metadata identity is invalid.`);
  }
  if (metadata.lifecycleStatus !== "active" && metadata.lifecycleStatus !== "archived") {
    throw new Error(`${label} ${expectedId} lifecycle status is invalid.`);
  }
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (typeof metadata[field] !== "string" || !Number.isFinite(Date.parse(metadata[field]))) {
      throw new Error(`${label} ${expectedId} ${field} is invalid.`);
    }
  }
  return {
    lifecycleStatus: metadata.lifecycleStatus,
    createdAt: metadata.createdAt as string,
    updatedAt: metadata.updatedAt as string,
  };
}

function credentialMetadataValue(value: unknown, expectedId: string): Record<string, unknown> {
  const metadata = record(value, `Credential ${expectedId} metadata`);
  if (metadata.credentialId !== expectedId || metadata.schemaVersion !== 1) {
    throw new Error(`Credential ${expectedId} metadata identity is invalid.`);
  }
  if (metadata.lifecycleStatus !== "active") {
    throw new Error(`Credential ${expectedId} created by a partial V1 migration is not active.`);
  }
  for (const field of ["createdAt", "updatedAt"] as const) {
    if (typeof metadata[field] !== "string" || !Number.isFinite(Date.parse(metadata[field]))) {
      throw new Error(`Credential ${expectedId} ${field} is invalid.`);
    }
  }
  return metadata;
}

async function findOriginalAuthenticationBackup(
  legacyBackupRoot: string,
  authProviderId: string,
  expectedSecret: Buffer,
  expectedProvider: Record<string, unknown>,
  expectedMetadata: { lifecycleStatus: "active" | "archived"; createdAt: string },
): Promise<{ providerRoot: string; keyPath: string } | undefined> {
  for (const migrationId of (await directoryNames(legacyBackupRoot)).sort()) {
    try {
      const candidate = path.join(legacyBackupRoot, migrationId, "agent-authentication-v1");
      const providerRoot = path.join(candidate, "agent-auth-providers", authProviderId);
      const definition = await readJsonFileOptional(path.join(providerRoot, "definition.json"));
      const metadata = await readJsonFileOptional(path.join(providerRoot, "metadata.json"));
      const keyPath = path.join(candidate, "credentials", `${authProviderId}.key`);
      const key = await readFileOptional(keyPath);
      if (
        definition !== undefined
        && metadata !== undefined
        && key?.bytes.equals(expectedSecret)
        && originalProviderMatches(definition.value, expectedProvider)
      ) {
        const originalMetadata = authenticationMetadata(metadata.value, authProviderId, "Authentication provider backup");
        if (
          originalMetadata.lifecycleStatus === expectedMetadata.lifecycleStatus
          && originalMetadata.createdAt === expectedMetadata.createdAt
        ) {
          return { providerRoot, keyPath };
        }
      }
    } catch {
      // A process can stop while creating a backup. Ignore incomplete backup candidates and use a complete one.
    }
  }
  return undefined;
}

function originalProviderMatches(
  candidate: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return candidate.schemaVersion === 1
    && candidate.authProviderId === expected.authProviderId
    && candidate.displayName === expected.displayName
    && candidate.kind === "api-key"
    && candidate.executionProviderId === expected.executionProviderId
    && candidate.modelProvider === expected.modelProvider
    && candidate.targetVariable === expected.targetVariable;
}

async function installFileIdempotent(destination: string, bytes: Buffer, mode?: number): Promise<void> {
  const existing = await readFileOptional(destination);
  if (existing !== undefined) {
    if (!existing.bytes.equals(bytes)) {
      throw new Error(`Migration destination already contains different data: ${destination}`);
    }
    if (mode !== undefined && existing.mode !== mode) await fs.chmod(destination, mode);
    await assertFileEqual(destination, bytes, mode);
    return;
  }
  await replaceFileAtomicVerified(destination, bytes, mode);
}

async function replaceFileAtomicVerified(destination: string, bytes: Buffer, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", ...(mode === undefined ? {} : { mode }) });
    if (mode !== undefined) await fs.chmod(temporary, mode);
    await assertFileEqual(temporary, bytes, mode);
    await fs.rename(temporary, destination);
    await assertFileEqual(destination, bytes, mode);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertFileEqual(destination: string, bytes: Buffer, mode?: number): Promise<void> {
  const written = await readFileOptional(destination);
  if (written === undefined || !written.bytes.equals(bytes)) {
    throw new Error(`Migration verification failed for ${destination}.`);
  }
  if (mode !== undefined && written.mode !== mode) {
    throw new Error(`Migration mode verification failed for ${destination}.`);
  }
}

async function assertJsonFileEqual(destination: string, expected: Record<string, unknown>): Promise<void> {
  const found = await readJsonFile(destination);
  assertJsonEqual(found.value, expected, destination);
}

function assertJsonEqual(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  destination: string,
): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`Migration destination already contains different data: ${destination}`);
  }
}

function jsonBytes(value: Record<string, unknown>): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function migrateFlatRunConfigurations(repositoryRoot: string): Promise<LocalStoreMigrationResult> {
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const paths = resolveLocalFileStorePaths(resolvedRepositoryRoot);
  const source = path.join(paths.configuration, "run-configurations");
  let names: string[];
  try {
    names = await fs.readdir(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { migrated: false, files: 0, message: "No flat run configurations were found." };
    }
    throw error;
  }
  const definitionNames = names.filter((name) => name.endsWith(".json"));
  if (definitionNames.length === 0) {
    return { migrated: false, files: 0, message: "No flat run configurations were found." };
  }
  const migrationId = migrationIdentifier();
  const backupRoot = path.join(paths.legacyBackup, migrationId, "run-configurations");
  const destinationRoot = path.join(paths.configuration, "workflow-run-configurations");
  let files = 0;
  for (const name of definitionNames) {
    const sourceDefinition = path.join(source, name);
    const bytes = await fs.readFile(sourceDefinition);
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    const definition = legacyDefinition(value, name.slice(0, -5));
    const destination = path.join(
      destinationRoot,
      encodeURIComponent(definition.workflow.kind),
      String(definition.workflow.version),
      definition.configurationId,
    );
    await fs.mkdir(destination, { recursive: true });
    const destinationDefinition = path.join(destination, "definition.json");
    await writeVerified(destinationDefinition, bytes);
    files += 1;
    const sourceLifecycle = path.join(source, ".lifecycle", name);
    if (await pathExists(sourceLifecycle)) {
      const lifecycle = JSON.parse(await fs.readFile(sourceLifecycle, "utf8")) as Record<string, unknown>;
      const translated = Buffer.from(`${JSON.stringify({ ...lifecycle, workflow: definition.workflow }, null, 2)}\n`, "utf8");
      await writeVerified(path.join(destination, "lifecycle.json"), translated);
      files += 1;
    }
  }
  await fs.mkdir(path.dirname(backupRoot), { recursive: true, mode: 0o700 });
  await fs.rename(source, backupRoot);
  return {
    migrated: true,
    files,
    backupRoot,
    message: `Migrated ${definitionNames.length} flat run configurations into workflow-scoped storage. Source files remain recoverable at ${backupRoot}.`,
  };
}

function legacyDefinition(value: unknown, expectedConfigurationId: string): {
  configurationId: string;
  workflow: { kind: string; version: number };
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Run configuration ${expectedConfigurationId} is not an object.`);
  const record = value as Record<string, unknown>;
  if (record.configurationId !== expectedConfigurationId) throw new Error(`Run configuration file ${expectedConfigurationId}.json has a mismatched configurationId.`);
  if (!record.workflow || typeof record.workflow !== "object" || Array.isArray(record.workflow)) throw new Error(`Run configuration ${expectedConfigurationId} has no workflow identity.`);
  const workflow = record.workflow as Record<string, unknown>;
  if (typeof workflow.kind !== "string" || !Number.isInteger(workflow.version) || Number(workflow.version) <= 0) throw new Error(`Run configuration ${expectedConfigurationId} has an invalid workflow identity.`);
  return { configurationId: expectedConfigurationId, workflow: { kind: workflow.kind, version: Number(workflow.version) } };
}

async function writeVerified(destination: string, bytes: Buffer): Promise<void> {
  try {
    await fs.writeFile(destination, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(destination);
    if (!existing.equals(bytes)) throw new Error(`Migration destination already contains different data: ${destination}`);
  }
  const written = await fs.readFile(destination);
  if (!written.equals(bytes)) throw new Error(`Migration verification failed for ${destination}.`);
}

async function copyEntryVerified(source: string, destination: string): Promise<number> {
  await copyEntry(source, destination);
  const [sourceSnapshot, copiedSnapshot] = await Promise.all([
    entrySnapshot(source),
    entrySnapshot(destination),
  ]);
  if (sourceSnapshot.digest !== copiedSnapshot.digest || sourceSnapshot.files !== copiedSnapshot.files) {
    throw new Error(`Verification failed while migrating ${source}. Legacy data was not retired.`);
  }
  return sourceSnapshot.files;
}

async function copyEntry(source: string, destination: string): Promise<void> {
  const stat = await fs.lstat(source);
  const mode = stat.mode & 0o777;
  if (stat.isDirectory()) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.mkdir(destination, { recursive: false, mode });
    for (const name of (await fs.readdir(source)).sort()) {
      await copyEntry(path.join(source, name), path.join(destination, name));
    }
    await fs.chmod(destination, mode);
    return;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (stat.isFile()) {
    await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
    await fs.chmod(destination, mode);
    return;
  }
  if (stat.isSymbolicLink()) {
    await fs.symlink(await fs.readlink(source), destination);
    return;
  }
  throw new Error(`Unsupported local-storage entry type at ${source}.`);
}

async function entrySnapshot(root: string): Promise<{ files: number; digest: string }> {
  const entries: Array<{ path: string; type: "directory" | "file" | "symlink"; mode: number; content: Buffer }> = [];
  await visit(root, "", entries);
  return snapshotEntries(entries);
}

async function storageContentSnapshot(
  root: string,
  ignoredTopLevelNames: ReadonlySet<string> = new Set(),
): Promise<{ files: number; digest: string }> {
  const entries: Array<{ path: string; type: "directory" | "file" | "symlink"; mode: number; content: Buffer }> = [];
  for (const name of (await directoryNames(root)).sort()) {
    if (!ignoredTopLevelNames.has(name)) await visit(path.join(root, name), name, entries);
  }
  return snapshotEntries(entries);
}

function snapshotEntries(
  entries: Array<{ path: string; type: "directory" | "file" | "symlink"; mode: number; content: Buffer }>,
): { files: number; digest: string } {
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.type).update("\0").update(entry.path).update("\0");
    hash.update(entry.mode.toString(8)).update("\0").update(entry.content).update("\0");
  }
  return {
    files: entries.filter(({ type }) => type !== "directory").length,
    digest: hash.digest("hex"),
  };
}

async function visit(
  candidate: string,
  relative: string,
  entries: Array<{ path: string; type: "directory" | "file" | "symlink"; mode: number; content: Buffer }>,
): Promise<void> {
  const stat = await fs.lstat(candidate);
  const mode = stat.mode & 0o777;
  if (stat.isDirectory()) {
    entries.push({ path: relative, type: "directory", mode, content: Buffer.alloc(0) });
    for (const name of await fs.readdir(candidate)) {
      await visit(path.join(candidate, name), path.join(relative, name), entries);
    }
    return;
  }
  if (stat.isFile()) {
    entries.push({ path: relative, type: "file", mode, content: await fs.readFile(candidate) });
    return;
  }
  if (stat.isSymbolicLink()) {
    entries.push({ path: relative, type: "symlink", mode, content: Buffer.from(await fs.readlink(candidate)) });
    return;
  }
  throw new Error(`Unsupported local-storage entry type at ${candidate}.`);
}

async function assertDirectory(candidate: string, label: string): Promise<void> {
  const stat = await fs.lstat(candidate);
  if (!stat.isDirectory()) throw new Error(`${label} ${candidate} must be a directory.`);
}

function migrationIdentifier(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function relativeProjectPath(repositoryRoot: string, candidate: string): string {
  return path.relative(repositoryRoot, candidate) || ".";
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
