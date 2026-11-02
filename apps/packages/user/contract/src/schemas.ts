import { z } from "zod";

export const safeIdentifierSchema = z.string().min(1).max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/);

export const canonicalTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}, "must be a canonical ISO-8601 timestamp");

export const externalIdentitySchema = z.object({
  providerId: safeIdentifierSchema,
  subjectId: z.string().min(1).max(512).refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "must not contain control characters",
  ),
}).strict();

export const userSchema = z.object({
  schemaVersion: z.literal(1),
  userId: safeIdentifierSchema,
  status: z.enum(["active", "disabled"]),
  displayName: z.string().trim().min(1).max(256).optional(),
  identity: externalIdentitySchema,
  registeredAt: canonicalTimestampSchema,
}).strict();

export const registerCurrentUserRequestSchema = z.object({
  requestedUserId: safeIdentifierSchema.optional(),
  displayName: z.string().trim().min(1).max(256).optional(),
}).strict();

export const registerCurrentUserResponseSchema = z.object({ user: userSchema }).strict();

export const userListQuerySchema = z.object({
  status: z.enum(["active", "disabled"]).optional(),
  pageSize: z.number().int().min(1).max(500).optional(),
  cursor: z.string().min(1).optional(),
}).strict();

export const paginationSchema = z.object({
  nextCursor: z.string().min(1).optional(),
}).strict();

export const userListResponseSchema = z.object({
  items: z.array(userSchema),
  pagination: paginationSchema,
}).strict();

export const userDetailResponseSchema = z.object({ user: userSchema }).strict();

export const setUserStatusRequestSchema = z.object({
  status: z.enum(["active", "disabled"]),
}).strict();

export const setUserStatusResponseSchema = z.object({ user: userSchema }).strict();

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  }).strict(),
}).strict();

export type ExternalIdentityDto = z.infer<typeof externalIdentitySchema>;
export type UserDto = z.infer<typeof userSchema>;
export type RegisterCurrentUserRequestDto = z.infer<typeof registerCurrentUserRequestSchema>;
export type RegisterCurrentUserResponseDto = z.infer<typeof registerCurrentUserResponseSchema>;
export type UserListQueryDto = z.infer<typeof userListQuerySchema>;
export type UserListResponseDto = z.infer<typeof userListResponseSchema>;
export type UserDetailResponseDto = z.infer<typeof userDetailResponseSchema>;
export type SetUserStatusRequestDto = z.infer<typeof setUserStatusRequestSchema>;
export type SetUserStatusResponseDto = z.infer<typeof setUserStatusResponseSchema>;
