import { RunApiClient } from "@com-pyvue/agent-execution-run-contract";
import { DECISION_BRIEF_RESULT_KIND, validateDecisionBriefResult } from "../workflows/decision-brief/src/contract.js";
import { readLocalRuntimeRecord } from "./runtime-record.js";

const executionId = option("--run");
if (!executionId) throw new Error("--run <execution-id> is required.");
const runtime = await readLocalRuntimeRecord(process.cwd());
const client = new RunApiClient({ baseUrl: option("--api") ?? runtime.url });
const run = await waitForTerminalRun(client, executionId);
if (run.run.status?.status !== "complete") {
  const status = run.run.status;
  const message = status?.status === "failed" ? status.message : "no failure message";
  throw new Error(`Run ${executionId} ended with ${status?.status ?? "unknown"}: ${message}`);
}
const listed = await client.listResults(executionId);
const reference = listed.items.find(({ resultKind }) => resultKind === DECISION_BRIEF_RESULT_KIND);
if (!reference) throw new Error(`Run ${executionId} has no ${DECISION_BRIEF_RESULT_KIND}.`);
const [result, resolvedConfiguration] = await Promise.all([
  client.getResult(executionId, reference.resultId),
  client.getResolvedConfiguration(executionId),
]);
const payload = validateDecisionBriefResult(result.payload);
const configuration = resolvedConfiguration.resolvedConfiguration as {
  configurationId?: string;
  agents?: Record<string, { execution?: { provider?: string; authProvider?: string; parameters?: { model?: string } } }>;
};
const slot = configuration.agents?.["decision-author"]?.execution;
console.log(JSON.stringify({
  executionId,
  workflow: run.run.workflow,
  lifecycle: run.run.status,
  configuration: {
    configurationId: configuration.configurationId,
    contentHash: run.run.runConfiguration?.contentHash,
  },
  agentSlots: [{
    slotId: "decision-author",
    runtimeProvider: slot?.provider,
    authProvider: slot?.authProvider,
    model: slot?.parameters?.model,
  }],
  result: {
    resultId: result.resultId,
    resultKind: result.resultKind,
    envelopeSchemaVersion: result.envelopeSchemaVersion,
    payloadSchemaVersion: payload.schemaVersion,
    payload,
  },
}, null, 2));

async function waitForTerminalRun(client: RunApiClient, id: string) {
  const deadline = Date.now() + 12 * 60_000;
  while (Date.now() < deadline) {
    const run = await client.getRun(id);
    if (run.run.status?.status === "complete" || run.run.status?.status === "failed"
      || run.run.status?.status === "cancelled") return run;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Run ${id} did not finish within 12 minutes.`);
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}
