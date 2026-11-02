/** Public V2 session coordinator for disposable Docker mock-debug cases. */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareExpectations, HeadlessDebuggerError, parseHeadlessRequest,
  type HeadlessAuthorizationV2, type HeadlessManifestV2, type HeadlessProtocolVersion,
  type HeadlessRequest } from "../../local/src/headlessDebuggerContracts.ts";
import type { DockerMockDebuggerBootstrap, DockerMockDebuggerBridgeMethod,
  DockerMockDebuggerBridgeParams, DockerMockDebuggerJson } from "./dockerMockDebuggerBridgeContracts.ts";
import { describeDockerMockDebuggerAssets, launchDockerMockDebugger, type DockerMockDebuggerBridgeSession } from "./dockerMockDebuggerLauncher.ts";
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { prepareDockerMockDebuggerSession } from "./prepareHeadlessDebugger.ts";
import type { DebugImageSource, EnsuredDebugImage } from "./dockerMockDebugger.ts";

type PublicDebugMethod = Exclude<DockerMockDebuggerBridgeMethod, "session.close" | "session.inspect" | "case.respond">;
type CaseTerminal = {
  schemaVersion: 1;
  kind: "arkimux-mock-debugger-case-result";
  simulated: true;
  caseId: string;
  status: "passed" | "mismatch" | "failed" | "cancelled" | "sandbox_unavailable";
  comparison: ReturnType<typeof compareExpectations>;
  output?: DockerMockDebuggerJson;
  failure?: { code: string; message: string; provider?: string };
};

export interface PreparedDockerMockDebuggerSession {
  readonly image: EnsuredDebugImage;
  readonly retainedCode: string;
  readonly retainedAssets: Readonly<Record<string, Uint8Array>>;
  readonly buildSha256: string;
  readonly buildVersion: string;
  readonly workflow: { kind: string; version: number };
  readonly configuration: { configurationId: string; contentHash: string };
  readonly construction: DockerMockDebuggerBootstrap["construction"];
  readonly workflowContractVersion: string;
  readonly resultKind: string;
  readonly runConfiguration: DockerMockDebuggerJson;
  readonly invocationModel: "workflow-input" | "graph-entry";
  readonly agentSlotIds: readonly string[];
}

export interface DockerMockDebuggerCoordinatorOptions {
  prepare(input: { manifest: HeadlessManifestV2; authorization: HeadlessAuthorizationV2 }): Promise<PreparedDockerMockDebuggerSession>;
  launch(input: { image: EnsuredDebugImage; bootstrap: DockerMockDebuggerBootstrap; retainedCode: string;
    retainedAssets: Readonly<Record<string, Uint8Array>> }): Promise<DockerMockDebuggerBridgeSession>;
  onChange?(sessionId: string, revision: number): void;
  now?(): Date;
}

export interface PreparedDockerMockDebuggerCoordinatorOptions {
  projectRoot: string;
  hostRequirements: Record<string, string>;
  imageSource: DebugImageSource;
  ensureImage?(source: DebugImageSource): Promise<EnsuredDebugImage>;
  launch?: DockerMockDebuggerCoordinatorOptions["launch"];
  onChange?(sessionId: string, revision: number): void;
  now?(): Date;
  makePreparationDirectory?(): Promise<string>;
  removePreparationDirectory?(directory: string): Promise<void>;
}

type Evidence = { evidenceId: string; kind: "terminal"; mediaType: "application/json"; totalBytes: number; sha256: string; redacted: true };
type CaseState = { caseId: string; state: "not_started" | "active" | "paused" | "waiting_for_input" | "terminal";
  request: unknown | null; terminal: CaseTerminal | null; evidence: Evidence[] };
type ActiveCase = { caseId: string; bridge: DockerMockDebuggerBridgeSession };

function fail(code: ConstructorParameters<typeof HeadlessDebuggerError>[0], message: string,
  retry?: ConstructorParameters<typeof HeadlessDebuggerError>[2]): never { throw new HeadlessDebuggerError(code, message, retry); }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function terminalEvidence(terminal: CaseTerminal): { descriptor: Evidence; bytes: Buffer } {
  const bytes = Buffer.from(JSON.stringify(terminal));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, descriptor: { evidenceId: `e-${sha256}`, kind: "terminal", mediaType: "application/json",
    totalBytes: bytes.length, sha256, redacted: true } };
}

function cancelled(caseId: string): CaseTerminal {
  return { schemaVersion: 1, kind: "arkimux-mock-debugger-case-result", simulated: true, caseId, status: "cancelled",
    comparison: { comparison: "not_checked", checks: [] },
    failure: { code: "cancelled", message: "The simulated debug case was cancelled." } };
}

function unavailable(caseId: string): CaseTerminal {
  return { schemaVersion: 1, kind: "arkimux-mock-debugger-case-result", simulated: true, caseId, status: "sandbox_unavailable",
    comparison: { comparison: "unavailable", checks: [] },
    failure: { code: "debugger_unavailable", message: "The simulated debug case could not start in its Docker sandbox." } };
}

function parseTerminal(value: unknown, caseId: string): CaseTerminal | null {
  if (value === null) return null;
  if (!object(value) || value.schemaVersion !== 1 || value.kind !== "arkimux-mock-debugger-case-result"
    || value.simulated !== true || value.caseId !== caseId
    || !["passed", "mismatch", "failed", "sandbox_unavailable"].includes(String(value.status))
    || !object(value.comparison)) fail("state_uncertain", "The mock-debug container returned an invalid terminal case result.");
  return value as CaseTerminal;
}

/**
 * Coordinates public V2 requests without executing retained project code in the
 * CLI process. The supplied prepare function may inspect and retain source, but
 * launch is the only boundary that starts executable workflow code.
 */
export function createDockerMockDebuggerCoordinator(options: DockerMockDebuggerCoordinatorOptions) {
  const now = options.now ?? (() => new Date());
  let manifest: HeadlessManifestV2 | undefined;
  let prepared: PreparedDockerMockDebuggerSession | undefined;
  let revision = 0;
  let active: ActiveCase | undefined;
  let closed = false;
  let createIdentity: string | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const cases = new Map<string, CaseState>();
  const evidence = new Map<string, { caseId: string; descriptor: Evidence; bytes: Buffer }>();
  const controls = new Map<string, { signature: string; result: unknown }>();

  const changed = () => {
    revision++;
    if (manifest) options.onChange?.(manifest.sessionId, revision);
  };
  const selected = (caseId: string): HeadlessManifestV2["cases"][number] => manifest?.cases.find(item => item.caseId === caseId)
    ?? fail("not_found", "The selected mock debug case does not exist.");
  const caseState = (caseId: string): CaseState => cases.get(caseId) ?? fail("not_found", "The selected mock debug case does not exist.");
  const activeFor = (caseId?: string): ActiveCase => {
    if (!active) fail("not_running", "Run a mock debug case before using live controls.");
    if (caseId !== undefined && active.caseId !== caseId) fail("not_running", "The selected mock debug case is not active.");
    return active;
  };
  const saveTerminal = (item: CaseState, terminal: CaseTerminal) => {
    item.state = "terminal";
    item.request = null;
    item.terminal = terminal;
    const saved = terminalEvidence(terminal);
    item.evidence = [saved.descriptor];
    evidence.set(saved.descriptor.evidenceId, { caseId: item.caseId, ...saved });
    changed();
  };
  const closeActive = async () => {
    if (!active) return;
    const current = active;
    await current.bridge.close();
    if (active === current) active = undefined;
  };
  const refresh = async (expectedCaseId?: string) => {
    const current = activeFor(expectedCaseId);
    let result: unknown;
    try { result = await current.bridge.request("session.inspect", {}); }
    catch (error) {
      let cleanupError: unknown;
      try { await closeActive(); } catch (caught) { cleanupError = caught; }
      saveTerminal(caseState(current.caseId), unavailable(current.caseId));
      throw cleanupError ?? error;
    }
    if (!object(result) || !object(result.state) || !("terminal" in result)) {
      fail("state_uncertain", "The mock-debug container returned an invalid inspection result.");
    }
    const inspection = result as Record<string, unknown> & { state: Record<string, unknown>; terminal: unknown };
    const item = caseState(current.caseId);
    const terminal = parseTerminal(inspection.terminal, current.caseId);
    if (terminal) {
      saveTerminal(item, terminal);
      await closeActive();
    } else {
      item.request = object(inspection.suspension) ? inspection.suspension : null;
      const next = item.request ? "waiting_for_input" : inspection.state.state === "paused" ? "paused" : "active";
      if (item.state !== next) { item.state = next; changed(); }
    }
    return inspection;
  };
  const snapshot = () => {
    if (!manifest || !prepared) fail("not_found", "Create a mock debug session first.");
    const currentManifest = manifest, currentPrepared = prepared;
    return { sessionId: currentManifest.sessionId, revision, simulated: true, preparation: "ready",
      workflow: currentPrepared.workflow, configuration: currentPrepared.configuration,
      build: { buildSha256: currentPrepared.buildSha256, version: currentPrepared.buildVersion },
      image: { identity: currentPrepared.image.imageIdentity, sourceKind: currentPrepared.image.sourceKind },
      cases: [...cases.values()].map(item => ({ ...item, evidence: [...item.evidence] })) };
  };

  const inspectSession = async () => {
    if (active) await refresh(active.caseId);
    return snapshot();
  };

  const runCase = async (caseId: string) => {
    if (!manifest || !prepared) fail("not_found", "Create a mock debug session first.");
    const currentManifest = manifest, currentPrepared = prepared;
    const definition = selected(caseId), item = caseState(caseId);
    if (item.state === "terminal") return item;
    if (active) {
      if (active.caseId === caseId) { await refresh(caseId); return { ...item, evidence: [...item.evidence] }; }
      fail("case_busy", "Another mock debug case is active. Finish or cancel it before starting this case.");
    }
    item.state = "active"; changed();
    const createdAt = now().toISOString();
    const bootstrap: DockerMockDebuggerBootstrap = {
      schemaVersion: 1,
      kind: "arkimux-mock-debugger-bootstrap",
      caseId,
      buildSha256: currentPrepared.buildSha256,
      construction: currentPrepared.construction,
      invocation: { schemaVersion: 1, runRef: { executionId: `mock-${currentManifest.sessionId}-${caseId}` }, workflow: currentPrepared.workflow,
        workflowContractVersion: currentPrepared.workflowContractVersion, runConfiguration: currentPrepared.configuration,
        resultKind: currentPrepared.resultKind, input: definition.input, createdAt },
      runConfiguration: currentPrepared.runConfiguration,
      ...(currentPrepared.invocationModel === "graph-entry" ? { graph: {
        request: definition.input,
        identity: { runRef: { executionId: `mock-${currentManifest.sessionId}-${caseId}` },
          runConfiguration: currentPrepared.configuration,
          executableBindingId: `mock-${currentManifest.sessionId}-${caseId}`,
          buildSha256: currentPrepared.buildSha256, createdAt,
          requestId: `graph-${caseId}` },
        agentSlotIds: [...currentPrepared.agentSlotIds],
      } } : {}),
      assets: describeDockerMockDebuggerAssets(currentPrepared.retainedAssets),
      mocks: definition.mocks,
      expectations: definition.expectations,
      stopOnEntry: true,
    };
    try {
      const bridge = await options.launch({ image: currentPrepared.image, bootstrap, retainedCode: currentPrepared.retainedCode,
        retainedAssets: currentPrepared.retainedAssets });
      active = { caseId, bridge };
      item.state = "paused"; changed();
      if (!currentManifest.debug.stopOnEntry) {
        const ready = bridge.ready as { pause?: { pauseId?: unknown } };
        const pauseId = ready?.pause?.pauseId;
        if (typeof pauseId !== "string") fail("state_uncertain", "The mock-debug container did not return its entry pause.");
        await bridge.request("debug.continue", { pauseId });
        item.state = "active"; changed();
      }
      return { ...item, evidence: [...item.evidence] };
    } catch (error) {
      if (active?.caseId === caseId) await closeActive().catch(() => {});
      saveTerminal(item, unavailable(caseId));
      throw error;
    }
  };

  const cancelCase = async (caseId: string) => {
    const item = caseState(caseId);
    if (item.state === "terminal") return { ...item, evidence: [...item.evidence] };
    if (active?.caseId === caseId) await closeActive();
    saveTerminal(item, cancelled(caseId));
    return { ...item, evidence: [...item.evidence] };
  };

  const bridgeRequest = async (method: PublicDebugMethod, params: Record<string, unknown>) => {
    const caseId = typeof params.caseId === "string" ? params.caseId : undefined;
    const controlId = typeof params.controlId === "string" && ["debug.pause", "debug.continue", "debug.step", "debug.variable.set"].includes(method)
      ? params.controlId : undefined;
    const controlKey = controlId ? `${caseId ?? "active"}:${method}:${controlId}` : undefined;
    const signature = controlKey ? createHash("sha256").update(JSON.stringify(params)).digest("hex") : undefined;
    const previous = controlKey ? controls.get(controlKey) : undefined;
    if (previous) {
      if (previous.signature !== signature) fail("control_conflict", "This control ID was already used for another mock debug action.");
      return previous.result;
    }
    const current = activeFor(caseId);
    if (method === "debug.inspect") {
      const result = await refresh(current.caseId);
      return { caseId: current.caseId, simulated: true, ...result };
    }
    if (method === "debug.breakpoints.set") {
      const inspection = await current.bridge.request("debug.inspect", {});
      const state = object(inspection) && object(inspection.state) ? inspection.state : undefined;
      if (!state || !Number.isSafeInteger(state.debuggerRevision)) fail("state_uncertain", "The mock debugger revision is unavailable.");
      if (state.debuggerRevision !== params.expectedDebuggerRevision) fail("stale_debugger_revision", "The debugger changed. Inspect it and replace breakpoints against the current revision.");
    }
    const forwarded: Record<string, unknown> = { ...params };
    delete forwarded.caseId;
    delete forwarded.expectedDebuggerRevision;
    if (["debug.pause", "debug.continue", "debug.step"].includes(method)) delete forwarded.controlId;
    const result = await current.bridge.request(method, forwarded as never);
    if (controlKey && signature) controls.set(controlKey, { signature, result });
    return result;
  };

  const execute = async (method: string, params: unknown, schemaVersion: HeadlessProtocolVersion): Promise<unknown> => {
    if (schemaVersion !== 2) fail("unsupported_version", "The Docker mock debugger accepts only protocol V2.");
    const parsed = parseHeadlessRequest({ schemaVersion, id: "coordinator", method, params });
    const request = parsed as Extract<HeadlessRequest, { schemaVersion: 2 }>;
    if (request.schemaVersion !== 2) fail("unsupported_version", "The Docker mock debugger accepts only protocol V2.");
    if (method === "session.close") {
      if (active) {
        const item = caseState(active.caseId);
        await closeActive();
        if (item.state !== "terminal") saveTerminal(item, cancelled(item.caseId));
      }
      closed = true;
      return { closed: true };
    }
    if (closed) fail("session_busy", "The mock debug session is closed.");
    if (request.method === "session.create") {
      const identity = createHash("sha256").update(JSON.stringify([request.params.manifest, request.params.authorization])).digest("hex");
      if (manifest) {
        if (manifest.sessionId !== request.params.manifest.sessionId) fail("session_busy", "This process already owns another mock debug session.");
        if (createIdentity !== identity) fail("identity_conflict", "This session ID already has different immutable mock debug settings.");
        return await inspectSession();
      }
      const candidate = await options.prepare(request.params);
      manifest = request.params.manifest;
      prepared = candidate;
      createIdentity = identity;
      for (const item of manifest.cases) cases.set(item.caseId, { caseId: item.caseId, state: "not_started", request: null, terminal: null, evidence: [] });
      changed();
      return snapshot();
    }
    if (request.method === "session.open") {
      if (!manifest || manifest.sessionId !== request.params.sessionId) fail("not_found", "The mock debug session is not open in this process.");
      return await inspectSession();
    }
    if (!manifest) fail("not_found", "Create a mock debug session first.");
    if (request.method === "session.inspect") return await inspectSession();
    if (request.method === "case.run") return await runCase(request.params.caseId);
    if (request.method === "case.cancel") return await cancelCase(request.params.caseId);
    if (request.method === "case.respond") {
      const current = activeFor(request.params.caseId), item = caseState(request.params.caseId);
      const result = await current.bridge.request("case.respond", request.params);
      item.request = null; item.state = "paused"; changed();
      return result;
    }
    if (request.method === "evidence.read") {
      const saved = evidence.get(request.params.evidenceId);
      if (!saved || saved.caseId !== request.params.caseId) fail("not_found", "This evidence does not belong to the selected mock debug case.");
      if (request.params.offset > saved.bytes.length) fail("invalid_request", "Evidence offset exceeds the item length.");
      const end = Math.min(saved.bytes.length, request.params.offset + request.params.limit);
      return { evidenceId: saved.descriptor.evidenceId, mediaType: saved.descriptor.mediaType, encoding: "base64",
        offset: request.params.offset, totalBytes: saved.bytes.length, data: saved.bytes.subarray(request.params.offset, end).toString("base64"),
        nextOffset: end === saved.bytes.length ? null : end };
    }
    if (request.method.startsWith("debug.")) return await bridgeRequest(request.method as PublicDebugMethod, request.params as Record<string, unknown>);
    return fail("unsupported_operation", "This mock debugger operation is not supported.");
  };

  return {
    request(method: string, params: unknown, schemaVersion: HeadlessProtocolVersion = 2): Promise<unknown> {
      const next = tail.then(() => execute(method, params, schemaVersion));
      tail = next.catch(() => {});
      return next;
    },
    async close(): Promise<void> {
      await tail;
      if (!closed) await execute("session.close", {}, 2);
    },
  };
}

/** Internal checked composition. The released CLI keeps protocol V2 guarded
 * until its remaining controls and full conformance are complete. */
export async function createPreparedDockerMockDebuggerCoordinator(options: PreparedDockerMockDebuggerCoordinatorOptions) {
  const makeDirectory = options.makePreparationDirectory
    ?? (() => mkdtemp(path.join(tmpdir(), "arkimux-mock-debug-preparation-")));
  const removeDirectory = options.removePreparationDirectory
    ?? ((directory: string) => rm(directory, { recursive: true, force: true }));
  const directory = await makeDirectory();
  let store: FileRetainedExecutionStoreV1;
  try { store = await FileRetainedExecutionStoreV1.open(path.join(directory, "retained")); }
  catch (error) { await removeDirectory(directory).catch(() => {}); throw error; }
  const coordinator = createDockerMockDebuggerCoordinator({
    prepare: input => prepareDockerMockDebuggerSession({ ...input, projectRoot: options.projectRoot, store,
      hostRequirements: options.hostRequirements, imageSource: options.imageSource, ensureImage: options.ensureImage }),
    launch: options.launch ?? launchDockerMockDebugger,
    onChange: options.onChange,
    now: options.now,
  });
  let closing: Promise<void> | undefined;
  return {
    request: coordinator.request,
    close(): Promise<void> {
      return closing ??= (async () => {
        let failure: unknown;
        try { await coordinator.close(); } catch (error) { failure = error; }
        try { await store.close(); } catch (error) { failure ??= error; }
        try { await removeDirectory(directory); } catch (error) { failure ??= error; }
        if (failure) throw failure;
      })();
    },
  };
}
