import { readFile } from "node:fs/promises";
import { RunApiClient } from "@com-pyvue/agent-execution-run-contract";
import { weatherInputSchema } from "../workflows/weather-advisor/src/contract.js";
import { readLocalRuntimeRecord } from "./runtime-record.js";
const runtime = await readLocalRuntimeRecord(process.cwd());
const cityIndex = process.argv.indexOf("--city");
const input = weatherInputSchema.parse(cityIndex >= 0
  ? { schemaVersion: 1, city: process.argv[cityIndex + 1] }
  : JSON.parse(await readFile("workflows/weather-advisor/fixtures/example-input.json", "utf8")));
const response = await new RunApiClient({ baseUrl: runtime.url }).submitRun({
  workflow: { kind: "weather-advisor", version: 1 }, roleId: runtime.roleId,
  runConfigurationId: "weather-advisor-codex-openai-v1",
  input: { schemaVersion: 1, acquisition: "supplied", entry: { kind: "default" }, values: { entry: input } },
});
console.log(JSON.stringify({ executionId: response.runRef.executionId, next: `npm run weather:result -- --run ${response.runRef.executionId}`, url: `${runtime.url}/runs/${response.runRef.executionId}` }, null, 2));
