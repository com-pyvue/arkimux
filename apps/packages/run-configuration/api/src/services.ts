import {
  ApplicationBoundaryError,
  requireApplicationPermission,
  type AuthorizedApplicationPrincipal,
} from "@com-pyvue/agent-execution-application-host";
import {
  compareRunConfigurationsRequestSchema,
  compareRunConfigurationsResponseSchema,
  pageQuerySchema,
  publishRunConfigurationRequestSchema,
  publishRunConfigurationResponseSchema,
  runConfigurationDetailResponseSchema,
  runConfigurationListResponseSchema,
  validateRunConfigurationRequestSchema,
  validateRunConfigurationResponseSchema,
  type CompareRunConfigurationsRequestDto,
  type CompareRunConfigurationsResponseDto,
  type PageQueryDto,
  type PublishRunConfigurationRequestDto,
  type PublishRunConfigurationResponseDto,
  type RunConfigurationDefinitionDto,
  type RunConfigurationDetailResponseDto,
  type RunConfigurationListResponseDto,
  type WorkflowIdentityDto,
  type ValidateRunConfigurationRequestDto,
  type ValidateRunConfigurationResponseDto,
} from "@com-pyvue/agent-execution-run-configuration-contract";
import {
  WorkflowRunConfigurationDefinitionConflictError,
  ImmutableDefinitionConflictError,
  redactResolvedRunConfiguration,
  runConfigurationContentHash,
  validateAgentRunPolicy,
  validateAgentRunPolicyProviderSchema,
  type AgentExecutionProviderEditorDescriptor,
  type ResolvedRunConfiguration,
  type WorkflowRunConfigurationStore,
  type RunConfigurationLifecycleStatus,
} from "@com-pyvue/agent-execution-core";
import {
  RunConfigurationDefinitionValidatorRegistry,
  type RunConfigurationDefinition,
} from "./validatorRegistry.ts";

export class RunConfigurationApplicationService {
  constructor(
    private readonly store: WorkflowRunConfigurationStore<RunConfigurationDefinition>,
    private readonly validators: RunConfigurationDefinitionValidatorRegistry,
    private readonly providers: readonly AgentExecutionProviderEditorDescriptor[] | (() => Promise<readonly AgentExecutionProviderEditorDescriptor[]>) = [],
  ) {}

  async validate(
    principal: AuthorizedApplicationPrincipal,
    workflow: WorkflowIdentityDto,
    input: ValidateRunConfigurationRequestDto,
  ): Promise<ValidateRunConfigurationResponseDto> {
    requireAdministration(principal, workflow);
    const request = validateRunConfigurationRequestSchema.parse(input);
    const definition = await this.validateRequest(request.definition, workflow);
    return validateRunConfigurationResponseSchema.parse({
      definition: this.dto({
        configuration: definition,
        contentHash: runConfigurationContentHash(definition),
      }, "active"),
    });
  }

  async publish(
    principal: AuthorizedApplicationPrincipal,
    workflow: WorkflowIdentityDto,
    input: PublishRunConfigurationRequestDto,
  ): Promise<PublishRunConfigurationResponseDto> {
    requireAdministration(principal, workflow);
    const request = publishRunConfigurationRequestSchema.parse(input);
    const definition = await this.validateRequest(request.definition, workflow);
    try {
      return publishRunConfigurationResponseSchema.parse({
        definition: this.dto(await this.store.publish(definition), "active"),
      });
    } catch (error) {
      if (error instanceof WorkflowRunConfigurationDefinitionConflictError || error instanceof ImmutableDefinitionConflictError) {
        throw new ApplicationBoundaryError("conflict", 409, error.message);
      }
      throw error;
    }
  }

  async list(
    principal: AuthorizedApplicationPrincipal,
    workflow: WorkflowIdentityDto,
    input: PageQueryDto,
  ): Promise<RunConfigurationListResponseDto> {
    requireAdministration(principal, workflow);
    const query = pageQuerySchema.parse(input);
    const page = await this.store.list(workflow, query);
    return runConfigurationListResponseSchema.parse({
      items: await Promise.all(page.items.map(async (resolved) => this.dto(
        resolved,
        await this.requiredLifecycleStatus(workflow, resolved.configuration.configurationId),
      ))),
      pagination: page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
    });
  }

  async get(
    principal: AuthorizedApplicationPrincipal,
    workflow: WorkflowIdentityDto,
    configurationId: string,
  ): Promise<RunConfigurationDetailResponseDto> {
    requireAdministration(principal, workflow);
    const resolved = await this.store.resolve(workflow, configurationId);
    if (!resolved) {
      throw new ApplicationBoundaryError(
        "not-found",
        404,
        `Run configuration ${configurationId} does not exist.`,
      );
    }
    return runConfigurationDetailResponseSchema.parse({
      definition: this.dto(resolved, await this.requiredLifecycleStatus(workflow, configurationId)),
    });
  }

  async archive(
    principal: AuthorizedApplicationPrincipal,
    workflow: WorkflowIdentityDto,
    configurationId: string,
  ): Promise<RunConfigurationDetailResponseDto> {
    requireAdministration(principal, workflow);
    const resolved = await this.requiredDefinition(workflow, configurationId);
    await this.store.archive(workflow, configurationId);
    return runConfigurationDetailResponseSchema.parse({ definition: this.dto(resolved, "archived") });
  }

  async restore(
    principal: AuthorizedApplicationPrincipal,
    workflow: WorkflowIdentityDto,
    configurationId: string,
  ): Promise<RunConfigurationDetailResponseDto> {
    requireAdministration(principal, workflow);
    const resolved = await this.requiredDefinition(workflow, configurationId);
    await this.store.restore(workflow, configurationId);
    return runConfigurationDetailResponseSchema.parse({ definition: this.dto(resolved, "active") });
  }

  async compare(
    principal: AuthorizedApplicationPrincipal,
    workflow: WorkflowIdentityDto,
    input: CompareRunConfigurationsRequestDto,
  ): Promise<CompareRunConfigurationsResponseDto> {
    requireAdministration(principal, workflow);
    const request = compareRunConfigurationsRequestSchema.parse(input);
    const items = await Promise.all(request.configurationIds.map(async (configurationId) => {
      const resolved = await this.store.resolve(workflow, configurationId);
      if (!resolved) {
        throw new ApplicationBoundaryError(
          "not-found",
          404,
          `Run configuration ${configurationId} does not exist.`,
        );
      }
      return this.dto(resolved, await this.requiredLifecycleStatus(workflow, configurationId));
    }));
    return compareRunConfigurationsResponseSchema.parse({ items });
  }

  private async validateRequest(value: unknown, workflow: WorkflowIdentityDto): Promise<RunConfigurationDefinition> {
    try {
      assertBrowserPublishableDefinition(value);
      const definition = this.validators.validate(value);
      assertWorkflowMatches(definition.workflow, workflow);
      await this.validateAgentPolicies(definition);
      return definition;
    } catch (error) {
      throw new ApplicationBoundaryError(
        "invalid-request",
        400,
        error instanceof Error ? error.message : "Run configuration validation failed.",
      );
    }
  }

  private async validateAgentPolicies(definition: RunConfigurationDefinition): Promise<void> {
    const providers = typeof this.providers === "function" ? await this.providers() : this.providers;
    // An explicitly configured catalog must fail closed, even when it is empty.
    if (providers.length === 0 && typeof this.providers !== "function") return;
    const agents = (definition as RunConfigurationDefinition & { agents?: unknown }).agents;
    if (agents === undefined) return;
    if (!isRecord(agents)) throw new Error("Run configuration agents must be an object.");
    for (const [slotId, candidate] of Object.entries(agents)) {
      const policy = validateAgentRunPolicy(candidate, `Run configuration agent ${slotId}`);
      validateAgentRunPolicyProviderSchema(policy, providers, `Run configuration agent ${slotId}`);
    }
  }

  private dto(
    resolved: ResolvedRunConfiguration<RunConfigurationDefinition>,
    lifecycleStatus: RunConfigurationLifecycleStatus,
  ): RunConfigurationDefinitionDto {
    const validated = this.validators.validate(
      resolved.configuration,
      resolved.configuration.configurationId,
    );
    const canonicalHash = runConfigurationContentHash(validated);
    if (canonicalHash !== resolved.contentHash) {
      throw new Error(
        `Run configuration ${validated.configurationId} content hash does not match its validated definition.`,
      );
    }
    const redacted = redactResolvedRunConfiguration({ configuration: validated, contentHash: canonicalHash });
    return {
      configurationId: validated.configurationId,
      workflow: validated.workflow,
      lifecycleStatus,
      contentHash: canonicalHash,
      ...(resolved.createdAt === undefined ? {} : { createdAt: resolved.createdAt }),
      redactedDefinition: redacted.configuration as unknown as RunConfigurationDefinitionDto["redactedDefinition"],
    };
  }

  private async requiredDefinition(
    workflow: WorkflowIdentityDto,
    configurationId: string,
  ): Promise<ResolvedRunConfiguration<RunConfigurationDefinition>> {
    const resolved = await this.store.resolve(workflow, configurationId);
    if (!resolved) {
      throw new ApplicationBoundaryError("not-found", 404, `Run configuration ${configurationId} does not exist.`);
    }
    return resolved;
  }

  private async requiredLifecycleStatus(
    workflow: WorkflowIdentityDto,
    configurationId: string,
  ): Promise<RunConfigurationLifecycleStatus> {
    const status = await this.store.lifecycleStatus(workflow, configurationId);
    if (!status) {
      throw new ApplicationBoundaryError("not-found", 404, `Run configuration ${configurationId} does not exist.`);
    }
    return status;
  }
}

function requireAdministration(
  principal: AuthorizedApplicationPrincipal,
  workflow: WorkflowIdentityDto,
): void {
  requireApplicationPermission(principal, `workflow:${workflow.kind}:configure`);
}

function assertWorkflowMatches(actual: WorkflowIdentityDto, expected: WorkflowIdentityDto): void {
  if (actual.kind !== expected.kind || actual.version !== expected.version) {
    throw new Error(`Run configuration workflow must be ${expected.kind}@${expected.version}.`);
  }
}

const secretKey = /(api[_-]?key|token|secret|password|authorization|credential)/i;
const executablePathKey = /(?:^|[._-])(?:plugin|module|executable)[_-]?path(?:$|[._-])/i;

function assertBrowserPublishableDefinition(value: unknown, path = "definition"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertBrowserPublishableDefinition(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (secretKey.test(key)) throw new Error(`${path}.${key} cannot contain secret or credential values.`);
    if (executablePathKey.test(key)) throw new Error(`${path}.${key} cannot select executable plugin paths.`);
    assertBrowserPublishableDefinition(child, `${path}.${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
