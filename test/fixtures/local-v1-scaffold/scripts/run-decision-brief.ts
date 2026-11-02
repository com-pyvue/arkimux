import { readFile } from "node:fs/promises";
import path from "node:path";
import { RunApiClient } from "@com-pyvue/agent-execution-run-contract";
import { validateDecisionBriefInput } from "../workflows/decision-brief/src/contract.js";
import { readLocalRuntimeRecord } from "./runtime-record.js";

const repositoryRoot = process.cwd();
const runtime = await readLocalRuntimeRecord(repositoryRoot);
const inputPath = path.resolve(repositoryRoot, option("--input") ?? "workflows/decision-brief/fixtures/example-input.json");
const input = validateDecisionBriefInput(JSON.parse(await readFile(inputPath, "utf8")));
const client = new RunApiClient({ baseUrl: runtime.url });
const response = await client.submitRun({
  workflow: { kind: "decision-brief", version: 1 },
  roleId: runtime.roleId,
  runConfigurationId: "decision-brief-codex-native-v1",
  input,
});
console.log(JSON.stringify({
  executionId: response.runRef.executionId,
  api: runtime.url,
  next: `npm run decision-brief:result -- --run ${response.runRef.executionId}`,
}, null, 2));

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}
