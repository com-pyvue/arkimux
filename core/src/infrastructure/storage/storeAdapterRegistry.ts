import type {
  StoreAdapterFactory,
  StoreAdapterRegistry,
} from "../../application/storeAdapter.ts";

const adapterIdPattern = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/;

export class DuplicateStoreAdapterError extends Error {
  constructor(readonly adapterId: string) {
    super(`Store adapter is registered more than once: ${adapterId}`);
    this.name = "DuplicateStoreAdapterError";
  }
}

export class UnknownStoreAdapterError extends Error {
  constructor(readonly adapterId: string) {
    super(`Store adapter is not installed: ${adapterId}`);
    this.name = "UnknownStoreAdapterError";
  }
}

export class StoreAdapterRoleMismatchError<TRole extends string = string> extends Error {
  constructor(
    readonly adapterId: string,
    readonly expectedRole: TRole,
    readonly actualRole: TRole,
  ) {
    super(`Store adapter ${adapterId} has role ${actualRole}, not ${expectedRole}.`);
    this.name = "StoreAdapterRoleMismatchError";
  }
}

export interface DefaultStoreAdapterRegistryOptions<
  TRole extends string,
  TContext,
> {
  roles: readonly TRole[];
  factories?: readonly StoreAdapterFactory<TRole, unknown, TContext>[];
}

export class DefaultStoreAdapterRegistry<
  TRole extends string,
  TStoreByRole extends Record<TRole, unknown>,
  TContext,
> implements StoreAdapterRegistry<TRole, TStoreByRole, TContext> {
  private readonly roles: ReadonlySet<TRole>;
  private readonly factories = new Map<string, StoreAdapterFactory<TRole, unknown, TContext>>();

  constructor(options: DefaultStoreAdapterRegistryOptions<TRole, TContext>) {
    this.roles = validatedRoles(options.roles);
    for (const factory of options.factories ?? []) this.register(factory);
  }

  register(factory: StoreAdapterFactory<TRole, unknown, TContext>): void {
    if (!adapterIdPattern.test(factory.adapterId)) {
      throw new Error(`Store adapter ID must contain an exact positive numeric version: ${factory.adapterId}`);
    }
    if (!this.roles.has(factory.role)) {
      throw new Error(`Store adapter ${factory.adapterId} has an unsupported role: ${factory.role}`);
    }
    if (this.factories.has(factory.adapterId)) {
      throw new DuplicateStoreAdapterError(factory.adapterId);
    }
    this.factories.set(factory.adapterId, factory);
  }

  resolve<TRequestedRole extends TRole>(
    role: TRequestedRole,
    adapterId: string,
  ): StoreAdapterFactory<TRequestedRole, TStoreByRole[TRequestedRole], TContext> {
    const factory = this.factories.get(adapterId);
    if (!factory) throw new UnknownStoreAdapterError(adapterId);
    if (factory.role !== role) {
      throw new StoreAdapterRoleMismatchError(adapterId, role, factory.role);
    }
    return factory as StoreAdapterFactory<
      TRequestedRole,
      TStoreByRole[TRequestedRole],
      TContext
    >;
  }
}

function validatedRoles<TRole extends string>(roles: readonly TRole[]): ReadonlySet<TRole> {
  const result = new Set<TRole>();
  for (const role of roles) {
    if (role.length === 0) throw new Error("Store role must not be empty.");
    if (result.has(role)) throw new Error(`Store role is duplicated: ${role}.`);
    result.add(role);
  }
  return result;
}
