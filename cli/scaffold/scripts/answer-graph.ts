import { RunApiClient } from "@com-pyvue/agent-execution-run-contract";
import { readLocalRuntimeRecord } from "./runtime-record.js";
import { graphFixtureEntryFromAddress, graphFixtureValues } from "./graph-fixture.js";

const index = process.argv.indexOf("--run"), id = process.argv[index + 1];
if (index < 0 || !id || id.startsWith("--")) throw new Error("Use --run <execution-id>.");
const runtime = await readLocalRuntimeRecord(process.cwd()), client = new RunApiClient({ baseUrl: runtime.url });
const requests = await client.listInputRequests(id);
const request = requests.items.find(item => item.status === "pending");
if (!request || !("kind" in request) || request.kind !== "graph-entry") throw new Error("The Run has no pending graph input request.");
const entry = graphFixtureEntryFromAddress(request.entry.path);
await client.submitInputResponse(id, request.requestId, {
  submissionId: `fixture-${Date.now()}`, expectedRevision: request.revision,
  response: { schemaVersion: 1, planSha256: request.planSha256, values: await graphFixtureValues(entry) },
});
console.log(JSON.stringify({ executionId: id, entry, next: `npm run graph:result -- --run ${id}`, url: `${runtime.url}/runs/${id}` }, null, 2));
