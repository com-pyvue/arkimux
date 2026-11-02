import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { PublishedResultEnvelope } from "../../application/publishedResult.ts";
import type {
  ExecutionStoreAdapterContext,
  ExecutionStoreAdapterFactory,
  ExecutionStoreAdapterRegistry,
} from "../../application/executionStore.ts";
import { FilePublishedResultStore } from "./filePublishedResultStore.ts";
import { FileRunArtifactStore } from "./fileRunArtifactStore.ts";
import { FileRunPerformanceV2Store } from "./fileRunPerformanceV2Store.ts";
import { FileRunStateV3Store } from "./fileRunStateV3Store.ts";
import { DefaultExecutionStoreAdapterRegistry } from "./executionStoreRegistry.ts";

export interface FileExecutionStoreLayout {
  runRoot(context: ExecutionStoreAdapterContext): string;
  reservationRoot(context: ExecutionStoreAdapterContext): string;
  publishedResultId(result: PublishedResultEnvelope<unknown>): string;
}

function validateEmptyOptions(options: unknown, adapterId: string): Record<string, unknown> {
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new Error(`Store adapter ${adapterId} options must be an object.`);
  }
  const keys = Object.keys(options);
  if (keys.length > 0) {
    throw new Error(`Store adapter ${adapterId} does not support options [${keys.join(", ")}].`);
  }
  return {};
}

function factory<TStore>(input: {
  adapterId: string;
  role: ExecutionStoreAdapterFactory<TStore>["role"];
  create(context: ExecutionStoreAdapterContext): TStore;
  root(store: TStore): string;
}): ExecutionStoreAdapterFactory<TStore> {
  return {
    adapterId: input.adapterId,
    role: input.role,
    validateConfig: (options) => validateEmptyOptions(options, input.adapterId),
    async create(context) {
      validateEmptyOptions(context.options, input.adapterId);
      return input.create(context);
    },
    async preflight(store) {
      const root = input.root(store);
      try {
        await fs.mkdir(root, { recursive: true });
        await fs.access(root, fsConstants.R_OK | fsConstants.W_OK);
        return { adapterId: input.adapterId, role: input.role, available: true };
      } catch (error) {
        return {
          adapterId: input.adapterId,
          role: input.role,
          available: false,
          message: (error as Error).message,
        };
      }
    },
  };
}

export function createFileExecutionStoreAdapterFactories(
  layout: FileExecutionStoreLayout,
): ExecutionStoreAdapterFactory[] {
  const runStateV3 = factory({
    adapterId: "file-run-state@3",
    role: "run-state" as const,
    create: (context) => new FileRunStateV3Store({
      root: path.join(layout.runRoot(context), "state"),
      reservationRoot: layout.reservationRoot(context),
      runRef: context.runRef,
    }),
    root: (store) => store.root,
  });
  const runArtifacts = factory({
    adapterId: "file-run-artifacts@1",
    role: "run-artifact" as const,
    create: (context) => {
      const runRoot = layout.runRoot(context);
      return new FileRunArtifactStore(path.join(runRoot, "state"), runRoot);
    },
    root: (store) => store.root,
  });
  const performance = factory({
    adapterId: "file-run-performance@2",
    role: "run-performance" as const,
    create: (context) => new FileRunPerformanceV2Store(
      path.join(layout.runRoot(context), "state"),
      context.runRef,
    ),
    root: (store) => store.root,
  });
  const publishedResults = factory({
    adapterId: "file-published-results@2",
    role: "published-result" as const,
    create: (context) => new FilePublishedResultStore({
      root: layout.runRoot(context),
      resultId: layout.publishedResultId,
    }),
    root: (store) => store.root,
  });
  return [runStateV3, runArtifacts, performance, publishedResults] as ExecutionStoreAdapterFactory[];
}

export function createFileExecutionStoreAdapterRegistry(
  layout: FileExecutionStoreLayout,
): ExecutionStoreAdapterRegistry {
  return new DefaultExecutionStoreAdapterRegistry(
    createFileExecutionStoreAdapterFactories(layout),
  );
}
