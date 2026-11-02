import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import {
  FileRunCatalogStore,
  validateRunManifestV3,
  validateRunRef,
  type RunCatalogEntry,
  type RunCatalogPage,
  type RunCatalogQuery,
  type RunCatalogStore,
  type RunRef,
} from "@com-pyvue/agent-execution-core";

export interface LocatedCanonicalV3Run {
  runRef: RunRef;
  runRoot: string;
  sourceRoot: string;
}

export class CanonicalV3FileRunLocator {
  readonly roots: readonly string[];
  #activeListing?: Promise<LocatedCanonicalV3Run[]>;

  constructor(roots: readonly string[]) {
    if (roots.length === 0) throw new Error("Canonical V3 run locator requires at least one root.");
    this.roots = roots.map((root) => path.resolve(root));
    if (new Set(this.roots).size !== this.roots.length) {
      throw new Error("Canonical V3 run locator roots must be unique.");
    }
  }

  async list(): Promise<LocatedCanonicalV3Run[]> {
    if (this.#activeListing) return this.#activeListing;
    const listing = this.#scan();
    this.#activeListing = listing;
    try {
      return await listing;
    } finally {
      if (this.#activeListing === listing) this.#activeListing = undefined;
    }
  }

  async #scan(): Promise<LocatedCanonicalV3Run[]> {
    const selected = new Map<string, LocatedCanonicalV3Run>();
    for (const sourceRoot of this.roots) {
      for (const manifestPath of (await findFiles(sourceRoot, "run-manifest.json")).sort()) {
        const value = await readJson(manifestPath);
        if (!isRecord(value) || value.schemaVersion !== 3) continue;
        const manifest = validateRunManifestV3(value);
        if (!selected.has(manifest.runRef.executionId)) {
          selected.set(manifest.runRef.executionId, {
            runRef: manifest.runRef,
            runRoot: path.dirname(path.dirname(manifestPath)),
            sourceRoot,
          });
        }
      }
    }
    return [...selected.values()].sort((left, right) => (
      left.runRef.executionId.localeCompare(right.runRef.executionId)
    ));
  }

  async resolve(runRef: RunRef): Promise<LocatedCanonicalV3Run | undefined> {
    const validated = validateRunRef(runRef);
    return (await this.list()).find(({ runRef: candidate }) => (
      candidate.executionId === validated.executionId
    ));
  }
}

export class CanonicalV3FileRunCatalogStore implements RunCatalogStore {
  constructor(readonly locator: CanonicalV3FileRunLocator) {}

  async get(runRef: RunRef): Promise<RunCatalogEntry | undefined> {
    const located = await this.locator.resolve(runRef);
    return located === undefined
      ? undefined
      : new FileRunCatalogStore(located.runRoot).get(runRef);
  }

  async archive(runRef: RunRef, archivedAt: string): Promise<void> {
    const located = await this.locator.resolve(runRef);
    if (!located) throw new Error(`Run ${runRef.executionId} does not exist.`);
    await new FileRunCatalogStore(located.runRoot).archive(runRef, archivedAt);
  }

  async restore(runRef: RunRef, restoredAt: string): Promise<void> {
    const located = await this.locator.resolve(runRef);
    if (!located) throw new Error(`Run ${runRef.executionId} does not exist.`);
    await new FileRunCatalogStore(located.runRoot).restore(runRef, restoredAt);
  }

  async list(query: RunCatalogQuery): Promise<RunCatalogPage> {
    const { pageSize, offset } = validatePagination(query);
    const { cursor: _cursor, pageSize: _pageSize, ...filters } = query;
    const entries = (await Promise.all((await this.locator.list()).map(async ({ runRoot }) => (
      (await new FileRunCatalogStore(runRoot).list({ ...filters, pageSize: 1 })).items[0]
    )))).filter((entry): entry is RunCatalogEntry => entry !== undefined)
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
}

function validatePagination(query: RunCatalogQuery): { pageSize: number; offset: number } {
  const pageSize = query.pageSize ?? 50;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new Error("Run catalog pageSize must be an integer from 1 to 500.");
  }
  const offset = query.cursor === undefined ? 0 : Number(query.cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || (query.cursor !== undefined && String(offset) !== query.cursor)) {
    throw new Error("Run catalog cursor is invalid.");
  }
  return { pageSize, offset };
}

async function findFiles(root: string, name: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return (await Promise.all(entries.map(async (entry) => {
    const location = path.join(root, entry.name);
    if (entry.isDirectory()) return findFiles(location, name);
    return entry.isFile() && entry.name === name ? [location] : [];
  }))).flat();
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
