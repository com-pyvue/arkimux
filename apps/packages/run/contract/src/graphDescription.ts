import { z } from "zod";
import { jsonValueSchema } from "./schemas.ts";

const id = z.string().min(1);
const schema = z.record(z.string(), jsonValueSchema);
export const graphDescriptionSchema = z.object({
  schemaVersion: z.literal(1), declarationSha256: z.string().regex(/^[a-f0-9]{64}$/), rootScopeId: id,
  scopes: z.array(z.object({ id, title: id, parentNodeId: id.optional(), inputNodeId: id, entryNodeId: id, resultNodeId: id }).strict()),
  nodes: z.array(z.object({ id, scopeId: id, nodeId: id, title: id,
    kind: z.enum(["step", "subgraph", "map", "reduce", "loop", "choice", "input"]),
    inputSchema: schema, outputSchema: schema, bodyScopeIds: z.array(id) }).strict()),
  edges: z.array(z.object({ id, scopeId: id, source: id, target: id, kind: z.enum(["data", "order"]),
    sourcePort: z.enum(["input", "output"]), sourcePath: z.array(z.union([z.string(), z.number()])),
    targetPath: z.array(z.union([z.string(), z.number()])) }).strict()),
}).strict();
export const graphEntryPresentationSchema = z.object({
  selectedNodeId: id,
  scopes: z.array(z.object({ scopeId: id, activeNodeIds: z.array(id) }).strict()),
  requirementTargets: z.array(z.object({ requirementId: id, nodeId: id, port: z.enum(["input", "output", "state"]) }).strict()),
}).strict();
export type GraphDescriptionDto = z.infer<typeof graphDescriptionSchema>;
export type GraphEntryPresentationDto = z.infer<typeof graphEntryPresentationSchema>;
