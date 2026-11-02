import { constants as fsConstants, promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import {
  FilePublishedResultQueryStore,
  FileRunArtifactQueryStore,
  FileRunCatalogStore,
  FileRunPerformanceV2Store,
  validateRunManifestV2,
  validateRunManifestV3,
  validateRunRef,
  type PublishedResultQueryStore,
  type RunArtifactQueryStore,
  type RunPerformanceQueryStore,
  type RunRef,
  type StorePreflightResult,
} from "@com-pyvue/agent-execution-core";
import type {
  ApplicationQueryAdapterContext,
  ApplicationQueryAdapterFactory,
  RunScopedQueryStoreProvider,
} from "./adapters.ts";
import {
  CanonicalV3FileRunCatalogStore,
  CanonicalV3FileRunLocator,
} from "./canonicalFileRunQueries.ts";

interface FileRunCatalogOptions {
  outputRoot: string;
}

interface CanonicalV3FileRunCatalogOptions {
  outputRoots: string[];
}

function catalogOptions(value: unknown): Record<string, unknown> & FileRunCatalogOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("file-run-catalog@1 options must be an object.");
  }
  const options = value as Record<string, unknown>;
  const unknown = Object.keys(options).filter((key) => key !== "outputRoot");
  if (unknown.length > 0) throw new Error(`file-run-catalog@1 has unknown options [${unknown.join(", ")}].`);
  if (typeof options.outputRoot !== "string" || options.outputRoot.length === 0) {
    throw new Error("file-run-catalog@1 outputRoot must be a non-empty string.");
  }
  return options as Record<string, unknown> & FileRunCatalogOptions;
}

function canonicalCatalogOptions(value: unknown): Record<string, unknown> & CanonicalV3FileRunCatalogOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("file-run-catalog@2 options must be an object.");
  }
  const options = value as Record<string, unknown>;
  const unknown = Object.keys(options).filter((key) => key !== "outputRoots");
  if (unknown.length > 0) throw new Error(`file-run-catalog@2 has unknown options [${unknown.join(", ")}].`);
  if (
    !Array.isArray(options.outputRoots)
    || options.outputRoots.length === 0
    || options.outputRoots.some((root) => typeof root !== "string" || root.length === 0)
  ) {
    throw new Error("file-run-catalog@2 outputRoots must be a non-empty array of non-empty strings.");
  }
  if (new Set(options.outputRoots).size !== options.outputRoots.length) {
    throw new Error("file-run-catalog@2 outputRoots must be unique.");
  }
  return options as Record<string, unknown> & CanonicalV3FileRunCatalogOptions;
}

function emptyOptions(value: unknown, adapterId: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${adapterId} options must be an object.`);
  }
  const keys = Object.keys(value);
  if (keys.length > 0) throw new Error(`${adapterId} does not support options [${keys.join(", ")}].`);
  return {};
}

function outputRoot(context: ApplicationQueryAdapterContext): string {
  const options = catalogOptions(context.runCatalogOptions);
  if (path.isAbsolute(options.outputRoot)) return path.resolve(options.outputRoot);
  if (!context.repositoryRoot) throw new Error("Relative query outputRoot requires repositoryRoot context.");
  return path.resolve(context.repositoryRoot, options.outputRoot);
}

function canonicalOutputRoots(context: ApplicationQueryAdapterContext): string[] {
  const options = canonicalCatalogOptions(context.runCatalogOptions);
  return options.outputRoots.map((root) => {
    if (path.isAbsolute(root)) return path.resolve(root);
    if (!context.repositoryRoot) throw new Error("Relative query outputRoots require repositoryRoot context.");
    return path.resolve(context.repositoryRoot, root);
  });
}

class FileRunScopedQueryProvider<TStore> implements RunScopedQueryStoreProvider<TStore> {
  readonly root: string;

  constructor(
    root: string,
    private readonly createStore: (runRoot: string, runRef: RunRef) => TStore,
  ) {
    this.root = root;
  }

  async open(runRef: RunRef): Promise<TStore> {
    const validated = validateRunRef(runRef);
    const runRoot = await findRunRoot(this.root, validated);
    if (!runRoot) throw new Error(`Run ${validated.executionId} is not present in the configured query store.`);
    return this.createStore(runRoot, validated);
  }
}

class CanonicalV3FileRunScopedQueryProvider<TStore> implements RunScopedQueryStoreProvider<TStore> {
  constructor(
    readonly locator: CanonicalV3FileRunLocator,
    private readonly createStore: (runRoot: string, runRef: RunRef) => TStore,
  ) {}

  async open(runRef: RunRef): Promise<TStore> {
    const validated = validateRunRef(runRef);
    const located = await this.locator.resolve(validated);
    if (!located) throw new Error(`Run ${validated.executionId} is not present in the configured canonical V3 query store.`);
    return this.createStore(located.runRoot, validated);
  }
}

function queryFactory<TRole extends "run-artifacts" | "published-results" | "run-performance", TStore>(input: {
  adapterId: string;
  role: TRole;
  createStore(runRoot: string, runRef: RunRef): TStore;
}): ApplicationQueryAdapterFactory<TRole> {
  return {
    adapterId: input.adapterId,
    role: input.role,
    validateConfig: (options: unknown) => emptyOptions(options, input.adapterId),
    async create(context: ApplicationQueryAdapterContext) {
      emptyOptions(context.options, input.adapterId);
      return new FileRunScopedQueryProvider(outputRoot(context), input.createStore);
    },
    async preflight(provider: RunScopedQueryStoreProvider<TStore>) {
      return preflightRoot(
        input.adapterId,
        input.role,
        (provider as FileRunScopedQueryProvider<TStore>).root,
      );
    },
  } as unknown as ApplicationQueryAdapterFactory<TRole>;
}

function canonicalQueryFactory<TRole extends "run-artifacts" | "published-results" | "run-performance", TStore>(input: {
  adapterId: string;
  role: TRole;
  createStore(runRoot: string, runRef: RunRef): TStore;
}): ApplicationQueryAdapterFactory<TRole> {
  return {
    adapterId: input.adapterId,
    role: input.role,
    validateConfig: (options: unknown) => emptyOptions(options, input.adapterId),
    async create(context: ApplicationQueryAdapterContext) {
      emptyOptions(context.options, input.adapterId);
      return new CanonicalV3FileRunScopedQueryProvider(
        new CanonicalV3FileRunLocator(canonicalOutputRoots(context)),
        input.createStore,
      );
    },
    async preflight(provider: RunScopedQueryStoreProvider<TStore>) {
      return preflightRoots(
        input.adapterId,
        input.role,
        (provider as CanonicalV3FileRunScopedQueryProvider<TStore>).locator.roots,
      );
    },
  } as unknown as ApplicationQueryAdapterFactory<TRole>;
}

export function createFileApplicationQueryAdapterFactories(): ApplicationQueryAdapterFactory[] {
  const catalog: ApplicationQueryAdapterFactory<"run-catalog"> = {
    adapterId: "file-run-catalog@1",
    role: "run-catalog",
    validateConfig: catalogOptions,
    async create(context) {
      const options = catalogOptions(context.options);
      const root = path.isAbsolute(options.outputRoot)
        ? path.resolve(options.outputRoot)
        : context.repositoryRoot
          ? path.resolve(context.repositoryRoot, options.outputRoot)
          : (() => { throw new Error("Relative query outputRoot requires repositoryRoot context."); })();
      return new FileRunCatalogStore(root);
    },
    async preflight(store) {
      return preflightRoot("file-run-catalog@1", "run-catalog", (store as FileRunCatalogStore).root);
    },
  };
  const canonicalCatalog: ApplicationQueryAdapterFactory<"run-catalog"> = {
    adapterId: "file-run-catalog@2",
    role: "run-catalog",
    validateConfig: canonicalCatalogOptions,
    async create(context) {
      const locator = new CanonicalV3FileRunLocator(canonicalOutputRoots({
        ...context,
        runCatalogOptions: context.options,
      }));
      return new CanonicalV3FileRunCatalogStore(locator);
    },
    async preflight(store) {
      return preflightRoots(
        "file-run-catalog@2",
        "run-catalog",
        (store as CanonicalV3FileRunCatalogStore).locator.roots,
      );
    },
  };
  return [
    catalog,
    canonicalCatalog,
    queryFactory<"run-artifacts", RunArtifactQueryStore>({
      adapterId: "file-run-artifacts-query@1",
      role: "run-artifacts",
      createStore: (runRoot) => new FileRunArtifactQueryStore(runRoot),
    }),
    queryFactory<"published-results", PublishedResultQueryStore>({
      adapterId: "file-published-results-query@1",
      role: "published-results",
      createStore: (runRoot, runRef) => new FilePublishedResultQueryStore({ root: runRoot, runRef }),
    }),
    queryFactory<"run-performance", RunPerformanceQueryStore>({
      adapterId: "file-run-performance-query@1",
      role: "run-performance",
      createStore: (runRoot, runRef) => {
        const store = new FileRunPerformanceV2Store(path.join(runRoot, "state"), runRef);
        return { get: (query) => store.get(query) };
      },
    }),
    canonicalQueryFactory<"run-artifacts", RunArtifactQueryStore>({
      adapterId: "file-run-artifacts-query@2",
      role: "run-artifacts",
      createStore: (runRoot) => new FileRunArtifactQueryStore(runRoot),
    }),
    canonicalQueryFactory<"published-results", PublishedResultQueryStore>({
      adapterId: "file-published-results-query@2",
      role: "published-results",
      createStore: (runRoot, runRef) => new FilePublishedResultQueryStore({ root: runRoot, runRef }),
    }),
    canonicalQueryFactory<"run-performance", RunPerformanceQueryStore>({
      adapterId: "file-run-performance-query@2",
      role: "run-performance",
      createStore: (runRoot, runRef) => {
        const store = new FileRunPerformanceV2Store(path.join(runRoot, "state"), runRef);
        return { get: (query) => store.get(query) };
      },
    }),
  ];
}

async function preflightRoots<TRole extends "run-catalog" | "run-artifacts" | "published-results" | "run-performance">(
  adapterId: string,
  role: TRole,
  roots: readonly string[],
): Promise<StorePreflightResult<TRole>> {
  for (const root of roots) {
    const result = await preflightRoot(adapterId, role, root);
    if (!result.available) return result;
  }
  return { adapterId, role, available: true };
}

async function preflightRoot<TRole extends "run-catalog" | "run-artifacts" | "published-results" | "run-performance">(
  adapterId: string,
  role: TRole,
  root: string,
): Promise<StorePreflightResult<TRole>> {
  try {
    await fs.access(root, fsConstants.R_OK);
    return { adapterId, role, available: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        await fs.access(await nearestExistingAncestor(root), fsConstants.R_OK);
        return { adapterId, role, available: true };
      } catch (parentError) {
        return { adapterId, role, available: false, message: (parentError as Error).message };
      }
    }
    return { adapterId, role, available: false, message: (error as Error).message };
  }
}

async function nearestExistingAncestor(location: string): Promise<string> {
  let candidate = path.resolve(location);
  while (true) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function findRunRoot(root: string, runRef: RunRef): Promise<string | undefined> {
  for (const manifestPath of await findFiles(root, "run-manifest.json")) {
    const value = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const schemaVersion = (value as Record<string, unknown>).schemaVersion;
    if (schemaVersion !== 2 && schemaVersion !== 3) continue;
    const manifest = schemaVersion === 3 ? validateRunManifestV3(value) : validateRunManifestV2(value);
    if (manifest.runRef.executionId === runRef.executionId) return path.dirname(path.dirname(manifestPath));
  }
  return undefined;
}

async function findFiles(root: string, name: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files = await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) return findFiles(filePath, name);
    return entry.isFile() && entry.name === name ? [filePath] : [];
  }));
  return files.flat();
}
