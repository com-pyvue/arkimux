import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import type {
  RunCatalogEntry,
  RunCatalogPage,
  RunCatalogQuery,
  RunCatalogStore,
} from "../../application/runQueries.ts";
import {
  validateRunStateProjection,
  type RunHeartbeatProjection,
  type RunStatusProjection,
} from "../../application/runState.ts";
import {
  validateRunManifestV2,
  validateRunManifestV3,
  type RunManifestV2,
  type RunManifestV3,
} from "../../domain/runManifest.ts";
import { validateRunRef, type RunRef } from "../../domain/runIdentity.ts";

export class FileRunCatalogStore implements RunCatalogStore {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  async get(runRef: RunRef): Promise<RunCatalogEntry | undefined> {
    const validated = validateRunRef(runRef);
    const manifests = await findFiles(this.root, "run-manifest.json");
    for (const manifest of manifests) {
      const entry = await this.entry(manifest);
      if (entry?.runRef.executionId === validated.executionId) return entry;
    }
    return undefined;
  }

  async archive(runRef: RunRef, archivedAt: string): Promise<void> {
    await this.writeLifecycle(runRef, "archived", archivedAt);
  }

  async restore(runRef: RunRef, restoredAt: string): Promise<void> {
    await this.writeLifecycle(runRef, "active", restoredAt);
  }

  async list(query: RunCatalogQuery): Promise<RunCatalogPage> {
    validateCatalogQuery(query);
    const pageSize = query.pageSize ?? 50;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
      throw new Error("Run catalog pageSize must be an integer from 1 to 500.");
    }
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    if (
      !Number.isSafeInteger(offset)
      || offset < 0
      || (query.cursor !== undefined && String(offset) !== query.cursor)
    ) {
      throw new Error("Run catalog cursor is invalid.");
    }
    const manifests = await findFiles(this.root, "run-manifest.json");
    const entries = (await Promise.all(manifests.map((filePath) => this.entry(filePath))))
      .filter((entry): entry is RunCatalogEntry => entry !== undefined)
      .filter((entry) => matches(entry, query))
      .sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt)
        || left.runRef.executionId.localeCompare(right.runRef.executionId)
      ));
    const items = entries.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    return {
      items,
      ...(nextOffset < entries.length ? { nextCursor: String(nextOffset) } : {}),
    };
  }

  private async entry(manifestPath: string): Promise<RunCatalogEntry | undefined> {
    const value = await readJson(manifestPath);
    if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const schemaVersion = (value as Record<string, unknown>).schemaVersion;
    if (schemaVersion !== 2 && schemaVersion !== 3) return undefined;
    const manifest: RunManifestV2 | RunManifestV3 = schemaVersion === 3
      ? validateRunManifestV3(value)
      : validateRunManifestV2(value);
    const stateRoot = path.dirname(manifestPath);
    const status = await readProjection(path.join(stateRoot, "run-status.json"), "status");
    const heartbeat = await readProjection(path.join(stateRoot, "run-heartbeat.json"), "heartbeat");
    const lifecycle = await readCatalogLifecycle(path.join(stateRoot, "run-catalog-lifecycle.json"));
    return {
      runRef: manifest.runRef,
      workflow: manifest.workflow,
      ...(manifest.target === undefined ? {} : { target: manifest.target }),
      actor: manifest.actor,
      createdAt: manifest.createdAt,
      ...("runConfiguration" in manifest ? { runConfiguration: manifest.runConfiguration } : {}),
      ...(status === undefined ? {} : { status: status as RunStatusProjection }),
      ...(heartbeat === undefined ? {} : { heartbeat: heartbeat as RunHeartbeatProjection }),
      lifecycleStatus: lifecycle?.status ?? "active",
      ...(lifecycle?.status === "archived" ? { archivedAt: lifecycle.updatedAt } : {}),
    };
  }

  private async writeLifecycle(
    runRef: RunRef,
    status: "active" | "archived",
    updatedAt: string,
  ): Promise<void> {
    canonicalTimestamp(updatedAt, "Run catalog lifecycle.updatedAt");
    const validated = validateRunRef(runRef);
    const manifests = await findFiles(this.root, "run-manifest.json");
    for (const manifestPath of manifests) {
      const entry = await this.entry(manifestPath);
      if (entry?.runRef.executionId !== validated.executionId) continue;
      const target = path.join(path.dirname(manifestPath), "run-catalog-lifecycle.json");
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, status, updatedAt }, null, 2)}\n`, "utf8");
      await fs.rename(temporary, target);
      return;
    }
    throw new Error(`Run ${validated.executionId} does not exist.`);
  }
}

function matches(entry: RunCatalogEntry, query: RunCatalogQuery): boolean {
  if (query.userId !== undefined && entry.actor.userId !== query.userId) return false;
  if (query.workflow !== undefined && (
    entry.workflow.kind !== query.workflow.kind || entry.workflow.version !== query.workflow.version
  )) return false;
  if (query.status !== undefined && entry.status?.status !== query.status) return false;
  if (query.target !== undefined) {
    if (entry.target?.kind !== query.target.kind) return false;
    if (query.target.identity !== undefined && !Object.entries(query.target.identity).every(
      ([key, value]) => entry.target?.identity[key] === value,
    )) return false;
  }
  if (query.createdAtOrAfter !== undefined && entry.createdAt < query.createdAtOrAfter) return false;
  if (query.createdBefore !== undefined && entry.createdAt >= query.createdBefore) return false;
  const lifecycleStatus = entry.lifecycleStatus ?? "active";
  if ((query.lifecycleStatus ?? "active") !== "all" && lifecycleStatus !== (query.lifecycleStatus ?? "active")) return false;
  return true;
}

function validateCatalogQuery(query: RunCatalogQuery): void {
  for (const [name, value] of [
    ["createdAtOrAfter", query.createdAtOrAfter],
    ["createdBefore", query.createdBefore],
  ] as const) {
    if (value !== undefined) {
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
        throw new Error(`Run catalog ${name} must be a canonical ISO-8601 timestamp.`);
      }
    }
  }
  if (query.target !== undefined) {
    if (query.target.kind.length === 0) throw new Error("Run catalog target kind must not be empty.");
    for (const [key, value] of Object.entries(query.target.identity ?? {})) {
      if (key.length === 0 || value.length === 0) {
        throw new Error("Run catalog target identity keys and values must not be empty.");
      }
    }
  }
}

async function findFiles(root: string, name: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) return findFiles(filePath, name);
    return entry.isFile() && entry.name === name ? [filePath] : [];
  }));
  return nested.flat();
}

async function readJson(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readProjection(
  filePath: string,
  kind: "status" | "heartbeat",
): Promise<RunStatusProjection | RunHeartbeatProjection | undefined> {
  const stored = await readJson(filePath);
  if (stored === undefined || typeof stored !== "object" || stored === null || Array.isArray(stored)) return undefined;
  return validateRunStateProjection({ kind, ...stored });
}

async function readCatalogLifecycle(
  filePath: string,
): Promise<{ status: "active" | "archived"; updatedAt: string } | undefined> {
  const stored = await readJson(filePath);
  if (stored === undefined) return undefined;
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    throw new Error("Run catalog lifecycle must be an object.");
  }
  const record = stored as Record<string, unknown>;
  if (record.schemaVersion !== 1 || (record.status !== "active" && record.status !== "archived")) {
    throw new Error("Run catalog lifecycle must use schemaVersion 1 and active or archived status.");
  }
  canonicalTimestamp(record.updatedAt, "Run catalog lifecycle.updatedAt");
  return { status: record.status, updatedAt: record.updatedAt as string };
}

function canonicalTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp.`);
  }
}
