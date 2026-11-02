/** Internal diagnostic coordinator. All workflow execution uses the normal retained runtime. */
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { createLocalRetainedRuntime } from "./localRetainedRuntime.ts";
import { projectRetainedRunStatus } from "./localRetainedRunOrchestrator.ts";
import { resolveLocalDurableExecutionPaths } from "./localDurableWorkflowRuntime.ts";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import { activeComputeLimitsSchema } from "../../core/src/application/activeCompute.ts";
import { getExternalErrorDiagnostic, type ExternalErrorDiagnostic } from "../../core/src/application/externalError.ts";
import { retainedExternalDiagnosticSchema } from "../../core/src/application/retainedExecution.ts";
import { runConfigurationContentHash } from "../../core/src/application/runConfiguration.ts";
import { executableBindingSchema, terminalRun, type ExecutableBindingV1, type RetainedRunControlV1, type InputSubmissionReceiptV1 } from "../../core/src/application/retainedExecution.ts";
import { validatePublishedResultEnvelope } from "../../core/src/application/publishedResult.ts";
import { validateRunPerformance } from "../../core/src/application/runPerformance.ts";
import { validateRunRef, type RunRef } from "../../core/src/domain/runIdentity.ts";
import { validateWorkflowIdentity, type WorkflowIdentity } from "../../core/src/domain/workflowIdentity.ts";
import { readDurableJson, replaceDurableJson } from "../../core/src/infrastructure/storage/localFileAuthority.ts";
import { FileStepCheckpointStoreV2 } from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";
import type { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { compareExpectations, HeadlessDebuggerError, parseHeadlessRequest, parseHeadlessManifest, parseHeadlessAuthorization,
  sanitizeEvidence, type HeadlessManifest, type HeadlessAuthorization, type HeadlessDebuggerErrorCode } from "./headlessDebuggerContracts.ts";
import { headlessDebuggerErrorCodeSchema, type HeadlessProtocolVersion } from "./headlessDebuggerContracts.ts";
import type { HeadlessRuntimeDebugger } from "./localRetainedWorkflowRunner.ts";
import type { RetainedAttemptContextV2 } from "./localRetainedExecutionHost.ts";
import type { HeadlessWorkerDebugger, LiveBreakpoint } from "./headlessWorkerDebugger.ts";
import { HeadlessDebugSources } from "./headlessDebugSources.ts";

export interface PreparedHeadlessSession {
  workflow: WorkflowIdentity;
  configuration: { configurationId: string; workflow: WorkflowIdentity; agents: Record<string, unknown>; [key: string]: unknown };
  buildSha256: string; buildVersion: string; workflowContractVersion: string; resultKind: string;
  agentSlotIds: string[]; nonSecretEnvironment: Record<string, string>; credentialReferences: string[];
  executionProfile: { maxScratchBytes: number; computeLimits: { totalMs: number; attemptMs: number; finalizationReserveMs: number } };
  hostRequirements: Record<string, string>;
}
export interface HeadlessDebuggerOptions {
  projectRoot: string; packageVersion: string; workerPath?: string;
  onChange?(sessionId: string, revision: number): void;
  prepareSession?(options: { projectRoot: string; store: FileRetainedExecutionStoreV1; manifest: HeadlessManifest;
    authorization: HeadlessAuthorization; hostRequirements: Record<string, string>; signal?: AbortSignal }): Promise<PreparedHeadlessSession>;
}
type SafeError = { code: HeadlessDebuggerErrorCode; message: string; retry: "never" | "after_action" | "same_identity"; externalDiagnostic?: ExternalErrorDiagnostic };
type CaseRecord = { caseId: string; runRef: RunRef; intent: boolean; cancelled: boolean; error: SafeError | null };
type LiveJournal = { revision: number; breakpoints: LiveBreakpoint[]; lastMutation: { revision: number; signature: string } | null;
  controls: { caseId: string; controlId: string; signature: string; method: string; targetId: string; at: string;
    status: "pending" | "applied" | "failed"; error: SafeError | null }[] };
type Journal = { schemaVersion: 1 | 2; revision: number; manifest: HeadlessManifest; authorization: HeadlessAuthorization;
  manifestHash: string; prepared: PreparedHeadlessSession | null; preparedHash: string | null;
  runtime: { packageVersion: string; nodeVersion: string }; createdAt: string; cases: CaseRecord[]; observedHash: string | null; live?: LiveJournal };
type Evidence = { evidenceId: string; kind: string; mediaType: string; totalBytes: number; sha256: string; redacted: boolean };
const errorCodes = ["invalid_request", "message_too_large", "unsupported_version", "unsupported_operation", "authorization_required", "project_invalid", "configuration_invalid", "connection_action_required", "not_found", "identity_conflict", "session_busy", "case_busy", "preparation_incomplete", "invalid_response", "stale_revision", "input_expired", "input_already_answered", "run_terminal", "evidence_too_large", "state_uncertain", "cleanup_unconfirmed", "storage_unavailable", "internal_error"] as const;
const safeErrorSchema = z.strictObject({ code: headlessDebuggerErrorCodeSchema, message: z.string().max(4096), retry: z.enum(["never", "after_action", "same_identity"]), externalDiagnostic: retainedExternalDiagnosticSchema.optional() });
const liveJournalSchema = z.strictObject({ revision: z.number().int().nonnegative().safe(),
  breakpoints: z.array(z.strictObject({ breakpointId: z.string(), sourceId: z.string(), line: z.number().int().positive().safe(), column: z.number().int().positive().safe(),
    condition: z.string().min(1).max(4096).optional(), logExpression: z.string().min(1).max(4096).optional() })).max(100),
  lastMutation: z.strictObject({ revision: z.number().int().nonnegative().safe(), signature: z.string() }).nullable(),
  controls: z.array(z.strictObject({ caseId: z.string(), controlId: z.string(), signature: z.string(), method: z.enum(["debug.pause", "debug.continue", "debug.step"]),
    targetId: z.string(), at: z.string().datetime(), status: z.enum(["pending", "applied", "failed"]), error: safeErrorSchema.nullable() })) });
const evidenceSchema = z.strictObject({ evidenceId: z.string().regex(/^e-[a-f0-9]{64}$/), kind: z.enum(["input", "result", "expectations", "steps", "step-output", "performance", "failure"]), mediaType: z.literal("application/json"), totalBytes: z.number().int().nonnegative().safe(), sha256: z.string().regex(/^[a-f0-9]{64}$/), redacted: z.boolean() });
const digest = (value: unknown) => hashJson(inputWaitJsonSnapshot(value));
const bytesHash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
// Evidence identity must not depend on property insertion order after reopening.
function evidenceBytes(value: unknown): Buffer {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(",")}}`;
  };
  return Buffer.from(canonical(value));
}
const error = (code: HeadlessDebuggerErrorCode, message: string) => new HeadlessDebuggerError(code, message);
const safeError = (value: unknown): SafeError => {
  const externalDiagnostic = getExternalErrorDiagnostic(value);
  if (externalDiagnostic) return { code: "action_required", retry: "after_action", externalDiagnostic,
    message: externalDiagnostic.message.length <= 4096 ? externalDiagnostic.message
      : `${externalDiagnostic.message.slice(0, 4000)}\nRead the failure evidence for the complete provider diagnostic.` };
  if (value instanceof HeadlessDebuggerError) return { code: value.code, message: value.message, retry: value.retry };
  const code = (value as { code?: string })?.code;
  const mapping: Record<string, HeadlessDebuggerErrorCode> = { "invalid-response": "invalid_response", "stale-revision": "stale_revision",
    "request-closed": "input_already_answered", "submission-reused": "identity_conflict", "run-closed": "run_terminal",
    "not-found": "not_found", "validation-unavailable": "connection_action_required", "input-unavailable": "storage_unavailable",
    "invalid-input": "invalid_request", "invalid-construction": "project_invalid", "missing-build": "state_uncertain" };
  const mapped = mapping[code ?? ""] ?? "internal_error";
  return { code: mapped, message: mapped === "internal_error" ? "The diagnostic operation could not finish. Inspect this session before retrying."
    : "The operation could not be completed. Check the saved case and the request before retrying.", retry: mapped === "internal_error" || mapped === "storage_unavailable" ? "same_identity" : "after_action" };
};
function prepared(value: unknown): PreparedHeadlessSession {
  const record = z.strictObject({ workflow: z.unknown().transform(validateWorkflowIdentity), configuration: z.object({ configurationId: z.string(), workflow: z.unknown(), agents: z.record(z.string(), z.unknown()) }).passthrough(),
    buildSha256: z.string().regex(/^[a-f0-9]{64}$/), buildVersion: z.string().min(1), workflowContractVersion: z.string().min(1), resultKind: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
    agentSlotIds: z.array(z.string()), nonSecretEnvironment: z.record(z.string(), z.string()), credentialReferences: z.array(z.string()),
    executionProfile: z.strictObject({ maxScratchBytes: z.number().int().positive().safe(), computeLimits: activeComputeLimitsSchema }), hostRequirements: z.record(z.string(), z.string()) }).parse(value);
  if (digest(record.workflow) !== digest(record.configuration.workflow)
    || digest([...record.agentSlotIds].sort()) !== digest(Object.keys(record.configuration.agents).sort())) throw error("state_uncertain", "The retained diagnostic settings do not agree.");
  return record as PreparedHeadlessSession;
}

export async function createHeadlessDebugger(options: HeadlessDebuggerOptions) {
  const projectRoot = await fs.realpath(options.projectRoot);
  return new HeadlessDebugger({ ...options, projectRoot });
}

class HeadlessDebugger {
  #runtime?: Awaited<ReturnType<typeof createLocalRetainedRuntime>>;
  #journal?: Journal;
  #root?: string;
  #tail: Promise<unknown> = Promise.resolve();
  #active = new Map<string, Promise<void>>();
  #admissionControllers = new Map<string, AbortController>();
  #responses = new Map<string, { signature: string; controller: AbortController; work: Promise<InputSubmissionReceiptV1> }>();
  #responseOperations = new Set<Promise<unknown>>();
  #closing?: Promise<void>;
  #abort = new AbortController();
  #backgroundFailure?: SafeError;
  #version?: HeadlessProtocolVersion;
  #liveAttempts = new Map<string, { controller: HeadlessWorkerDebugger; context: RetainedAttemptContextV2 }>();
  #sources?: HeadlessDebugSources;
  constructor(readonly options: HeadlessDebuggerOptions) {}
  async request(method: string, params: unknown, schemaVersion: HeadlessProtocolVersion = 1): Promise<unknown> {
    const request = parseHeadlessRequest({ schemaVersion, id: "local", method, params });
    if (this.#version !== undefined && this.#version !== schemaVersion) throw error("unsupported_version", "A process cannot mix debugger protocol versions.");
    this.#version = schemaVersion;
    if (method === "session.close") {
      await this.close(); return { closed: true };
    }
    if (this.#closing) throw error("session_busy", "The diagnostic session is closing.");
    if (request.method === "case.respond") {
      // Validation runs outside the journal queue; inspect/cancel must stay usable.
      const pending = this.#respond(request.params).catch(cause => { const failure = safeError(cause); throw new HeadlessDebuggerError(failure.code, failure.message, failure.retry); });
      this.#responseOperations.add(pending);
      void pending.finally(() => this.#responseOperations.delete(pending)).catch(() => {});
      return pending;
    }
    return this.#serial(async () => {
      if (this.#closing) throw error("session_busy", "The diagnostic session is closing.");
      try {
        if (request.method === "session.create") return await this.#open(request.params.manifest.sessionId, request.params);
        if (request.method === "session.open") return await this.#open(request.params.sessionId);
        if (!this.#journal) throw error("not_found", "Open or create a diagnostic session first.");
        if (request.method.startsWith("debug.")) return await this.#debugRequest(request.method, request.params);
        switch (request.method) {
          case "session.inspect": return await this.#snapshot();
          case "case.run": return await this.#run(request.params.caseId);
          case "case.cancel": return await this.#cancel(request.params.caseId);
          case "evidence.read": return await this.#readEvidence(request.params);
        }
      } catch (cause) { const failure = safeError(cause); throw new HeadlessDebuggerError(failure.code, failure.message, failure.retry); }
    });
  }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(work); this.#tail = next.catch(() => {}); return next;
  }
  async #open(sessionId: string, create?: { manifest: HeadlessManifest; authorization: HeadlessAuthorization }) {
    if (this.#journal) {
      if (this.#journal.manifest.sessionId !== sessionId) throw error("session_busy", "This process already owns another diagnostic session.");
      if (create && digest([create.manifest, create.authorization]) !== this.#journal.manifestHash) throw error("identity_conflict", "This session ID already has different immutable settings.");
      return this.#snapshot();
    }
    // Refuse symlinks for every diagnostic directory; never follow a caller-selected store path.
    let directory = this.options.projectRoot;
    for (const part of [".arkimux", "debug", "sessions", sessionId]) {
      directory = path.join(directory, part);
      if (create) await fs.mkdir(directory, { mode: 0o700 }).catch(cause => { if (cause.code !== "EEXIST") throw cause; });
      const stat = await fs.lstat(directory).catch(() => { throw error("not_found", "The diagnostic session does not exist."); });
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw error("state_uncertain", "Diagnostic storage must use ordinary project-owned directories.");
    }
    this.#root = directory;
    for (const child of ["retained", "runs", "evidence"]) {
      const info = await fs.lstat(path.join(directory, child)).catch(cause => { if (cause.code !== "ENOENT") throw cause; return undefined; });
      if (info && (!info.isDirectory() || info.isSymbolicLink())) throw error("state_uncertain", "Diagnostic storage contains an unsafe directory.");
    }
    try { this.#runtime = await createLocalRetainedRuntime({ projectRoot: this.options.projectRoot, executionDataRoot: directory,
      workerPath: this.options.workerPath, ...(this.#version === 2 ? { liveDebugger: this.#liveRuntime() } : {}) }); }
    catch { throw error("session_busy", "Another process owns this diagnostic session, or its local storage guard is unavailable."); }
    try {
      const stored = await readDurableJson(path.join(directory, "session.json"));
      if (stored !== undefined) {
        if ((stored as { schemaVersion?: unknown }).schemaVersion !== this.#version) throw error("session_version_mismatch", "Open this session using its original debugger protocol version.");
        try { this.#journal = this.#validateJournal(stored); }
        catch { throw error("state_uncertain", "Saved diagnostic settings failed validation. No workflow was executed."); }
        if (this.#journal.manifest.sessionId !== sessionId) throw error("state_uncertain", "Session storage identity differs.");
        if (create && this.#journal.manifestHash !== digest([create.manifest, create.authorization])) throw error("identity_conflict", "This session ID already has different immutable settings.");
        await this.#runtime.reconcile(); // Deliberately does not dispatch any saved intent.
      } else {
        if (!create) throw error("not_found", "The diagnostic session does not exist.");
        this.#journal = { schemaVersion: this.#version!, revision: 1, manifest: create.manifest, authorization: create.authorization,
          manifestHash: digest([create.manifest, create.authorization]), prepared: null, preparedHash: null,
          runtime: { packageVersion: this.options.packageVersion, nodeVersion: process.versions.node }, createdAt: new Date().toISOString(),
          cases: create.manifest.cases.map(c => ({ caseId: c.caseId, runRef: { executionId: `debug-${randomUUID()}` }, intent: false, cancelled: false, error: null })), observedHash: null,
          ...(this.#version === 2 ? { live: { revision: 0, breakpoints: [], lastMutation: null, controls: [] } } : {}) };
        await this.#save();
        if (!this.options.prepareSession) throw error("preparation_incomplete", "Diagnostic preparation is unavailable. No case was executed.");
        const pinned = prepared(await this.options.prepareSession({ projectRoot: this.options.projectRoot, store: this.#runtime.store,
          manifest: create.manifest, authorization: create.authorization, hostRequirements: this.#runtime.hostRequirements, signal: this.#abort.signal }));
        if (this.#closing || this.#abort.signal.aborted) throw error("preparation_incomplete", "Diagnostic preparation was interrupted. No case was executed.");
        if (pinned.workflow.kind !== create.manifest.workflowId || pinned.configuration.configurationId !== create.manifest.configurationId) throw error("configuration_invalid", "Prepared settings differ from the selected workflow or configuration.");
        this.#journal.prepared = pinned; this.#journal.preparedHash = digest(pinned); await this.#save();
      }
      return await this.#snapshot();
    } catch (cause) {
      await this.#runtime.close(); this.#runtime = undefined; this.#journal = undefined; this.#root = undefined; throw cause;
    }
  }
  #validateJournal(value: unknown): Journal {
    const j = z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]), revision: z.number().int().positive().safe(), manifest: z.unknown(), authorization: z.unknown(),
      manifestHash: z.string(), prepared: z.unknown().nullable(), preparedHash: z.string().nullable(), runtime: z.strictObject({ packageVersion: z.string(), nodeVersion: z.string() }),
      createdAt: z.string().datetime(), cases: z.array(z.strictObject({ caseId: z.string(), runRef: z.unknown().transform(validateRunRef), intent: z.boolean(), cancelled: z.boolean(), error: z.unknown().nullable() })), observedHash: z.string().nullable(), live: liveJournalSchema.optional() }).parse(value);
    const manifest = parseHeadlessManifest(j.manifest), authorization = parseHeadlessAuthorization(j.authorization, j.schemaVersion);
    if (j.schemaVersion !== manifest.schemaVersion || (j.schemaVersion === 2) !== !!j.live) throw error("state_uncertain", "The session protocol and saved debugger state differ.");
    if (j.live && (new Set(j.live.breakpoints.map(x => x.breakpointId)).size !== j.live.breakpoints.length
      || new Set(j.live.controls.map(x => `${x.caseId}/${x.controlId}`)).size !== j.live.controls.length
      || j.live.controls.some(x => !j.cases.some(c => c.caseId === x.caseId)))) throw error("state_uncertain", "Saved live controls have inconsistent identities.");
    if (j.manifestHash !== digest([manifest, authorization]) || digest(j.cases.map(c => c.caseId)) !== digest(manifest.cases.map(c => c.caseId))
      || new Set(j.cases.map(c => c.runRef.executionId)).size !== j.cases.length || (j.prepared === null) !== (j.preparedHash === null)
      || (j.prepared && digest(j.prepared) !== j.preparedHash)) throw error("state_uncertain", "Diagnostic session metadata is inconsistent.");
    const pinned = j.prepared === null ? null : prepared(j.prepared);
    if (pinned && (pinned.workflow.kind !== manifest.workflowId || pinned.configuration.configurationId !== manifest.configurationId)
      || !pinned && j.cases.some(c => c.intent)) throw error("state_uncertain", "Saved case settings differ from the manifest.");
    return { ...j, manifest, authorization, prepared: pinned, cases: j.cases.map(c => ({ ...c, error: c.error === null ? null : safeErrorSchema.parse(c.error) })) };
  }
  async #save() {
    this.#journal!.revision++;
    await replaceDurableJson(path.join(this.#root!, "session.json"), this.#journal);
    try { this.options.onChange?.(this.#journal!.manifest.sessionId, this.#journal!.revision); } catch { /* Observer cannot affect durable execution. */ }
  }
  #knownSecrets(): string[] {
    // Collect labelled credential-like inputs without interpreting accessors.
    // These values are already retained by the authorized session; only this
    // private controller uses the list to prevent aliases bypassing redaction.
    if (!this.#journal) return [];
    const secrets = new Set<string>();
    const work: unknown[] = [this.#journal.manifest.cases, this.#journal.prepared?.configuration];
    while (work.length) {
      const value = work.pop();
      if (!value || typeof value !== "object") continue;
      for (const [name, child] of Object.entries(value)) {
        if (typeof child === "string" && /api[-_]?key|secret|password|token|credentialvalue|authorization/i.test(name) && child) secrets.add(child);
        else if (child && typeof child === "object") work.push(child);
      }
    }
    return [...secrets];
  }
  #liveRuntime(): HeadlessRuntimeDebugger {
    return {
      configuration: ref => {
        const j = this.#journal;
        if (j?.manifest.schemaVersion !== 2 || !j.live || !j.cases.some(c => c.runRef.executionId === ref.executionId)) return undefined;
        return { stopOnEntry: j.manifest.debug.stopOnEntry, breakpoints: structuredClone(j.live.breakpoints), knownSecrets: this.#knownSecrets() };
      },
      attached: async (ref, controller, context) => {
        const item = this.#journal!.cases.find(c => c.runRef.executionId === ref.executionId);
        if (!item || this.#closing || item.cancelled) throw error("session_busy", "The diagnostic case is closing.");
        // Recheck durable intent after async attachment, before worker dispatch.
        await controller.replaceBreakpoints(this.#journal!.live!.breakpoints);
        this.#liveAttempts.set(item.caseId, { controller, context });
      },
      changed: ref => {
        if (!this.#journal || this.#closing) return;
        if (!this.#journal.cases.some(c => c.runRef.executionId === ref.executionId)) return;
        void this.#serial(async () => { if (!this.#closing) await this.#save(); }).catch(() => {
          this.#backgroundFailure = safeError(error("storage_unavailable", "Debugger progress could not be saved. Inspect or cancel this case."));
        });
      },
      stopped: (ref, attemptId) => {
        const item = this.#journal?.cases.find(c => c.runRef.executionId === ref.executionId);
        if (item && this.#liveAttempts.get(item.caseId)?.context.owner.attemptId === attemptId) this.#liveAttempts.delete(item.caseId);
      },
    };
  }
  async #sourceCatalog() {
    if (this.#sources) return this.#sources;
    const p = this.#journal!.prepared;
    if (!p) throw error("preparation_incomplete", "The retained workflow is not ready.");
    const build = await this.#runtime!.store.readBuild(p.buildSha256);
    return this.#sources = new HeadlessDebugSources(Buffer.from(build.files[build.manifest.entryPoint]).toString("utf8"), p.buildSha256);
  }
  async #debugSnapshot(caseId: string) {
    const item = this.#case(caseId), attempt = this.#liveAttempts.get(caseId);
    const saved = await this.#runtime!.store.read(item.runRef), live = attempt?.controller.inspect();
    const uncertain = saved?.compute?.certainty === "uncertain";
    const pending = this.#journal!.live!.controls.some(c => c.caseId === caseId && c.status === "pending");
    const failure = this.#backgroundFailure ?? (pending ? safeError(error("state_uncertain", "A debugger control has an unconfirmed outcome. Inspect or cancel; it will not be dispatched again.")) : null);
    const limits = saved?.compute?.limits ?? this.#journal!.prepared?.executionProfile.computeLimits;
    const spent = uncertain ? null : saved?.compute?.spentMs ?? 0;
    const budget = attempt?.context.diagnosticClock?.snapshot() ?? { limitMs: limits?.totalMs ?? null, spentMs: spent,
      remainingMs: limits && spent !== null ? Math.max(0, limits.totalMs - spent) : null,
      excludedPauseMs: uncertain ? null : saved?.compute?.excludedPauseMs ?? 0,
      clock: uncertain ? "uncertain" : "running", reason: "executing" };
    return { caseId, runRef: saved ? item.runRef : null, attemptId: attempt?.context.owner.attemptId ?? null,
      ...live, debuggerRevision: this.#journal!.live!.revision,
      state: failure || uncertain ? "action_required" : live?.state ?? (saved?.status === "waiting_for_input" ? "waiting_for_input"
        : saved && terminalRun(saved) || item.cancelled ? "terminated" : this.#active.has(caseId) ? "attaching" : "not_started"),
      pause: live?.pause ?? null,
      breakpoints: live?.breakpoints ?? this.#journal!.live!.breakpoints.map(({ breakpointId, ...requested }) => ({ breakpointId, requested, actual: null, state: "pending", reason: null })),
      budget,
      externalWork: { activeCount: "activeCount" in budget ? budget.activeCount : 0,
        activityKnown: "activityKnown" in budget ? budget.activityKnown : !attempt,
        warning: budget.reason === "external_work" || budget.reason === "unknown_activity" ? "Pausing workflow JavaScript does not pause external work or provider billing. This time remains charged." : null },
      error: failure ?? live?.error ?? (uncertain ? safeError(error("state_uncertain", "Diagnostic accounting is uncertain; execution cannot continue.")) : null) };
  }
  async #debugRequest(method: string, raw: unknown): Promise<unknown> {
    if (this.#journal!.schemaVersion !== 2 || !this.#journal!.live) throw error("unsupported_operation", "Live debugging requires a V2 session.");
    // The protocol parser has already validated all fields and bounds.
    const p = raw as { caseId: string; sourceId: string; offset: number; limit: number; expectedDebuggerRevision: number;
      breakpoints: LiveBreakpoint[]; attemptId: string; pauseId: string; controlId: string; frameId: string; objectId: string; kind: "into" | "over" | "out" };
    const journal = this.#journal!.live;
    if (method === "debug.sources") return (await this.#sourceCatalog()).list(p.offset, p.limit);
    if (method === "debug.source.read") return (await this.#sourceCatalog()).read(p.sourceId, p.offset, p.limit, this.#knownSecrets());
    if (method === "debug.breakpoints.set") {
      const signature = digest(p.breakpoints);
      const duplicate = journal.lastMutation?.revision === p.expectedDebuggerRevision && journal.lastMutation.signature === signature;
      if (!duplicate && journal.revision !== p.expectedDebuggerRevision) throw error("stale_debugger_revision", "Refresh breakpoint intent before changing it.");
      if (!duplicate) {
        const catalog = await this.#sourceCatalog();
        for (const breakpoint of p.breakpoints) catalog.generated(breakpoint);
        journal.lastMutation = { revision: journal.revision, signature }; journal.revision++;
        journal.breakpoints = structuredClone(p.breakpoints); await this.#save();
      }
      const bindings = [];
      for (const [caseId, attempt] of this.#liveAttempts) bindings.push({ caseId, items: await attempt.controller.replaceBreakpoints(journal.breakpoints) });
      return { debuggerRevision: journal.revision, breakpoints: journal.breakpoints, bindings };
    }
    this.#case(p.caseId);
    if (method === "debug.inspect") return this.#debugSnapshot(p.caseId);
    if (["debug.pause", "debug.continue", "debug.step"].includes(method)) {
      const signature = digest([method, raw]);
      let receipt = journal.controls.find(c => c.caseId === p.caseId && c.controlId === p.controlId);
      if (receipt) {
        if (receipt.signature !== signature) throw error("control_conflict", "This control ID already belongs to another action.");
        if (receipt.error) throw new HeadlessDebuggerError(receipt.error.code, receipt.error.message, receipt.error.retry);
        return { receipt: { controlId: receipt.controlId, status: receipt.status }, debugger: await this.#debugSnapshot(p.caseId) };
      }
      if (journal.controls.some(c => c.caseId === p.caseId && c.status === "pending")) throw error("state_uncertain", "Resolve the unconfirmed control by inspection or cancel the case; do not issue another control.");
      const attempt = this.#liveAttempts.get(p.caseId);
      if (!attempt) throw error("not_running", "This case has no live worker. Saved evidence is not live state.");
      const observed = attempt.controller.inspect();
      if (method === "debug.pause" ? observed.attemptId !== p.attemptId : observed.pause?.pauseId !== p.pauseId) throw error(method === "debug.pause" ? "stale_attempt" : "stale_pause", "The control target is no longer current.");
      receipt = { caseId: p.caseId, controlId: p.controlId, signature, method, targetId: p.pauseId ?? p.attemptId,
        at: new Date().toISOString(), status: "pending", error: null };
      journal.controls.push(receipt); await this.#save();
      try {
        if (method === "debug.pause") await attempt.controller.pause(p.attemptId);
        else if (method === "debug.continue") await attempt.controller.continue(p.pauseId);
        else await attempt.controller.step(p.pauseId, p.kind);
        receipt.status = "applied"; await this.#save();
      } catch (cause) {
        // A timeout/lost reply may mean the command executed. Persist uncertainty
        // and never replay it, even if the next client reuses its identity.
        receipt.status = "pending"; receipt.error = safeError(cause); await this.#save(); throw cause;
      }
      return { receipt: { controlId: receipt.controlId, status: receipt.status }, debugger: await this.#debugSnapshot(p.caseId) };
    }
    const attempt = this.#liveAttempts.get(p.caseId);
    if (!attempt) throw error("stale_handle", "This worker and its live inspection handles no longer exist.");
    if (method === "debug.stack") return attempt.controller.stack(p.pauseId, p.offset, p.limit);
    if (method === "debug.scopes") return attempt.controller.scopes(p.pauseId, p.frameId);
    if (method === "debug.properties") return attempt.controller.properties(p.pauseId, p.objectId, p.offset, p.limit);
    throw error("unsupported_operation", "This live debugger method is unavailable.");
  }
  #case(id: string) {
    const item = this.#journal!.cases.find(c => c.caseId === id);
    if (!item) throw error("not_found", "The case does not exist in this session.");
    return item;
  }
  #binding(item: CaseRecord): ExecutableBindingV1 {
    const j = this.#journal!, p = j.prepared!, selected = j.manifest.cases.find(c => c.caseId === item.caseId)!;
    const ref = item.runRef, createdAt = j.createdAt, configuration = { configurationId: p.configuration.configurationId, contentHash: runConfigurationContentHash(p.configuration) };
    const actor = { userId: "local-developer", roleId: "headless-debugger" };
    return executableBindingSchema.parse({ id: ref.executionId, buildSha256: p.buildSha256, workflow: p.workflow,
      invocation: { schemaVersion: 1, runRef: ref, workflow: p.workflow, workflowContractVersion: p.workflowContractVersion,
        resultKind: p.resultKind, input: selected.input, runConfiguration: configuration, createdAt },
      runConfiguration: p.configuration, executionProfile: p.executionProfile, nonSecretEnvironment: p.nonSecretEnvironment,
      credentialReferences: p.credentialReferences, hostRequirements: p.hostRequirements,
      runManifest: { schemaVersion: 3, runRef: ref, workflow: p.workflow, actor, runConfiguration: configuration, createdAt } });
  }
  async #run(caseId: string) {
    const item = this.#case(caseId);
    if (!this.#journal!.prepared) throw error("preparation_incomplete", "Session preparation did not finish. Create a new session after correcting setup.");
    const state = await this.#runtime!.store.read(item.runRef);
    if (state?.compute?.certainty === "uncertain" || item.error?.code === "state_uncertain" || this.#backgroundFailure) throw error("state_uncertain", "This case cannot be automatically restarted.");
    if (item.cancelled || (state && (terminalRun(state) || state.status === "waiting_for_input")) || this.#active.has(caseId)) return this.#caseSnapshot(item);
    if (this.#active.size || this.#responses.size) throw error("case_busy", "Another case is active in this session.");
    if (state && digest(state.binding) !== digest(this.#binding(item))) throw error("state_uncertain", "The saved Run binding differs from this case.");
    item.intent = true; item.error = null; await this.#save();
    const controller = new AbortController(); this.#admissionControllers.set(caseId, controller);
    this.#launch(item, async () => {
      try {
        if (!await this.#runtime!.store.read(item.runRef)) {
          const binding = this.#binding(item), p = this.#journal!.prepared!;
          await this.#runtime!.runs.reserve({ actor: binding.runManifest!.actor, workflow: p.workflow,
            input: this.#journal!.manifest.cases.find(c => c.caseId === caseId)!.input,
            requestedExecutionId: item.runRef.executionId,
            resolvedConfiguration: { configuration: p.configuration, contentHash: runConfigurationContentHash(p.configuration) } },
          { workflow: p.workflow, agentSlotIds: p.agentSlotIds, prepareBinding: async () => binding, signal: controller.signal });
        }
        if (item.cancelled) await this.#runtime!.store.cancel(item.runRef);
        await this.#runtime!.runs.execute(item.runRef);
      } finally { this.#admissionControllers.delete(caseId); }
    });
    return this.#caseSnapshot(item);
  }
  #launch(item: CaseRecord, work: () => Promise<void>) {
    const pending = Promise.resolve().then(work).catch(cause => { if (!item.cancelled) item.error = safeError(cause); }).finally(async () => {
      this.#active.delete(item.caseId);
      await this.#serial(async () => { await this.#save(); });
    }).catch(() => { this.#backgroundFailure = safeError(error("storage_unavailable", "Diagnostic progress could not be saved. Inspect before retrying.")); });
    this.#active.set(item.caseId, pending);
  }
  async #respond(params: { caseId: string; requestId: string; submissionId: string; expectedRevision: number; response: unknown }) {
    const { item, submission } = await this.#serial(async () => {
      if (this.#closing) throw error("session_busy", "The diagnostic session is closing.");
      if (!this.#journal) throw error("not_found", "Open or create a diagnostic session first.");
      const item = this.#case(params.caseId);
      if (!this.#journal.prepared) throw error("preparation_incomplete", "Session preparation did not finish.");
      if (Object.keys((params.response as { files: object }).files).length) throw error("unsupported_operation", "Headless V1 accepts field answers, not file uploads.");
      if ((this.#active.size && !this.#active.has(item.caseId)) || (this.#responses.size && !this.#responses.has(item.caseId))) throw error("case_busy", "Another case is active in this session.");
      const signature = digest(params), pending = this.#responses.get(item.caseId);
      if (pending) {
        if (pending.signature !== signature) throw error("case_busy", "Another answer for this case is being validated.");
        return { item, submission: pending }; // Join an identical in-flight submission.
      }
      const control = await this.#runtime!.store.read(item.runRef);
      if (!control) throw error("not_found", "This case has not started.");
      if (control.compute?.certainty === "uncertain" || digest(control.binding) !== digest(this.#binding(item)) || this.#backgroundFailure) throw error("state_uncertain", "The saved Run cannot safely accept a response.");
      const controller = new AbortController();
      const work = this.#runtime!.runs.submitInput(item.runRef, params.requestId,
        { submissionId: params.submissionId, expectedRevision: params.expectedRevision, response: params.response }, "local-developer", { signal: controller.signal })
        .then(receipt => { if ("kind" in receipt) throw error("unsupported_operation", "This diagnostic session cannot answer graph entry input."); return receipt; });
      // The worker can reject before this queue callback returns to its caller.
      void work.catch(() => {});
      const submission = { signature, controller, work }; this.#responses.set(item.caseId, submission);
      return { item, submission };
    });
    let receipt: InputSubmissionReceiptV1;
    try { receipt = await submission.work; }
    catch (cause) {
      return this.#serial(async () => {
        if (this.#responses.get(item.caseId) === submission) this.#responses.delete(item.caseId);
        const control = await this.#runtime!.store.read(item.runRef), saved = control?.requests[params.requestId];
        // Duplicate receipts are resolved by the retained store before expiry checks.
        if (["request-closed", "run-closed"].includes(String((cause as { code?: string })?.code)) && saved
          && (saved.status === "expired" || (saved.status === "pending" && Date.now() >= Date.parse(saved.definition.expiresAt)))) {
          throw error("input_expired", "This input request expired. Its answer was not accepted.");
        }
        throw cause;
      });
    }
    return this.#serial(async () => {
      if (this.#responses.get(item.caseId) === submission) this.#responses.delete(item.caseId);
      if (!this.#closing && !item.cancelled && !this.#active.has(item.caseId)) this.#launch(item, () => this.#runtime!.runs.execute(item.runRef));
      try { await this.#save(); return { receipt, case: await this.#caseSnapshot(item) }; }
      catch {
        // The retained submission already committed. Never report it as rejected.
        item.error = safeError(error("storage_unavailable", "The answer was accepted, but diagnostic evidence could not be refreshed. Inspect or retry the same submission."));
        return { receipt, case: { caseId: item.caseId, runRef: item.runRef, state: "action_required", runStatus: "resume_queued", comparison: "unavailable", checks: [], inputRequests: [], evidence: [], error: item.error } };
      }
    });
  }
  async #cancel(caseId: string) {
    const item = this.#case(caseId), state = await this.#runtime!.store.read(item.runRef);
    if (!state || !terminalRun(state)) {
      item.cancelled = true; item.error = null;
      this.#admissionControllers.get(caseId)?.abort();
      const response = this.#responses.get(caseId); response?.controller.abort();
      await this.#save();
      if (state) { await this.#runtime!.store.cancel(item.runRef); await this.#runtime!.runs.execute(item.runRef); }
      if (response) {
        await response.work.catch(() => {});
        if (this.#responses.get(caseId) === response) this.#responses.delete(caseId);
      }
      // Admission may still be running. Its work observes item.cancelled before execution.
      // Do not await the serial journal-finalizer while holding its own mutex.
      while (this.#active.has(caseId)) await new Promise(resolve => setTimeout(resolve, 5));
    }
    return this.#caseSnapshot(item);
  }
  async #safeRead(file: string): Promise<unknown | undefined> {
    const relative = path.relative(this.#root!, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw error("state_uncertain", "Evidence path escapes the session.");
    let current = this.#root!;
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(cause => { if (cause.code === "ENOENT") return undefined; throw cause; });
      if (!stat) return undefined;
      if (stat.isSymbolicLink()) throw error("state_uncertain", "Evidence must not follow symbolic links.");
    }
    return readDurableJson(file);
  }
  async #putEvidence(item: CaseRecord, kind: string, value: unknown, payload = false): Promise<Evidence> {
    const clean = sanitizeEvidence(value, { payload, knownSecrets: this.#knownSecrets() });
    const bytes = evidenceBytes(clean.value); const sha256 = bytesHash(bytes), evidenceId = `e-${digest([item.caseId, kind, sha256])}`;
    const file = path.join(this.#root!, "evidence", `${evidenceId}.json`);
    const existing = await this.#safeRead(file);
    if (existing === undefined) await replaceDurableJson(file, clean.value);
    else if (bytesHash(evidenceBytes(existing)) !== sha256) throw error("state_uncertain", "Saved evidence content differs from its identity.");
    const descriptor = { evidenceId, kind, mediaType: "application/json", totalBytes: bytes.length, sha256, redacted: clean.redacted };
    const metadata = { caseId: item.caseId, descriptor }, metadataPath = path.join(this.#root!, "evidence", `${evidenceId}.meta.json`);
    const savedMetadata = await this.#safeRead(metadataPath);
    if (savedMetadata === undefined) await replaceDurableJson(metadataPath, metadata);
    else if (digest(savedMetadata) !== digest(metadata)) throw error("state_uncertain", "Saved evidence metadata differs from its identity.");
    return descriptor;
  }
  async #caseSnapshot(item: CaseRecord) {
    const p = this.#journal!.prepared, control = await this.#runtime!.store.read(item.runRef), active = this.#active.has(item.caseId) || this.#responses.has(item.caseId);
    if (control && !p) throw error("state_uncertain", "An incomplete session cannot own an executable Run.");
    if (control && p && digest(control.binding) !== digest(this.#binding(item))) throw error("state_uncertain", "Run identity or pinned settings differ from the diagnostic case.");
    const selected = this.#journal!.manifest.cases.find(c => c.caseId === item.caseId)!;
    const evidence: Evidence[] = [await this.#putEvidence(item, "input", selected.input, true), await this.#putEvidence(item, "expectations", selected.expectations, true)];
    let payload: unknown, available = false, unavailable = false;
    const settled = !!control && terminalRun(control) && !active && !control.owner;
    if (settled && control.status === "complete") {
      try {
        const result = validatePublishedResultEnvelope(await this.#safeRead(path.join(this.#root!, "runs", item.runRef.executionId, `${p!.resultKind}.json`)));
        if (result.runRef.executionId !== item.runRef.executionId || result.resultKind !== p!.resultKind || digest(result.payload) !== digest(control.output)) throw Error("Result differs");
        payload = result.payload; available = true; evidence.push(await this.#putEvidence(item, "result", payload, true));
      } catch { unavailable = true; }
    }
    if (control) {
      const durable = resolveLocalDurableExecutionPaths(this.options.projectRoot, item.runRef, this.#root).root;
      const directory = path.join(durable, "steps"); const stepItems = [];
      const names = await fs.readdir(directory).catch(cause => { if (cause.code === "ENOENT") return []; throw cause; });
      for (const name of names.filter(n => n.endsWith(".json") && !n.startsWith(".")).sort()) {
        await this.#safeRead(path.join(directory, name));
        const stepId = decodeURIComponent(name.slice(0, -5)), step = await new FileStepCheckpointStoreV2({ root: durable }).read({ runRef: item.runRef, stepId });
        if (!step) continue;
        let outputEvidenceId: string | null = null;
        if (step.completed) { const output = await this.#putEvidence(item, "step-output", { stepId, output: step.completed.output }, true); evidence.push(output); outputEvidenceId = output.evidenceId; }
        const externalDiagnostic = getExternalErrorDiagnostic(step.terminal);
        stepItems.push({ stepId, state: step.state, attemptCount: step.attemptCount, elapsedMs: step.completed?.execution.elapsedMs ?? null, outputEvidenceId,
          ...(step.terminal ? { terminal: { code: step.terminal.code, at: step.terminal.at,
            message: externalDiagnostic?.message ?? "The workflow step stopped before completion. Inspect its state before retrying.",
            ...(externalDiagnostic ? { externalDiagnostic } : {}) } } : {}) });
      }
      evidence.push(await this.#putEvidence(item, "steps", { final: settled, items: stepItems }));
      const rawPerformance = await this.#safeRead(path.join(this.#root!, "runs", item.runRef.executionId, "state", "performance.json"));
      const summary = rawPerformance === undefined ? null : validateRunPerformance(rawPerformance);
      if (summary && (summary.runRef.executionId !== item.runRef.executionId || digest(summary.workflow) !== digest(p!.workflow))) throw error("state_uncertain", "Performance identity differs from the Run.");
      evidence.push(await this.#putEvidence(item, "performance", { activeMs: control.compute?.spentMs ?? null, certainty: control.compute?.certainty ?? null,
        final: settled, published: summary !== null, totalElapsedMs: summary?.totalElapsedMs ?? null,
        usage: summary?.usage ?? null, stages: summary?.stages ?? null,
        agentAttempts: summary?.agentAttempts.map(({ stageId, logicalAgentId, metrics }) => ({ stageId, slotId: logicalAgentId,
          providerId: metrics.providerId, model: metrics.model ?? null, attempt: metrics.attempt ?? null,
          status: metrics.status, elapsedMs: metrics.elapsedMs, usage: metrics.usage ?? null })) ?? null,
        limits: control.compute?.limits ?? p!.executionProfile.computeLimits, lastAttempt: control.compute?.lastAttempt ? { outcome: control.compute.lastAttempt.outcome, elapsedMs: control.compute.lastAttempt.elapsedMs } : null,
        workflow: p!.workflow, configurationId: p!.configuration.configurationId, buildSha256: p!.buildSha256,
        agents: Object.entries(p!.configuration.agents).map(([slotId, value]) => { const policy = value as { execution: { provider: string; authProvider: string; parameters?: Record<string, unknown> } };
          return { slotId, runtime: policy.execution.provider, connectionId: policy.execution.authProvider, model: policy.execution.parameters?.model ?? null }; }) }));
    }
    // A failed evidence refresh must not permanently hide a later validated result.
    if (item.error?.code === "storage_unavailable" && settled && available) item.error = null;
    const uncertain = control?.compute?.certainty === "uncertain";
    const dormant = !!control && !active && !settled && control.status !== "waiting_for_input";
    let controlFailure: SafeError | null = null;
    if (control?.failure) controlFailure = getExternalErrorDiagnostic(control.failure) ? safeError(control.failure)
      : safeError(error("internal_error", "The workflow Run failed. Inspect the saved steps and performance evidence."));
    const failure = this.#backgroundFailure ?? item.error ?? (uncertain ? safeError(error("state_uncertain", "The Run stopped with uncertain accounting; automatic retry is disabled."))
      : dormant ? safeError(error("preparation_incomplete", "The saved Run has a pending execution intent. Use case.run with the same case ID to continue."))
      : controlFailure);
    if (failure) evidence.push(await this.#putEvidence(item, "failure", failure));
    const runStatus = control ? projectRetainedRunStatus(control).status : null;
    const comparison = item.cancelled && !control ? { comparison: "not_checked" as const, checks: [] }
      : compareExpectations(selected.expectations, { terminal: settled, runStatus, resultAvailable: available, resultPayload: payload, unavailable: unavailable || uncertain });
    // Keep the protocol response bounded. The full safe text remains available
    // through the failure evidence descriptor and paginated evidence.read.
    const visibleFailure = failure?.externalDiagnostic && failure.externalDiagnostic.message.length > 4096
      ? { code: failure.code, message: failure.message, retry: failure.retry } : failure;
    return { caseId: item.caseId, runRef: control ? item.runRef : null,
      state: uncertain || item.error || this.#backgroundFailure || dormant ? "action_required" : active
        ? this.#liveAttempts.get(item.caseId)?.controller.inspect().state === "paused" ? "paused" : "active"
        : control?.status === "waiting_for_input" ? "waiting_for_input" : settled || item.cancelled ? "terminal" : "not_started",
      runStatus, ...comparison, inputRequests: control ? Object.values(control.requests).map(r => ({ requestId: r.definition.requestId, revision: r.revision, status: r.status, expiresAt: r.definition.expiresAt,
        form: sanitizeEvidence(r.definition.form, { payload: true }).value })) : [], evidence, error: visibleFailure };
  }
  async #snapshot() {
    const j = this.#journal!, cases = [];
    for (const item of j.cases) cases.push(await this.#caseSnapshot(item));
    const observed = digest(cases); if (j.observedHash !== observed) { j.observedHash = observed; await this.#save(); }
    return { sessionId: j.manifest.sessionId, revision: j.revision, manifestHash: j.manifestHash, preparation: j.prepared ? "ready" : "incomplete",
      workflow: j.prepared?.workflow ?? null, configuration: j.prepared ? { configurationId: j.prepared.configuration.configurationId, contentHash: runConfigurationContentHash(j.prepared.configuration) } : null,
      build: j.prepared ? { buildSha256: j.prepared.buildSha256, version: j.prepared.buildVersion } : null, runtime: j.runtime, cases };
  }
  async #readEvidence(params: { caseId: string; evidenceId: string; offset: number; limit: number }) {
    const item = this.#case(params.caseId);
    if (!/^e-[a-f0-9]{64}$/.test(params.evidenceId)) throw error("not_found", "This evidence does not belong to the selected case.");
    const metadata = await this.#safeRead(path.join(this.#root!, "evidence", `${params.evidenceId}.meta.json`));
    if (metadata === undefined) throw error("not_found", "This evidence does not belong to the selected case.");
    const { caseId, descriptor } = z.strictObject({ caseId: z.string(), descriptor: evidenceSchema }).parse(metadata);
    if (caseId !== item.caseId) throw error("not_found", "This evidence does not belong to the selected case.");
    if (descriptor.evidenceId !== params.evidenceId || descriptor.evidenceId !== `e-${digest([caseId, descriptor.kind, descriptor.sha256])}`) throw error("state_uncertain", "Evidence metadata failed its identity check.");
    const stored = await this.#safeRead(path.join(this.#root!, "evidence", `${descriptor.evidenceId}.json`));
    if (stored === undefined) throw error("storage_unavailable", "The saved evidence is missing. It will not be regenerated by running the workflow.");
    const bytes = evidenceBytes(stored); if (bytesHash(bytes) !== descriptor.sha256) throw error("state_uncertain", "Saved evidence failed its integrity check.");
    if (params.offset > bytes.length) throw error("invalid_request", "Evidence offset exceeds the item length.");
    const end = Math.min(bytes.length, params.offset + params.limit);
    return { evidenceId: descriptor.evidenceId, mediaType: descriptor.mediaType, encoding: "base64", offset: params.offset, totalBytes: bytes.length,
      data: bytes.subarray(params.offset, end).toString("base64"), nextOffset: end === bytes.length ? null : end };
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#abort.abort();
    for (const controller of this.#admissionControllers.values()) controller.abort();
    for (const response of this.#responses.values()) response.controller.abort();
    return this.#closing = (async () => {
      // Preparation and accepted commands settle first. No new command enters after closing.
      await this.#tail;
      if (!this.#runtime) return;
      // Keep the storage authority until worker teardown and journal finalizers settle.
      await this.#runtime.runs.close();
      await Promise.allSettled([...this.#responseOperations]);
      await Promise.allSettled([...this.#active.values()]); await this.#tail;
      let cleanupConfirmed = true;
      for (const item of this.#journal!.cases) {
        const state = await this.#runtime.store.read(item.runRef);
        if (state?.owner) cleanupConfirmed = false;
      }
      await this.#runtime.close();
      if (!cleanupConfirmed) throw error("cleanup_unconfirmed", "A diagnostic worker still owns the Run.");
      if (this.#backgroundFailure) throw error(this.#backgroundFailure.code, this.#backgroundFailure.message);
    })();
  }
}
