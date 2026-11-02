import {
  immutableJson, type DeepReadonly, type JsonValue,
} from "./durableWorkflow.ts";
import { inputWaitJsonSnapshot } from "./inputWait.ts";
import { graphPrivateWeakMap } from "./graphPrivateRegistry.ts";

/** Expressions are constructed by these helpers, never inferred by running code. */
export interface GraphBindingV1<T extends JsonValue> {
  readonly kind: "graph-binding";
  /** Type-only output marker. */
  readonly valueType?: T;
}
export interface GraphReferenceNodeV1<I extends JsonValue, O extends JsonValue> {
  readonly id: string;
  readonly input: { readonly parse: (value: unknown) => I };
  readonly output: { readonly parse: (value: unknown) => O };
}
export type GraphBindingExpressionV1 =
  | { readonly kind: "literal"; readonly value: DeepReadonly<JsonValue> }
  | { readonly kind: "scope-input" }
  | { readonly kind: "node-input" | "node-output"; readonly node: GraphReferenceNodeV1<JsonValue, JsonValue> }
  | { readonly kind: "field"; readonly source: GraphBindingV1<JsonValue>; readonly key: string | number; readonly fallback?: DeepReadonly<JsonValue> }
  | { readonly kind: "object"; readonly fields: Readonly<Record<string, GraphBindingV1<JsonValue>>> }
  | { readonly kind: "array"; readonly items: readonly GraphBindingV1<JsonValue>[] };

const expressions = graphPrivateWeakMap<GraphBindingExpressionV1>("binding-expressions");
function binding<T extends JsonValue>(expression: GraphBindingExpressionV1): GraphBindingV1<T> {
  const result = Object.freeze({ kind: "graph-binding" as const });
  expressions.set(result, Object.freeze(expression));
  return result;
}
/** Internal compiler view. Rejects forged or cross-version binding objects. */
export function graphBindingExpression(value: GraphBindingV1<JsonValue>): GraphBindingExpressionV1 {
  const expression = value && expressions.get(value);
  if (!expression) throw new Error("Use graph binding helpers to declare input bindings.");
  return expression;
}

export const graphRef = Object.freeze({
  /** Inside a control body this is that body's explicit input, not its parent. */
  workflowInput<T extends JsonValue>(): GraphBindingV1<T> {
    return binding<T>({ kind: "scope-input" });
  },
  input<I extends JsonValue, O extends JsonValue>(node: GraphReferenceNodeV1<I, O>): GraphBindingV1<I> {
    return binding<I>({ kind: "node-input", node });
  },
  output<I extends JsonValue, O extends JsonValue>(node: GraphReferenceNodeV1<I, O>): GraphBindingV1<O> {
    return binding<O>({ kind: "node-output", node });
  },
});

export const graphValue = Object.freeze({
  literal<T extends JsonValue>(value: T): GraphBindingV1<T> {
    return binding<T>({ kind: "literal", value: immutableJson(inputWaitJsonSnapshot(value)) });
  },
  object<T extends Record<string, JsonValue>>(fields: { readonly [K in keyof T]: GraphBindingV1<T[K]> }): GraphBindingV1<T> {
    for (const value of Object.values(fields)) graphBindingExpression(value);
    return binding<T>({ kind: "object", fields: Object.freeze({ ...fields }) });
  },
  array<T extends JsonValue>(items: readonly GraphBindingV1<T>[]): GraphBindingV1<T[]> {
    items.forEach(graphBindingExpression);
    return binding<T[]>({ kind: "array", items: Object.freeze([...items]) });
  },
  field<T extends JsonValue, K extends keyof T & (string | number)>(
    source: GraphBindingV1<T>, key: K, options?: { readonly fallback: Extract<T[K], JsonValue> },
  ): GraphBindingV1<Extract<T[K], JsonValue>> {
    graphBindingExpression(source);
    if (typeof key !== "string" && !(typeof key === "number" && Number.isSafeInteger(key) && key >= 0)) {
      throw new Error("Graph field paths require a property name or non-negative integer index.");
    }
    return binding({ kind: "field", source, key,
      ...(options ? { fallback: immutableJson(inputWaitJsonSnapshot(options.fallback)) } : {}) });
  },
});

export interface GraphBindingValuesV1 {
  readonly input: JsonValue;
  /** Only successfully completed instances belong here. Not pending/failed nodes. */
  readonly completed: ReadonlyMap<string, { readonly input?: JsonValue; readonly output?: JsonValue }>;
}
/** Pure binding evaluation over execution-owned JSON. Never invokes workflow bodies. */
export function resolveGraphBindingV1<T extends JsonValue>(
  value: GraphBindingV1<T>, values: GraphBindingValuesV1,
): DeepReadonly<T> {
  // Snapshot JSON before reading fields. Only execution-owned JSON is accepted.
  const scope = immutableJson(inputWaitJsonSnapshot(values.input)) as JsonValue;
  const resolve = (current: GraphBindingV1<JsonValue>): JsonValue => {
    const expression = graphBindingExpression(current);
    switch (expression.kind) {
      case "literal": return expression.value as JsonValue;
      case "scope-input": return scope;
      case "node-input": case "node-output": {
        const completed = values.completed.get(expression.node.id);
        if (!completed) throw new Error(`Graph dependency ${expression.node.id} has not succeeded.`);
        const field = expression.kind === "node-input" ? "input" : "output";
        if (!Object.hasOwn(completed, field)) throw new Error(`Graph dependency ${expression.node.id} has no supplied ${field}.`);
        return immutableJson(inputWaitJsonSnapshot(completed[field])) as JsonValue;
      }
      case "field": {
        const source = resolve(expression.source);
        if (source !== null && typeof source === "object" && Object.hasOwn(source, expression.key)) {
          return (source as Record<string | number, JsonValue>)[expression.key];
        }
        if (Object.hasOwn(expression, "fallback")) return expression.fallback as JsonValue;
        throw new Error(`Graph input field ${String(expression.key)} is missing.`);
      }
      case "object": return Object.fromEntries(Object.entries(expression.fields).map(([key, item]) => [key, resolve(item)]));
      case "array": return expression.items.map(resolve);
    }
  };
  return immutableJson(resolve(value)) as DeepReadonly<T>;
}
