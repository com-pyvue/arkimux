import { RunApiClient } from "@com-pyvue/agent-execution-run-contract";
import type { JsonValue } from "@com-pyvue/agent-execution-core";
import { readLocalRuntimeRecord } from "./runtime-record.js";
import { graphFixtureSelection, graphFixtureValues, type GraphFixtureEntry } from "./graph-fixture.js";

const value = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const entry = (value("--entry") ?? "step1") as GraphFixtureEntry;
if (!(["step1", "step2", "map-item-1"] as string[]).includes(entry)) throw new Error("Use --entry step1, step2, or map-item-1.");
const deferred = process.argv.includes("--deferred");
const runtime = await readLocalRuntimeRecord(process.cwd());
const input: JsonValue = deferred
  ? { schemaVersion: 1 as const, acquisition: "deferred" as const, entry: graphFixtureSelection(entry), wait: { duration: "1d" as const } }
  : { schemaVersion: 1 as const, acquisition: "supplied" as const, entry: graphFixtureSelection(entry), values: await graphFixtureValues(entry) };
const response = await new RunApiClient({ baseUrl: runtime.url }).submitRun({
  workflow: { kind: "graph-invocation", version: 1 }, roleId: runtime.roleId,
  runConfigurationId: "graph-invocation-local-v1", input,
});
const id = response.runRef.executionId;
console.log(JSON.stringify({ executionId: id, entry, mode: deferred ? "deferred" : "supplied",
  next: deferred ? `npm run graph:answer -- --run ${id}` : `npm run graph:result -- --run ${id}`,
  url: `${runtime.url}/runs/${id}` }, null, 2));
