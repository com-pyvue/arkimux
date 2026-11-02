// Controlled fault harness. Runtime modules and workflow definitions are resolved
// by the parent to the verified candidate snapshot, never the current checkout.
// Candidate aliases are resolved at probe time. Their deliberately dynamic test
// boundaries use any here; production source is typechecked separately.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DurableWorkflowEngineV2 } from "@conformance/engine";
import { DurableWorkflowRunExecutorV2 } from "@conformance/run";
import { hashJson, defineStep } from "@conformance/workflow";
import { LocalWholeRunExecutionHostV1, LocalInterruptedWorkflowRecoveryCoordinatorV1,
  createLocalDurableExecutionStorage, createLocalWorkflowInvocationStore } from "@conformance/local";
import { FilePublishedResultStore } from "@conformance/results";
import { defineWeatherAdvisor } from "@conformance/weather";
import { defineVendorEvaluation } from "@conformance/vendor";
import { weatherInputSchema, weatherSnapshotSchema } from "@conformance/weather-contract";
import { vendorInputSchema, vendorResultSchema } from "@conformance/vendor-contract";
import { completedStepV1Schema, stepPerformanceV1Schema } from "@conformance/completion-contract";

const [root, workflowId, scenario, phase, exampleFile, project, clientRoot] = process.argv.slice(2);
const examples = JSON.parse(await fs.readFile(exampleFile, "utf8"));
const runRef = { executionId: `${workflowId}-${scenario}` };
const runRoot = path.join(root, ".arkimux/local/runs", runRef.executionId);
await fs.mkdir(runRoot, { recursive: true });
const publicCore = await import(pathToFileURL(path.join(project, "node_modules/@com-pyvue/agent-execution-core/dist/index.js")).href);
if (phase === "read") {
  const { startLocalWorkflowDevelopmentServer } = await import(pathToFileURL(path.join(project, "node_modules/@com-pyvue/agent-execution-local/dist/index.js")).href);
  const { ReferenceResultsClient } = await import(pathToFileURL(path.join(clientRoot, "dist/client.js")).href);
  const configRoot = path.join(root, ".arkimux/local/configuration");
  const users = new publicCore.FileUserStore(configRoot), roles = new publicCore.FileRoleStore(configRoot);
  const assignments = new publicCore.FileRoleAssignmentStore(configRoot);
  await new publicCore.UserRegistrationService(users).register({ requestedUserId: "local-developer", identity: { providerId: "local-cli", subjectId: "engine-conformance" } });
  await publicCore.defineRole(roles, { roleId: "engine-reader", permissions: ["runs:read-own"] });
  await new publicCore.RoleAssignmentService(users, roles, assignments).assign("local-developer", "engine-reader");
  const server = await startLocalWorkflowDevelopmentServer({ repositoryRoot: root, subjectId: "engine-conformance", workflows: [], port: 0, environment: {} });
  try {
    const inspection = await new ReferenceResultsClient({ apiBaseUrl: server.url }).inspect(runRef.executionId);
    const performance = await (await fetch(`${server.url}/api/v1/runs/${runRef.executionId}/performance`)).json();
    const result = await (await fetch(`${server.url}/api/v1/runs/${runRef.executionId}/results/${inspection.result.resultId}`)).json();
    await fs.writeFile(path.join(root, "read-outcome.json"), JSON.stringify({ inspection, performance, result, apiUrl: server.url, providerCalls: 0 }));
  } finally { await new Promise<void>((resolve, reject) => server.server.close((error: Error) => error ? reject(error) : resolve())); }
  process.exit(0);
}
const trace = async (event: string, details = {}) => fs.appendFile(path.join(root, "trace.jsonl"), JSON.stringify({ event, ...details }) + "\n");
const crash = async (at: string) => { await trace("fault", { at }); process.exit(86); };
const durable = createLocalDurableExecutionStorage(root, runRef);
const invocations = createLocalWorkflowInvocationStore(root, runRef);
const host = new LocalWholeRunExecutionHostV1({ repositoryRoot: root });
const config = { configurationId: "controlled-fixture-v1", contentHash: hashJson({ fixture: "controlled", workflowId }) };
const runState = new publicCore.FileRunStateV3Store({ root: path.join(runRoot, "state"), reservationRoot: path.join(root, ".arkimux/local/runs/.reservations"), runRef });
const runEvent = async (event: any) => fs.appendFile(path.join(root, "run-events.jsonl"), JSON.stringify(event) + "\n");
if (phase.startsWith("consumer-")) {
  const checkpoint = await durable.steps.read({ runRef, stepId: workflowId === "weather-advisor" ? "read-weather" : "evaluate-vendors" });
  const completed = checkpoint.completed;
  const inputSchema = workflowId === "weather-advisor" ? weatherInputSchema : vendorInputSchema;
  const outputSchema = workflowId === "weather-advisor" ? weatherSnapshotSchema : vendorResultSchema;
  const fullSchema = completedStepV1Schema({ inputSchema, outputSchema, stepId: checkpoint.ref.stepId });
  fullSchema.parse(completed);
  const kind = phase.slice(9);
  const validator = kind === "output" ? outputSchema : kind === "performance" ? stepPerformanceV1Schema : fullSchema;
  const value = kind === "output" ? completed.output : kind === "performance" ? completed.performance : completed;
  const consumerRef = { executionId: `${workflowId}-${phase}` };
  const storage = createLocalDurableExecutionStorage(root, consumerRef);
  const engine = new DurableWorkflowEngineV2({ storage, agents: { resolve() { throw new Error("No agent in consumer"); }, async invoke() { throw new Error("No agent in consumer"); } } });
  let callbacks = 0;
  const step = defineStep({ schemaVersion: 1, id: phase, definitionVersion: "1", input: validator, output: validator,
    async execute(_context: any, input: any) { callbacks++; return validator.parse(input); } });
  const attempt = await host.nextAttempt(consumerRef, { maxDurationMs: 30000, finalizationReserveMs: 1000, maxScratchBytes: 100000 });
  const result = await host.executeAttempt(attempt, context => engine.execute({ host: context, workflowContractVersion: "consumer-fixture-1",
    execute: async ctx => (await ctx.steps.run(step, value)).output }));
  if (result.status !== "completed" || hashJson(result.output) !== hashJson(value) || callbacks !== 1) throw new Error("Completion consumer failed");
  await fs.writeFile(path.join(root, `${phase}-outcome.json`), JSON.stringify({ kind, passed: true, callbacks,
    consumerRunRef: consumerRef, sourceCompletionSha256: hashJson(completed), consumedSha256: hashJson(value), outputSha256: hashJson(result.output) }));
  process.exit(0);
}
if (scenario.startsWith("effect-")) {
  const kind = scenario.slice(7);
  const safety = kind === "read-retry" ? "read" : kind.startsWith("idempotent-") ? "idempotent-write"
    : kind.startsWith("reconcile-") ? "reconcilable-write" : "unsafe-write";
  const value = { fixture: 1 }, validator = { parse(input: any) {
    if (input?.fixture !== 1 || Object.keys(input).length !== 1) throw new Error("Invalid controlled effect value"); return { fixture: 1 };
  } };
  const effect = { schemaVersion: 1, operationId: "controlled-effect", definitionVersion: "1", safety, input: validator, output: validator,
    async execute(context: any) {
      await trace("effect-call", { operationId: context.stableOperationId });
      if (phase === "crash") await crash("after-dispatch-before-completion");
      return value;
    },
    async reconcile(context: any) {
      await trace("reconciliation", { operationId: context.stableOperationId });
      return kind === "reconcile-found" ? { outcome: "completed", output: value } : kind === "reconcile-not-found"
        ? { outcome: "not-found" } : { outcome: "unknown", reasonCode: "fixture_unknown" };
    } };
  const step = defineStep({ schemaVersion: 1, id: "effect-probe", definitionVersion: "1", input: validator, output: validator,
    async execute(context: any, input: any) { await trace("callback", { stepId: "effect-probe" }); return context.effects.run(effect, input); } });
  const effectEngine = new DurableWorkflowEngineV2({ storage: durable, adapterConformance: () => kind === "idempotent-retry",
    agents: { resolve() { throw new Error("No agents in effect fixture"); }, async invoke() { throw new Error("No agents in effect fixture"); } } });
  const attempt = await host.nextAttempt(runRef, { maxDurationMs: 30000, finalizationReserveMs: 1000, maxScratchBytes: 100000 });
  const outcome = await host.executeAttempt(attempt, context => effectEngine.execute({ host: context, workflowContractVersion: "effect-fixture-1",
    execute: async ctx => (await ctx.steps.run(step, value)).output }));
  const operation = await durable.effects.read({ runRef, operationId: "effect-probe:controlled-effect" });
  const checkpoint = await durable.steps.read({ runRef, stepId: "effect-probe" });
  await fs.writeFile(path.join(root, `${phase}-outcome.json`), JSON.stringify({ outcome, operation, checkpoint }));
  process.exit(0);
}
const metrics = { providerId: "controlled-fixture", status: "complete", elapsedMs: 1, nativeToolCalls: 0,
  toolCallUnit: "native-tool-call", usage: { inputTokens: 4, outputTokens: 2 },
  artifacts: { eventsPath: "fixture/events", stderrPath: "fixture/stderr", lastMessagePath: "fixture/message", heartbeatPath: "fixture/heartbeat" } };
const engine = new DurableWorkflowEngineV2({ storage: durable, agents: {
  resolve: () => ({ providerId: "controlled-fixture", authProviderId: "controlled-fixture", configurationSha256: config.contentHash }),
  async invoke(request: any) {
    await trace("agent-call", { operationId: request.operation.operationId });
    if (scenario === "agent-dispatch" && phase === "crash") await crash("after-agent-dispatch-before-completion");
    if (scenario === "provider-failure") throw new Error("Controlled provider failure");
    const output = scenario === "invalid-output" ? {} : workflowId === "vendor-evaluation" ? examples.vendorResult
      : request.operation.slotId === "recommendation" ? examples.weatherResult.recommendation : examples.weatherResult.critique;
    const validated = request.operation.output.parse(output);
    const attemptMetrics = { ...metrics, attempt: phase === "crash" || phase === "single" ? 1 : 2, model: "controlled-fixture" };
    await runEvent({ type: "agent-completed", at: new Date().toISOString(), stageId: request.stepId, logicalAgentId: request.operation.slotId,
      providerId: metrics.providerId, metrics: attemptMetrics });
    return { output: validated, metrics: attemptMetrics };
  },
} });
const executeObserved = engine.execute.bind(engine);
engine.execute = async request => {
  try { return await executeObserved(request); }
  catch (error: any) {
    await trace("engine-rejected", { name: error.name, code: error.code ?? null });
    throw error;
  }
};
const weatherEffect = { schemaVersion: 1, operationId: "weather.current", definitionVersion: "fixture-1", safety: "read",
  input: weatherInputSchema, output: weatherSnapshotSchema,
  async execute() { await trace("effect-call", { operationId: "weather.current" }); return examples.weatherResult.weather; } };
const original = workflowId === "weather-advisor" ? defineWeatherAdvisor(weatherEffect) : defineVendorEvaluation();
const definition = { ...original, async execute(context: any, input: any) {
  // Observe actual callbacks without changing persisted workflow files or results.
  const observed = { ...context, steps: { ...context.steps, run: async (step: any, value: any) => {
    const output = await context.steps.run({ ...step, execute: async (...args: any[]) => {
      await trace("callback", { stepId: step.id }); return step.execute(...args);
    } }, value);
    await trace("completion-consumed", { stepId: step.id, recordSha256: hashJson(output),
      outputSha256: hashJson(output.output), performanceSha256: hashJson(output.performance) });
    await runEvent({ type: "stage-completed", at: new Date().toISOString(), stageId: step.id, elapsedMs: output.execution.elapsedMs });
    return output;
  } } };
  return original.execute(observed, input);
} };
const invocation = { schemaVersion: 1, runRef, workflow: original.workflow,
  workflowContractVersion: original.workflowContractVersion, runConfiguration: config,
  resultKind: original.resultKind, input: workflowId === "weather-advisor" ? examples.weatherInput : examples.vendorInput,
  createdAt: new Date().toISOString() };
const complete = durable.steps.complete.bind(durable.steps);
durable.steps.complete = async (request: any) => {
  const result = await complete(request);
  await trace("completion-commit", { stepId: request.ref.stepId, recordSha256: hashJson(request.completed) });
  if (phase === "crash" && scenario !== "agent-dispatch" && scenario !== "first-step") await crash("after-step-commit-before-continuation");
  return result;
};
const results = new FilePublishedResultStore({ root: runRoot, resultId: () => `${original.resultKind}.json` });
const publish = results.publish.bind(results);
results.publish = async (envelope: any) => {
  const ref = await publish(envelope); await trace("result-published", { resultSha256: hashJson(envelope.payload) }); return ref;
};
const executor = new DurableWorkflowRunExecutorV2({ engine, host, invocations, results,
  runState });
const limits = { maxDurationMs: 30000, finalizationReserveMs: 1000, maxScratchBytes: 1000000 };
let outcome: any;
try {
  if (phase === "crash" || phase === "single") {
    await runState.reserve();
    const configuration = { schemaVersion: 1, configurationId: config.configurationId, workflow: original.workflow,
      agents: Object.fromEntries((workflowId === "weather-advisor" ? ["recommendation", "critique"] : ["vendor-evaluator"]).map(slot => [slot,
        { timeoutMs: 30000, execution: { provider: "controlled-fixture", authProvider: "controlled-fixture", parameters: { model: "controlled-fixture" } } }])) };
    config.contentHash = publicCore.runConfigurationContentHash(configuration);
    const manifest = { schemaVersion: 3, runRef, workflow: original.workflow, createdAt: invocation.createdAt,
      actor: { userId: "local-developer", roleId: "engine-reader" }, runConfiguration: config };
    await runState.create(manifest);
    await fs.writeFile(path.join(runRoot, "state/run-config.resolved.json"), JSON.stringify(configuration));
    await fs.mkdir(path.join(runRoot, "artifacts"), { recursive: true });
    await fs.writeFile(path.join(runRoot, "artifacts/input.json"), JSON.stringify(invocation.input));
    await runEvent({ type: "run-started", at: invocation.createdAt, manifest });
    await invocations.create(invocation);
    await trace("invocation-persisted", { sha256: hashJson(invocation) });
    if (scenario === "first-step" && phase === "crash") await crash("after-invocation-before-first-step");
    const attempt = await host.nextAttempt(runRef, limits);
    await trace("host-start", { fence: attempt.fence });
    outcome = await executor.execute({ attempt, invocation, definition });
  } else {
    const configuration = JSON.parse(await fs.readFile(path.join(runRoot, "state/run-config.resolved.json"), "utf8"));
    config.contentHash = publicCore.runConfigurationContentHash(configuration);
    if (scenario === "cancelled-before-next-step") await host.cancel(runRef, "cancelled");
    const coordinator = new LocalInterruptedWorkflowRecoveryCoordinatorV1({ repositoryRoot: root,
      definitions: { resolve: () => scenario === "missing-workflow" ? undefined : scenario === "mismatched-workflow"
        ? { ...definition, workflowContractVersion: "incompatible" } : definition },
      runConfigurations: { resolve: async (_workflow: any, reference: any) => scenario === "missing-run-configuration" ? undefined
        : reference.contentHash === config.contentHash && reference.configurationId === config.configurationId ? config : undefined },
      async resume(resolved: any) {
        const attempt = await host.nextAttempt(runRef, limits);
        await trace("host-start", { fence: attempt.fence });
        outcome = await executor.execute({ attempt, invocation: resolved.invocation, definition: resolved.definition });
      } });
    await coordinator.resumeAll();
  }
  if (outcome?.status === "complete") {
    await runEvent({ type: "run-completed", at: new Date().toISOString() });
    // Project persisted events through the production collector after restart.
    // This is a controlled consumer, not a claim about live provider calls.
    const collector = new publicCore.PerformanceCollector(new publicCore.FileRunPerformanceV2Store(path.join(runRoot, "state"), runRef));
    for (const event of (await fs.readFile(path.join(root, "run-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse)) await collector.emit(event);
  }
  await fs.writeFile(path.join(root, `${phase}-outcome.json`), JSON.stringify({ outcome }));
} catch (error: any) {
  await fs.writeFile(path.join(root, `${phase}-outcome.json`), JSON.stringify({ error: { name: error.name, code: error.code ?? null,
    message: error.message } }));
}
