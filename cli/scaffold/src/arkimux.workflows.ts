import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { definePortableWorkflowManifest } from "@com-pyvue/agent-execution-core";
import { createLocalGraphWorkflow, validateWorkflowEnvironmentDeclaration } from "@com-pyvue/agent-execution-local";
import { weatherInputSchema, weatherResultSchema, WEATHER_RESULT_KIND, recommendationSchema, critiqueSchema } from "../workflows/weather-advisor/src/contract.js";
import { graphInputSchema, graphResultSchema, GRAPH_RESULT_KIND } from "../workflows/graph-invocation/src/contract.js";

/** Public project-level registry loaded by `arkimux local start`. */
export const workflowDeclarations = [{
  manifest: "workflows/weather-advisor/manifest.json",
  environment: "workflows/weather-advisor/environment.json",
  definition: { file: "workflows/weather-advisor/src/workflow.ts", export: "defineWeatherAdvisor" },
  inputValidator: { file: "workflows/weather-advisor/src/contract.ts", export: "weatherInputSchema" },
  resultValidator: { file: "workflows/weather-advisor/src/contract.ts", export: "weatherResultSchema" },
  result: { kind: "weather-advisor.result", schemaVersion: 2 },
  effects: [{ file: "workflows/weather-advisor/src/weather-effect.ts", export: "createWeatherEffect" }],
  agentSlots: ["recommendation", "critique"],
  construction: { file: "workflows/weather-advisor/src/construction.ts", export: "constructWeatherAdvisor",
    assets: ["workflows/weather-advisor/prompts/recommendation.md", "workflows/weather-advisor/prompts/critique.md"], invocationModel: "graph-entry" },
}, {
  manifest: "workflows/graph-invocation/manifest.json",
  environment: "workflows/graph-invocation/environment.json",
  definition: { file: "workflows/graph-invocation/src/workflow.ts", export: "defineGraphInvocationWorkflow" },
  inputValidator: { file: "workflows/graph-invocation/src/contract.ts", export: "graphInputSchema" },
  resultValidator: { file: "workflows/graph-invocation/src/contract.ts", export: "graphResultSchema" },
  result: { kind: "graph-invocation.result", schemaVersion: 1 },
  effects: [],
  agentSlots: [],
  construction: { file: "workflows/graph-invocation/src/workflow.ts", export: "constructGraphInvocationWorkflow", assets: [], invocationModel: "graph-entry" },
}];

export async function loadProjectWorkflows(repositoryRoot: string = process.cwd()) {
  const root = path.resolve(repositoryRoot);
  const file = (relative: string) => readFile(path.join(root, "workflows/weather-advisor", relative), "utf8");
  const graphFile = (relative: string) => readFile(path.join(root, "workflows/graph-invocation", relative), "utf8");
  return [await createLocalGraphWorkflow({
    repositoryRoot: root, workflow: { kind: "weather-advisor", version: 1 },
    title: "Weather Advisor", description: "Read the weather, recommend clothing, and review the advice.",
    input: weatherInputSchema, output: weatherResultSchema, inputExample: weatherInputSchema.parse(JSON.parse(await file("fixtures/example-input.json"))),
    environment: validateWorkflowEnvironmentDeclaration(JSON.parse(await file("environment.json"))),
    environmentFile: workflowDeclarations[0].environment,
    resultSchemaVersion: workflowDeclarations[0].result.schemaVersion,
    manifest: definePortableWorkflowManifest(JSON.parse(await file("manifest.json"))),
    workflowContractVersion: "4", resultKind: WEATHER_RESULT_KIND,
    agentSlots: [
      { slotId: "recommendation", title: "Recommendation", description: "Recommend clothing for this weather.", prompt: `${await file("prompts/recommendation.md")}\nRecommendation schema:\n${JSON.stringify(z.toJSONSchema(recommendationSchema))}` },
      { slotId: "critique", title: "Critique", description: "Review the clothing advice.", prompt: `${await file("prompts/critique.md")}\nCritique schema:\n${JSON.stringify(z.toJSONSchema(critiqueSchema))}` },
    ],
    maxDurationMs: 540_000, finalizationReserveMs: 50_000,
  }), await createLocalGraphWorkflow({
    repositoryRoot: root, workflow: { kind: "graph-invocation", version: 1 },
    title: "Graph Invocation", description: "Try supplied or deferred input at Step 1, Step 2, and graph controls.",
    input: graphInputSchema, output: graphResultSchema,
    inputExample: graphInputSchema.parse(JSON.parse(await graphFile("fixtures/example-input.json"))),
    environment: validateWorkflowEnvironmentDeclaration(JSON.parse(await graphFile("environment.json"))),
    environmentFile: workflowDeclarations[1].environment,
    workflowContractVersion: "1", resultKind: GRAPH_RESULT_KIND, resultSchemaVersion: 1,
    manifest: definePortableWorkflowManifest(JSON.parse(await graphFile("manifest.json"))),
    agentSlots: [], maxDurationMs: 60_000, finalizationReserveMs: 5_000,
  })];
}
