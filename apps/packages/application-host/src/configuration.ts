import { createHash } from "node:crypto";
import { z } from "zod";

const versionedConfigurationId = /^[a-z][a-z0-9-]*-v[1-9][0-9]*$/;
const versionedAdapterId = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/;

export const applicationAdapterReferenceSchema = z.object({
  adapterId: z.string().regex(versionedAdapterId),
  options: z.record(z.string(), z.unknown()),
}).strict();

const exactBrowserOriginSchema = z.string().superRefine((value, context) => {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.origin !== value
      || parsed.username.length > 0
      || parsed.password.length > 0
    ) {
      context.addIssue({ code: "custom", message: "must be an exact HTTP(S) origin" });
    }
  } catch {
    context.addIssue({ code: "custom", message: "must be an exact HTTP(S) origin" });
  }
});

export const applicationHostConfigurationSchema = z.object({
  schemaVersion: z.literal(1),
  configurationId: z.string().regex(versionedConfigurationId),
  platformConfigurationId: z.string().regex(versionedConfigurationId),
  http: z.object({
    allowedBrowserOrigins: z.array(exactBrowserOriginSchema).min(1),
  }).strict(),
  authentication: applicationAdapterReferenceSchema,
  runDispatch: applicationAdapterReferenceSchema,
  queryStores: z.object({
    runCatalog: applicationAdapterReferenceSchema,
    runArtifacts: applicationAdapterReferenceSchema,
    publishedResults: applicationAdapterReferenceSchema,
    runPerformance: applicationAdapterReferenceSchema,
  }).strict(),
}).strict();

export type ApplicationAdapterReference = z.infer<typeof applicationAdapterReferenceSchema>;
export type AgentExecutionApplicationHostConfiguration = z.infer<typeof applicationHostConfigurationSchema>;

export interface ResolvedApplicationHostConfiguration {
  configuration: AgentExecutionApplicationHostConfiguration;
  contentHash: string;
}

export interface ApplicationHostConfigurationContext {
  repositoryRoot?: string;
}

export interface ApplicationHostConfigurationProvider {
  resolve(
    configurationId: string,
    context: ApplicationHostConfigurationContext,
  ): Promise<ResolvedApplicationHostConfiguration>;
}

export function validateApplicationHostConfiguration(
  value: unknown,
  expectedConfigurationId?: string,
): AgentExecutionApplicationHostConfiguration {
  const configuration = applicationHostConfigurationSchema.parse(value);
  if (expectedConfigurationId !== undefined && configuration.configurationId !== expectedConfigurationId) {
    throw new Error(
      `Application-host configuration ID mismatch: requested ${expectedConfigurationId}, document declares ${configuration.configurationId}.`,
    );
  }
  const uniqueOrigins = new Set(configuration.http.allowedBrowserOrigins);
  if (uniqueOrigins.size !== configuration.http.allowedBrowserOrigins.length) {
    throw new Error("Application-host allowed browser origins must be unique.");
  }
  return structuredClone(configuration);
}

export function assertApplicationHostConfigurationId(value: string): void {
  if (!versionedConfigurationId.test(value)) {
    throw new Error("Application-host configuration ID must be a lowercase versioned ID ending in -v<number>.");
  }
}

export function applicationHostConfigurationContentHash(configuration: unknown): string {
  return createHash("sha256").update(canonicalJson(configuration)).digest("hex");
}

export function redactApplicationHostConfiguration(
  configuration: AgentExecutionApplicationHostConfiguration,
): AgentExecutionApplicationHostConfiguration {
  return redact(configuration) as AgentExecutionApplicationHostConfiguration;
}

function redact(value: unknown, key = ""): unknown {
  if (/(?:secret|token|password|credential|authorization|api[-_]?key)/i.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nested]) => [
      nestedKey,
      redact(nested, nestedKey),
    ]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
