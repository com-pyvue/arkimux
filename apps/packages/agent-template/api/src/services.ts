import {
  ApplicationBoundaryError,
  requireApplicationPermission,
  type AuthorizedApplicationPrincipal,
} from "@com-pyvue/agent-execution-application-host";
import {
  agentTemplateDetailResponseSchema,
  agentTemplateEditorMetadataResponseSchema,
  agentTemplateListQuerySchema,
  agentTemplateListResponseSchema,
  agentTemplateMutationRequestSchema,
  agentTemplateMutationResponseSchema,
  type AgentTemplateDefinitionDto,
  type AgentTemplateDetailResponseDto,
  type AgentTemplateEditorMetadataResponseDto,
  type AgentTemplateListQueryDto,
  type AgentTemplateListResponseDto,
  type AgentTemplateMutationRequestDto,
  type AgentTemplateMutationResponseDto,
} from "@com-pyvue/agent-execution-agent-template-contract";
import {
  AgentTemplateDefinitionConflictError,
  ImmutableDefinitionConflictError,
  agentTemplateContentHash,
  validateAgentTemplateDefinition,
  validateAgentRunPolicyProviderSchema,
  type AgentExecutionProviderEditorDescriptor,
  type AgentTemplateDefinition,
  type AgentTemplateLifecycleStatus,
  type AgentTemplateStore,
  type ResolvedAgentTemplate,
} from "@com-pyvue/agent-execution-core";

export class AgentTemplateApplicationService {
  constructor(
    private readonly store: AgentTemplateStore,
    private readonly providers: readonly AgentExecutionProviderEditorDescriptor[] | (() => Promise<readonly AgentExecutionProviderEditorDescriptor[]>),
  ) {}

  async metadata(principal: AuthorizedApplicationPrincipal): Promise<AgentTemplateEditorMetadataResponseDto> {
    requirePermission(principal);
    return agentTemplateEditorMetadataResponseSchema.parse({ executionProviders: await this.resolveProviders() });
  }

  async validate(principal: AuthorizedApplicationPrincipal, input: AgentTemplateMutationRequestDto): Promise<AgentTemplateMutationResponseDto> {
    requirePermission(principal);
    const request = agentTemplateMutationRequestSchema.parse(input);
    const template = await this.validateCustom(request.definition);
    return agentTemplateMutationResponseSchema.parse({ definition: this.dto({ template, contentHash: agentTemplateContentHash(template) }, "active") });
  }

  async publish(principal: AuthorizedApplicationPrincipal, input: AgentTemplateMutationRequestDto): Promise<AgentTemplateMutationResponseDto> {
    requirePermission(principal);
    const request = agentTemplateMutationRequestSchema.parse(input);
    const template = await this.validateCustom(request.definition);
    try {
      return agentTemplateMutationResponseSchema.parse({ definition: this.dto(await this.store.publish(template), "active") });
    } catch (error) {
      if (error instanceof AgentTemplateDefinitionConflictError || error instanceof ImmutableDefinitionConflictError) {
        throw new ApplicationBoundaryError("conflict", 409, error.message);
      }
      throw error;
    }
  }

  async list(principal: AuthorizedApplicationPrincipal, input: AgentTemplateListQueryDto): Promise<AgentTemplateListResponseDto> {
    requirePermission(principal);
    const query = agentTemplateListQuerySchema.parse(input);
    const page = await this.store.list(query);
    return agentTemplateListResponseSchema.parse({
      items: await Promise.all(page.items.map(async (resolved) => this.dto(resolved, await this.requiredStatus(resolved.template.templateId)))),
      pagination: page.nextCursor ? { nextCursor: page.nextCursor } : {},
    });
  }

  async get(principal: AuthorizedApplicationPrincipal, templateId: string): Promise<AgentTemplateDetailResponseDto> {
    requirePermission(principal);
    const resolved = await this.required(templateId);
    return agentTemplateDetailResponseSchema.parse({ definition: this.dto(resolved, await this.requiredStatus(templateId)) });
  }

  async archive(principal: AuthorizedApplicationPrincipal, templateId: string): Promise<AgentTemplateDetailResponseDto> {
    requirePermission(principal);
    const resolved = await this.required(templateId);
    if (resolved.template.origin === "platform") throw new ApplicationBoundaryError("conflict", 409, `Platform Agent Template ${templateId} cannot be archived.`);
    await this.store.archive(templateId);
    return agentTemplateDetailResponseSchema.parse({ definition: this.dto(resolved, "archived") });
  }

  async restore(principal: AuthorizedApplicationPrincipal, templateId: string): Promise<AgentTemplateDetailResponseDto> {
    requirePermission(principal);
    const resolved = await this.required(templateId);
    await this.store.restore(templateId);
    return agentTemplateDetailResponseSchema.parse({ definition: this.dto(resolved, "active") });
  }

  private async validateCustom(value: unknown): Promise<AgentTemplateDefinition> {
    try {
      assertBrowserSafe(value);
      const template = validateAgentTemplateDefinition(value);
      if (template.origin !== "custom") throw new Error("Browser-published Agent Templates must have custom origin.");
      const providers = await this.resolveProviders();
      const provider = providers.find((candidate) => candidate.providerId === template.providerSchema.executionProvider && candidate.schemaVersion === template.providerSchema.schemaVersion);
      if (!provider) throw new Error(`Agent Template provider schema ${template.providerSchema.executionProvider}@${template.providerSchema.schemaVersion} is not installed.`);
      validateAgentRunPolicyProviderSchema(template.policy, providers, "Agent Template policy");
      return template;
    } catch (error) {
      throw new ApplicationBoundaryError("invalid-request", 400, error instanceof Error ? error.message : "Agent Template validation failed.");
    }
  }

  private resolveProviders(): Promise<readonly AgentExecutionProviderEditorDescriptor[]> {
    return typeof this.providers === "function" ? this.providers() : Promise.resolve(this.providers);
  }

  private dto(resolved: ResolvedAgentTemplate, lifecycleStatus: AgentTemplateLifecycleStatus): AgentTemplateDefinitionDto {
    const template = validateAgentTemplateDefinition(resolved.template, resolved.template.templateId);
    const contentHash = agentTemplateContentHash(template);
    if (contentHash !== resolved.contentHash) throw new Error(`Agent Template ${template.templateId} content hash mismatch.`);
    return { templateId: template.templateId, title: template.title, ...(template.description ? { description: template.description } : {}), origin: template.origin, lifecycleStatus, contentHash, redactedDefinition: template as unknown as AgentTemplateDefinitionDto["redactedDefinition"] };
  }
  private async required(templateId: string): Promise<ResolvedAgentTemplate> {
    const resolved = await this.store.resolve(templateId);
    if (!resolved) throw new ApplicationBoundaryError("not-found", 404, `Agent Template ${templateId} does not exist.`);
    return resolved;
  }
  private async requiredStatus(templateId: string): Promise<AgentTemplateLifecycleStatus> {
    const status = await this.store.lifecycleStatus(templateId);
    if (!status) throw new ApplicationBoundaryError("not-found", 404, `Agent Template ${templateId} does not exist.`);
    return status;
  }
}

function requirePermission(principal: AuthorizedApplicationPrincipal): void {
  requireApplicationPermission(principal, "agent-templates:admin");
}

const prohibitedKey = /(api[_-]?key|token|secret|password|authorization|credential)/i;
function assertBrowserSafe(value: unknown, location = "definition"): void {
  if (Array.isArray(value)) return value.forEach((child, index) => assertBrowserSafe(child, `${location}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (prohibitedKey.test(key)) throw new Error(`${location}.${key} cannot contain secret or credential values.`);
    assertBrowserSafe(child, `${location}.${key}`);
  }
}
