import { RunApiClient } from "@com-pyvue/agent-execution-run-contract";
import { GRAPH_RESULT_KIND, graphResultSchema } from "../workflows/graph-invocation/src/contract.js";
import { readLocalRuntimeRecord } from "./runtime-record.js";

const index = process.argv.indexOf("--run"), id = process.argv[index + 1];
if (index < 0 || !id || id.startsWith("--")) throw new Error("Use --run <execution-id>.");
const runtime = await readLocalRuntimeRecord(process.cwd()), client = new RunApiClient({ baseUrl: runtime.url });
const deadline = Date.now() + 60_000;
for (;;) {
  const response = await client.getRun(id);
  if (response.run.status?.status === "failed") throw new Error(response.run.status.message);
  if (response.run.status?.status === "cancelled") throw new Error("The Run was cancelled.");
  if (response.run.status?.status === "complete") break;
  if (Date.now() >= deadline) throw new Error("Run did not finish within one minute.");
  await new Promise(resolve => setTimeout(resolve, 200));
}
const reference = (await client.listResults(id)).items.find(item => item.resultKind === GRAPH_RESULT_KIND);
if (!reference) throw new Error("No Graph Invocation result was published.");
const result = await client.getResult(id, reference.resultId);
console.log(JSON.stringify({ executionId: id, resultKind: result.resultKind, payload: graphResultSchema.parse(result.payload) }, null, 2));
