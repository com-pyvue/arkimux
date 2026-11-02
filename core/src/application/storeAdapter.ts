export interface StorePreflightResult<TRole extends string = string> {
  adapterId: string;
  role: TRole;
  available: boolean;
  message?: string;
}

export interface StoreAdapterFactory<
  TRole extends string,
  TStore,
  TContext,
> {
  readonly adapterId: string;
  readonly role: TRole;
  validateConfig(options: unknown): Record<string, unknown>;
  create(context: TContext): Promise<TStore>;
  preflight(store: TStore): Promise<StorePreflightResult<TRole>>;
}

export interface StoreAdapterRegistry<
  TRole extends string,
  TStoreByRole extends Record<TRole, unknown>,
  TContext,
> {
  resolve<TRequestedRole extends TRole>(
    role: TRequestedRole,
    adapterId: string,
  ): StoreAdapterFactory<TRequestedRole, TStoreByRole[TRequestedRole], TContext>;
}
