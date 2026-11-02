/** Internal retained-execution contract. Initial execution and replay share it. */
import { z } from "zod";
import { immutableJson, type DeepReadonly, type EffectAdapterV1, type JsonValue } from "./durableWorkflow.ts";
import { assertInvocationMatchesDefinition, type DurableWorkflowDefinitionV1, type WorkflowInvocationV1 } from "./durableWorkflowInvocation.ts";
import { validateGraphRunInvocationV1, type GraphRunInvocationV1 } from "./graphInvocationRecords.ts";
import type { GraphWorkflowV1 } from "./graphWorkflow.ts";
import { inputWaitJsonSnapshot, type WorkflowExecutionContextV2 } from "./inputWait.ts";

export const constructionDescriptorFile = "construction.json";
const constructionDescriptorV1Schema = z.strictObject({
  schemaVersion: z.literal(1), export: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
  invocationModel: z.enum(["workflow-input", "graph-entry"]).optional(),
});
const adapterExport = z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
const constructionDescriptorV2Schema = z.strictObject({
  schemaVersion: z.literal(2), export: adapterExport,
  effectAdapterEntryPoint: z.literal("effect-adapters.mjs"),
  effectAdapters: z.array(adapterExport).min(1).refine(values => new Set(values).size === values.length, "Duplicate effect adapter export."),
  invocationModel: z.enum(["workflow-input", "graph-entry"]).optional(),
});
export const constructionDescriptorSchema = z.union([constructionDescriptorV1Schema, constructionDescriptorV2Schema]);
export const retainedAgentPromptsSchema = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.string());
export interface RetainedConstructionContextV1 {
  readonly runConfiguration: DeepReadonly<JsonValue>;
  /** Only declared assets in the retained build; each read returns a fresh copy. */
  readAsset(path: string): Uint8Array;
}
/** Host-only adapter setup. These values never enter retained workflow construction or the workflow worker. */
export interface EffectAdapterFactoryContextV1 {
  readonly environment: Readonly<Record<string, string>>;
  readonly credentials: Readonly<Record<string, string>>;
  readonly runConfiguration: DeepReadonly<JsonValue>;
}
export type RetainedEffectAdapterFactoryV1 = (context: EffectAdapterFactoryContextV1) =>
  EffectAdapterV1<JsonValue, JsonValue> | Promise<EffectAdapterV1<JsonValue, JsonValue>>;
export interface ConstructedRetainedWorkflowV1 {
  readonly workflow: Omit<DurableWorkflowDefinitionV1, "execute"> & {
    execute(context: WorkflowExecutionContextV2, input: DeepReadonly<JsonValue>): Promise<JsonValue>;
  };
  readonly agentPrompts: Readonly<Record<string, string>>;
}
export type RetainedWorkflowConstructorV1 = (context: RetainedConstructionContextV1) =>
  ConstructedRetainedWorkflowV1 | Promise<ConstructedRetainedWorkflowV1>;
export interface ConstructedRetainedGraphWorkflowV1 {
  readonly graph: GraphWorkflowV1;
  readonly agentPrompts: Readonly<Record<string, string>>;
}
export type RetainedGraphWorkflowConstructorV1 = (context: RetainedConstructionContextV1) =>
  ConstructedRetainedGraphWorkflowV1 | Promise<ConstructedRetainedGraphWorkflowV1>;

/** Call only in the isolated worker, once per attempt. No alternate live factory. */
export async function constructRetainedWorkflow(options: {
  module: Record<string, unknown>; descriptor: unknown; invocation: WorkflowInvocationV1;
  runConfiguration: JsonValue;
  assets: Record<string, Uint8Array>;
}): Promise<ConstructedRetainedWorkflowV1> {
  const { factory, context } = retainedFactory(options);
  const result = await (factory as RetainedWorkflowConstructorV1)(context);
  const workflow = result?.workflow;
  if (!workflow || typeof workflow.execute !== "function" || typeof workflow.input?.parse !== "function"
    || typeof workflow.output?.parse !== "function") throw new Error("Retained construction returned an invalid workflow.");
  assertInvocationMatchesDefinition(options.invocation, workflow);
  const agentPrompts = Object.freeze(retainedAgentPromptsSchema.parse(result.agentPrompts));
  return { workflow, agentPrompts };
}

/** Graph construction uses the same retained export and immutable inputs as the
 * existing workflow path. The retained invocation pins the exact graph digest. */
export async function constructRetainedGraphWorkflow(options: {
  module: Record<string, unknown>; descriptor: unknown; invocation: GraphRunInvocationV1;
  runConfiguration: JsonValue;
  assets: Record<string, Uint8Array>;
}): Promise<ConstructedRetainedGraphWorkflowV1> {
  const result = await constructRetainedGraphDefinition(options);
  validateGraphRunInvocationV1(result.graph, options.invocation);
  return result;
}

/** Admission-only graph construction. Call only in the isolated worker before
 * the immutable invocation exists. */
export async function constructRetainedGraphDefinition(options: {
  module: Record<string, unknown>; descriptor: unknown;
  runConfiguration: JsonValue;
  assets: Record<string, Uint8Array>;
}): Promise<ConstructedRetainedGraphWorkflowV1> {
  const { factory, context } = retainedFactory(options);
  const result = await (factory as RetainedGraphWorkflowConstructorV1)(context);
  const graph = result?.graph;
  if (!graph || graph.kind !== "graph-definition" || graph.schemaVersion !== 1) {
    throw new Error("Retained construction returned an invalid graph workflow.");
  }
  const agentPrompts = Object.freeze(retainedAgentPromptsSchema.parse(result.agentPrompts));
  return { graph, agentPrompts };
}

function retainedFactory(options: {
  module: Record<string, unknown>; descriptor: unknown;
  runConfiguration: JsonValue;
  assets: Record<string, Uint8Array>;
}): { factory: (context: RetainedConstructionContextV1) => unknown; context: RetainedConstructionContextV1 } {
  const descriptor = constructionDescriptorSchema.parse(options.descriptor);
  const factory = Object.hasOwn(options.module, descriptor.export) && options.module[descriptor.export];
  if (typeof factory !== "function") throw new Error("Retained construction export must be a function.");
  const context: RetainedConstructionContextV1 = Object.freeze({
    runConfiguration: immutableJson(inputWaitJsonSnapshot(options.runConfiguration)),
    readAsset(name: string) {
      if (!Object.hasOwn(options.assets, name)) throw new Error("Asset was not declared in this retained build.");
      return Uint8Array.from(options.assets[name]);
    },
  });
  return { factory: factory as (context: RetainedConstructionContextV1) => unknown, context };
}
