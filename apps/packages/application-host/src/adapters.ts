import {
  DefaultStoreAdapterRegistry,
  type RunArtifactQueryStore,
  type RunCatalogStore,
  type RunDispatcher,
  type RunPerformanceQueryStore,
  type PublishedResultQueryStore,
  type RunRef,
  type StoreAdapterFactory,
  type StoreAdapterRegistry,
  type TrustedRunCommand,
} from "@com-pyvue/agent-execution-core";

export interface AuthenticatedIdentity {
  providerId: string;
  subjectId: string;
}

export interface ApplicationAuthenticationProvider<TRequest = unknown> {
  authenticate(request: TRequest): Promise<AuthenticatedIdentity>;
}

export interface RunScopedQueryStoreProvider<TStore> {
  open(runRef: RunRef): Promise<TStore>;
}

export interface WorkflowExecutorRegistry {
  execute(command: TrustedRunCommand<unknown>): Promise<void>;
}

export interface ApplicationAuthenticationAdapterContext {
  options: Record<string, unknown>;
  environment: NodeJS.ProcessEnv;
}

export interface RunDispatchAdapterContext {
  options: Record<string, unknown>;
  workflows: WorkflowExecutorRegistry;
  onBackgroundError(error: Error): void;
}

export interface ApplicationQueryAdapterContext {
  options: Record<string, unknown>;
  repositoryRoot?: string;
  configurationRoot?: string;
  runCatalogOptions: Record<string, unknown>;
}

export type ApplicationAuthenticationAdapterRole = "request-authentication";
export interface ApplicationAuthenticationPortByRole {
  "request-authentication": ApplicationAuthenticationProvider;
}
export type ApplicationAuthenticationAdapterFactory = StoreAdapterFactory<
  ApplicationAuthenticationAdapterRole,
  ApplicationAuthenticationProvider,
  ApplicationAuthenticationAdapterContext
>;
export type ApplicationAuthenticationAdapterRegistry = StoreAdapterRegistry<
  ApplicationAuthenticationAdapterRole,
  ApplicationAuthenticationPortByRole,
  ApplicationAuthenticationAdapterContext
>;

export type RunDispatchAdapterRole = "run-dispatch";
export interface RunDispatchPortByRole {
  "run-dispatch": RunDispatcher<unknown>;
}
export type RunDispatchAdapterFactory = StoreAdapterFactory<
  RunDispatchAdapterRole,
  RunDispatcher<unknown>,
  RunDispatchAdapterContext
>;
export type RunDispatchAdapterRegistry = StoreAdapterRegistry<
  RunDispatchAdapterRole,
  RunDispatchPortByRole,
  RunDispatchAdapterContext
>;

export type ApplicationQueryAdapterRole =
  | "run-catalog"
  | "run-artifacts"
  | "published-results"
  | "run-performance";
export interface ApplicationQueryPortByRole {
  "run-catalog": RunCatalogStore;
  "run-artifacts": RunScopedQueryStoreProvider<RunArtifactQueryStore>;
  "published-results": RunScopedQueryStoreProvider<PublishedResultQueryStore>;
  "run-performance": RunScopedQueryStoreProvider<RunPerformanceQueryStore>;
}
export type ApplicationQueryAdapterFactory<TRole extends ApplicationQueryAdapterRole = ApplicationQueryAdapterRole> =
  StoreAdapterFactory<TRole, ApplicationQueryPortByRole[TRole], ApplicationQueryAdapterContext>;
export type ApplicationQueryAdapterRegistry = StoreAdapterRegistry<
  ApplicationQueryAdapterRole,
  ApplicationQueryPortByRole,
  ApplicationQueryAdapterContext
>;

export class DefaultApplicationAuthenticationAdapterRegistry
  extends DefaultStoreAdapterRegistry<
    ApplicationAuthenticationAdapterRole,
    ApplicationAuthenticationPortByRole,
    ApplicationAuthenticationAdapterContext
  > implements ApplicationAuthenticationAdapterRegistry {
  constructor(factories: ApplicationAuthenticationAdapterFactory[]) {
    super({ roles: ["request-authentication"], factories });
  }
}

export class DefaultRunDispatchAdapterRegistry
  extends DefaultStoreAdapterRegistry<RunDispatchAdapterRole, RunDispatchPortByRole, RunDispatchAdapterContext>
  implements RunDispatchAdapterRegistry {
  constructor(factories: RunDispatchAdapterFactory[]) {
    super({ roles: ["run-dispatch"], factories });
  }
}

export class DefaultApplicationQueryAdapterRegistry
  extends DefaultStoreAdapterRegistry<
    ApplicationQueryAdapterRole,
    ApplicationQueryPortByRole,
    ApplicationQueryAdapterContext
  > implements ApplicationQueryAdapterRegistry {
  constructor(factories: ApplicationQueryAdapterFactory[]) {
    super({
      roles: ["run-catalog", "run-artifacts", "published-results", "run-performance"],
      factories,
    });
  }
}
