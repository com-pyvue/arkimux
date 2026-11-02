import {
  ApplicationBoundaryError,
  authorizeRunRef,
  openAuthorizedRunStore,
  scopeRunCatalogQuery,
  type AuthorizedApplicationPrincipal,
  type RunScopedQueryStoreProvider,
} from "@com-pyvue/agent-execution-application-host";
import {
  artifactKeySchema,
  cancelRunRequestSchema,
  workflowListResponseSchema,
  publishedResultDtoSchema,
  publishedResultListResponseSchema,
  resolvedConfigurationResponseSchema,
  runFilterOptionsResponseSchema,
  runArtifactContentResponseSchema,
  runArtifactsResponseSchema,
  runComparisonRequestSchema,
  runComparisonResponseSchema,
  runDetailResponseSchema,
  runInputResponseSchema,
  runLifecycleResponseSchema,
  runListQuerySchema,
  runListResponseSchema,
  runPerformanceResponseSchema,
  submitRunRequestSchema,
  submitRunResponseSchema,
  workflowPreflightRequestSchema,
  workflowPreflightResponseSchema,
  type JsonValue,
  type CancelRunRequestDto,
  type WorkflowListResponseDto,
  type PublishedResultDto,
  type PublishedResultListResponseDto,
  type ResolvedConfigurationResponseDto,
  type RunArtifactContentResponseDto,
  type RunArtifactsResponseDto,
  type RunComparisonRequestDto,
  type RunComparisonResponseDto,
  type RunCorrectionLinkDto,
  type RunDetailResponseDto,
  type RunInputResponseDto,
  type RunLifecycleResponseDto,
  type RunFilterOptionsResponseDto,
  type RunListQueryDto,
  type RunListItemDto,
  type RunListResponseDto,
  type RunPerformanceResponseDto,
  type SubmitRunRequestDto,
  type SubmitRunResponseDto,
  type WorkflowPreflightRequestDto,
  type WorkflowPreflightResponseDto,
  type RunSummaryDto,
  type RunSummaryField,
  type RunNumericField,
  type RunSortField,
} from "@com-pyvue/agent-execution-run-contract";
import {
  validateWorkflowIdentity,
  type PublishedResultQueryStore,
  type RunArtifactQueryStore,
  type RunCatalogEntry,
  type RunCatalogStore,
  type WorkflowRunConfigurationStore,
  type RunDispatcher,
  type RunPerformance,
  type RunPerformanceQueryStore,
  type RunRef,
} from "@com-pyvue/agent-execution-core";
import {
  CodedWorkflowRegistry,
  UnknownCodedWorkflowError,
  type GenericRunConfiguration,
} from "./workflowRegistry.ts";
import type { InputUploadDto, RunInputRequests } from "./inputRequests.ts";
import type { RunCorrectionLinks } from "./runCorrections.ts";
import { inputRequestsResponseSchema, inputSubmissionResponseSchema, inputUploadResponseSchema,
  workflowInvocationOptionsRequestSchema, workflowInvocationOptionsResponseSchema,
  type InputSubmissionDto, type WorkflowInvocationOptionsRequestDto,
  type WorkflowInvocationOptionsResponseDto } from "@com-pyvue/agent-execution-run-contract";

export interface RunApplicationServiceDependencies {
  inputRequests?: RunInputRequests;
  corrections?: RunCorrectionLinks;
  catalog: RunCatalogStore;
  artifacts: RunScopedQueryStoreProvider<RunArtifactQueryStore>;
  results: RunScopedQueryStoreProvider<PublishedResultQueryStore>;
  performance: RunScopedQueryStoreProvider<RunPerformanceQueryStore>;
  runConfigurations: WorkflowRunConfigurationStore<GenericRunConfiguration>;
  dispatcher: RunDispatcher<unknown>;
  workflows: CodedWorkflowRegistry;
  /** Recheck host-owned Connection lifecycle/schema before any run reservation. */
  connectionPreflight?(configuration: GenericRunConfiguration): Promise<WorkflowPreflightResponseDto>;
}

export class RunApplicationService {
  constructor(private readonly dependencies: RunApplicationServiceDependencies) {}

  async listInputRequests(principal: AuthorizedApplicationPrincipal, ref: RunRef) {
    await authorizeRunRef(principal, this.dependencies.catalog, ref);
    if (!this.dependencies.inputRequests) return inputRequestsResponseSchema.parse({ schemaVersion: 1, runRef: ref, items: [] });
    return inputRequestsResponseSchema.parse(await this.dependencies.inputRequests.list(ref));
  }

  async submitInputResponse(principal: AuthorizedApplicationPrincipal, ref: RunRef, requestId: string, body: InputSubmissionDto) {
    await this.#authorizeInputResponse(principal, ref);
    if (!this.dependencies.inputRequests) throw new ApplicationBoundaryError("not-found", 404, "Input request does not exist.");
    return inputSubmissionResponseSchema.parse(await this.dependencies.inputRequests.submit(ref, requestId, body, principal.user.userId));
  }

  async uploadInputFile(principal: AuthorizedApplicationPrincipal, ref: RunRef, requestId: string, body: InputUploadDto) {
    await this.#authorizeInputResponse(principal, ref);
    if (!this.dependencies.inputRequests) throw new ApplicationBoundaryError("not-found", 404, "Input request does not exist.");
    return inputUploadResponseSchema.parse(await this.dependencies.inputRequests.upload(ref, requestId, body));
  }

  async #authorizeInputResponse(principal: AuthorizedApplicationPrincipal, ref: RunRef): Promise<void> {
    const entry = await authorizeRunRef(principal, this.dependencies.catalog, ref);
    if (!principal.permissions.includes("runs:respond-all")
      && !(entry.actor.userId === principal.user.userId && principal.permissions.includes("runs:respond-own"))) {
      throw new ApplicationBoundaryError("forbidden", 403, "Permission to respond to this Run is required.");
    }
  }

  async submit(
    principal: AuthorizedApplicationPrincipal,
    input: SubmitRunRequestDto,
  ): Promise<SubmitRunResponseDto> {
    const request = submitRunRequestSchema.parse(input);
    let registration;
    try {
      registration = this.dependencies.workflows.resolve(request.workflow);
    } catch (error) {
      if (error instanceof UnknownCodedWorkflowError) {
        throw new ApplicationBoundaryError("not-found", 404, error.message);
      }
      throw error;
    }
    const role = principal.roles.find(({ roleId }) => roleId === request.roleId);
    if (!role) {
      throw new ApplicationBoundaryError("forbidden", 403, `Role ${request.roleId} is not currently assigned.`);
    }
    const permission = `workflow:${request.workflow.kind}:start`;
    if (!role.permissions.includes(permission)) {
      throw new ApplicationBoundaryError("forbidden", 403, `Role ${request.roleId} does not grant ${permission}.`);
    }
    const prior = request.correction === undefined
      ? undefined
      : await this.#authorizeCorrection(principal, request.correction.priorRunRef, request.workflow);
    if (prior && request.requestedExecutionId === prior.runRef.executionId) {
      throw new ApplicationBoundaryError("invalid-request", 400, "A corrected Run must have a different Run ID.");
    }
    const resolvedConfiguration = await this.dependencies.runConfigurations.resolve(
      request.workflow,
      request.runConfigurationId,
    );
    if (!resolvedConfiguration) {
      throw new ApplicationBoundaryError(
        "not-found",
        404,
        `Run configuration ${request.runConfigurationId} does not exist.`,
      );
    }
    if (await this.dependencies.runConfigurations.lifecycleStatus(
      request.workflow,
      request.runConfigurationId,
    ) !== "active") {
      throw new ApplicationBoundaryError(
        "conflict",
        409,
        `Run configuration ${request.runConfigurationId} is archived and cannot start new runs.`,
      );
    }
    const configuredWorkflow = validateWorkflowIdentity(resolvedConfiguration.configuration.workflow);
    if (
      configuredWorkflow.kind !== request.workflow.kind
      || configuredWorkflow.version !== request.workflow.version
    ) {
      throw new ApplicationBoundaryError(
        "invalid-request",
        400,
        `Run configuration workflow is ${configuredWorkflow.kind}@${configuredWorkflow.version}.`,
      );
    }
    let workflowInput: unknown;
    try {
      workflowInput = registration.validateInput(request.input);
    } catch (error) {
      throw new ApplicationBoundaryError("invalid-request", 400, (error as Error).message);
    }
    const actor = { userId: principal.user.userId, roleId: role.roleId };
    const connections = await this.dependencies.connectionPreflight?.(resolvedConfiguration.configuration);
    if (connections && !connections.available) {
      throw new ApplicationBoundaryError("provider-unavailable", 503, preflightFailureMessage(connections));
    }
    if (registration.preflight) {
      const readiness = workflowPreflightResponseSchema.parse(await registration.preflight({
        actor,
        workflow: request.workflow,
        resolvedConfiguration,
      }));
      if (!readiness.available) {
        throw new ApplicationBoundaryError(
          "provider-unavailable",
          503,
          preflightFailureMessage(readiness),
        );
      }
    }
    if (prior && isActiveRun(prior)) {
      if (request.correction!.activeOriginal === "reject") {
        throw new ApplicationBoundaryError("conflict", 409,
          "The prior Run is still active. Retry with activeOriginal set to cancel after confirming the correction warning.");
      }
      if (!registration.cancel) {
        throw new ApplicationBoundaryError("service-unavailable", 503,
          "This workflow runtime cannot cancel the active prior Run.");
      }
      await registration.cancel(prior.runRef);
      const checked = await this.dependencies.catalog.get(prior.runRef);
      if (!checked || isActiveRun(checked)) {
        throw new ApplicationBoundaryError("conflict", 409,
          "The prior Run did not reach a terminal state, so the corrected Run was not started.");
      }
    }
    const runRef = await registration.reserve({
      actor,
      workflow: request.workflow,
      input: workflowInput,
      resolvedConfiguration,
      ...(request.requestedExecutionId === undefined ? {} : { requestedExecutionId: request.requestedExecutionId }),
    });
    let correction: RunCorrectionLinkDto | undefined;
    if (prior) {
      if (!this.dependencies.corrections) {
        await registration.cancel?.(runRef);
        throw new ApplicationBoundaryError("service-unavailable", 503,
          "Run correction lineage storage is unavailable.");
      }
      try {
        correction = await this.dependencies.corrections.create({
          schemaVersion: 1,
          priorRunRef: prior.runRef,
          correctedRunRef: runRef,
          createdAt: new Date().toISOString(),
        });
      } catch {
        await registration.cancel?.(runRef);
        throw new ApplicationBoundaryError("service-unavailable", 503,
          "The corrected Run link could not be retained, so the new Run was not dispatched.");
      }
    }
    try {
      await this.dependencies.dispatcher.dispatch({
        runRef,
        actor,
        workflow: request.workflow,
        input: workflowInput,
        runConfiguration: {
          configurationId: resolvedConfiguration.configuration.configurationId,
          contentHash: resolvedConfiguration.contentHash,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown dispatcher error";
      throw new ApplicationBoundaryError("dispatch-rejected", 503, `Run dispatch was rejected: ${message}`);
    }
    return submitRunResponseSchema.parse({ runRef, ...(correction ? { correction } : {}) });
  }

  async preflight(
    principal: AuthorizedApplicationPrincipal,
    input: WorkflowPreflightRequestDto,
  ): Promise<WorkflowPreflightResponseDto> {
    const request = workflowPreflightRequestSchema.parse(input);
    let registration;
    try {
      registration = this.dependencies.workflows.resolve(request.workflow);
    } catch (error) {
      if (error instanceof UnknownCodedWorkflowError) {
        throw new ApplicationBoundaryError("not-found", 404, error.message);
      }
      throw error;
    }
    const role = principal.roles.find(({ roleId }) => roleId === request.roleId);
    if (!role) {
      throw new ApplicationBoundaryError("forbidden", 403, `Role ${request.roleId} is not currently assigned.`);
    }
    const permission = `workflow:${request.workflow.kind}:start`;
    if (!role.permissions.includes(permission)) {
      throw new ApplicationBoundaryError("forbidden", 403, `Role ${request.roleId} does not grant ${permission}.`);
    }
    const resolvedConfiguration = await this.dependencies.runConfigurations.resolve(
      request.workflow,
      request.runConfigurationId,
    );
    if (!resolvedConfiguration) {
      throw new ApplicationBoundaryError(
        "not-found",
        404,
        `Run configuration ${request.runConfigurationId} does not exist.`,
      );
    }
    if (await this.dependencies.runConfigurations.lifecycleStatus(
      request.workflow,
      request.runConfigurationId,
    ) !== "active") {
      throw new ApplicationBoundaryError(
        "conflict",
        409,
        `Run configuration ${request.runConfigurationId} is archived and cannot start new runs.`,
      );
    }
    const connections = await this.dependencies.connectionPreflight?.(resolvedConfiguration.configuration);
    if (connections && !connections.available) return workflowPreflightResponseSchema.parse(connections);
    if (!registration.preflight) return workflowPreflightResponseSchema.parse({ available: true, agents: [] });
    return workflowPreflightResponseSchema.parse(await registration.preflight({
      actor: { userId: principal.user.userId, roleId: role.roleId },
      workflow: request.workflow,
      resolvedConfiguration,
    }));
  }

  async invocationOptions(
    principal: AuthorizedApplicationPrincipal,
    input: WorkflowInvocationOptionsRequestDto,
  ): Promise<WorkflowInvocationOptionsResponseDto> {
    const request = workflowInvocationOptionsRequestSchema.parse(input);
    const registration = this.#registration(request.workflow);
    const role = principal.roles.find(({ roleId }) => roleId === request.roleId);
    if (!role) throw new ApplicationBoundaryError("forbidden", 403, `Role ${request.roleId} is not currently assigned.`);
    const permission = `workflow:${request.workflow.kind}:start`;
    if (!role.permissions.includes(permission)) {
      throw new ApplicationBoundaryError("forbidden", 403, `Role ${request.roleId} does not grant ${permission}.`);
    }
    const resolvedConfiguration = await this.dependencies.runConfigurations.resolve(
      request.workflow,
      request.runConfigurationId,
    );
    if (!resolvedConfiguration) {
      throw new ApplicationBoundaryError("not-found", 404, `Run configuration ${request.runConfigurationId} does not exist.`);
    }
    if (await this.dependencies.runConfigurations.lifecycleStatus(
      request.workflow,
      request.runConfigurationId,
    ) !== "active") {
      throw new ApplicationBoundaryError(
        "conflict",
        409,
        `Run configuration ${request.runConfigurationId} is archived and cannot start new runs.`,
      );
    }
    if (registration.invocationModel !== "graph-entry") {
      return workflowInvocationOptionsResponseSchema.parse({ model: "workflow-input" });
    }
    if (!registration.describeInvocation) {
      throw new ApplicationBoundaryError("service-unavailable", 503,
        "This graph workflow cannot describe its invocation entries.");
    }
    return workflowInvocationOptionsResponseSchema.parse(await registration.describeInvocation({
      actor: { userId: principal.user.userId, roleId: role.roleId },
      workflow: request.workflow,
      resolvedConfiguration,
    }));
  }

  async listWorkflows(
    principal: AuthorizedApplicationPrincipal,
  ): Promise<WorkflowListResponseDto> {
    return workflowListResponseSchema.parse({
      items: this.dependencies.workflows.list().map((registration) => {
        const permission = `workflow:${registration.workflow.kind}:start`;
        return {
          workflow: registration.workflow,
          ...(registration.invocationModel === "graph-entry" ? { invocationModel: "graph-entry" as const } : {}),
          title: registration.title ?? registration.workflow.kind,
          ...(registration.description === undefined ? {} : { description: registration.description }),
          inputExample: registration.inputExample ?? {},
          agentSlots: registration.agentSlots ?? [],
          ...(registration.runConfigurationBase === undefined
            ? {}
            : { runConfigurationBase: registration.runConfigurationBase }),
          allowedRoleIds: principal.roles
            .filter((role) => role.permissions.includes(permission))
            .map((role) => role.roleId),
        };
      }),
    });
  }

  async list(
    principal: AuthorizedApplicationPrincipal,
    input: RunListQueryDto,
  ): Promise<RunListResponseDto> {
    const parsed = runListQuerySchema.parse(input);
    const {
      summaryFields = [],
      providers,
      models,
      numericRange,
      sort = { field: "createdAt" as const, direction: "desc" as const },
      pageSize = 50,
      cursor,
      ...catalogQuery
    } = parsed;
    const scopedQuery = scopeRunCatalogQuery(principal, catalogQuery);
    const requiredSummaryFields = requiredFields(summaryFields, providers, models, numericRange?.field, sort.field);
    if (
      (providers?.length ?? 0) === 0
      && (models?.length ?? 0) === 0
      && (numericRange === undefined || (numericRange.min == null && numericRange.max == null))
      && sort.field === "createdAt"
      && sort.direction === "desc"
    ) {
      const page = await this.dependencies.catalog.list({
        ...scopedQuery,
        pageSize,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const items = requiredSummaryFields.length === 0
        ? page.items
        : await mapWithConcurrency(page.items, 8, async (entry): Promise<RunListItemDto> => ({
          ...entry,
          summary: await this.#summary(entry, requiredSummaryFields),
        }));
      return runListResponseSchema.parse({
        items: items.map((entry) => projectSummary(entry, summaryFields)),
        pagination: page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor },
      });
    }
    const catalogEntries = await collectCatalogEntries(this.dependencies.catalog, scopedQuery);
    const enriched = requiredSummaryFields.length === 0
      ? catalogEntries
      : await mapWithConcurrency(catalogEntries, 8, async (entry): Promise<RunListItemDto> => ({
        ...entry,
        summary: await this.#summary(entry, requiredSummaryFields),
      }));
    const filtered = enriched.filter((entry) => matchesDerivedFilters(entry, providers, models, numericRange));
    filtered.sort((left, right) => compareRunItems(left, right, sort.field, sort.direction));
    const offset = decodeOffsetCursor(cursor);
    const items = filtered.slice(offset, offset + pageSize).map((entry) => projectSummary(entry, summaryFields));
    const nextOffset = offset + items.length;
    return runListResponseSchema.parse({
      items,
      pagination: nextOffset >= filtered.length ? {} : { nextCursor: encodeOffsetCursor(nextOffset) },
    });
  }

  async filterOptions(principal: AuthorizedApplicationPrincipal): Promise<RunFilterOptionsResponseDto> {
    const scoped = scopeRunCatalogQuery(principal, { lifecycleStatus: "all" });
    const entries = await collectCatalogEntries(this.dependencies.catalog, scoped);
    const summaries = await mapWithConcurrency(entries, 8, (entry) => this.#summary(entry, ["provider", "model"]));
    return runFilterOptionsResponseSchema.parse({
      providers: uniqueSorted(summaries.flatMap(({ providers }) => providers ?? [])),
      models: uniqueSorted(summaries.flatMap(({ models }) => models ?? [])),
      numericFields: runNumericFields,
    });
  }

  async archive(
    principal: AuthorizedApplicationPrincipal,
    runRef: RunRef,
  ): Promise<RunLifecycleResponseDto> {
    const entry = await authorizeRunRef(principal, this.dependencies.catalog, runRef);
    requireRunLifecyclePermission(principal, entry);
    if (entry.status?.status !== "complete" && entry.status?.status !== "failed" && entry.status?.status !== "cancelled") {
      throw new ApplicationBoundaryError("conflict", 409, "Only completed, failed or cancelled runs can be archived.");
    }
    await this.dependencies.catalog.archive(runRef, new Date().toISOString());
    const run = await this.dependencies.catalog.get(runRef);
    if (!run) throw new ApplicationBoundaryError("not-found", 404, `Run ${runRef.executionId} does not exist.`);
    return runLifecycleResponseSchema.parse({ run });
  }

  async restore(
    principal: AuthorizedApplicationPrincipal,
    runRef: RunRef,
  ): Promise<RunLifecycleResponseDto> {
    const entry = await authorizeRunRef(principal, this.dependencies.catalog, runRef);
    requireRunLifecyclePermission(principal, entry);
    await this.dependencies.catalog.restore(runRef, new Date().toISOString());
    const run = await this.dependencies.catalog.get(runRef);
    if (!run) throw new ApplicationBoundaryError("not-found", 404, `Run ${runRef.executionId} does not exist.`);
    return runLifecycleResponseSchema.parse({ run });
  }

  async cancel(
    principal: AuthorizedApplicationPrincipal,
    runRef: RunRef,
    input: CancelRunRequestDto,
  ): Promise<RunLifecycleResponseDto> {
    cancelRunRequestSchema.parse(input);
    const entry = await authorizeRunRef(principal, this.dependencies.catalog, runRef);
    requireRunResponsePermission(principal, entry, "cancel");
    if (!isActiveRun(entry)) return runLifecycleResponseSchema.parse({ run: entry });
    const registration = this.#registration(entry.workflow);
    if (!registration.cancel) {
      throw new ApplicationBoundaryError("service-unavailable", 503,
        "This workflow runtime cannot cancel the active Run.");
    }
    await registration.cancel(runRef);
    const checked = await this.dependencies.catalog.get(runRef);
    if (!checked) throw new ApplicationBoundaryError("not-found", 404, `Run ${runRef.executionId} does not exist.`);
    if (isActiveRun(checked)) {
      throw new ApplicationBoundaryError("conflict", 409, "The Run did not reach a terminal state after cancellation.");
    }
    return runLifecycleResponseSchema.parse({ run: checked });
  }

  async get(principal: AuthorizedApplicationPrincipal, runRef: RunRef): Promise<RunDetailResponseDto> {
    const run = await authorizeRunRef(principal, this.dependencies.catalog, runRef);
    const [candidateCorrection, candidateCorrectedRuns] = this.dependencies.corrections
      ? await Promise.all([
        this.dependencies.corrections.getByCorrectedRun(runRef),
        this.dependencies.corrections.listByPriorRun(runRef),
      ])
      : [undefined, []];
    const correction = candidateCorrection
      && await canReadRun(principal, this.dependencies.catalog, candidateCorrection.priorRunRef)
      ? candidateCorrection
      : null;
    const correctedRuns = (await Promise.all(candidateCorrectedRuns.map(async (link) => (
      await canReadRun(principal, this.dependencies.catalog, link.correctedRunRef) ? link : undefined
    )))).filter((link): link is RunCorrectionLinkDto => link !== undefined);
    return runDetailResponseSchema.parse({ run, correction: correction ?? null, correctedRuns });
  }

  async #authorizeCorrection(
    principal: AuthorizedApplicationPrincipal,
    priorRunRef: RunRef,
    workflow: { kind: string; version: number },
  ): Promise<RunCatalogEntry> {
    if (!this.dependencies.corrections) {
      throw new ApplicationBoundaryError("service-unavailable", 503, "Run correction lineage storage is unavailable.");
    }
    const prior = await authorizeRunRef(principal, this.dependencies.catalog, priorRunRef);
    requireRunResponsePermission(principal, prior, "correct");
    if (prior.workflow.kind !== workflow.kind || prior.workflow.version !== workflow.version) {
      throw new ApplicationBoundaryError("invalid-request", 400,
        "A corrected Run must use the same workflow identity as its prior Run.");
    }
    return prior;
  }

  #registration(workflow: { kind: string; version: number }) {
    try { return this.dependencies.workflows.resolve(workflow); }
    catch (error) {
      if (error instanceof UnknownCodedWorkflowError) {
        throw new ApplicationBoundaryError("not-found", 404, error.message);
      }
      throw error;
    }
  }

  async listArtifacts(
    principal: AuthorizedApplicationPrincipal,
    runRef: RunRef,
  ): Promise<RunArtifactsResponseDto> {
    const store = await openAuthorizedRunStore(
      principal,
      this.dependencies.catalog,
      runRef,
      (authorized) => this.dependencies.artifacts.open(authorized),
    );
    return runArtifactsResponseSchema.parse({ runRef, items: await store.list() });
  }

  async getArtifactContent(
    principal: AuthorizedApplicationPrincipal,
    runRef: RunRef,
    key: string,
  ): Promise<RunArtifactContentResponseDto> {
    const artifactKey = artifactKeySchema.parse(key);
    const store = await openAuthorizedRunStore(
      principal,
      this.dependencies.catalog,
      runRef,
      (authorized) => this.dependencies.artifacts.open(authorized),
    );
    const artifact = (await store.list()).find((candidate) => candidate.key === artifactKey);
    if (!artifact) {
      throw new ApplicationBoundaryError("not-found", 404, `Run artifact ${artifactKey} does not exist.`);
    }
    const bytes = await store.readBytes(artifactKey);
    if (!bytes) {
      throw new ApplicationBoundaryError("not-found", 404, `Run artifact ${artifactKey} does not exist.`);
    }
    const text = isTextArtifact(artifact.mediaType);
    return runArtifactContentResponseSchema.parse({
      runRef,
      artifact,
      encoding: text ? "utf8" : "base64",
      content: text ? new TextDecoder().decode(bytes) : bytesToBase64(bytes),
    });
  }

  async getInput(
    principal: AuthorizedApplicationPrincipal,
    runRef: RunRef,
  ): Promise<RunInputResponseDto> {
    const store = await openAuthorizedRunStore(
      principal,
      this.dependencies.catalog,
      runRef,
      (authorized) => this.dependencies.artifacts.open(authorized),
    );
    return runInputResponseSchema.parse({
      runRef,
      input: await store.readJson("artifacts/input.json") as JsonValue | undefined ?? null,
    });
  }

  async listResults(
    principal: AuthorizedApplicationPrincipal,
    runRef: RunRef,
  ): Promise<PublishedResultListResponseDto> {
    const store = await openAuthorizedRunStore(
      principal,
      this.dependencies.catalog,
      runRef,
      (authorized) => this.dependencies.results.open(authorized),
    );
    const references = await store.list();
    const items = await Promise.all(references.map(async (reference) => {
      const result = await store.get(reference);
      if (!result) throw new Error(`Published result ${reference.resultId} disappeared while listing.`);
      return {
        ...reference,
        payloadSchemaVersion: payloadSchemaVersion(result.payload),
      };
    }));
    return publishedResultListResponseSchema.parse({ runRef, items });
  }

  async getResult(
    principal: AuthorizedApplicationPrincipal,
    runRef: RunRef,
    resultId: string,
  ): Promise<PublishedResultDto> {
    const store = await openAuthorizedRunStore(
      principal,
      this.dependencies.catalog,
      runRef,
      (authorized) => this.dependencies.results.open(authorized),
    );
    const reference = (await store.list()).find((candidate) => candidate.resultId === resultId);
    if (!reference) {
      throw new ApplicationBoundaryError("not-found", 404, `Published result ${resultId} does not exist.`);
    }
    const result = await store.get(reference);
    if (!result) throw new ApplicationBoundaryError("not-found", 404, `Published result ${resultId} does not exist.`);
    return publishedResultDtoSchema.parse({ resultId, ...result });
  }

  async getPerformance(
    principal: AuthorizedApplicationPrincipal,
    runRef: RunRef,
  ): Promise<RunPerformanceResponseDto> {
    const store = await openAuthorizedRunStore(
      principal,
      this.dependencies.catalog,
      runRef,
      (authorized) => this.dependencies.performance.open(authorized),
    );
    return runPerformanceResponseSchema.parse({ runRef, performance: await store.get(runRef) ?? null });
  }

  async getResolvedConfiguration(
    principal: AuthorizedApplicationPrincipal,
    runRef: RunRef,
  ): Promise<ResolvedConfigurationResponseDto> {
    const store = await openAuthorizedRunStore(
      principal,
      this.dependencies.catalog,
      runRef,
      (authorized) => this.dependencies.artifacts.open(authorized),
    );
    return resolvedConfigurationResponseSchema.parse({
      runRef,
      resolvedConfiguration: await store.readJson("state/run-config.resolved.json") as JsonValue | undefined ?? null,
    });
  }

  async compare(
    principal: AuthorizedApplicationPrincipal,
    input: RunComparisonRequestDto,
  ): Promise<RunComparisonResponseDto> {
    const request = runComparisonRequestSchema.parse(input);
    const rows = await Promise.all(request.executionIds.map(async (executionId) => {
      const runRef = { executionId };
      const entry = await authorizeRunRef(principal, this.dependencies.catalog, runRef);
      const [performanceStore, artifactStore] = await Promise.all([
        this.dependencies.performance.open(entry.runRef),
        this.dependencies.artifacts.open(entry.runRef),
      ]);
      const [performance, resolvedConfiguration] = await Promise.all([
        performanceStore.get(entry.runRef),
        artifactStore.readJson("state/run-config.resolved.json"),
      ]);
      return comparisonRow(entry, performance, resolvedConfiguration);
    }));
    return runComparisonResponseSchema.parse({ rows });
  }

  async #summary(entry: RunCatalogEntry, fields: RunSummaryField[]): Promise<RunSummaryDto> {
    const needsConfiguration = fields.some((field) => identitySummaryFields.has(field));
    const performanceStore = await this.dependencies.performance.open(entry.runRef);
    const artifactStore = needsConfiguration ? await this.dependencies.artifacts.open(entry.runRef) : undefined;
    const [performance, resolvedConfiguration] = await Promise.all([
      performanceStore.get(entry.runRef),
      artifactStore?.readJson("state/run-config.resolved.json"),
    ]);
    return summaryProjection(performance, resolvedConfiguration, fields);
  }
}

function preflightFailureMessage(readiness: WorkflowPreflightResponseDto): string {
  const failures = readiness.agents
    .filter(({ available }) => !available)
    .map(({ slotId, message }) => `${slotId}: ${message ?? "agent provider is unavailable"}`);
  return failures.length === 0
    ? "Workflow runtime preflight failed."
    : `Workflow runtime preflight failed: ${failures.join("; ")}`;
}

function isActiveRun(entry: RunCatalogEntry): boolean {
  return entry.status?.status === undefined
    || entry.status.status === "running"
    || entry.status.status === "waiting_for_input"
    || entry.status.status === "resume_queued";
}

function requireRunResponsePermission(
  principal: AuthorizedApplicationPrincipal,
  entry: RunCatalogEntry,
  action: "cancel" | "correct",
): void {
  if (principal.permissions.includes("runs:respond-all")) return;
  if (entry.actor.userId === principal.user.userId && principal.permissions.includes("runs:respond-own")) return;
  throw new ApplicationBoundaryError("forbidden", 403, `Permission to ${action} this Run is required.`);
}

async function canReadRun(
  principal: AuthorizedApplicationPrincipal,
  catalog: RunCatalogStore,
  runRef: RunRef,
): Promise<boolean> {
  const entry = await catalog.get(runRef);
  if (!entry) return false;
  return principal.permissions.includes("runs:read-all")
    || (principal.permissions.includes("runs:read-own") && entry.actor.userId === principal.user.userId);
}

function payloadSchemaVersion(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = Reflect.get(payload, "schemaVersion");
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : null;
}

function isTextArtifact(mediaType: string): boolean {
  return mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType === "application/x-ndjson"
    || mediaType.endsWith("+json");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function comparisonRow(
  entry: RunCatalogEntry,
  performance: RunPerformance | undefined,
  resolvedConfiguration: unknown,
) {
  const summary = summaryProjection(performance, resolvedConfiguration, allSummaryFields);
  return {
    runRef: entry.runRef,
    status: entry.status?.status ?? null,
    userId: entry.actor.userId,
    roleId: entry.actor.roleId,
    workflow: entry.workflow,
    target: entry.target ?? null,
    runConfiguration: entry.runConfiguration ?? null,
    provider: summary.provider ?? null,
    model: summary.model ?? null,
    providers: summary.providers ?? [],
    models: summary.models ?? [],
    reasoningEffort: summary.reasoningEffort ?? null,
    speed: summary.speed ?? null,
    durationMs: summary.totalElapsedMs ?? null,
    inputTokens: summary.inputTokens ?? null,
    cachedInputTokens: summary.cachedInputTokens ?? null,
    outputTokens: summary.outputTokens ?? null,
    reasoningOutputTokens: summary.reasoningOutputTokens ?? null,
    costs: summary.costs ?? null,
    toolCalls: summary.toolCalls ?? null,
    searchCalls: summary.searchCalls ?? null,
  };
}

const allSummaryFields: RunSummaryField[] = [
  "totalElapsedMs",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "costs",
  "toolCalls",
  "searchCalls",
  "provider",
  "model",
  "reasoningEffort",
  "speed",
];
const identitySummaryFields = new Set<RunSummaryField>(["provider", "model", "reasoningEffort", "speed"]);

function summaryProjection(
  performance: RunPerformance | undefined,
  resolvedConfiguration: unknown,
  fields: RunSummaryField[],
): RunSummaryDto {
  const attempts = performance?.agentAttempts ?? [];
  const providers = identityValues(
    attempts.map(({ metrics }) => metrics.providerId),
    configuredAgentValues(resolvedConfiguration, "provider"),
  );
  const models = identityValues(
    attempts.flatMap(({ metrics }) => metrics.model === undefined ? [] : [metrics.model]),
    configuredAgentParameterValues(resolvedConfiguration, ["model"]),
  );
  const values: Record<RunSummaryField, RunSummaryDto[keyof RunSummaryDto]> = {
    totalElapsedMs: performance?.totalElapsedMs ?? null,
    inputTokens: performance?.usage?.inputTokens ?? null,
    cachedInputTokens: performance?.usage?.cachedInputTokens ?? null,
    outputTokens: performance?.usage?.outputTokens ?? null,
    reasoningOutputTokens: performance?.usage?.reasoningOutputTokens ?? null,
    costs: performance?.usage?.costs ?? null,
    toolCalls: performance === undefined
      ? null
      : attempts.reduce((sum, attempt) => sum + attempt.metrics.nativeToolCalls, 0),
    searchCalls: performance === undefined || attempts.every(({ metrics }) => metrics.repositorySearchCalls === undefined)
      ? null
      : attempts.reduce((sum, attempt) => sum + (attempt.metrics.repositorySearchCalls ?? 0), 0),
    provider: oneOrMixed(providers, []),
    model: oneOrMixed(models, []),
    reasoningEffort: oneOrMixed(
      attempts.flatMap(({ metrics }) => metrics.reasoningEffort === undefined ? [] : [metrics.reasoningEffort]),
      configuredAgentParameterValues(resolvedConfiguration, ["model_reasoning_effort", "thinking"]),
    ),
    speed: oneOrMixed([], configuredAgentParameterValues(resolvedConfiguration, ["speed", "service_tier"])),
  };
  const projection: RunSummaryDto = Object.fromEntries(fields.map((field) => [field, values[field]]));
  if (fields.includes("provider")) projection.providers = providers;
  if (fields.includes("model")) projection.models = models;
  return projection;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  task: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const output = new Array<TOutput>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await task(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

function configuredAgentValues(value: unknown, field: string): string[] {
  return configuredAgents(value).flatMap((agent) => {
    const execution = record(agent.execution);
    const candidate = execution?.[field];
    return typeof candidate === "string" ? [candidate] : [];
  });
}

function configuredAgentParameterValues(value: unknown, fields: string[]): string[] {
  return configuredAgents(value).flatMap((agent) => {
    const parameters = record(record(agent.execution)?.parameters);
    for (const field of fields) {
      const candidate = parameters?.[field];
      if (typeof candidate === "string") return [candidate];
    }
    return [];
  });
}

function configuredAgents(value: unknown): Record<string, unknown>[] {
  const agents = record(record(value)?.agents);
  return agents === undefined ? [] : Object.values(agents).flatMap((agent) => {
    const parsed = record(agent);
    return parsed === undefined ? [] : [parsed];
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function oneOrMixed(primary: string[], fallback: string[]): string | null {
  const values = [...new Set(primary.length > 0 ? primary : fallback)].sort();
  if (values.length === 0) return null;
  return values.length === 1 ? values[0] : "mixed";
}

const runNumericFields: RunNumericField[] = [
  "totalElapsedMs",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "toolCalls",
  "searchCalls",
];

function identityValues(primary: string[], fallback: string[]): string[] {
  return uniqueSorted([...primary, ...fallback]);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

async function collectCatalogEntries(
  catalog: RunCatalogStore,
  query: Parameters<RunCatalogStore["list"]>[0],
): Promise<RunCatalogEntry[]> {
  const items: RunCatalogEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await catalog.list({
      ...query,
      pageSize: 500,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
}

function requiredFields(
  requested: RunSummaryField[],
  providers: string[] | undefined,
  models: string[] | undefined,
  numericField: RunNumericField | undefined,
  sortField: RunSortField,
): RunSummaryField[] {
  const required = new Set<RunSummaryField>(requested);
  if ((providers?.length ?? 0) > 0) required.add("provider");
  if ((models?.length ?? 0) > 0) required.add("model");
  if (numericField !== undefined) required.add(numericField);
  if (summarySortFields.has(sortField)) required.add(sortField as RunSummaryField);
  return [...required];
}

function matchesDerivedFilters(
  entry: RunListItemDto,
  providers: string[] | undefined,
  models: string[] | undefined,
  numericRange: RunListQueryDto["numericRange"],
): boolean {
  if ((providers?.length ?? 0) > 0 && !providers!.some((value) => entry.summary?.providers?.includes(value))) {
    return false;
  }
  if ((models?.length ?? 0) > 0 && !models!.some((value) => entry.summary?.models?.includes(value))) {
    return false;
  }
  if (numericRange !== undefined && (numericRange.min != null || numericRange.max != null)) {
    const candidate = entry.summary?.[numericRange.field];
    if (typeof candidate !== "number") return false;
    if (numericRange.min != null && candidate < numericRange.min) return false;
    if (numericRange.max != null && candidate > numericRange.max) return false;
  }
  return true;
}

const summarySortFields = new Set<RunSortField>([
  "provider",
  "model",
  "reasoningEffort",
  "speed",
  ...runNumericFields,
]);

function compareRunItems(
  left: RunListItemDto,
  right: RunListItemDto,
  field: RunSortField,
  direction: "asc" | "desc",
): number {
  const leftValue = sortableValue(left, field);
  const rightValue = sortableValue(right, field);
  const nullOrder = leftValue == null ? (rightValue == null ? 0 : 1) : rightValue == null ? -1 : 0;
  if (nullOrder !== 0) return nullOrder;
  const compared = typeof leftValue === "number" && typeof rightValue === "number"
      ? leftValue - rightValue
      : String(leftValue).localeCompare(String(rightValue));
  if (compared === 0) return left.runRef.executionId.localeCompare(right.runRef.executionId);
  return direction === "asc" ? compared : -compared;
}

function sortableValue(entry: RunListItemDto, field: RunSortField): string | number | null {
  switch (field) {
    case "executionId": return entry.runRef.executionId;
    case "workflow": return `${entry.workflow.kind}@${entry.workflow.version}`;
    case "status": return entry.status?.status ?? null;
    case "userId": return entry.actor.userId;
    case "roleId": return entry.actor.roleId;
    case "createdAt": return entry.createdAt;
    default: {
      const value = entry.summary?.[field as keyof RunSummaryDto];
      return typeof value === "string" || typeof value === "number" ? value : null;
    }
  }
}

function projectSummary(entry: RunListItemDto, requested: RunSummaryField[]): RunListItemDto {
  if (requested.length === 0) {
    const { summary: _summary, ...catalogEntry } = entry;
    return catalogEntry;
  }
  const summary: RunSummaryDto = Object.fromEntries(requested.map((field) => [field, entry.summary?.[field] ?? null]));
  return { ...entry, summary };
}

function encodeOffsetCursor(offset: number): string {
  return String(offset);
}

function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^(\d+)$/.exec(cursor);
  if (!match) throw new ApplicationBoundaryError("invalid-request", 400, "Run cursor is invalid.");
  return Number(match[1]);
}

function requireRunLifecyclePermission(
  principal: AuthorizedApplicationPrincipal,
  entry: RunCatalogEntry,
): void {
  if (principal.permissions.includes("runs:archive-all")) return;
  if (entry.actor.userId === principal.user.userId && principal.permissions.includes("runs:archive-own")) return;
  throw new ApplicationBoundaryError("forbidden", 403, "Permission runs:archive-own or runs:archive-all is required.");
}
