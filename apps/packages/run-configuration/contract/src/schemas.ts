import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));
export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export const safeIdentifierSchema = z.string().min(1).max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);
export const configurationIdSchema = z.string().min(1).max(256)
  .regex(/^[a-z][a-z0-9-]*-v[1-9][0-9]*$/);
export const workflowIdentitySchema = z.object({
  kind: safeIdentifierSchema,
  version: z.number().int().positive(),
}).strict();
export const contentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const runConfigurationDefinitionSchema = z.object({
  configurationId: configurationIdSchema,
  workflow: workflowIdentitySchema,
  lifecycleStatus: z.enum(["active", "archived"]),
  contentHash: contentHashSchema,
  createdAt: z.string().datetime().optional(),
  redactedDefinition: jsonObjectSchema,
}).strict();

export const validateRunConfigurationRequestSchema = z.object({
  definition: jsonObjectSchema,
}).strict();
export const validateRunConfigurationResponseSchema = z.object({
  definition: runConfigurationDefinitionSchema,
}).strict();
export const publishRunConfigurationRequestSchema = validateRunConfigurationRequestSchema;
export const publishRunConfigurationResponseSchema = validateRunConfigurationResponseSchema;

export const pageQuerySchema = z.object({
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
  lifecycleStatus: z.enum(["active", "archived", "all"]).optional(),
}).strict();
export const paginationSchema = z.object({ nextCursor: z.string().min(1).optional() }).strict();
export const runConfigurationListResponseSchema = z.object({
  items: z.array(runConfigurationDefinitionSchema),
  pagination: paginationSchema,
}).strict();
export const runConfigurationDetailResponseSchema = z.object({
  definition: runConfigurationDefinitionSchema,
}).strict();

export const compareRunConfigurationsRequestSchema = z.object({
  configurationIds: z.array(configurationIdSchema).min(2).max(10)
    .refine((values) => new Set(values).size === values.length, "configuration IDs must be unique"),
}).strict();
export const compareRunConfigurationsResponseSchema = z.object({
  items: z.array(runConfigurationDefinitionSchema).min(2).max(10),
}).strict();

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }).strict(),
}).strict();

export type WorkflowIdentityDto = z.infer<typeof workflowIdentitySchema>;
export type RunConfigurationDefinitionDto = z.infer<typeof runConfigurationDefinitionSchema>;
export type ValidateRunConfigurationRequestDto = z.infer<typeof validateRunConfigurationRequestSchema>;
export type ValidateRunConfigurationResponseDto = z.infer<typeof validateRunConfigurationResponseSchema>;
export type PublishRunConfigurationRequestDto = z.infer<typeof publishRunConfigurationRequestSchema>;
export type PublishRunConfigurationResponseDto = z.infer<typeof publishRunConfigurationResponseSchema>;
export type PageQueryDto = z.infer<typeof pageQuerySchema>;
export type RunConfigurationListResponseDto = z.infer<typeof runConfigurationListResponseSchema>;
export type RunConfigurationDetailResponseDto = z.infer<typeof runConfigurationDetailResponseSchema>;
export type CompareRunConfigurationsRequestDto = z.infer<typeof compareRunConfigurationsRequestSchema>;
export type CompareRunConfigurationsResponseDto = z.infer<typeof compareRunConfigurationsResponseSchema>;
