import { immutableJson, type DeepReadonly, type JsonValue } from "./durableWorkflow.ts";
import { graphBindingExpression, type GraphBindingV1 } from "./graphBindings.ts";
import { graphNodeDetails, type GraphDefinitionV1, type GraphNodeV1 } from "./graphWorkflow.ts";
import { describeGraphEntryV1, type GraphEntrySelectionV1 } from "./graphInvocation.ts";
import type { GraphInstanceSegmentV1 } from "./graphInstance.ts";

export interface GraphDescriptionV1 {
  schemaVersion: 1;
  declarationSha256: string;
  rootScopeId: string;
  scopes: { id: string; title: string; parentNodeId?: string; inputNodeId: string; entryNodeId: string; resultNodeId: string }[];
  nodes: { id: string; scopeId: string; nodeId: string; title: string;
    kind: GraphNodeV1["kind"] | "input"; inputSchema: Record<string, JsonValue>; outputSchema: Record<string, JsonValue>;
    bodyScopeIds: string[] }[];
  edges: { id: string; scopeId: string; source: string; target: string; kind: "data" | "order";
    sourcePort: "input" | "output"; sourcePath: (string | number)[]; targetPath: (string | number)[] }[];
}

export interface GraphEntryPresentationV1 {
  selectedNodeId: string;
  scopes: { scopeId: string; activeNodeIds: string[] }[];
  requirementTargets: { requirementId: string; nodeId: string; port: "input" | "output" | "state" }[];
}

const nodeId = (scope: string, id: string) => `${scope}/node/${encodeURIComponent(id)}`;
const bodyId = (id: string, choice?: string) => `${id}/body${choice === undefined ? "" : `/${encodeURIComponent(choice)}`}`;
const title = (id: string) => id.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/[._-]+/g, " ")
  .replace(/^./, character => character.toUpperCase());

/** Reads SDK bindings only. Never executes steps, validators, selectors or loop conditions.
 * Literal values and callback source are deliberately absent from the presentation. */
export function describeGraphV1(graph: GraphDefinitionV1): DeepReadonly<GraphDescriptionV1> {
  const result: GraphDescriptionV1 = { schemaVersion: 1, declarationSha256: graph.declarationSha256,
    rootScopeId: "root", scopes: [], nodes: [], edges: [] };
  function scope(current: GraphDefinitionV1, id: string, scopeTitle: string, parentNodeId?: string) {
    const inputNodeId = `${id}/input`;
    result.scopes.push({ id, title: scopeTitle, ...(parentNodeId ? { parentNodeId } : {}), inputNodeId,
      entryNodeId: nodeId(id, current.entry.id), resultNodeId: nodeId(id, current.result.id) });
    result.nodes.push({ id: inputNodeId, scopeId: id, nodeId: "$input", title: "Scope input", kind: "input",
      inputSchema: current.input.schema, outputSchema: current.input.schema, bodyScopeIds: [] });
    for (const node of [...current.nodes].sort((a, b) => a.id.localeCompare(b.id))) {
      const fullId = nodeId(id, node.id), data = graphNodeDetails(node), bodies: string[] = [];
      if (data.kind === "choice") {
        for (const [name, body] of Object.entries(data.cases).sort(([a], [b]) => a.localeCompare(b))) {
          const nested = bodyId(fullId, name); bodies.push(nested); scope(body, nested, title(name), fullId);
        }
      } else if (data.kind !== "step") {
        const nested = bodyId(fullId); bodies.push(nested); scope(data.body, nested, `${title(node.id)} body`, fullId);
      }
      result.nodes.push({ id: fullId, scopeId: id, nodeId: node.id, title: title(node.id), kind: node.kind,
        inputSchema: node.inputContract.schema, outputSchema: node.outputContract.schema, bodyScopeIds: bodies });
      function edge(source: string, sourcePort: "input" | "output", sourcePath: (string | number)[], targetPath: (string | number)[], kind: "data" | "order" = "data") {
        result.edges.push({ id: `edge-${result.edges.length}`, scopeId: id, source, target: fullId, kind, sourcePort, sourcePath, targetPath });
      }
      function binding(value: GraphBindingV1<JsonValue>, targetPath: (string | number)[] = [], sourcePath: (string | number)[] = []) {
        const expression = graphBindingExpression(value);
        switch (expression.kind) {
          case "literal": return;
          case "scope-input": edge(inputNodeId, "output", sourcePath, targetPath); return;
          case "node-input": case "node-output": edge(nodeId(id, expression.node.id), expression.kind === "node-input" ? "input" : "output", sourcePath, targetPath); return;
          case "field": binding(expression.source, targetPath, [expression.key, ...sourcePath]); return;
          case "object":
            // Resolving a constructed object evaluates every member before a
            // field is selected. Preserve those dependencies as the scheduler does.
            for (const [key, child] of Object.entries(expression.fields).sort(([a], [b]) => a.localeCompare(b))) {
              binding(child, sourcePath.length ? targetPath : [...targetPath, key],
                sourcePath.length && String(sourcePath[0]) === key ? sourcePath.slice(1) : []);
            }
            return;
          case "array":
            expression.items.forEach((child, index) => binding(child, sourcePath.length ? targetPath : [...targetPath, index],
              sourcePath.length && Number(sourcePath[0]) === index ? sourcePath.slice(1) : []));
        }
      }
      binding(data.binding);
      for (const dependency of [...data.after].sort((a, b) => a.id.localeCompare(b.id))) edge(nodeId(id, dependency.id), "output", [], [], "order");
    }
  }
  scope(graph, "root", title(graph.id));
  return immutableJson(result as unknown as JsonValue) as unknown as DeepReadonly<GraphDescriptionV1>;
}

function scopeFor(path: readonly DeepReadonly<GraphInstanceSegmentV1>[]): string {
  return path.reduce((scope, part) => bodyId(nodeId(scope, part.nodeId), part.occurrence?.kind === "choice" ? part.occurrence.case : undefined), "root");
}
function targetFor(path: readonly DeepReadonly<GraphInstanceSegmentV1>[]): string {
  return nodeId(scopeFor(path.slice(0, -1)), path.at(-1)!.nodeId);
}

/** Uses the execution planner so the diagram does not invent a second scheduling model. */
export function describeGraphEntryPresentationV1(graph: GraphDefinitionV1, selection: GraphEntrySelectionV1): DeepReadonly<GraphEntryPresentationV1> {
  const plan = describeGraphEntryV1(graph, selection);
  const result: GraphEntryPresentationV1 = {
    selectedNodeId: targetFor(plan.entry.path),
    scopes: plan.continuation.map(scope => ({ scopeId: scopeFor(scope.scopePath),
      activeNodeIds: scope.nodeIds.map(id => nodeId(scopeFor(scope.scopePath), id)) })),
    requirementTargets: plan.requirements.map(requirement => ({ requirementId: requirement.id,
      nodeId: requirement.address ? targetFor(requirement.address.path) : "root/input",
      port: requirement.role === "skipped-node-output" ? "output" : ["map-completed-outputs", "reduce-accumulator", "loop-iteration"].includes(requirement.role) ? "state" : "input" })),
  };
  return immutableJson(result as unknown as JsonValue) as unknown as DeepReadonly<GraphEntryPresentationV1>;
}
