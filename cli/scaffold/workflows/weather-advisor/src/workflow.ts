import { defineStep, defineGraphValue, defineWorkflow, graphRef, graphStep, graphValue, type EffectContractV1, type JsonValue } from "@com-pyvue/agent-execution-core";
import { z } from "zod";
import { weatherInputSchema, weatherSnapshotSchema, weatherResultSchema, recommendationSchema, critiqueSchema, WEATHER_RESULT_KIND, type WeatherInput, type WeatherSnapshot } from "./contract.js";

export function defineWeatherAdvisor(weatherEffect: EffectContractV1<WeatherInput, WeatherSnapshot>) {
  const jsonSchema = (schema: z.ZodType) => z.toJSONSchema(schema) as Record<string, JsonValue>;
  const readWeather = defineStep({
    schemaVersion: 1, id: "read-weather", definitionVersion: "3", input: weatherInputSchema, output: weatherSnapshotSchema,
    execute: (context, input) => context.effects.run(weatherEffect, input).then((output) => structuredClone(output)),
  });
  const recommendationInput = z.object({ city: weatherInputSchema.shape.city, weather: weatherSnapshotSchema }).strict();
  const recommend = defineStep({
    schemaVersion: 1, id: "recommend-clothing", definitionVersion: "2", input: recommendationInput, output: recommendationSchema,
    execute: async (context, input) => recommendationSchema.parse(await context.agents.invoke({ schemaVersion: 1, operationId: "recommendation", slotId: "recommendation", output: recommendationSchema }, input)),
  });
  const critiqueInput = recommendationInput.extend({ recommendation: recommendationSchema }).strict();
  const critique = defineStep({
    schemaVersion: 1, id: "critique-clothing", definitionVersion: "2",
    input: critiqueInput, output: critiqueSchema,
    execute: async (context, input) => critiqueSchema.parse(await context.agents.invoke({ schemaVersion: 1, operationId: "critique", slotId: "critique", output: critiqueSchema }, input)),
  });
  const weather = graphStep({ id: "read-weather", step: readWeather, input: graphRef.workflowInput<WeatherInput>(),
    inputSchema: jsonSchema(weatherInputSchema), outputSchema: jsonSchema(weatherSnapshotSchema) });
  const city = graphValue.field(graphRef.input(weather), "city");
  const recommendation = graphStep({ id: "recommend-clothing", step: recommend,
    input: graphValue.object({ city, weather: graphRef.output(weather) }),
    inputSchema: jsonSchema(recommendationInput), outputSchema: jsonSchema(recommendationSchema) });
  const review = graphStep({ id: "critique-clothing", step: critique,
    input: graphValue.object({ city, weather: graphRef.output(weather), recommendation: graphRef.output(recommendation) }),
    inputSchema: jsonSchema(critiqueInput), outputSchema: jsonSchema(critiqueSchema) });
  const assemble = defineStep({ schemaVersion: 1, id: "assemble-result", definitionVersion: "1",
    input: weatherResultSchema, output: weatherResultSchema,
    async execute(_context, input) { return weatherResultSchema.parse(input); } });
  const result = graphStep({ id: "assemble-result", step: assemble,
    input: graphValue.object({ schemaVersion: graphValue.literal(2 as const), city, weather: graphRef.output(weather),
      recommendation: graphRef.output(recommendation), critique: graphRef.output(review) }),
    inputSchema: jsonSchema(weatherResultSchema), outputSchema: jsonSchema(weatherResultSchema) });
  return defineWorkflow({
    workflow: { kind: "weather-advisor", version: 1 }, workflowContractVersion: "4", resultKind: WEATHER_RESULT_KIND,
    input: defineGraphValue({ version: "1", schema: jsonSchema(weatherInputSchema), validator: weatherInputSchema }),
    nodes: [weather, recommendation, review, result], entry: weather, result,
  });
}
