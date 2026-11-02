import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);
export const templateIdSchema = z.string().min(1).max(256).regex(/^[a-z][a-z0-9-]*-v[1-9][0-9]*$/);
export const safeIdentifierSchema = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
export const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const agentTemplateDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  templateId: templateIdSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  origin: z.enum(["platform", "custom"]),
  providerSchema: z.object({
    executionProvider: safeIdentifierSchema,
    schemaVersion: z.number().int().positive(),
  }).strict(),
  policy: jsonObjectSchema,
}).strict();

export const agentTemplateDefinitionSchema = z.object({
  templateId: templateIdSchema,
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  origin: z.enum(["platform", "custom"]),
  lifecycleStatus: z.enum(["active", "archived"]),
  contentHash: contentHashSchema,
  redactedDefinition: agentTemplateDocumentSchema,
}).strict();

export const agentTemplateMutationRequestSchema = z.object({ definition: agentTemplateDocumentSchema }).strict();
export const agentTemplateMutationResponseSchema = z.object({ definition: agentTemplateDefinitionSchema }).strict();
export const agentTemplateListQuerySchema = z.object({
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
  lifecycleStatus: z.enum(["active", "archived", "all"]).optional(),
}).strict();
export const agentTemplateListResponseSchema = z.object({
  items: z.array(agentTemplateDefinitionSchema),
  pagination: z.object({ nextCursor: z.string().min(1).optional() }).strict(),
}).strict();
export const agentTemplateDetailResponseSchema = z.object({ definition: agentTemplateDefinitionSchema }).strict();

export const executionParameterOptionSchema = z.object({ value: z.string().min(1), label: z.string().min(1) }).strict();
export const executionAuthProviderOptionSchema = executionParameterOptionSchema.extend({
  modelProvider: z.string().min(1).optional(),
}).strict();
export const executionParameterEditorFieldSchema = z.discriminatedUnion("kind", [
  z.object({
    key: safeIdentifierSchema,
    label: z.string().min(1),
    kind: z.literal("string"),
    required: z.boolean(),
    placeholder: z.string().min(1).optional(),
    defaultValue: z.string().optional(),
    allowsCustomValue: z.boolean(),
    suggestions: z.array(executionParameterOptionSchema).optional(),
    conditionalSuggestions: z.array(z.object({
      parameterKey: safeIdentifierSchema,
      parameterValue: z.string().min(1),
      options: z.array(executionParameterOptionSchema).min(1),
    }).strict()).optional(),
  }).strict(),
  z.object({
    key: safeIdentifierSchema,
    label: z.string().min(1),
    kind: z.literal("enum"),
    required: z.boolean(),
    options: z.array(executionParameterOptionSchema).min(1),
  }).strict(),
]);
export const executionProviderEditorDescriptorSchema = z.object({
  providerId: safeIdentifierSchema,
  schemaVersion: z.number().int().positive(),
  displayName: z.string().min(1),
  connectionDriven: z.boolean().optional(),
  defaultAuthProviderId: safeIdentifierSchema,
  authProviderOptions: z.array(executionAuthProviderOptionSchema).optional(),
  allowsCustomAuthProvider: z.boolean(),
  allowsAdditionalParameters: z.boolean(),
  fields: z.array(executionParameterEditorFieldSchema),
}).strict();
export const agentTemplateEditorMetadataResponseSchema = z.object({
  executionProviders: z.array(executionProviderEditorDescriptorSchema),
}).strict();
export const apiErrorResponseSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string().min(1), details: z.unknown().optional() }).strict(),
}).strict();

export type AgentTemplateDocumentDto = z.infer<typeof agentTemplateDocumentSchema>;
export type AgentTemplateDefinitionDto = z.infer<typeof agentTemplateDefinitionSchema>;
export type AgentTemplateMutationRequestDto = z.infer<typeof agentTemplateMutationRequestSchema>;
export type AgentTemplateMutationResponseDto = z.infer<typeof agentTemplateMutationResponseSchema>;
export type AgentTemplateListQueryDto = z.infer<typeof agentTemplateListQuerySchema>;
export type AgentTemplateListResponseDto = z.infer<typeof agentTemplateListResponseSchema>;
export type AgentTemplateDetailResponseDto = z.infer<typeof agentTemplateDetailResponseSchema>;
export type ExecutionProviderEditorDescriptorDto = z.infer<typeof executionProviderEditorDescriptorSchema>;
export type AgentTemplateEditorMetadataResponseDto = z.infer<typeof agentTemplateEditorMetadataResponseSchema>;
