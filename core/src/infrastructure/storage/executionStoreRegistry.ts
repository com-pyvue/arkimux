import type {
  ExecutionStoreAdapterFactory,
  ExecutionStoreAdapterRegistry,
  ExecutionStoreAdapterContext,
  ExecutionStorePortByRole,
  ExecutionStoreRole,
} from "../../application/executionStore.ts";
import { DefaultStoreAdapterRegistry } from "./storeAdapterRegistry.ts";

const roles = [
  "run-state",
  "run-artifact",
  "run-performance",
  "published-result",
] as const satisfies readonly ExecutionStoreRole[];

export class DefaultExecutionStoreAdapterRegistry
  extends DefaultStoreAdapterRegistry<
    ExecutionStoreRole,
    ExecutionStorePortByRole,
    ExecutionStoreAdapterContext
  >
  implements ExecutionStoreAdapterRegistry {
  constructor(factories: readonly ExecutionStoreAdapterFactory[] = []) {
    super({ roles, factories });
  }
}
