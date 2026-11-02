import { defineEffectContract, type EffectContractV1 } from "@com-pyvue/agent-execution-core";
import { weatherInputSchema, weatherSnapshotSchema, type WeatherInput, type WeatherSnapshot } from "./contract.js";

/** Workflow-safe effect identity and validators. No host implementation belongs here. */
export const weatherCurrentEffect: EffectContractV1<WeatherInput, WeatherSnapshot> = defineEffectContract({
  schemaVersion: 1, operationId: "weather.current", definitionVersion: "4", safety: "read",
  input: weatherInputSchema, output: weatherSnapshotSchema,
});
