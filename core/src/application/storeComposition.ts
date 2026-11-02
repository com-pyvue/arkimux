import type { StoreAdapterReference } from "./runConfiguration.ts";
import type {
  StoreAdapterFactory,
  StoreAdapterRegistry,
} from "./storeAdapter.ts";

export interface SelectedStoreAdapter<TRole extends string, TStore, TContext> {
  factory: StoreAdapterFactory<TRole, TStore, TContext>;
  options: Record<string, unknown>;
  reference: StoreAdapterReference;
}

export function selectStoreAdapter<
  TRole extends string,
  TPortByRole extends { [K in TRole]: unknown },
  TContext,
  TSelectedRole extends TRole,
>(
  registry: StoreAdapterRegistry<TRole, TPortByRole, TContext>,
  role: TSelectedRole,
  reference: StoreAdapterReference,
): SelectedStoreAdapter<TSelectedRole, TPortByRole[TSelectedRole], TContext> {
  const factory = registry.resolve(role, reference.adapterId);
  return {
    factory,
    options: factory.validateConfig(reference.options),
    reference,
  };
}

export async function createSelectedStore<TRole extends string, TStore, TContext>(
  selection: SelectedStoreAdapter<TRole, TStore, TContext>,
  context: Omit<TContext, "options">,
): Promise<TStore> {
  return selection.factory.create({ ...context, options: selection.options } as TContext);
}
