import { z } from "zod";
import type { RetainedConstructionContextV1 } from "@com-pyvue/agent-execution-core";
import { defineWeatherAdvisor } from "./workflow.js";
import { weatherCurrentEffect } from "./weather-effect-contract.js";
import { recommendationSchema, critiqueSchema } from "./contract.js";

/** Runs only in the retained worker, using pinned prompt assets and no host configuration. */
export function constructWeatherAdvisor(context: RetainedConstructionContextV1) {
  const prompt = (name: string) => new TextDecoder().decode(context.readAsset(`workflows/weather-advisor/prompts/${name}.md`));
  return {
    graph: defineWeatherAdvisor(weatherCurrentEffect),
    agentPrompts: {
      recommendation: `${prompt("recommendation")}\nRecommendation schema:\n${JSON.stringify(z.toJSONSchema(recommendationSchema))}`,
      critique: `${prompt("critique")}\nCritique schema:\n${JSON.stringify(z.toJSONSchema(critiqueSchema))}`,
    },
  };
}
