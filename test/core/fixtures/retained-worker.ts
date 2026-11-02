import { FileRetainedExecutionStoreV1 } from "../../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
const store = await FileRetainedExecutionStoreV1.open(process.argv[2]);
const ref = { executionId: "crash-run" };
const requirements = { node: "22.19.0" };
const build = await store.publishBuild({ inputSha256: "a".repeat(64), entryPoint: "entry.mjs", files: { "entry.mjs": Buffer.from("export const value = 1;") }, hostRequirements: requirements });
await store.createRun(ref, { id: "binding", buildSha256: build.buildSha256, workflow: {}, invocation: {}, runConfiguration: {}, executionProfile: {}, nonSecretEnvironment: {}, credentialReferences: [], hostRequirements: requirements });
const owner = await store.claim(ref, "attempt-1", requirements, process.argv[3] === "accounted"
  ? { totalMs: 900_000, attemptMs: 600_000, finalizationReserveMs: 1000 } : undefined);
const request = await store.openRequest(ref, owner, { stepId: "ask", title: "Answer", expiresAfter: "1h", form: { schemaVersion: 1, id: "form", version: "v1", fields: [] } });
const receipt = await store.submit(ref, request.requestId, { submissionId: "one", expectedRevision: 1, response: { schemaVersion: 1, fields: {}, files: {} } }, "developer", async (_request, response) => response);
process.send?.({ request, receipt, owner });
// Parent kills this fixture while it still owns the Run and before suspension release.
setInterval(() => undefined, 1000);
