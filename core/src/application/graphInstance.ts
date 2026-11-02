import { hashJson, type DeepReadonly } from "./durableWorkflow.ts";
import { graphNodeDetails, validateGraphInstanceAddressStructureV1, type GraphDefinitionV1, type GraphNodeV1 } from "./graphWorkflow.ts";
import { validateRunRef, type RunRef } from "../domain/runIdentity.ts";

/** Each enclosing control names the occurrence containing the next path segment. */
export type GraphInstanceSegmentV1 = {
  nodeId: string;
  occurrence?: { kind: "map" | "reduce"; index: number }
    | { kind: "loop"; iteration: number }
    | { kind: "choice"; case: string }
    | { kind: "subgraph" };
};
export type GraphInstanceAddressV1 = { schemaVersion: 1; path: GraphInstanceSegmentV1[] };

/** Structural address validation only. Entry admission must separately validate boundary/state. */
export function validateGraphInstanceAddressV1(graph: GraphDefinitionV1, value: unknown): DeepReadonly<GraphInstanceAddressV1> {
  return validateGraphInstanceAddressStructureV1(graph, value);
}

/** Attempt number is intentionally absent: retries keep the same instance key. */
export function graphInstanceKeyV1(graph: GraphDefinitionV1, runRef: RunRef, address: GraphInstanceAddressV1 | DeepReadonly<GraphInstanceAddressV1>): string {
  return hashJson({ schemaVersion: 1, runRef: validateRunRef(runRef), declarationSha256: graph.declarationSha256,
    address: validateGraphInstanceAddressV1(graph, address) });
}

export function graphInstanceNodeV1(graph: GraphDefinitionV1, address: GraphInstanceAddressV1 | DeepReadonly<GraphInstanceAddressV1>): GraphNodeV1 {
  const validated = validateGraphInstanceAddressV1(graph, address);
  let scope = graph;
  for (const segment of validated.path) {
    const node = scope.nodes.find((item) => item.id === segment.nodeId)!;
    if (!segment.occurrence) return node;
    if (segment === validated.path.at(-1)) return node;
    const data = graphNodeDetails(node);
    if (data.kind === "choice" && segment.occurrence.kind === "choice") scope = data.cases[segment.occurrence.case];
    else if (data.kind !== "step" && data.kind !== "choice") scope = data.body;
  }
  throw new Error("Graph instance path has no target.");
}
