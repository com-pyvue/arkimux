import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { LocalSessionInstrumentation } from "./localSessionInstrumentation.ts";
import {
  DefaultApplicationAuthenticationAdapterRegistry,
  DefaultApplicationQueryAdapterRegistry,
  DefaultRunDispatchAdapterRegistry,
  FileApplicationHostConfigurationProvider,
  authenticateApplicationRequest,
  authenticateExternalIdentity,
  composeApplicationHost,
  createFileApplicationQueryAdapterFactories,
  createLocalAuthenticationAdapterFactory,
  createLocalRunDispatchAdapterFactory,
  type ComposedApplicationHost,
} from "@com-pyvue/agent-execution-application-host";
import {
  agentExecutionUiConfiguration,
  resolveAgentExecutionUiProfile,
} from "@com-pyvue/agent-execution-ui-profile-contract";
import {
  FilePlatformConfigurationProvider,
  createDefaultAgentExecutionProviderEditorDescriptors,
  defaultAgentTemplateDefinitions,
  createFilePlatformStoreAdapterRegistry,
  loadPiCliModelOptions,
  validateAgentRunPolicy,
  validateAgentRunPolicyProviderSchema,
  type WorkflowRunConfigurationStore,
  type AgentExecutionProviderEditorDescriptor,
  type AgentAuthProviderStore,
  type AgentAuthProviderDefinition,
  type AgentCredentialStore,
  createAgentExecutionProviderRegistry,
  createStoreBackedAgentAuthProviderRegistry,
  ExecutionAgentAuthConnectionProbe,
  resolveAgentProviderConfigDocument,
  createAgentProviderConfigProvider,
  type ResolvedAgentProviderConfig,
} from "@com-pyvue/agent-execution-core";
import defaultAgentProviderConfig from "@com-pyvue/agent-execution-core/config/agent-providers.default.json" with { type: "json" };
import { nativeConnectionPresets } from "@com-pyvue/agent-execution-core/internal/application/nativeConnectionCatalog.ts";
import { admittedLocalApiKeyPresets } from "@com-pyvue/agent-execution-core/internal/application/localApiKeyConnectionCatalog.ts";
import { nativeConnectionSetupEvidence } from "@com-pyvue/agent-execution-core/internal/application/nativeConnectionSetupEvidence.ts";
import {
  CodedWorkflowRegistry,
  RunApplicationService,
  createRunRouter,
  type GenericRunConfiguration,
  type RunInputRequests,
  type RunCorrectionLinks,
} from "@com-pyvue/agent-execution-run-api";
import {
  UserApplicationService,
  createUserRouter,
} from "@com-pyvue/agent-execution-user-api";
import {
  RoleApplicationService,
  createRoleRouter,
} from "@com-pyvue/agent-execution-role-api";
import {
  RunConfigurationApplicationService,
  RunConfigurationDefinitionValidatorRegistry,
  createRunConfigurationRouter,
  type RunConfigurationDefinition,
} from "@com-pyvue/agent-execution-run-configuration-api";
import {
  AgentTemplateApplicationService,
  createAgentTemplateRouter,
} from "@com-pyvue/agent-execution-agent-template-api";
import {
  AgentAuthenticationApplicationService,
  createAgentAuthenticationRouter,
} from "@com-pyvue/agent-execution-agent-authentication-api";
import { createAgentExecutionApiHost } from "./apiHost.ts";

export const LOCAL_FILESYSTEM_APPLICATION_CONFIGURATION_ID = "local-filesystem-apps-v5";

export interface LocalFilesystemApiHostOptions {
  onFrameworkError?: import("@com-pyvue/agent-execution-application-host/internal/frameworkErrors.ts").FrameworkErrorObserver;
  localServerOrigin?: () => string | undefined;
  inputRequests?: RunInputRequests;
  corrections?: RunCorrectionLinks;
  repositoryRoot: string;
  applicationConfigurationRoot: string;
  platformConfigurationDirectory: string;
  platformStoreConfigurationRoot: string;
  applicationConfigurationId?: string;
  workflows: CodedWorkflowRegistry;
  runConfigurationValidators?: RunConfigurationDefinitionValidatorRegistry;
  environment?: NodeJS.ProcessEnv;
  onBackgroundError?(error: Error): void;
  /** Private Local lifecycle hook; shared service and HTTP contracts are unchanged. */
  onPlatformStores?(stores: ComposedApplicationHost["platformStores"]): void;
  localUsageTelemetry?: {
    status(): Promise<unknown>;
    choose(choice: "yes" | "no" | "ask-later"): Promise<unknown>;
    requestDeletion?(): Promise<unknown>;
  };
  localSession?: LocalSessionInstrumentation;
  localFrameworkDiagnostics?: {
    receiveBrowser?(value: unknown, origin: string): Promise<boolean>;
    list(): Promise<unknown>;
    get(diagnosticId: string): Promise<unknown | undefined>;
    delete(diagnosticId: string): Promise<void>;
    clear(): Promise<void>;
  };
}

export async function composeLocalFilesystemAgentExecutionApplication(
  options: LocalFilesystemApiHostOptions,
): Promise<ComposedApplicationHost> {
  return composeApplicationHost(
    options.applicationConfigurationId ?? LOCAL_FILESYSTEM_APPLICATION_CONFIGURATION_ID,
    {
      applicationConfigurations: new FileApplicationHostConfigurationProvider(options.applicationConfigurationRoot),
      platformConfigurations: new FilePlatformConfigurationProvider({
        configurationDirectory: options.platformConfigurationDirectory,
      }),
      platformStoreAdapters: createFilePlatformStoreAdapterRegistry(),
      authenticationAdapters: new DefaultApplicationAuthenticationAdapterRegistry([
        createLocalAuthenticationAdapterFactory(),
      ]),
      runDispatchAdapters: new DefaultRunDispatchAdapterRegistry([
        createLocalRunDispatchAdapterFactory(),
      ]),
      queryAdapters: new DefaultApplicationQueryAdapterRegistry(createFileApplicationQueryAdapterFactories()),
      workflows: options.workflows,
      repositoryRoot: options.repositoryRoot,
      applicationConfigurationRoot: options.applicationConfigurationRoot,
      platformConfigurationRoot: options.platformStoreConfigurationRoot,
      environment: options.environment,
      onBackgroundError: options.onBackgroundError,
    },
  );
}

export async function createLocalFilesystemAgentExecutionApiHost(options: LocalFilesystemApiHostOptions) {
  const composed = await composeLocalFilesystemAgentExecutionApplication(options);
  options.onPlatformStores?.(composed.platformStores);
  const uiConfiguration = agentExecutionUiConfiguration(resolveAgentExecutionUiProfile(
    options.environment?.AGENT_EXECUTION_UI_PROFILE,
    "platform",
  ));
  const platformProfile = uiConfiguration.profile === "platform";
  const enabledFeatures = new Set(uiConfiguration.features);
  const runConfigurations = requiredStore(
    composed.platformStores.workflowRunConfigurations,
    "workflow run configuration",
  ) as WorkflowRunConfigurationStore<GenericRunConfiguration>;
  const runConfigurationDefinitions = runConfigurations as WorkflowRunConfigurationStore<RunConfigurationDefinition>;
  const agentTemplates = requiredStore(composed.platformStores.agentTemplates, "Agent Template");
  const validators = options.runConfigurationValidators ?? new RunConfigurationDefinitionValidatorRegistry();
  await seedPlatformAgentTemplates(agentTemplates);
  const authProviders = composed.platformStores.agentAuthProviders;
  const agentCredentials = composed.platformStores.agentCredentials;
  const projectProviderConfigPath = path.join(options.repositoryRoot, "config/agent-providers.default.json");
  const hasProjectProviderConfig = await access(projectProviderConfigPath).then(() => true).catch((error) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  const agentProviderConfig = hasProjectProviderConfig
    ? await (await createAgentProviderConfigProvider({ defaultConfigPath: projectProviderConfigPath, environment: options.environment ?? process.env })).resolve()
    : resolveAgentProviderConfigDocument(defaultAgentProviderConfig, options.environment ?? process.env);
  const localV2Connections = uiConfiguration.profile === "workflow-development"
    && await readFile(path.join(options.repositoryRoot, ".arkimux/project.json"), "utf8")
      .then((source) => JSON.parse(source).kind === "arkimux-project")
      .catch((error) => { if (error.code === "ENOENT") return false; throw error; });
  const providerEditorDescriptors = () => localProviderEditorDescriptors(
    authProviders,
    agentCredentials,
    options.repositoryRoot,
    options.environment,
    agentProviderConfig,
    localV2Connections,
  );
  const runService = new RunApplicationService({
    inputRequests: options.inputRequests,
    corrections: options.corrections,
    catalog: composed.queryStores.runCatalog,
    artifacts: composed.queryStores.runArtifacts,
    results: composed.queryStores.publishedResults,
    performance: composed.queryStores.runPerformance,
    runConfigurations,
    dispatcher: composed.runDispatch,
    workflows: options.workflows,
    ...(localV2Connections ? { connectionPreflight: async (configuration: GenericRunConfiguration) => {
      const providers = await providerEditorDescriptors();
      const agents = Object.entries((configuration as GenericRunConfiguration & { agents?: Record<string, unknown> }).agents ?? {}).map(([slotId, candidate]) => {
        const policy = validateAgentRunPolicy(candidate, `Agent slot ${slotId}`);
        const identity = { slotId, providerId: policy.execution.provider, authProviderId: policy.execution.authProvider };
        try {
          validateAgentRunPolicyProviderSchema(policy, providers, `Agent slot ${slotId}`);
          return { ...identity, available: true };
        } catch (error) {
          return { ...identity, available: false, message: `${error instanceof Error ? error.message : "Connection is unavailable."} Choose an active compatible Connection in a new Run Configuration; check its login in Connections.` };
        }
      });
      return { available: agents.every((agent) => agent.available), agents };
    } } : {}),
  });
  const authenticationStores = {
    users: composed.platformStores.users,
    roles: composed.platformStores.roles,
    assignments: composed.platformStores.roleAssignments,
  };
  const runRouter = createRunRouter({
    service: runService,
    authenticate: (request) => authenticateApplicationRequest(request, composed.authentication, authenticationStores),
  });
  const userRouter = platformProfile ? createUserRouter({
    service: new UserApplicationService(composed.platformStores.users),
    identify: (request) => authenticateExternalIdentity(request, composed.authentication),
    authenticate: (request) => authenticateApplicationRequest(request, composed.authentication, authenticationStores),
  }) : undefined;
  const roleRouter = platformProfile ? createRoleRouter({
    service: new RoleApplicationService(
      composed.platformStores.users,
      composed.platformStores.roles,
      composed.platformStores.roleAssignments,
    ),
    authenticate: (request) => authenticateApplicationRequest(request, composed.authentication, authenticationStores),
  }) : undefined;
  const runConfigurationRouter = enabledFeatures.has("workflows") ? createRunConfigurationRouter({
    service: new RunConfigurationApplicationService(
      runConfigurationDefinitions,
      validators,
      providerEditorDescriptors,
    ),
    authenticate: (request) => authenticateApplicationRequest(request, composed.authentication, authenticationStores),
  }) : undefined;
  const agentTemplateRouter = enabledFeatures.has("agent-templates") ? createAgentTemplateRouter({
    service: new AgentTemplateApplicationService(
      agentTemplates,
      providerEditorDescriptors,
    ),
    authenticate: (request) => authenticateApplicationRequest(request, composed.authentication, authenticationStores),
  }) : undefined;
  const agentAuthenticationRouter = enabledFeatures.has("agent-authentication") && authProviders && agentCredentials ? createAgentAuthenticationRouter({
    service: new AgentAuthenticationApplicationService(authProviders, agentCredentials, {
      providerConfig: agentProviderConfig,
      localV2Connections,
      connectionProbe: new ExecutionAgentAuthConnectionProbe(
        createAgentExecutionProviderRegistry(
          agentProviderConfig,
          createStoreBackedAgentAuthProviderRegistry(
            agentProviderConfig,
            authProviders,
            agentCredentials,
            options.environment ?? process.env,
          ),
          options.environment ?? process.env,
        ),
        agentProviderConfig,
        options.repositoryRoot,
        options.environment ?? process.env,
      ),
    }),
    authenticate: (request) => authenticateApplicationRequest(request, composed.authentication, authenticationStores),
  }) : undefined;
  const authenticate = (request: Request) => authenticateApplicationRequest(
    request,
    composed.authentication,
    authenticationStores,
  );
  return createAgentExecutionApiHost({
    runRouter,
    userRouter,
    roleRouter,
    runConfigurationRouter,
    agentTemplateRouter,
    agentAuthenticationRouter,
    uiConfiguration,
    allowedBrowserOrigins: composed.resolvedConfiguration.configuration.http.allowedBrowserOrigins,
    localServerOrigin: options.localServerOrigin,
    onFrameworkError: options.onFrameworkError,
    localUsageTelemetry: options.localUsageTelemetry ? { ...options.localUsageTelemetry, authorizeDeletion: authenticate } : undefined,
    localSession: options.localSession,
    localFrameworkDiagnostics: options.localFrameworkDiagnostics ? {
      list: () => options.localFrameworkDiagnostics!.list(),
      get: diagnosticId => options.localFrameworkDiagnostics!.get(diagnosticId),
      delete: diagnosticId => options.localFrameworkDiagnostics!.delete(diagnosticId),
      clear: () => options.localFrameworkDiagnostics!.clear(),
      receiveBrowser: options.localFrameworkDiagnostics.receiveBrowser,
      authorize: authenticate,
    } : undefined,
  });
}

export async function localProviderEditorDescriptors(
  store: AgentAuthProviderStore | undefined,
  credentials: AgentCredentialStore | undefined,
  repositoryRoot: string,
  environment?: NodeJS.ProcessEnv,
  providerConfig?: ResolvedAgentProviderConfig,
  connectionDriven = false,
): Promise<readonly AgentExecutionProviderEditorDescriptor[]> {
  const definitions: AgentAuthProviderDefinition[] = [];
  let cursor: string | undefined;
  if (store) {
    do {
      const page = await store.list({ lifecycleStatus: "active", pageSize: 500, ...(cursor ? { cursor } : {}) });
      definitions.push(...page.items.map(({ definition }) => definition));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  const readyDefinitions = (await Promise.all(definitions.map(async (definition) => {
      if (definition.kind === "runtime-native") return definition;
      const credential = await credentials?.getDefinition(definition.credentialId);
      return credential?.lifecycleStatus === "active" && credential.valueAvailable ? definition : undefined;
    }))).filter((definition): definition is AgentAuthProviderDefinition => definition !== undefined);
  const piModelProviders = [...new Set([
    "openai-codex",
    ...Object.values(providerConfig?.authProviders ?? {}).flatMap((definition) =>
      definition.kind === "runtime-native" && definition.runtime === "pi-cli" && definition.modelProvider ? [definition.modelProvider] : []),
    ...readyDefinitions
      .filter(({ executionProviderId }) => executionProviderId === "pi-cli")
      .map(({ modelProvider }) => modelProvider)
      .filter((modelProvider): modelProvider is string => typeof modelProvider === "string" && modelProvider.length > 0),
  ])];
  const piModelCatalogs = Object.fromEntries(await Promise.all(piModelProviders.map(async (modelProvider) => [
    modelProvider,
    await loadPiCliModelOptions({
      cwd: repositoryRoot,
      environment,
      modelProvider,
    }),
  ])));
  const admitted = (runtime: string, modelProvider: string | undefined) => nativeConnectionPresets.some((preset) =>
    preset.executionProviderId === runtime && preset.modelProvider === modelProvider
    && providerConfig?.executionProviders[preset.executionProviderId]?.requiredVersion === preset.requiredVersion
    && nativeConnectionSetupEvidence.some((record) => record.presetId === preset.presetId && record.requiredVersion === preset.requiredVersion));
  return createDefaultAgentExecutionProviderEditorDescriptors({ piModelCatalogs }).map((provider) => ({
    ...provider,
    ...(connectionDriven ? { connectionDriven: true } : {}),
    authProviderOptions: [
      ...(connectionDriven ? [] : provider.authProviderOptions ?? []),
      ...Object.entries(providerConfig?.authProviders ?? {}).flatMap(([value, definition]) =>
        definition.kind === "runtime-native" && definition.runtime === provider.providerId
          && (connectionDriven
            ? admitted(definition.runtime, definition.modelProvider ?? (definition.runtime === "codex-cli" ? "openai" : undefined))
              && !(value === "codex-native-session" && providerConfig?.authProviders["codex-openai-native-session"])
            : !provider.authProviderOptions?.some((option) => option.value === value))
          ? [{ value, label: value, modelProvider: definition.modelProvider ?? (definition.runtime === "codex-cli" ? "openai" : undefined) }]
          : []),
      ...readyDefinitions
        .filter(({ executionProviderId }) => executionProviderId === provider.providerId)
        .filter((definition) => !connectionDriven || (definition.kind === "runtime-native"
          ? admitted(definition.executionProviderId, definition.modelProvider)
          : admittedLocalApiKeyPresets(providerConfig).some(preset => preset.executionProviderId === definition.executionProviderId && preset.modelProvider === definition.modelProvider && preset.targetVariable === definition.targetVariable)))
        .map(({ authProviderId, displayName, modelProvider }) => ({
          value: authProviderId,
          label: displayName,
          modelProvider,
        })),
    ],
  })).filter((provider) => !connectionDriven || provider.authProviderOptions.length > 0);
}

function requiredStore<T>(store: T | undefined, label: string): T {
  if (!store) throw new Error(`The selected platform configuration does not provide a ${label} store.`);
  return store;
}

async function seedPlatformAgentTemplates(
  store: NonNullable<ComposedApplicationHost["platformStores"]["agentTemplates"]>,
): Promise<void> {
  for (const template of defaultAgentTemplateDefinitions) {
    await store.publish(template);
    if (await store.lifecycleStatus(template.templateId) !== "active") {
      await store.restore(template.templateId);
    }
  }
  for (const templateId of ["claude-code-cli-default-v1", "kimi-code-cli-default-v1"] as const) {
    if (await store.resolve(templateId) && await store.lifecycleStatus(templateId) !== "archived") {
      await store.archive(templateId, { allowPlatformTemplate: true });
    }
  }
}
