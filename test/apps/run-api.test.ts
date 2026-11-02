import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  RunApiClient,
  RunApiError,
  type WorkflowInvocationEntryDto,
} from "../../apps/packages/run/contract/src/index.ts";
import {
  CodedWorkflowRegistry,
  RunApplicationService,
  createRunRouter,
  type GenericRunConfiguration,
  type RunInputRequests,
  type RunCorrectionLinks,
} from "../../apps/packages/run/api/src/index.ts";
import { createAgentExecutionApiHost } from "../../apps/hosts/api/src/index.ts";
import type {
  PublishedResultEnvelope,
  PublishedResultQueryStore,
  PublishedResultRef,
  ResolvedRunConfiguration,
  RunArtifactQueryStore,
  RunCatalogEntry,
  RunCatalogQuery,
  RunCatalogStore,
  WorkflowRunConfigurationStore,
  RunDispatcher,
  RunPerformance,
  RunPerformanceQueryStore,
  RunRef,
  StoredArtifact,
  TrustedRunCommand,
} from "@com-pyvue/agent-execution-core";
import type { AuthorizedApplicationPrincipal } from "../../apps/packages/application-host/src/index.ts";
import { agentExecutionUiConfiguration } from "../../apps/packages/ui-profile/contract/src/index.ts";

const timestamp = "2026-08-05T12:00:00.000Z";
const configurationHash = "a".repeat(64);
const workflow = { kind: "fixture.workflow", version: 1 } as const;
const configuration: GenericRunConfiguration = {
  configurationId: "fixture-v1",
  workflow,
  agents: {
    discovery: {
      execution: {
        provider: "pi-cli",
        parameters: {
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          thinking: "high",
          speed: "fast",
        },
      },
    },
  },
};
const resolvedConfiguration: ResolvedRunConfiguration<GenericRunConfiguration> = {
  configuration,
  contentHash: configurationHash,
};

const ownerPrincipal = principal("owner", "runner", [
  "runs:read-own",
  "runs:archive-own",
  "runs:respond-own",
  "workflow:fixture.workflow:start",
]);
const adminPrincipal = principal("admin", "admin", [
  "runs:read-all",
  "runs:archive-all",
  "runs:respond-all",
  "workflow:fixture.workflow:start",
]);

interface FixtureOptions {
  rejectDispatch?: boolean;
  archivedConfiguration?: boolean;
  providerAvailable?: boolean;
  multiProviderSummary?: boolean;
  inputRequests?: RunInputRequests;
  graphInvocationEntries?: readonly WorkflowInvocationEntryDto[];
}

function fixture(options: FixtureOptions = {}) {
  const summaryConfiguration = options.multiProviderSummary ? {
    ...configuration,
    agents: {
      ...configuration.agents,
      review: {
        execution: {
          provider: "codex-cli",
          parameters: { model: "gpt-5.6-sol", model_reasoning_effort: "high" },
        },
      },
    },
  } : configuration;
  const entries: RunCatalogEntry[] = [
    catalogEntry("owner-complete", "owner", "complete"),
    catalogEntry("owner-failed", "owner", "failed"),
    catalogEntry("other-running", "other", "running"),
  ];
  const catalog: RunCatalogStore = {
    get: async ({ executionId }) => entries.find((entry) => entry.runRef.executionId === executionId),
    list: async (query) => page(entries.filter((entry) => matches(entry, query)), query),
    archive: async ({ executionId }, archivedAt) => {
      const entry = entries.find((candidate) => candidate.runRef.executionId === executionId);
      if (!entry) throw new Error(`Run ${executionId} does not exist.`);
      entry.lifecycleStatus = "archived";
      entry.archivedAt = archivedAt;
    },
    restore: async ({ executionId }) => {
      const entry = entries.find((candidate) => candidate.runRef.executionId === executionId);
      if (!entry) throw new Error(`Run ${executionId} does not exist.`);
      entry.lifecycleStatus = "active";
      delete entry.archivedAt;
    },
  };

  const artifacts = new Map<string, RunArtifactQueryStore>([
    ["owner-complete", artifactStore({
      "artifacts/input.json": { message: "fixture input" },
      "state/run-config.resolved.json": summaryConfiguration,
    })],
    ["owner-failed", artifactStore({})],
    ["other-running", artifactStore({})],
  ]);
  const resultEnvelope: PublishedResultEnvelope = {
    envelopeSchemaVersion: 1,
    resultKind: "fixture.result",
    runRef: { executionId: "owner-complete" },
    payload: { schemaVersion: 2, message: "opaque workflow result" },
  };
  const results = new Map<string, PublishedResultQueryStore>([
    ["owner-complete", resultStore("result.json", resultEnvelope)],
    ["owner-failed", resultStore()],
    ["other-running", resultStore()],
  ]);
  const performance = new Map<string, RunPerformanceQueryStore>([
    ["owner-complete", { get: async () => runPerformance("owner-complete") }],
    ["owner-failed", { get: async () => undefined }],
    ["other-running", { get: async () => undefined }],
  ]);
  const dispatched: TrustedRunCommand<unknown>[] = [];
  const reserve = vi.fn(async (request: { requestedExecutionId?: string }) => {
    const runRef = { executionId: request.requestedExecutionId ?? "reserved-run" };
    if (!entries.some(entry => entry.runRef.executionId === runRef.executionId)) {
      entries.push(catalogEntry(runRef.executionId, "owner", "running"));
    }
    return runRef;
  });
  const cancel = vi.fn(async ({ executionId }: RunRef) => {
    const entry = entries.find(candidate => candidate.runRef.executionId === executionId);
    if (!entry) throw new Error(`Run ${executionId} does not exist.`);
    entry.status = { kind: "status", status: "cancelled", updatedAt: timestamp };
  });
  const correctionLinks: Awaited<ReturnType<RunCorrectionLinks["create"]>>[] = [];
  const corrections: RunCorrectionLinks = {
    create: vi.fn(async link => {
      correctionLinks.push(link);
      return link;
    }),
    getByCorrectedRun: async ({ executionId }) => correctionLinks.find(link => link.correctedRunRef.executionId === executionId),
    listByPriorRun: async ({ executionId }) => correctionLinks.filter(link => link.priorRunRef.executionId === executionId),
  };
  const dispatcher: RunDispatcher<unknown> = {
    dispatch: vi.fn(async (command) => {
      if (options.rejectDispatch) throw new Error("queue unavailable");
      dispatched.push(command);
    }),
  };
  const runConfigurations: WorkflowRunConfigurationStore<GenericRunConfiguration> = {
    publish: async () => resolvedConfiguration,
    resolve: async (requestedWorkflow, configurationId) => requestedWorkflow.kind === workflow.kind && requestedWorkflow.version === workflow.version && configurationId === "fixture-v1" ? resolvedConfiguration : undefined,
    lifecycleStatus: async (_requestedWorkflow, configurationId) => configurationId === "fixture-v1"
      ? options.archivedConfiguration ? "archived" : "active"
      : undefined,
    archive: async () => undefined,
    restore: async () => undefined,
    list: async () => ({ items: [resolvedConfiguration] }),
  };
  const workflows = new CodedWorkflowRegistry([{
    workflow,
    ...(options.graphInvocationEntries ? { invocationModel: "graph-entry" as const,
      describeInvocation: async () => ({ model: "graph-entry" as const, entries: [...options.graphInvocationEntries!] }) } : {}),
    title: "Fixture workflow",
    description: "Exercises local workflow invocation.",
    inputExample: { message: "example" },
    agentSlots: [
      { slotId: "discovery", title: "Discovery", description: "Discovers fixture inputs." },
    ],
    validateInput: (input) => z.object({ message: z.string() }).strict().parse(input),
    preflight: async () => ({
      available: options.providerAvailable !== false,
      agents: [{
        slotId: "discovery",
        providerId: "pi-cli",
        authProviderId: "pi-session",
        available: options.providerAvailable !== false,
        status: options.providerAvailable === false ? "unavailable" as const : "ready" as const,
        ...(options.providerAvailable === false ? { reason: "provider-unavailable" as const } : {}),
        ...(options.providerAvailable === false
          ? { message: "Agent execution provider pi-cli could not find command pi." }
          : { resolvedCommand: "/repo/node_modules/.bin/pi", commandSource: "repository-local" as const }),
      }],
    }),
    reserve,
    cancel,
    execute: async () => undefined,
  }]);
  const artifactProvider = provider(artifacts);
  const performanceProvider = provider(performance);
  const service = new RunApplicationService({
    ...(options.inputRequests ? { inputRequests: options.inputRequests } : {}),
    corrections,
    catalog,
    artifacts: artifactProvider,
    results: provider(results),
    performance: performanceProvider,
    runConfigurations,
    dispatcher,
    workflows,
  });
  const router = createRunRouter({
    service,
    authenticate: async (request) => request.headers.get("x-principal") === "admin"
      ? adminPrincipal
      : ownerPrincipal,
  });
  const client = new RunApiClient({
    baseUrl: "http://run-api.test",
    fetch: (input, init) => router.request(input, withHeader(init, "x-principal", "owner")),
  });
  return { artifactProvider, artifacts, cancel, client, corrections, dispatched, entries, performanceProvider, reserve, router, service };
}

describe("Run API submission", () => {
  it("describes selectable graph entries for an authorized Run Configuration", async () => {
    const entries = [{ id: "default", label: "calculate (default)", nodeKind: "step" as const,
      entry: { kind: "default" as const }, requirements: [{ id: "entry", role: "entry-input" as const,
        contractVersion: "1", schema: { type: "number" }, provenance: "caller-supplied" as const }] }];
    const test = fixture({ graphInvocationEntries: entries });
    await expect(test.client.getWorkflowInvocationOptions({ workflow, roleId: "runner", runConfigurationId: "fixture-v1" }))
      .resolves.toEqual({ model: "graph-entry", entries });
    const forbidden = await test.router.request("http://run-api.test/api/v1/workflows/invocation-options", {
      method: "POST", headers: { "content-type": "application/json", "x-principal": "owner" },
      body: JSON.stringify({ workflow, roleId: "admin", runConfigurationId: "fixture-v1" }),
    });
    expect(forbidden.status).toBe(403);
    await expect(fixture({ graphInvocationEntries: entries, archivedConfiguration: true }).client
      .getWorkflowInvocationOptions({ workflow, roleId: "runner", runConfigurationId: "fixture-v1" }))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
  });

  it("lists and accepts graph entry input without returning accepted values", async () => {
    const requestId = "graph-request-1", acceptedBodySha256 = "c".repeat(64), planSha256 = "d".repeat(64);
    const list = vi.fn(async () => ({ schemaVersion: 1 as const, runRef: { executionId: "owner-complete" }, items: [{
      kind: "graph-entry" as const, schemaVersion: 1 as const, requestId, status: "pending" as const, revision: 1,
      updatedAt: timestamp, entry: { schemaVersion: 1 as const, path: [{ nodeId: "calculate" }] }, planSha256,
      requirements: [{ id: "entry", role: "entry-input" as const, contractVersion: "1", schema: { type: "number" },
        provenance: "caller-supplied" as const }], createdAt: timestamp, expiresAt: "2026-08-06T12:00:00.000Z",
    }] }));
    const submit = vi.fn(async () => ({ schemaVersion: 1 as const, runRef: { executionId: "owner-complete" },
      kind: "graph-entry" as const, accepted: { schemaVersion: 1 as const, acceptanceId: "answer-1", requestId,
        acceptedAt: timestamp, acceptedBodySha256 } }));
    const upload = async (): Promise<never> => { throw new Error("Unexpected upload"); };
    const test = fixture({ inputRequests: { list, submit, upload } });

    const listed = await test.router.request("http://run-api.test/api/v1/runs/owner-complete/input-requests",
      { headers: { "x-principal": "owner" } });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(listedBody.items[0]).toMatchObject({ kind: "graph-entry", requestId, planSha256, status: "pending" });
    expect(JSON.stringify(listedBody)).not.toContain('"values"');

    const body = { submissionId: "answer-1", expectedRevision: 1,
      response: { schemaVersion: 1, planSha256, values: { entry: 10 } } };
    const response = await test.router.request(`http://run-api.test/api/v1/runs/owner-complete/input-requests/${requestId}/response`, {
      method: "POST", headers: { "content-type": "application/json", "x-principal": "owner" }, body: JSON.stringify(body),
    });
    expect(response.status).toBe(202);
    const responseBody = await response.json();
    expect(responseBody).toMatchObject({ kind: "graph-entry", accepted: { acceptanceId: "answer-1", requestId, acceptedBodySha256 } });
    expect(JSON.stringify(responseBody)).not.toContain('"values"');
    expect(submit).toHaveBeenCalledWith({ executionId: "owner-complete" }, requestId, body, "owner");
  });

  it("accepts one multipart input file and passes only finalized bytes to the input service", async () => {
    const receipt = { schemaVersion: 1 as const, runRef: { executionId: "owner-complete" }, requestId: "request-1",
      fieldId: "documents", uploadId: "upload-1", file: { objectId: `upload-${"a".repeat(64)}`,
        mediaType: "text/plain", byteLength: 5, sha256: "b".repeat(64) } };
    const upload = vi.fn(async () => receipt);
    const unavailable = async (): Promise<never> => { throw new Error("Unexpected input operation"); };
    const test = fixture({ inputRequests: { list: unavailable, submit: unavailable, upload } });
    const body = new FormData(); body.set("fieldId", "documents"); body.set("uploadId", "upload-1");
    body.set("file", new File(["hello"], "note.txt", { type: "text/plain" }));
    const response = await test.router.request("http://run-api.test/api/v1/runs/owner-complete/input-requests/request-1/uploads",
      { method: "POST", headers: { "x-principal": "owner" }, body });
    expect(response.status).toBe(201); expect(await response.json()).toEqual(receipt);
    expect(upload).toHaveBeenCalledWith({ executionId: "owner-complete" }, "request-1", {
      fieldId: "documents", uploadId: "upload-1", filename: "note.txt", mediaType: "text/plain", bytes: new Uint8Array(Buffer.from("hello")),
    });
  });

  it("rejects non-multipart and multi-file input uploads before storage", async () => {
    const upload = vi.fn();
    const unavailable = async (): Promise<never> => { throw new Error("Unexpected input operation"); };
    const test = fixture({ inputRequests: { list: unavailable, submit: unavailable, upload } });
    const wrong = await test.router.request("http://run-api.test/api/v1/runs/owner-complete/input-requests/request-1/uploads",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(wrong.status).toBe(415);
    const body = new FormData(); body.set("fieldId", "documents"); body.set("uploadId", "upload-1");
    body.append("file", new File(["one"], "one.txt", { type: "text/plain" }));
    body.append("file", new File(["two"], "two.txt", { type: "text/plain" }));
    const multiple = await test.router.request("http://run-api.test/api/v1/runs/owner-complete/input-requests/request-1/uploads", { method: "POST", body });
    expect(multiple.status).toBe(400); expect(upload).not.toHaveBeenCalled();
  });
  it("lists registered workflows with only the caller's authorized roles", async () => {
    const catalog = await fixture().client.listWorkflows();
    expect(catalog).toEqual({
      items: [{
        workflow,
        title: "Fixture workflow",
        description: "Exercises local workflow invocation.",
        inputExample: { message: "example" },
        agentSlots: [
          { slotId: "discovery", title: "Discovery", description: "Discovers fixture inputs." },
        ],
        allowedRoleIds: ["runner"],
      }],
    });
  });

  it("does not retain the former coded-workflows route", async () => {
    const response = await fixture().router.request("http://run-api.test/api/v1/coded-workflows");
    expect(response.status).toBe(404);
  });

  it("reserves and accepts a registered coded workflow with the trusted actor", async () => {
    const test = fixture();
    const response = await test.client.submitRun({
      workflow,
      roleId: "runner",
      input: { message: "start" },
      runConfigurationId: "fixture-v1",
      requestedExecutionId: "requested-run",
    });

    expect(response).toEqual({ runRef: { executionId: "requested-run" } });
    expect(test.dispatched).toEqual([expect.objectContaining({
      runRef: { executionId: "requested-run" },
      actor: { userId: "owner", roleId: "runner" },
      workflow,
      runConfiguration: { configurationId: "fixture-v1", contentHash: configurationHash },
    })]);
  });

  it("cancels an authorized active Run only with the fixed effects acknowledgement", async () => {
    const test = fixture();
    test.entries.push(catalogEntry("owner-running", "owner", "running"));
    await expect(test.client.cancelRun("owner-running", { acknowledgement: "external-effects-not-undone" }))
      .resolves.toMatchObject({ run: { status: { status: "cancelled" } } });
    expect(test.cancel).toHaveBeenCalledWith({ executionId: "owner-running" });
    await expect(test.client.cancelRun("owner-running", { acknowledgement: "external-effects-not-undone" }))
      .resolves.toMatchObject({ run: { status: { status: "cancelled" } } });
    expect(test.cancel).toHaveBeenCalledTimes(1);
    await expect(test.client.cancelRun("other-running", { acknowledgement: "external-effects-not-undone" }))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("rejects an active prior Run unless cancellation is explicit, then retains both sides of the correction link", async () => {
    const test = fixture();
    test.entries.push(catalogEntry("owner-running", "owner", "running"));
    const base = {
      workflow,
      roleId: "runner",
      input: { message: "corrected" },
      runConfigurationId: "fixture-v1",
      requestedExecutionId: "corrected-run",
      correction: {
        priorRunRef: { executionId: "owner-running" },
        acknowledgement: "new-run-from-start-effects-not-undone" as const,
      },
    };

    await expect(test.client.submitRun({ ...base, correction: { ...base.correction, activeOriginal: "reject" } }))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(test.cancel).not.toHaveBeenCalled();
    expect(test.reserve).not.toHaveBeenCalled();

    const submitted = await test.client.submitRun({ ...base, correction: { ...base.correction, activeOriginal: "cancel" } });
    expect(test.cancel).toHaveBeenCalledWith({ executionId: "owner-running" });
    expect(submitted).toMatchObject({
      runRef: { executionId: "corrected-run" },
      correction: {
        schemaVersion: 1,
        priorRunRef: { executionId: "owner-running" },
        correctedRunRef: { executionId: "corrected-run" },
      },
    });
    expect(test.dispatched).toHaveLength(1);
    await expect(test.client.getRun("owner-running")).resolves.toMatchObject({
      run: { status: { status: "cancelled" } },
      correctedRuns: [{ correctedRunRef: { executionId: "corrected-run" } }],
    });
    await expect(test.client.getRun("corrected-run")).resolves.toMatchObject({
      correction: { priorRunRef: { executionId: "owner-running" } },
      correctedRuns: [],
    });
  });

  it("does not cancel a terminal original and rejects cross-owner correction", async () => {
    const test = fixture();
    await expect(test.client.submitRun({
      workflow, roleId: "runner", input: { message: "corrected" }, runConfigurationId: "fixture-v1",
      requestedExecutionId: "corrected-complete",
      correction: { priorRunRef: { executionId: "owner-complete" }, activeOriginal: "reject",
        acknowledgement: "new-run-from-start-effects-not-undone" },
    })).resolves.toMatchObject({ runRef: { executionId: "corrected-complete" } });
    expect(test.cancel).not.toHaveBeenCalled();

    await expect(test.client.submitRun({
      workflow, roleId: "runner", input: { message: "wrong owner" }, runConfigurationId: "fixture-v1",
      correction: { priorRunRef: { executionId: "other-running" }, activeOriginal: "cancel",
        acknowledgement: "new-run-from-start-effects-not-undone" },
    })).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("does not disclose correction links to Runs the caller cannot read", async () => {
    const test = fixture();
    await test.corrections.create({
      schemaVersion: 1,
      priorRunRef: { executionId: "owner-complete" },
      correctedRunRef: { executionId: "other-running" },
      createdAt: timestamp,
    });
    await expect(test.client.getRun("owner-complete")).resolves.toMatchObject({ correctedRuns: [] });
    const admin = new RunApiClient({
      baseUrl: "http://run-api.test",
      fetch: (input, init) => test.router.request(input, withHeader(init, "x-principal", "admin")),
    });
    await expect(admin.getRun("owner-complete")).resolves.toMatchObject({
      correctedRuns: [{ correctedRunRef: { executionId: "other-running" } }],
    });
  });

  it("reports runtime readiness and rejects unavailable providers before reserving a run", async () => {
    const ready = fixture();
    await expect(ready.client.preflightWorkflow({
      workflow,
      roleId: "runner",
      runConfigurationId: "fixture-v1",
    })).resolves.toEqual({
      available: true,
      agents: [{
        slotId: "discovery",
        providerId: "pi-cli",
        authProviderId: "pi-session",
        available: true,
        status: "ready",
        resolvedCommand: "/repo/node_modules/.bin/pi",
        commandSource: "repository-local",
      }],
    });

    const unavailable = fixture({ providerAvailable: false });
    await expect(unavailable.client.submitRun({
      workflow,
      roleId: "runner",
      input: { message: "start" },
      runConfigurationId: "fixture-v1",
    })).rejects.toMatchObject({
      status: 503,
      code: "provider-unavailable",
      message: expect.stringContaining("could not find command pi"),
    });
    expect(unavailable.reserve).not.toHaveBeenCalled();
    expect(unavailable.dispatched).toEqual([]);
  });

  it("rejects unknown workflows, invalid workflow input, and rejected dispatch", async () => {
    const test = fixture();
    await expect(test.client.submitRun({
      workflow: { kind: "missing.workflow", version: 1 },
      roleId: "runner",
      input: {},
      runConfigurationId: "fixture-v1",
    })).rejects.toMatchObject({ status: 404, code: "not-found" });
    await expect(test.client.submitRun({
      workflow,
      roleId: "runner",
      input: {},
      runConfigurationId: "fixture-v1",
    })).rejects.toMatchObject({ status: 400, code: "invalid-request" });

    const rejected = fixture({ rejectDispatch: true });
    await expect(rejected.client.submitRun({
      workflow,
      roleId: "runner",
      input: { message: "start" },
      runConfigurationId: "fixture-v1",
    })).rejects.toMatchObject({ status: 503, code: "dispatch-rejected" });
  });

  it("rejects archived configurations before reserving or dispatching", async () => {
    const test = fixture({ archivedConfiguration: true });
    await expect(test.client.submitRun({
      workflow,
      roleId: "runner",
      input: { message: "start" },
      runConfigurationId: "fixture-v1",
    })).rejects.toMatchObject({ status: 409, code: "conflict" });
    expect(test.dispatched).toEqual([]);
  });
});

describe("Run API queries", () => {
  it("loads only explicitly requested aggregate summaries for the current page", async () => {
    const test = fixture();
    const plain = await test.client.listRuns({ pageSize: 1 });
    expect(plain.items[0]).not.toHaveProperty("summary");
    expect(test.performanceProvider.open).not.toHaveBeenCalled();
    expect(test.artifactProvider.open).not.toHaveBeenCalled();

    const aggregate = await test.client.listRuns({
      pageSize: 1,
      summaryFields: ["totalElapsedMs", "reasoningOutputTokens", "provider", "speed"],
    });
    expect(aggregate.items[0]?.summary).toEqual({
      totalElapsedMs: 1_000,
      reasoningOutputTokens: 5,
      provider: "pi-cli",
      speed: "fast",
    });
    expect(test.performanceProvider.open).toHaveBeenCalledTimes(1);
    expect(test.artifactProvider.open).toHaveBeenCalledTimes(1);
    expect(aggregate.items[0]).not.toHaveProperty("agentAttempts");
  });

  it("paginates only the caller's runs and permits cross-user reads only with read-all", async () => {
    const test = fixture();
    const ownerPage = await test.client.listRuns({ pageSize: 1 });
    expect(ownerPage.items.map(({ runRef }) => runRef.executionId)).toEqual(["owner-complete"]);
    expect(ownerPage.pagination.nextCursor).toBe("1");
    await expect(test.client.listRuns({ userId: "other" })).rejects.toMatchObject({
      status: 403,
      code: "forbidden",
    });

    const response = await test.router.request("http://run-api.test/api/v1/runs?userId=other", {
      headers: { "x-principal": "admin" },
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { items: RunCatalogEntry[] }).items).toHaveLength(1);
  });

  it("filters complete results before pagination using independent provider, model, and numeric predicates", async () => {
    const test = fixture({ multiProviderSummary: true });
    const options = await test.client.getRunFilterOptions();
    expect(options).toMatchObject({ providers: ["codex-cli", "pi-cli"], models: ["gpt-5.6-luna", "gpt-5.6-sol"] });
    const matching = await test.client.listRuns({
      providers: ["pi-cli"],
      models: ["gpt-5.6-sol"],
      numericRange: { field: "inputTokens", min: 100, max: null },
      sort: { field: "inputTokens", direction: "desc" },
      pageSize: 10,
    });
    expect(matching.items.map(({ runRef }) => runRef.executionId)).toEqual(["owner-complete"]);
    expect((await test.client.listRuns({ numericRange: { field: "inputTokens", min: 101 } })).items).toEqual([]);
  });

  it("archives only terminal runs and restores their catalog visibility", async () => {
    const test = fixture();
    await expect(test.client.archiveRun("owner-complete")).resolves.toMatchObject({ run: { lifecycleStatus: "archived" } });
    expect((await test.client.listRuns()).items.map(({ runRef }) => runRef.executionId)).toEqual(["owner-failed"]);
    expect((await test.client.listRuns({ lifecycleStatus: "archived" })).items.map(({ runRef }) => runRef.executionId)).toEqual(["owner-complete"]);
    await expect(test.service.archive(adminPrincipal, { executionId: "other-running" }))
      .rejects.toMatchObject({ status: 409, code: "conflict" });
    await expect(test.client.restoreRun("owner-complete")).resolves.toMatchObject({ run: { lifecycleStatus: "active" } });
  });

  it("returns lifecycle, artifacts, generic results, performance, and resolved configuration", async () => {
    const test = fixture();
    expect((await test.client.getRun("owner-failed")).run.status).toMatchObject({ status: "failed" });
    expect((await test.client.listArtifacts("owner-complete")).items).toHaveLength(2);
    expect(await test.client.getInput("owner-complete")).toEqual({
      runRef: { executionId: "owner-complete" },
      input: { message: "fixture input" },
    });
    expect(await test.client.getArtifactContent("owner-complete", "artifacts/input.json"))
      .toMatchObject({
        runRef: { executionId: "owner-complete" },
        artifact: { key: "artifacts/input.json", mediaType: "application/json" },
        encoding: "utf8",
        content: JSON.stringify({ message: "fixture input" }),
      });
    const listed = await test.client.listResults("owner-complete");
    expect(listed.items).toEqual([expect.objectContaining({
      resultKind: "fixture.result",
      resultId: "result.json",
      payloadSchemaVersion: 2,
    })]);
    expect((await test.client.getResult("owner-complete", "result.json")).payload).toEqual({
      schemaVersion: 2,
      message: "opaque workflow result",
    });
    expect((await test.client.getPerformance("owner-complete")).performance?.totalElapsedMs).toBe(1_000);
    expect((await test.client.getResolvedConfiguration("owner-complete")).resolvedConfiguration)
      .toEqual(configuration);
  });

  it("keeps failed runs queryable and represents absent optional data explicitly", async () => {
    const test = fixture();
    expect(await test.client.listResults("owner-failed")).toEqual({
      runRef: { executionId: "owner-failed" },
      items: [],
    });
    expect(await test.client.getPerformance("owner-failed")).toEqual({
      runRef: { executionId: "owner-failed" },
      performance: null,
    });
    expect(await test.client.getResolvedConfiguration("owner-failed")).toEqual({
      runRef: { executionId: "owner-failed" },
      resolvedConfiguration: null,
    });
    expect(await test.client.getInput("owner-failed")).toEqual({
      runRef: { executionId: "owner-failed" },
      input: null,
    });
  });

  it("rejects unknown runs and result IDs before exposing scoped data", async () => {
    const test = fixture();
    await expect(test.client.getRun("unknown-run")).rejects.toMatchObject({ status: 404, code: "not-found" });
    await expect(test.client.getResult("owner-complete", "unknown.json"))
      .rejects.toMatchObject({ status: 404, code: "not-found" });
    await expect(test.client.getArtifactContent("owner-complete", "unknown.json"))
      .rejects.toMatchObject({ status: 404, code: "not-found" });
    await expect(test.client.getRun("other-running"))
      .rejects.toMatchObject({ status: 403, code: "forbidden" });
  });

  it("builds bounded server-side comparison rows without converting missing metrics to zero", async () => {
    const test = fixture();
    const comparison = await test.client.compareRuns({ executionIds: ["owner-complete", "owner-failed"] });
    expect(comparison.rows[0]).toMatchObject({
      provider: "pi-cli",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      speed: "fast",
      durationMs: 1_000,
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      toolCalls: 7,
      searchCalls: 3,
    });
    expect(comparison.rows[1]).toMatchObject({
      status: "failed",
      provider: null,
      model: null,
      durationMs: null,
      inputTokens: null,
      costs: null,
      toolCalls: null,
      searchCalls: null,
    });
    expect(() => test.client.compareRuns({ executionIds: ["owner-complete", "owner-complete"] }))
      .toThrow(z.ZodError);
  });
});

describe("Run API host", () => {
  it("uses an exact browser-origin allowlist", async () => {
    const test = fixture();
    const host = createAgentExecutionApiHost({
      runRouter: test.router,
      uiConfiguration: agentExecutionUiConfiguration("workflow-development"),
      allowedBrowserOrigins: ["http://localhost:5173"],
    });
    await expect((await host.request("http://api.test/api/v1/ui-configuration")).json()).resolves.toEqual({
      schemaVersion: 1,
      profile: "workflow-development",
      features: ["runs", "agent-authentication", "agent-templates", "workflows"],
    });
    const allowed = await host.request("http://api.test/api/v1/runs", {
      headers: { origin: "http://localhost:5173" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const rejected = await host.request("http://api.test/api/v1/runs", {
      headers: { origin: "http://localhost:5173.evil.example" },
    });
    expect(rejected.headers.has("access-control-allow-origin")).toBe(false);
  });
});

function principal(
  userId: string,
  roleId: string,
  permissions: string[],
): AuthorizedApplicationPrincipal {
  return {
    user: {
      schemaVersion: 1,
      userId,
      status: "active",
      identity: { providerId: "fixture", subjectId: userId },
      registeredAt: timestamp,
    },
    roles: [{ schemaVersion: 1, roleId, permissions }],
    permissions,
  };
}

function catalogEntry(
  executionId: string,
  userId: string,
  status: "running" | "complete" | "failed",
): RunCatalogEntry {
  return {
    runRef: { executionId },
    workflow,
    actor: { userId, roleId: userId === "owner" ? "runner" : "other-role" },
    createdAt: timestamp,
    runConfiguration: { configurationId: "fixture-v1", contentHash: configurationHash },
    status: status === "failed"
      ? { kind: "status", status, updatedAt: timestamp, message: "fixture failure" }
      : { kind: "status", status, updatedAt: timestamp },
    heartbeat: {
      kind: "heartbeat",
      status,
      lastEventType: status === "running" ? "agent.running" : `run.${status}`,
      updatedAt: timestamp,
    },
  };
}

function matches(entry: RunCatalogEntry, query: RunCatalogQuery): boolean {
  return (query.userId === undefined || entry.actor.userId === query.userId)
    && (query.status === undefined || entry.status?.status === query.status)
    && (query.workflow === undefined || (
      entry.workflow.kind === query.workflow.kind && entry.workflow.version === query.workflow.version
    ))
    && ((query.lifecycleStatus ?? "active") === "all"
      || (entry.lifecycleStatus ?? "active") === (query.lifecycleStatus ?? "active"));
}

function page(entries: RunCatalogEntry[], query: RunCatalogQuery) {
  const offset = query.cursor === undefined ? 0 : Number(query.cursor);
  const pageSize = query.pageSize ?? 100;
  const items = entries.slice(offset, offset + pageSize);
  const nextOffset = offset + items.length;
  return {
    items,
    ...(nextOffset < entries.length ? { nextCursor: String(nextOffset) } : {}),
  };
}

function provider<T>(stores: Map<string, T>) {
  return {
    open: vi.fn(async ({ executionId }: RunRef) => {
      const store = stores.get(executionId);
      if (!store) throw new Error(`Missing fixture store for ${executionId}.`);
      return store;
    }),
  };
}

function artifactStore(json: Record<string, unknown>): RunArtifactQueryStore {
  const encoded = new Map(Object.entries(json).map(([key, value]) => [key, new TextEncoder().encode(JSON.stringify(value))]));
  const items: StoredArtifact[] = [...encoded].map(([key, value]) => ({
    key,
    mediaType: "application/json",
    sizeBytes: value.byteLength,
    sha256: "b".repeat(64),
  }));
  return {
    list: async () => items,
    readText: async (key) => encoded.has(key) ? new TextDecoder().decode(encoded.get(key)) : undefined,
    readBytes: async (key) => encoded.get(key),
    readJson: async (key) => json[key],
  };
}

function resultStore(
  resultId?: string,
  envelope?: PublishedResultEnvelope,
): PublishedResultQueryStore {
  const reference: PublishedResultRef | undefined = resultId === undefined || envelope === undefined
    ? undefined
    : { runRef: envelope.runRef, resultKind: envelope.resultKind, resultId };
  return {
    list: async () => reference === undefined ? [] : [reference],
    get: async (candidate) => candidate.resultId === reference?.resultId ? envelope : undefined,
  };
}

function runPerformance(executionId: string): RunPerformance {
  return {
    schemaVersion: 1,
    runRef: { executionId },
    workflow,
    startedAt: timestamp,
    completedAt: "2026-08-05T12:00:01.000Z",
    totalElapsedMs: 1_000,
    stages: [{ stageId: "discovery", status: "complete", elapsedMs: 1_000 }],
    agentAttempts: [{
      stageId: "discovery",
      logicalAgentId: "discovery",
      metrics: {
        providerId: "pi-cli",
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
        status: "complete",
        elapsedMs: 1_000,
        artifacts: {
          eventsPath: "events.jsonl",
          stderrPath: "stderr.log",
          lastMessagePath: "last-message.txt",
          heartbeatPath: "heartbeat.json",
        },
        nativeToolCalls: 7,
        toolCallUnit: "guarded-repository-operation",
        repositorySearchCalls: 3,
        usage: {
          inputTokens: 100,
          cachedInputTokens: 25,
          outputTokens: 10,
          reasoningOutputTokens: 5,
          cost: { amount: 0.01, currency: "USD", kind: "provider-estimate" },
        },
      },
    }],
    usage: {
      inputTokens: 100,
      cachedInputTokens: 25,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      costs: [{ amount: 0.01, currency: "USD", kind: "provider-estimate" }],
    },
  };
}

function withHeader(init: RequestInit | undefined, name: string, value: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set(name, value);
  return { ...init, headers };
}
