import {
  createSelectedStore,
  selectStoreAdapter,
  type PlatformConfigurationProvider,
  type PlatformStoreAdapterRegistry,
  type RoleAssignmentStore,
  type RoleStore,
  type AgentTemplateStore,
  type AgentAuthProviderStore,
  type AgentCredentialStore,
  type RunArtifactQueryStore,
  type RunCatalogStore,
  type RunConfigurationStore,
  type WorkflowRunConfigurationStore,
  type RunDispatcher,
  type RunPerformanceQueryStore,
  type PublishedResultQueryStore,
  type UserStore,
  type DeploymentHealthStore,
  type EnvironmentStore,
  type MeterRecordStore,
  type OrganizationStore,
  type PlatformRunProjectionStore,
  type WorkflowDeploymentStore,
  type WorkflowReleaseStore,
} from "@com-pyvue/agent-execution-core";
import type {
  ApplicationAuthenticationAdapterRegistry,
  ApplicationAuthenticationProvider,
  ApplicationQueryAdapterRegistry,
  RunDispatchAdapterRegistry,
  RunScopedQueryStoreProvider,
  WorkflowExecutorRegistry,
} from "./adapters.ts";
import type {
  ApplicationHostConfigurationProvider,
  ResolvedApplicationHostConfiguration,
} from "./configuration.ts";

export interface ApplicationHostDependencies {
  applicationConfigurations: ApplicationHostConfigurationProvider;
  platformConfigurations: PlatformConfigurationProvider;
  platformStoreAdapters: PlatformStoreAdapterRegistry;
  authenticationAdapters: ApplicationAuthenticationAdapterRegistry;
  runDispatchAdapters: RunDispatchAdapterRegistry;
  queryAdapters: ApplicationQueryAdapterRegistry;
  workflows: WorkflowExecutorRegistry;
  repositoryRoot: string;
  applicationConfigurationRoot: string;
  platformConfigurationRoot: string;
  environment?: NodeJS.ProcessEnv;
  /** Host-owned extension for Managed stores; Local never registers these implementations. */
  composeAdditionalStores?(platform: import("@com-pyvue/agent-execution-core/internal/application/platformConfiguration.ts").ResolvedPlatformConfiguration, context: {repositoryRoot: string; configurationRoot: string}, registry: PlatformStoreAdapterRegistry): Promise<Partial<ComposedApplicationHost['platformStores']>>;
  onBackgroundError?(error: Error): void;
}

export interface ComposedApplicationHost {
  resolvedConfiguration: ResolvedApplicationHostConfiguration;
  authentication: ApplicationAuthenticationProvider;
  runDispatch: RunDispatcher<unknown>;
  platformStores: {
    users: UserStore;
    roles: RoleStore;
    roleAssignments: RoleAssignmentStore;
    runConfigurations?: RunConfigurationStore;
    agentTemplates?: AgentTemplateStore;
    workflowRunConfigurations?: WorkflowRunConfigurationStore;
    agentAuthProviders?: AgentAuthProviderStore;
    agentCredentials?: AgentCredentialStore;
    organizations?: OrganizationStore;
    environments?: EnvironmentStore;
    workflowReleases?: WorkflowReleaseStore;
    workflowDeployments?: WorkflowDeploymentStore;
    deploymentHealth?: DeploymentHealthStore;
    meterRecords?: MeterRecordStore;
    runProjections?: PlatformRunProjectionStore;
  };
  queryStores: {
    runCatalog: RunCatalogStore;
    runArtifacts: RunScopedQueryStoreProvider<RunArtifactQueryStore>;
    publishedResults: RunScopedQueryStoreProvider<PublishedResultQueryStore>;
    runPerformance: RunScopedQueryStoreProvider<RunPerformanceQueryStore>;
  };
}

export async function composeApplicationHost(
  configurationId: string,
  dependencies: ApplicationHostDependencies,
): Promise<ComposedApplicationHost> {
  const resolvedConfiguration = await dependencies.applicationConfigurations.resolve(
    configurationId,
    { repositoryRoot: dependencies.repositoryRoot },
  );
  const configuration = resolvedConfiguration.configuration;
  const platform = await dependencies.platformConfigurations.resolve(
    configuration.platformConfigurationId,
    { repositoryRoot: dependencies.repositoryRoot },
  );
  const platformBase = {
    repositoryRoot: dependencies.repositoryRoot,
    configurationRoot: dependencies.platformConfigurationRoot,
  };
  const users = await createAndPreflight(
    selectStoreAdapter(dependencies.platformStoreAdapters, "user", platform.configuration.stores.users),
    platformBase,
  );
  const roles = await createAndPreflight(
    selectStoreAdapter(dependencies.platformStoreAdapters, "role", platform.configuration.stores.roles),
    platformBase,
  );
  const roleAssignments = await createAndPreflight(
    selectStoreAdapter(dependencies.platformStoreAdapters, "role-assignment", platform.configuration.stores.roleAssignments),
    platformBase,
  );
  const configurationStores = platform.configuration.schemaVersion === 3 || platform.configuration.schemaVersion === 4
    ? {
      agentTemplates: await createAndPreflight(
        selectStoreAdapter(dependencies.platformStoreAdapters, "agent-template", platform.configuration.stores.agentTemplates),
        platformBase,
      ),
      workflowRunConfigurations: await createAndPreflight(
        selectStoreAdapter(
          dependencies.platformStoreAdapters,
          "workflow-run-configuration",
          platform.configuration.stores.workflowRunConfigurations,
        ),
        platformBase,
      ),
      ...(platform.configuration.schemaVersion === 4 ? {
        agentAuthProviders: await createAndPreflight(
          selectStoreAdapter(
            dependencies.platformStoreAdapters,
            "agent-auth-provider",
            platform.configuration.stores.agentAuthProviders,
          ),
          platformBase,
        ),
        agentCredentials: await createAndPreflight(
          selectStoreAdapter(
            dependencies.platformStoreAdapters,
            "agent-credential",
            platform.configuration.stores.agentCredentials,
          ),
          platformBase,
        ),
      } : {}),
    }
    : {
      runConfigurations: await createAndPreflight(
        selectStoreAdapter(
          dependencies.platformStoreAdapters,
          "run-configuration",
          platform.configuration.stores.runConfigurations,
        ),
        platformBase,
      ),
    };
  const controlPlaneStores = await dependencies.composeAdditionalStores?.(platform, platformBase, dependencies.platformStoreAdapters) ?? {};
  const authentication = await createAndPreflight(
    selectStoreAdapter(dependencies.authenticationAdapters, "request-authentication", configuration.authentication),
    { environment: dependencies.environment ?? process.env },
  );
  const runDispatch = await createAndPreflight(
    selectStoreAdapter(dependencies.runDispatchAdapters, "run-dispatch", configuration.runDispatch),
    {
      workflows: dependencies.workflows,
      onBackgroundError: dependencies.onBackgroundError ?? (() => undefined),
    },
  );
  const queryBase = {
    repositoryRoot: dependencies.repositoryRoot,
    configurationRoot: dependencies.applicationConfigurationRoot,
    runCatalogOptions: configuration.queryStores.runCatalog.options,
  };
  const runCatalog = await createAndPreflight(
    selectStoreAdapter(dependencies.queryAdapters, "run-catalog", configuration.queryStores.runCatalog),
    queryBase,
  );
  const runArtifacts = await createAndPreflight(
    selectStoreAdapter(dependencies.queryAdapters, "run-artifacts", configuration.queryStores.runArtifacts),
    queryBase,
  );
  const publishedResults = await createAndPreflight(
    selectStoreAdapter(dependencies.queryAdapters, "published-results", configuration.queryStores.publishedResults),
    queryBase,
  );
  const runPerformance = await createAndPreflight(
    selectStoreAdapter(dependencies.queryAdapters, "run-performance", configuration.queryStores.runPerformance),
    queryBase,
  );

  return {
    resolvedConfiguration,
    authentication,
    runDispatch,
    platformStores: { users, roles, roleAssignments, ...configurationStores, ...controlPlaneStores },
    queryStores: { runCatalog, runArtifacts, publishedResults, runPerformance },
  };
}

async function createAndPreflight<TRole extends string, TStore, TContext>(
  selection: Parameters<typeof createSelectedStore<TRole, TStore, TContext>>[0],
  context: Omit<TContext, "options">,
): Promise<TStore> {
  const store = await createSelectedStore(selection, context);
  const preflight = await selection.factory.preflight(store);
  if (!preflight.available) {
    throw new Error(`Application adapter preflight failed for ${preflight.adapterId}: ${preflight.message ?? "unavailable"}`);
  }
  return store;
}
