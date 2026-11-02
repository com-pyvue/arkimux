import { RunApiClient } from "@com-pyvue/agent-execution-run-contract";
import { WEATHER_RESULT_KIND, readableWeatherResultSchema } from "../workflows/weather-advisor/src/contract.js";
import { readLocalRuntimeRecord } from "./runtime-record.js";
const id = process.argv[process.argv.indexOf("--run") + 1];
if (!process.argv.includes("--run") || !id || id.startsWith("--")) throw new Error("Use --run <execution-id>.");
const runtime = await readLocalRuntimeRecord(process.cwd());
const client = new RunApiClient({ baseUrl: runtime.url });
const deadline = Date.now() + 600_000;
for (;;) {
  const response = await client.getRun(id);
  if (response.run.status?.status === "failed") throw new Error(response.run.status.message);
  if (response.run.status?.status === "cancelled") throw new Error("The Run was cancelled.");
  if (response.run.status?.status === "complete") break;
  if (Date.now() >= deadline) throw new Error("Run did not finish within ten minutes.");
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const reference = (await client.listResults(id)).items.find((item) => item.resultKind === WEATHER_RESULT_KIND);
if (!reference) throw new Error("No Weather Advisor result was published.");
const result = await client.getResult(id, reference.resultId);
const payload = readableWeatherResultSchema.parse(result.payload);
console.log(JSON.stringify({ executionId: id, resultKind: result.resultKind, payload, configuration: await client.getResolvedConfiguration(id) }, null, 2));
