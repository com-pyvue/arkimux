import { createHash } from "node:crypto";
import { z } from "zod";

export const workflowCapabilitiesV1 = [
  "agent-slot-invocation@1", "durable-sequential-steps@1", "effect-idempotent-write@1",
  "effect-read@1", "effect-reconcilable-write@1", "effect-unsafe-write@1", "typed-results@1",
] as const;
export const executionFeaturesV1 = ["child-processes", "container-runtime", "shell"] as const;
const id = z.string().regex(/^[a-z][a-z0-9-]*$/);
const version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const text = z.string().min(1).max(1024).refine(v => v === v.trim() && !/[\u0000-\u001f\u007f]/u.test(v));
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const sorted = <T extends z.ZodType<string>>(item: T, minimum = 0) => z.array(item).min(minimum)
  .refine(v => v.every((x, i) => i === 0 || v[i - 1]! < x), "Expected sorted unique values.");
export const projectSourcePathV1Schema = text.refine(v => !v.startsWith("/") && !v.includes("\\")
  && !v.includes(":") && v.split("/").every(p => p !== "" && p !== "." && p !== ".." && !p.startsWith(".")),
"Expected a normalized non-hidden project-relative path.");
export const sourceExportV1Schema = z.object({ file: projectSourcePathV1Schema,
  export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/) }).strict();
export const requirementSetV1Schema = z.object({
  maxDurationSeconds: positive,
  resources: z.object({ minCpuMillis: positive.optional(), minMemoryMiB: positive.optional(),
    minTemporaryDiskMiB: positive.optional() }).strict().optional(),
  requiredFeatures: sorted(z.enum(executionFeaturesV1)).optional(),
  architectures: sorted(z.enum(["arm64", "x64"]), 1).optional(),
}).strict();
export const executionRequirementsV1Schema = z.object({ schemaVersion: z.literal(1),
  run: requirementSetV1Schema, operations: z.record(id, requirementSetV1Schema) }).strict()
  .superRefine((v, ctx) => {
    for (const [key, op] of Object.entries(v.operations)) if (op.maxDurationSeconds > v.run.maxDurationSeconds) {
      ctx.addIssue({ code: "custom", path: ["operations", key, "maxDurationSeconds"], message: "Operation exceeds run deadline." });
    }
    const sets = [v.run, ...Object.values(v.operations)].flatMap(x => x.architectures ? [x.architectures] : []);
    if (sets.length && !sets[0]!.some(a => sets.every(s => s.includes(a)))) {
      ctx.addIssue({ code: "custom", message: "Architecture requirements have no common architecture." });
    }
  });
export const sourceBindingV1Schema = z.object({
  kind: z.enum(["framework", "workflow-engine", "agent-provider", "model", "compute-provider"]),
  id: text,
  source: z.union([
    z.object({ file: projectSourcePathV1Schema, import: text }).strict(),
    z.object({ file: projectSourcePathV1Schema, pointer: z.string().regex(/^(?:\/(?:[^~]|~[01])*)+$/) }).strict(),
  ]),
}).strict();
export const workflowManifestV1Schema = z.object({
  schemaVersion: z.literal(1), workflowId: id,
  workflowMode: z.enum(["arkimux-portable", "native-runtime-bound"]),
  workflowContractVersion: version, requiredCapabilities: sorted(z.enum(workflowCapabilitiesV1)),
  executionRequirements: executionRequirementsV1Schema, sourceBindings: z.array(sourceBindingV1Schema),
}).strict().superRefine((v, ctx) => {
  if (v.workflowMode === "arkimux-portable" && v.sourceBindings.length) {
    ctx.addIssue({ code: "custom", path: ["sourceBindings"], message: "Portable workflows cannot have source bindings." });
  }
  const keys = v.sourceBindings.map(canonicalWorkflowJson);
  if (!keys.every((key, i) => i === 0 || keys[i - 1]! < key)) {
    ctx.addIssue({ code: "custom", path: ["sourceBindings"], message: "Expected sorted unique source bindings." });
  }
});
export const workflowDeclarationV1Schema = z.object({
  manifest: projectSourcePathV1Schema, environment: projectSourcePathV1Schema,
  definition: sourceExportV1Schema, inputValidator: sourceExportV1Schema, resultValidator: sourceExportV1Schema,
  result: z.object({ kind: text, schemaVersion: positive }).strict(),
  effects: z.array(sourceExportV1Schema).refine(v => new Set(v.map(canonicalWorkflowJson)).size === v.length, "Duplicate effect."),
  agentSlots: z.array(id).refine(v => new Set(v).size === v.length, "Duplicate Agent Slot."),
}).strict();
export const rendererDeclarationV1Schema = z.object({ workflowId: id, resultKind: text,
  payloadSchemaVersion: positive, renderer: sourceExportV1Schema }).strict();

export type RequirementSetV1 = z.infer<typeof requirementSetV1Schema>;
export type ExecutionRequirementsV1 = z.infer<typeof executionRequirementsV1Schema>;
export type WorkflowManifestV1 = z.infer<typeof workflowManifestV1Schema>;
export type WorkflowDeclarationV1 = z.infer<typeof workflowDeclarationV1Schema>;
export type RendererDeclarationV1 = z.infer<typeof rendererDeclarationV1Schema>;
export type SourceBindingV1 = z.infer<typeof sourceBindingV1Schema>;

/** Canonicalizes validated JSON data, never runtime objects or credentials. */
export function canonicalWorkflowJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalWorkflowJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalWorkflowJson(v)}`).join(",")}}`;
  if (value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  throw new Error("Expected JSON data.");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
export function validateWorkflowManifestV1(value: unknown): WorkflowManifestV1 {
  return freeze(workflowManifestV1Schema.parse(value));
}
export function definePortableWorkflowManifest(value: unknown): WorkflowManifestV1 & { workflowMode: "arkimux-portable" } {
  const manifest = validateWorkflowManifestV1(value);
  if (manifest.workflowMode !== "arkimux-portable") throw new Error("Expected arkimux-portable workflowMode.");
  return manifest as WorkflowManifestV1 & { workflowMode: "arkimux-portable" };
}
export function defineNativeWorkflowManifest(value: unknown): WorkflowManifestV1 & { workflowMode: "native-runtime-bound" } {
  const manifest = validateWorkflowManifestV1(value);
  if (manifest.workflowMode !== "native-runtime-bound") throw new Error("Expected native-runtime-bound workflowMode.");
  return manifest as WorkflowManifestV1 & { workflowMode: "native-runtime-bound" };
}
export function workflowManifestDigest(value: unknown): string {
  return createHash("sha256").update(canonicalWorkflowJson(validateWorkflowManifestV1(value))).digest("hex");
}
/** Computes workflow-only minima; does not allocate resources or select a host. */
export function effectiveWorkflowRequirements(value: unknown): RequirementSetV1 {
  const v = executionRequirementsV1Schema.parse(value);
  const sets = [v.run, ...Object.values(v.operations)];
  const resources: NonNullable<RequirementSetV1["resources"]> = {};
  for (const key of ["minCpuMillis", "minMemoryMiB", "minTemporaryDiskMiB"] as const) {
    const minima = sets.flatMap(s => s.resources?.[key] === undefined ? [] : [s.resources[key]!]);
    if (minima.length) resources[key] = Math.max(...minima);
  }
  const features = [...new Set(sets.flatMap(s => s.requiredFeatures ?? []))].sort();
  const arch = sets.flatMap(s => s.architectures ? [s.architectures] : []);
  return freeze({ maxDurationSeconds: v.run.maxDurationSeconds,
    ...(Object.keys(resources).length ? { resources } : {}),
    ...(sets.some(s => s.requiredFeatures !== undefined) ? { requiredFeatures: features } : {}),
    ...(arch.length ? { architectures: arch[0]!.filter(a => arch.every(s => s.includes(a))) } : {}),
  });
}
