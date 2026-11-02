import { z } from "zod";
import { readExternalErrorDiagnostic } from "@com-pyvue/agent-execution-core/internal/application/externalError.ts";

export const authProviderIdSchema = z.string().min(1).max(128).regex(/^[a-z][a-z0-9-]*$/);
export const credentialIdSchema = authProviderIdSchema;
export const executionProviderIdSchema = z.enum(["codex-cli", "pi-cli", "claude-code-cli", "kimi-code-cli"]);
export const environmentVariableSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const lifecycleStatusSchema = z.enum(["active", "archived"]);
const credentialValueSchema = z.string().min(1).max(65536).refine((value) => !/[\r\n]/.test(value), "Credential must be a single line.");

export const agentCredentialDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  credentialId: credentialIdSchema,
  displayName: z.string().min(1).max(256),
  kind: z.literal("api-key"),
  modelProvider: authProviderIdSchema,
}).strict();

export const agentCredentialDtoSchema = z.object({
  definition: agentCredentialDefinitionSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  lifecycleStatus: lifecycleStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  valueAvailable: z.boolean(),
}).strict();

export const createAgentCredentialRequestSchema = z.object({
  definition: agentCredentialDefinitionSchema,
  credential: credentialValueSchema,
}).strict();
export const replaceAgentCredentialRequestSchema = z.object({ credential: credentialValueSchema }).strict();
export const agentCredentialResponseSchema = z.object({ credential: agentCredentialDtoSchema }).strict();
export const agentCredentialListResponseSchema = z.object({
  items: z.array(agentCredentialDtoSchema),
  pagination: z.object({ nextCursor: z.string().min(1).optional() }).strict(),
}).strict();
export const agentCredentialListQuerySchema = z.object({
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
  lifecycleStatus: z.enum(["active", "archived", "all"]).optional(),
  modelProvider: authProviderIdSchema.optional(),
}).strict();

const agentAuthProviderDefinitionBase = z.object({
  schemaVersion: z.literal(2),
  authProviderId: authProviderIdSchema,
  displayName: z.string().min(1).max(256),
  executionProviderId: executionProviderIdSchema,
  modelProvider: authProviderIdSchema.optional(),
});
export const agentAuthProviderDefinitionSchema = z.discriminatedUnion("kind", [agentAuthProviderDefinitionBase.extend({
  kind: z.literal("stored-credential"),
  credentialId: credentialIdSchema,
  targetVariable: environmentVariableSchema,
}).strict(), agentAuthProviderDefinitionBase.extend({ kind: z.literal("runtime-native"), modelProvider: authProviderIdSchema }).strict()]);

export const agentAuthProviderDtoSchema = z.object({
  definition: agentAuthProviderDefinitionSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  lifecycleStatus: lifecycleStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const createAgentAuthProviderRequestSchema = z.object({ definition: agentAuthProviderDefinitionSchema }).strict();
export const agentAuthProviderResponseSchema = z.object({ provider: agentAuthProviderDtoSchema }).strict();

const externalDiagnosticSchema = z.unknown().transform((value, context) => {
  const diagnostic = readExternalErrorDiagnostic(value);
  if (diagnostic === undefined) {
    context.addIssue({ code: "custom", message: "Expected an external provider diagnostic." });
    return z.NEVER;
  }
  return diagnostic;
});

export const agentAuthProbeResultSchema = z.object({
  schemaVersion: z.literal(1),
  authProviderId: authProviderIdSchema,
  checkedAt: z.string().datetime(),
  status: z.enum(["connected", "action-required", "failed", "indeterminate"]),
  mechanism: z.enum(["native-status", "provider-check", "minimal-inference"]),
  latencyMs: z.number().nonnegative(),
  probeModel: z.string().min(1).optional(),
  message: z.string().min(1),
  externalDiagnostic: externalDiagnosticSchema.optional(),
}).strict();

export const agentAuthConfigurationCatalogItemSchema = z.object({
  authProviderId: authProviderIdSchema,
  displayName: z.string().min(1).max(256),
  origin: z.enum(["platform", "user"]),
  kind: z.enum(["runtime-native", "stored-credential"]),
  executionProviderId: executionProviderIdSchema,
  modelProvider: authProviderIdSchema.optional(),
  credentialId: credentialIdSchema.optional(),
  lifecycleStatus: lifecycleStatusSchema,
  loginRequirement: z.object({
    application: z.string().min(1),
    instruction: z.string().min(1),
  }).strict().optional(),
  latestProbe: agentAuthProbeResultSchema.optional(),
}).strict();
export const agentAuthProviderListResponseSchema = z.object({
  items: z.array(agentAuthConfigurationCatalogItemSchema),
  pagination: z.object({ nextCursor: z.string().min(1).optional() }).strict(),
}).strict();
export const agentAuthProviderListQuerySchema = z.object({
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
  lifecycleStatus: z.enum(["active", "archived", "all"]).optional(),
  executionProviderId: executionProviderIdSchema.optional(),
}).strict();
export const agentAuthProviderPreflightResponseSchema = z.object({
  authProviderId: authProviderIdSchema,
  available: z.boolean(),
  message: z.string().min(1).optional(),
}).strict();
export const agentAuthProviderProbeResponseSchema = z.object({ probe: agentAuthProbeResultSchema }).strict();

export const authProviderPresetSchema = z.object({
  presetId: authProviderIdSchema,
  label: z.string().min(1),
  executionProviderId: executionProviderIdSchema,
  modelProvider: authProviderIdSchema.optional(),
  targetVariable: environmentVariableSchema,
}).strict();
export const credentialPresetSchema = z.object({
  presetId: authProviderIdSchema,
  label: z.string().min(1),
  modelProvider: authProviderIdSchema,
}).strict();
export const agentAuthenticationMetadataResponseSchema = z.object({
  authProviderPresets: z.array(authProviderPresetSchema),
  credentialPresets: z.array(credentialPresetSchema),
  nativeSessionPresets: z.array(z.object({
    presetId: authProviderIdSchema, label: z.string().min(1),
    executionProviderId: executionProviderIdSchema, modelProvider: authProviderIdSchema,
    requiredVersion: z.string().min(1), loginInstruction: z.string().min(1),
  }).strict()).default([]),
}).strict();
export const apiErrorResponseSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
}).strict();

export type AgentCredentialDefinitionDto = z.infer<typeof agentCredentialDefinitionSchema>;
export type AgentCredentialDto = z.infer<typeof agentCredentialDtoSchema>;
export type CreateAgentCredentialRequestDto = z.infer<typeof createAgentCredentialRequestSchema>;
export type ReplaceAgentCredentialRequestDto = z.infer<typeof replaceAgentCredentialRequestSchema>;
export type AgentCredentialResponseDto = z.infer<typeof agentCredentialResponseSchema>;
export type AgentCredentialListResponseDto = z.infer<typeof agentCredentialListResponseSchema>;
export type AgentCredentialListQueryDto = z.infer<typeof agentCredentialListQuerySchema>;
export type AgentAuthProviderDefinitionDto = z.infer<typeof agentAuthProviderDefinitionSchema>;
export type AgentAuthProviderDto = z.infer<typeof agentAuthProviderDtoSchema>;
export type AgentAuthProbeResultDto = z.infer<typeof agentAuthProbeResultSchema>;
export type AgentAuthConfigurationCatalogItemDto = z.infer<typeof agentAuthConfigurationCatalogItemSchema>;
export type CreateAgentAuthProviderRequestDto = z.infer<typeof createAgentAuthProviderRequestSchema>;
export type AgentAuthProviderResponseDto = z.infer<typeof agentAuthProviderResponseSchema>;
export type AgentAuthProviderListResponseDto = z.infer<typeof agentAuthProviderListResponseSchema>;
export type AgentAuthProviderListQueryDto = z.infer<typeof agentAuthProviderListQuerySchema>;
export type AgentAuthProviderPreflightResponseDto = z.infer<typeof agentAuthProviderPreflightResponseSchema>;
export type AgentAuthProviderProbeResponseDto = z.infer<typeof agentAuthProviderProbeResponseSchema>;
export type AgentAuthenticationMetadataResponseDto = z.infer<typeof agentAuthenticationMetadataResponseSchema>;
