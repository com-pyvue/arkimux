import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { retainedExternalDiagnosticSchema } from "../../application/retainedExecution.ts";
import type { ExternalErrorDiagnostic } from "../../application/externalError.ts";
import { activeComputeLimitsSchema, diagnosticClockRecordSchema, diagnosticMonotonicNow, readinessFailureSchema, readinessFailureMessage, remainingComputeMs, type DiagnosticClockRecordV2, type ActiveComputeLimitsV1, type AccountedOutcomeV1, type ReadinessFailureV1 } from "../../application/activeCompute.ts";
import { hashJson, type JsonValue } from "../../application/durableWorkflow.ts";
import { inputWaitJsonSnapshot, inputFormDigestV1, InputResponseShapeError, parseInputWaitDurationV1, validateInputFormDescriptorV1, validateInputResponseShapeV1,
  INPUT_UPLOAD_MAX_BYTES_PER_FILE, INPUT_UPLOAD_MAX_BYTES_PER_REQUEST, INPUT_UPLOAD_MAX_FILES_PER_FIELD, INPUT_UPLOAD_ORPHAN_GRACE_MS,
  type ImmutableInputFileRefV1, type InputFormDescriptorV1, type InputRequestV1, type InputResponseV1 } from "../../application/inputWait.ts";
import { digest, executableBindingSchema, InputControlConflict, ownerSchema, requestKey, retainedId, runKey, sameOwner, terminalRun,
  validateRetainedRunControl, type ExecutableBindingV1, type InputControlStoreV1, type InputSubmissionReceiptV1,
  type RetainedOwnerV1, type RetainedRunControlV1, type StoredInputSubmissionV1 } from "../../application/retainedExecution.ts";
import { validateRunRef, type RunRef } from "../../domain/runIdentity.ts";
import type { GraphAcceptedBoundaryV1 } from "../../application/graphInvocationRecords.ts";
import { validateGraphEntryBoundaryV1, type GraphEntryBoundaryV1 } from "../../application/graphInvocation.ts";
import type { GraphWorkflowV1 } from "../../application/graphWorkflow.ts";
import { restoreRetainedGraphInputV1, validateRetainedGraphInputV1,
  type RetainedGraphInputV1 } from "../../application/retainedGraphInput.ts";
import { LocalFileAuthority, readDurableJson, replaceDurableBytes, replaceDurableJson, syncDirectory } from "./localFileAuthority.ts";

const byteHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sha = (value: unknown): string => hashJson(inputWaitJsonSnapshot(value));
const buildFile = z.string().refine(value => value.length > 0 && !value.includes("\\") && !path.posix.isAbsolute(value)
  && value.split("/").every(segment => /^[a-zA-Z0-9_@][a-zA-Z0-9._@+-]*$/.test(segment)
    && !["constructor", "prototype", "__proto__", "credentials", "credentials.json", "credential", "auth.json", "secrets", "secrets.json", "login", "node_modules"].includes(segment.toLowerCase())));
const preparationSchema = z.strictObject({ keySha256: digest, resolutionSha256: digest, inputFiles: z.record(z.string(), digest) });
const manifestSchema = z.strictObject({ schemaVersion: z.literal(1), buildSha256: digest, inputSha256: digest,
  createdAt: z.string().datetime({ precision: 3 }), entryPoint: buildFile,
  hostRequirements: z.record(z.string(), z.string()),
  files: z.record(buildFile, z.strictObject({ sha256: digest, byteLength: z.number().int().nonnegative().safe() })),
  preparation: preparationSchema.optional(),
});
const uploadFieldId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/)
  .refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const uploadManifestSchema = z.strictObject({ schemaVersion: z.literal(1), objectId: retainedId,
  runKey: digest, requestId: retainedId, fieldId: uploadFieldId, uploadId: retainedId,
  filename: z.string().min(1), mediaType: z.string().min(1), byteLength: z.number().int().nonnegative().safe(), sha256: digest,
  createdAt: z.string().datetime({ precision: 3 }), state: z.enum(["attached", "referenced", "orphaned"]),
  orphanedAt: z.string().datetime({ precision: 3 }).optional() });
type InputUploadManifestV1 = z.infer<typeof uploadManifestSchema>;
export interface InputFileUploadV1 { fieldId: string; uploadId: string; filename: string; mediaType: string; bytes: Uint8Array }
export interface InputFileUploadReceiptV1 { requestId: string; fieldId: string; uploadId: string; file: ImmutableInputFileRefV1 }
export type RetainedBuildManifestV1 = z.infer<typeof manifestSchema>;
export interface BuildCleanupPreviewV1 { readonly builds: readonly { readonly buildSha256: string; readonly byteLength: number }[] }
function conflict(code: ConstructorParameters<typeof InputControlConflict>[0]): never { throw new InputControlConflict(code); }
const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
};
const satisfies = (required: Record<string, string>, actual: Record<string, string>): boolean => Object.entries(required).every(([key, version]) => actual[key] === version);

/** Distinguishes a rejected submission from invalid stored state or storage I/O. */
export class InputSubmissionValidationError extends Error {
  constructor(readonly field: string, message: string) { super(message); }
}
export class InputFileUploadValidationError extends Error {
  constructor(readonly code: "invalid-upload" | "unsupported-media-type" | "file-too-large" | "file-count-exceeded" | "request-size-exceeded",
    readonly field: string, message: string) { super(message); }
}
function submissionShape(form: InputFormDescriptorV1, value: unknown): InputResponseV1 {
  try { return validateInputResponseShapeV1(form, value); }
  catch (error) {
    if (error instanceof InputResponseShapeError) throw new InputSubmissionValidationError(error.field, error.message);
    throw error;
  }
}
function validateUploadFilename(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 255
    || value === "." || value === ".." || path.basename(value) !== value || /[\\/\0-\x1f\x7f]/.test(value)) {
    throw new InputFileUploadValidationError("invalid-upload", "$file", "Filename must be a plain name without a path or control characters.");
  }
  return value;
}
function uploadReceipt(manifest: InputUploadManifestV1): InputFileUploadReceiptV1 {
  return { requestId: manifest.requestId, fieldId: manifest.fieldId, uploadId: manifest.uploadId,
    file: { objectId: manifest.objectId, mediaType: manifest.mediaType, byteLength: manifest.byteLength, sha256: manifest.sha256 } };
}
function sameFileRef(manifest: InputUploadManifestV1, file: ImmutableInputFileRefV1): boolean {
  return manifest.objectId === file.objectId && manifest.mediaType === file.mediaType
    && manifest.byteLength === file.byteLength && manifest.sha256 === file.sha256;
}
function responseHasFile(response: InputResponseV1 | undefined, fieldId: string, manifest: InputUploadManifestV1): boolean {
  return !!response?.files[fieldId]?.some(file => sameFileRef(manifest, file));
}

/** Internal same-machine adapter. All mutations, uploads and build pins share one authority.
 * Callers enforce authorization and supply the retained validator.
 * This adapter never invokes a workflow, retrieves credentials or exposes public paths.
 */
export class FileRetainedExecutionStoreV1 implements InputControlStoreV1 {
  readonly #authority: LocalFileAuthority;
  readonly #now: () => Date;
  readonly #buildHolds = new Map<string, number>();
  private constructor(authority: LocalFileAuthority, now: () => Date) { this.#authority = authority; this.#now = now; }
  static async open(root: string, options: { now?: () => Date } = {}): Promise<FileRetainedExecutionStoreV1> {
    return new FileRetainedExecutionStoreV1(await LocalFileAuthority.open(root), options.now ?? (() => new Date()));
  }
  async close(): Promise<void> { await this.#authority.close(); }
  #at(): string { return this.#now().toISOString(); }
  #file(ref: RunRef): string { return path.join(this.#authority.root, "runs", `${runKey(ref)}.json`); }
  #uploadRoot(ref: RunRef): string { return path.join(this.#authority.root, "uploads", runKey(ref)); }
  #uploadDirectory(ref: RunRef, objectId: string): string { return path.join(this.#uploadRoot(ref), retainedId.parse(objectId)); }
  async #read(ref: RunRef): Promise<RetainedRunControlV1 | undefined> {
    const value = await readDurableJson(this.#file(ref));
    if (value === undefined) return undefined;
    const state = validateRetainedRunControl(value);
    if (runKey(state.runRef) !== runKey(ref)) conflict("binding-mismatch");
    return state;
  }
  async #required(ref: RunRef): Promise<RetainedRunControlV1> { return await this.#read(ref) ?? conflict("not-found"); }
  async #save(state: RetainedRunControlV1): Promise<void> {
    state.revision++; state.updatedAt = this.#at();
    await replaceDurableJson(this.#file(state.runRef), validateRetainedRunControl(state));
    await this.#reconcileInputUploads(state);
  }
  async #uploadManifests(ref: RunRef): Promise<InputUploadManifestV1[]> {
    const root = this.#uploadRoot(ref);
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(root, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const manifests: InputUploadManifestV1[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Retained upload object must be a directory.");
      const directory = path.join(root, entry.name), value = await readDurableJson(path.join(directory, "manifest.json"));
      if (value === undefined) { await fs.rm(directory, { recursive: true, force: true }); continue; }
      const manifest = uploadManifestSchema.parse(value);
      if (manifest.objectId !== entry.name || manifest.runKey !== runKey(ref)) throw new Error("Retained upload binding differs.");
      manifests.push(manifest);
    }
    return manifests;
  }
  async #verifyUploadBytes(ref: RunRef, manifest: InputUploadManifestV1): Promise<Uint8Array> {
    const file = path.join(this.#uploadDirectory(ref, manifest.objectId), "content");
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.byteLength) throw new Error("Retained upload bytes are corrupt.");
    const bytes = await fs.readFile(file);
    if (byteHash(bytes) !== manifest.sha256) throw new Error("Retained upload bytes are corrupt.");
    return bytes;
  }
  async #reconcileInputUploads(state: RetainedRunControlV1): Promise<void> {
    const root = this.#uploadRoot(state.runRef);
    if (state.retainedDataDeleted) { await fs.rm(root, { recursive: true, force: true }); return; }
    for (const manifest of await this.#uploadManifests(state.runRef)) {
      const request = state.requests[manifest.requestId];
      let nextState: InputUploadManifestV1["state"], orphanedAt: string | undefined;
      if (request?.status === "pending") nextState = "attached";
      else if (request?.status === "submitted" && responseHasFile(request.response as InputResponseV1, manifest.fieldId, manifest)) nextState = "referenced";
      else { nextState = "orphaned"; orphanedAt = manifest.orphanedAt ?? request?.updatedAt ?? state.updatedAt; }
      if (nextState === "orphaned" && Date.parse(this.#at()) - Date.parse(orphanedAt!) >= INPUT_UPLOAD_ORPHAN_GRACE_MS) {
        await fs.rm(this.#uploadDirectory(state.runRef, manifest.objectId), { recursive: true, force: true });
        continue;
      }
      if (manifest.state !== nextState || manifest.orphanedAt !== orphanedAt) {
        const updated: Record<string, unknown> = { ...manifest, state: nextState };
        if (orphanedAt) updated.orphanedAt = orphanedAt; else delete updated.orphanedAt;
        await replaceDurableJson(path.join(this.#uploadDirectory(state.runRef, manifest.objectId), "manifest.json"),
          uploadManifestSchema.parse(updated));
      }
    }
  }
  async #verifyResponseUploads(state: RetainedRunControlV1, requestId: string, response: InputResponseV1): Promise<void> {
    const manifests = await this.#uploadManifests(state.runRef), byId = new Map(manifests.map(manifest => [manifest.objectId, manifest]));
    const seen = new Set<string>();
    for (const [fieldId, files] of Object.entries(response.files)) for (const file of files) {
      if (seen.has(file.objectId)) throw new InputSubmissionValidationError(fieldId, "An uploaded file can be submitted only once.");
      seen.add(file.objectId);
      const manifest = byId.get(file.objectId);
      if (!manifest || manifest.requestId !== requestId || manifest.fieldId !== fieldId || manifest.state !== "attached"
        || !sameFileRef(manifest, file)) throw new InputSubmissionValidationError(fieldId, "Uploaded file is not finalized for this Run and input request.");
      await this.#verifyUploadBytes(state.runRef, manifest);
    }
  }
  async read(ref: RunRef): Promise<RetainedRunControlV1 | undefined> {
    const fixed = validateRunRef(inputWaitJsonSnapshot(ref));
    return this.#authority.transaction(() => this.#read(fixed));
  }

  /** Finalizes exactly one request-bound file. A reused upload ID is idempotent
   * only when every immutable byte and declared property is identical. */
  async uploadInputFile(ref: RunRef, requestId: string, value: InputFileUploadV1): Promise<InputFileUploadReceiptV1> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref)); retainedId.parse(requestId); retainedId.parse(value.uploadId);
    const fieldId = typeof value.fieldId === "string" ? value.fieldId : "";
    const filename = validateUploadFilename(value.filename), mediaType = typeof value.mediaType === "string" ? value.mediaType : "";
    if (!(value.bytes instanceof Uint8Array)) throw new InputFileUploadValidationError("invalid-upload", fieldId || "$file", "Upload must contain one complete file.");
    const bytes = Buffer.from(value.bytes), sha256 = byteHash(bytes);
    if (bytes.byteLength > INPUT_UPLOAD_MAX_BYTES_PER_FILE) throw new InputFileUploadValidationError("file-too-large", fieldId || "$file",
      `File must not exceed ${INPUT_UPLOAD_MAX_BYTES_PER_FILE} bytes.`);
    const objectId = `upload-${sha({ runKey: runKey(ref), requestId, fieldId, uploadId: value.uploadId })}`;
    return this.#authority.transaction(async () => {
      const state = await this.#required(ref);
      await this.#reconcileInputUploads(state);
      const directory = this.#uploadDirectory(ref, objectId), manifestFile = path.join(directory, "manifest.json");
      const existingValue = await readDurableJson(manifestFile);
      if (existingValue !== undefined) {
        const existing = uploadManifestSchema.parse(existingValue);
        if (existing.runKey !== runKey(ref) || existing.requestId !== requestId || existing.fieldId !== fieldId
          || existing.uploadId !== value.uploadId || existing.filename !== filename || existing.mediaType !== mediaType
          || existing.byteLength !== bytes.byteLength || existing.sha256 !== sha256) conflict("upload-reused");
        await this.#verifyUploadBytes(ref, existing);
        return uploadReceipt(existing);
      }
      if (terminalRun(state) || state.retainedDataDeleted) conflict("run-closed");
      const request = state.requests[requestId];
      if (!request) conflict("not-found");
      if (request.status !== "pending" || Date.parse(this.#at()) >= Date.parse(request.definition.expiresAt)) conflict("request-closed");
      const field = request.definition.form.fields.find(candidate => candidate.id === fieldId);
      if (field?.type !== "files") throw new InputFileUploadValidationError("invalid-upload", fieldId || "$file", "Upload field is not declared by this input request.");
      if (!field.mediaTypes.includes(mediaType)) throw new InputFileUploadValidationError("unsupported-media-type", fieldId, "File media type is not allowed by this input field.");
      if (bytes.byteLength > field.maxBytesPerFile) throw new InputFileUploadValidationError("file-too-large", fieldId, `File must not exceed ${field.maxBytesPerFile} bytes.`);
      const manifests = await this.#uploadManifests(ref);
      if (manifests.filter(item => item.requestId === requestId && item.fieldId === fieldId && item.state !== "orphaned").length
        >= Math.min(field.maxFiles, INPUT_UPLOAD_MAX_FILES_PER_FIELD)) {
        throw new InputFileUploadValidationError("file-count-exceeded", fieldId, `This field accepts at most ${Math.min(field.maxFiles, INPUT_UPLOAD_MAX_FILES_PER_FIELD)} files.`);
      }
      const total = manifests.filter(item => item.requestId === requestId && item.state !== "orphaned")
        .reduce((sum, item) => sum + item.byteLength, 0);
      if (total + bytes.byteLength > INPUT_UPLOAD_MAX_BYTES_PER_REQUEST) throw new InputFileUploadValidationError("request-size-exceeded", fieldId,
        `Files for one input request must not exceed ${INPUT_UPLOAD_MAX_BYTES_PER_REQUEST} bytes.`);
      const manifest = uploadManifestSchema.parse({ schemaVersion: 1, objectId, runKey: runKey(ref), requestId, fieldId,
        uploadId: value.uploadId, filename, mediaType, byteLength: bytes.byteLength, sha256, createdAt: this.#at(), state: "attached" });
      try {
        await replaceDurableBytes(path.join(directory, "content"), bytes);
        await replaceDurableJson(manifestFile, manifest);
      } catch (error) {
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
      }
      return uploadReceipt(manifest);
    });
  }

  /** Internal retained-byte read used by execution adapters and conformance tests. */
  async readInputFile(ref: RunRef, file: ImmutableInputFileRefV1): Promise<Uint8Array> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref)); retainedId.parse(file.objectId);
    return this.#authority.transaction(async () => {
      const value = await readDurableJson(path.join(this.#uploadDirectory(ref, file.objectId), "manifest.json"));
      if (value === undefined) conflict("not-found");
      const manifest = uploadManifestSchema.parse(value);
      if (manifest.runKey !== runKey(ref) || manifest.state !== "referenced" || !sameFileRef(manifest, file)) conflict("binding-mismatch");
      return this.#verifyUploadBytes(ref, manifest);
    });
  }

  async cleanInputUploads(): Promise<void> {
    await this.#authority.transaction(async () => {
      for (const state of await this.#runs()) await this.#reconcileInputUploads(state);
    });
  }

  /** Host recovery and projection repair; never exposed without Run authorization. */
  async listRuns(): Promise<RetainedRunControlV1[]> {
    return this.#authority.transaction(() => this.#runs());
  }

  async createRun(ref: RunRef, binding: ExecutableBindingV1, graphInput?: {
    graph: GraphWorkflowV1;
    state: RetainedGraphInputV1;
  } | { state: RetainedGraphInputV1 }): Promise<RetainedRunControlV1> {
    const fixedRef = validateRunRef(inputWaitJsonSnapshot(ref)), fixed = executableBindingSchema.parse(inputWaitJsonSnapshot(binding));
    const fixedGraph = graphInput && ("graph" in graphInput
      ? restoreRetainedGraphInputV1(graphInput.graph, graphInput.state)
      : validateRetainedGraphInputV1(graphInput.state));
    if (fixedGraph?.invocation.acquisition === "deferred"
      && (fixedGraph.requestState?.status !== "pending" || fixedGraph.requestState.revision !== 1
        || fixedGraph.requestState.updatedAt !== fixedGraph.invocation.createdAt || fixedGraph.accepted)) {
      throw new Error("A new deferred graph Run must start with its original pending input request.");
    }
    return this.#authority.transaction(async () => {
      const existing = await this.#read(fixedRef);
      if (existing) {
        if (sha(existing.binding) !== sha(fixed) || sha(existing.graphInput ?? null) !== sha(fixedGraph ?? null)
          || existing.retainedDataDeleted) conflict("binding-mismatch");
        return existing;
      }
      const build = await this.#findBuild(fixed.buildSha256);
      if (!build || !satisfies(build.manifest.hostRequirements, fixed.hostRequirements)) conflict("missing-build");
      await this.#verifyBuild(build.directory, build.manifest);
      const state: RetainedRunControlV1 = { schemaVersion: 1, runRef: fixedRef, binding: fixed, revision: 1, fence: 0,
        status: fixedGraph?.requestState?.status === "pending" ? "waiting_for_input" : "running",
        owner: null, requests: {}, receipts: {}, commands: {}, updatedAt: this.#at(), retainedDataDeleted: false,
        ...(fixedGraph ? { graphInput: fixedGraph } : {}) };
      await replaceDurableJson(this.#file(fixedRef), validateRetainedRunControl(state));
      return state;
    });
  }

  async readGraphInput(ref: RunRef, graph: GraphWorkflowV1): Promise<RetainedGraphInputV1 | undefined> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref));
    return this.#authority.transaction(async () => {
      const state = await this.#read(ref);
      return state?.graphInput ? restoreRetainedGraphInputV1(graph, state.graphInput) : undefined;
    });
  }

  /** Validates outside the writer transaction, then atomically saves the
   * accepted boundary and queues the same Run in one control-record replace. */
  async submitGraphInput(ref: RunRef, graph: GraphWorkflowV1, body: {
    acceptanceId: string;
    expectedRevision: number;
    boundary: unknown;
  }): Promise<GraphAcceptedBoundaryV1> {
    return this.submitGraphInputValidated(ref, body, (_input, boundary) => {
      const current = restoreRetainedGraphInputV1(graph, _input);
      return validateGraphEntryBoundaryV1(current.invocation.entryPlan, boundary);
    });
  }

  async submitGraphInputValidated(ref: RunRef, body: {
    acceptanceId: string;
    expectedRevision: number;
    boundary: unknown;
  }, validate: (input: RetainedGraphInputV1, boundary: unknown) => Promise<GraphEntryBoundaryV1> | GraphEntryBoundaryV1): Promise<GraphAcceptedBoundaryV1> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref)); retainedId.parse(body.acceptanceId);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) throw new Error("Graph input revision must be a positive safe integer.");
    const observed = await this.#authority.transaction(async () => {
      const run = await this.#required(ref);
      if (!run.graphInput) conflict("not-found");
      return { run, graphInput: validateRetainedGraphInputV1(run.graphInput) };
    });
    const boundary = await validate(observed.graphInput, body.boundary);
    const bodySha256 = sha(boundary);
    const previous = observed.graphInput.accepted;
    if (previous) {
      if (previous.acceptanceId !== body.acceptanceId || previous.acceptedBodySha256 !== bodySha256) conflict("submission-reused");
      return previous;
    }
    const observedRequest = observed.graphInput.requestState;
    if (terminalRun(observed.run) || observed.run.retainedDataDeleted || observed.graphInput.invocation.acquisition !== "deferred"
      || observedRequest?.status !== "pending" || observedRequest.revision !== body.expectedRevision
      || Date.parse(this.#at()) >= Date.parse(observedRequest.request.expiresAt)) conflict("request-closed");

    return this.#authority.transaction(async () => {
      const run = await this.#required(ref);
      if (!run.graphInput) conflict("not-found");
      const current = validateRetainedGraphInputV1(run.graphInput), requestState = current.requestState;
      if (current.accepted) {
        if (current.accepted.acceptanceId !== body.acceptanceId || current.accepted.acceptedBodySha256 !== bodySha256) conflict("submission-reused");
        return current.accepted;
      }
      if (terminalRun(run) || run.retainedDataDeleted || current.invocation.acquisition !== "deferred"
        || requestState?.status !== "pending" || requestState.revision !== body.expectedRevision) conflict("request-closed");
      const acceptedAt = this.#at();
      if (Date.parse(acceptedAt) >= Date.parse(requestState.request.expiresAt)) conflict("request-closed");
      const accepted = { schemaVersion: 1 as const, acceptanceId: body.acceptanceId, runRef: current.invocation.runRef,
        planSha256: current.invocation.entryPlan.planSha256, boundary, acceptedBodySha256: bodySha256,
        acceptedAt, source: "deferred-submission" as const, requestId: requestState.request.requestId };
      run.graphInput = validateRetainedGraphInputV1({ schemaVersion: 1, invocation: current.invocation,
        requestState: { ...requestState, status: "submitted", revision: requestState.revision + 1, updatedAt: acceptedAt }, accepted });
      run.status = "resume_queued";
      await this.#save(run);
      return accepted;
    });
  }

  async expireGraphInput(ref: RunRef, graph?: GraphWorkflowV1): Promise<boolean> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref));
    return this.#authority.transaction(async () => {
      const run = await this.#required(ref);
      if (!run.graphInput || terminalRun(run)) return false;
      const current = graph ? restoreRetainedGraphInputV1(graph, run.graphInput) : validateRetainedGraphInputV1(run.graphInput);
      const requestState = current.requestState;
      if (requestState?.status !== "pending" || Date.parse(this.#at()) < Date.parse(requestState.request.expiresAt)) return false;
      run.graphInput = validateRetainedGraphInputV1({ schemaVersion: 1, invocation: current.invocation,
        requestState: { ...requestState, status: "expired", revision: requestState.revision + 1, updatedAt: this.#at() } });
      this.#fail(run, "input-expired", "The graph input request expired before an answer was accepted.");
      await this.#save(run); return true;
    });
  }

  async claim(ref: RunRef, attemptId: string, hostRequirements: Record<string, string>, computeLimits?: ActiveComputeLimitsV1, diagnosticOnly = false): Promise<RetainedOwnerV1> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref));
    retainedId.parse(attemptId); const environment = z.record(z.string(), z.string()).parse(inputWaitJsonSnapshot(hostRequirements));
    const limits = computeLimits === undefined ? undefined : activeComputeLimitsSchema.parse(inputWaitJsonSnapshot(computeLimits));
    if (diagnosticOnly && !limits) throw new Error("Diagnostic execution requires accounted limits.");
    return this.#authority.transaction(async () => {
      const state = await this.#required(ref);
      if (terminalRun(state) || state.retainedDataDeleted) conflict("run-closed");
      if (state.owner) conflict("owner-active");
      if (state.status === "waiting_for_input") conflict("request-closed");
      if (state.compute && (!limits || sha(state.compute.limits) !== sha(limits))) conflict("binding-mismatch");
      if (state.compute && !!state.compute.diagnosticOnly !== diagnosticOnly) conflict("binding-mismatch");
      // Never add a fresh budget to a Run that has already executed without accounting.
      if (!state.compute && limits && state.fence !== 0) conflict("binding-mismatch");
      if (limits && !state.compute) state.compute = { schemaVersion: 1, limits, spentMs: 0, certainty: "known", active: null,
        ...(diagnosticOnly ? { diagnosticOnly: true, excludedPauseMs: 0 } : {}) };
      if (state.compute && remainingComputeMs(state.compute) <= state.compute.limits.finalizationReserveMs) {
        this.#fail(state, "compute-budget-exhausted", "The Run has no execution allowance left after its finalization reserve.");
        await this.#save(state); conflict("run-closed");
      }
      if (!satisfies(state.binding.hostRequirements, environment)) conflict("binding-mismatch");
      const build = await this.#findBuild(state.binding.buildSha256);
      if (!build) conflict("missing-build");
      await this.#verifyBuild(build.directory, build.manifest);
      const owner = ownerSchema.parse({ attemptId, fence: state.fence + 1, pid: process.pid });
      state.owner = owner; state.fence = owner.fence; state.status = "running";
      if (state.compute) {
        const startedAt = this.#at();
        state.compute.active = { attemptId, fence: owner.fence, startedAt,
          deadlineAt: new Date(Date.parse(startedAt) + Math.min(state.compute.limits.attemptMs, remainingComputeMs(state.compute))).toISOString(),
          ...(diagnosticOnly ? { diagnostic: { schemaVersion: 2 as const, revision: 0, clock: "running" as const, pauseId: null,
            activeCount: 0, activityKnown: false, wallMs: 0, chargedMs: 0, excludedPauseMs: 0, sampledAtMonotonicMs: diagnosticMonotonicNow() } } : {}) };
      }
      for (const command of Object.values(state.commands)) if (command.state === "pending") { command.state = "claimed"; command.owner = owner; }
      await this.#save(state);
      return owner;
    });
  }

  async openRequest(ref: RunRef, owner: RetainedOwnerV1, options: {
    stepId: string; title: string; form: InputFormDescriptorV1; expiresAfter: string; runExpiresAt?: string;
  }): Promise<InputRequestV1> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref)); owner = ownerSchema.parse(inputWaitJsonSnapshot(owner));
    const form = validateInputFormDescriptorV1(options.form), duration = parseInputWaitDurationV1(options.expiresAfter);
    const fixed = { ...options, form }; retainedId.parse(fixed.stepId);
    const optionsSha256 = sha(fixed);
    return this.#authority.transaction(async () => {
      const state = await this.#required(ref); this.#owner(state, owner);
      if (terminalRun(state)) conflict("run-closed");
      const id = requestKey(ref, fixed.stepId), existing = state.requests[id];
      if (existing) {
        if (existing.optionsSha256 !== optionsSha256) conflict("binding-mismatch");
        return existing.definition; // Never recalculate timestamps on replay.
      }
      if (Object.values(state.requests).some(request => request.status === "pending") ||
        Object.values(state.commands).some(command => command.state !== "done")) conflict("request-closed");
      const createdAt = this.#at(), cap = fixed.runExpiresAt === undefined ? Infinity : Date.parse(fixed.runExpiresAt);
      if (Number.isNaN(cap)) throw new Error("Run expiry must be a timestamp.");
      const definition: InputRequestV1 = { schemaVersion: 1, requestId: id, stepId: fixed.stepId, title: fixed.title,
        form, formSha256: inputFormDigestV1(form), executableBindingId: state.binding.id, createdAt,
        expiresAt: new Date(Math.min(Date.parse(createdAt) + duration, cap)).toISOString() };
      state.requests[id] = { definition, optionsSha256, status: "pending", revision: 1, updatedAt: createdAt };
      state.status = "waiting_for_input";
      await this.#save(state);
      return definition;
    });
  }

  async submit(ref: RunRef, requestId: string, body: StoredInputSubmissionV1, responderId: string,
    validate: (request: InputRequestV1, response: InputResponseV1) => Promise<InputResponseV1>): Promise<InputSubmissionReceiptV1> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref));
    retainedId.parse(requestId); retainedId.parse(responderId);
    const fixed = z.strictObject({ submissionId: retainedId, expectedRevision: z.number().int().positive().safe(), response: z.unknown() }).parse(inputWaitJsonSnapshot(body));
    const bodySha256 = sha(fixed);
    const inspect = async () => {
      const state = await this.#required(ref), previous = state.receipts[fixed.submissionId];
      await this.#reconcileInputUploads(state);
      if (previous) {
        if (previous.acceptedBodySha256 !== bodySha256 || previous.requestId !== requestId) conflict("submission-reused");
        return { previous }; // Authorization is still required by the calling service on every retry.
      }
      if (terminalRun(state) || state.retainedDataDeleted) conflict("run-closed");
      const request = state.requests[requestId];
      if (!request) conflict("not-found");
      if (request.status !== "pending" || Date.parse(this.#at()) >= Date.parse(request.definition.expiresAt)) conflict("request-closed");
      if (request.revision !== fixed.expectedRevision) conflict("stale-revision");
      return { state, request };
    };
    const observed = await this.#authority.transaction(inspect);
    if (observed.previous) return observed.previous;
    const raw = submissionShape(observed.request!.definition.form, fixed.response);
    // User validation and upload I/O must not hold the cross-Run writer authority.
    const response = submissionShape(observed.request!.definition.form,
      await validate(structuredClone(observed.request!.definition), structuredClone(raw)));
    if (sha(response.files) !== sha(raw.files)) throw new Error("Input validation must preserve file references.");
    return this.#authority.transaction(async () => {
      const checked = await inspect();
      if (checked.previous) return checked.previous;
      const state = checked.state!, request = checked.request!;
      if (sha(request.definition) !== sha(observed.request!.definition)) conflict("binding-mismatch");
      const acceptedAt = this.#at();
      if (Date.parse(acceptedAt) >= Date.parse(request.definition.expiresAt)) conflict("request-closed");
      await this.#verifyResponseUploads(state, requestId, response);
      const commandId = `resume-${sha({ run: runKey(ref), requestId })}`;
      const receipt: InputSubmissionReceiptV1 = { schemaVersion: 1, submissionId: fixed.submissionId, requestId,
        acceptedAt, acceptedBodySha256: bodySha256, resumeCommandId: commandId, responderId };
      request.status = "submitted"; request.revision++; request.updatedAt = acceptedAt; request.response = response; request.submissionId = fixed.submissionId;
      state.receipts[fixed.submissionId] = receipt;
      state.commands[commandId] = { id: commandId, requestId, state: "pending" };
      state.status = "resume_queued";
      await this.#save(state);
      return receipt;
    });
  }

  #owner(state: RetainedRunControlV1, owner: RetainedOwnerV1): void {
    ownerSchema.parse(owner);
    if (!sameOwner(state.owner, owner)) conflict("stale-owner");
  }
  async release(ref: RunRef, owner: RetainedOwnerV1): Promise<void> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref)); owner = ownerSchema.parse(inputWaitJsonSnapshot(owner));
    await this.#authority.transaction(async () => {
      const state = await this.#required(ref); this.#owner(state, owner);
      if (state.compute) throw new Error("Accounted attempts require settleAttempt; unaccounted release is forbidden.");
      for (const command of Object.values(state.commands)) if (command.state === "claimed") { command.state = "pending"; delete command.owner; }
      state.owner = null;
      if (!terminalRun(state)) {
        if (Object.values(state.commands).some(command => command.state === "pending")) state.status = "resume_queued";
        else if (Object.values(state.requests).some(request => request.status === "pending")) state.status = "waiting_for_input";
        else state.status = "running";
      }
      await this.#save(state);
    });
  }
  async completeInput(ref: RunRef, owner: RetainedOwnerV1, requestId: string): Promise<InputResponseV1> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref)); owner = ownerSchema.parse(inputWaitJsonSnapshot(owner)); retainedId.parse(requestId);
    return this.#authority.transaction(async () => {
      const state = await this.#required(ref); this.#owner(state, owner);
      if (terminalRun(state)) conflict("run-closed");
      const request = state.requests[requestId];
      if (request?.status !== "submitted") conflict("request-closed");
      const receipt = state.receipts[request.submissionId!], command = state.commands[receipt.resumeCommandId];
      if (command.state !== "done" && !sameOwner(command.owner, owner)) conflict("stale-owner");
      command.state = "done"; delete command.owner;
      await this.#save(state);
      return request.response as InputResponseV1;
    });
  }
  async cancel(ref: RunRef): Promise<void> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref));
    await this.#authority.transaction(async () => {
      const state = await this.#required(ref);
      if (terminalRun(state)) return;
      state.status = "cancelled";
      for (const request of Object.values(state.requests)) if (request.status === "pending") { request.status = "cancelled"; request.revision++; request.updatedAt = this.#at(); }
      this.#closeGraphRequest(state, "cancelled");
      // Keep accepted receipts and queued intent; the terminal Run prevents another owner.
      await this.#save(state);
    });
  }
  async expire(ref: RunRef, requestId: string): Promise<boolean> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref)); retainedId.parse(requestId);
    return this.#authority.transaction(async () => {
      const state = await this.#required(ref), request = state.requests[requestId];
      if (terminalRun(state) || request?.status !== "pending" || Date.parse(this.#at()) < Date.parse(request.definition.expiresAt)) return false;
      request.status = "expired"; request.revision++; request.updatedAt = this.#at(); state.status = "failed";
      await this.#save(state); return true;
    });
  }
  async finish(ref: RunRef, owner: RetainedOwnerV1, outcome: "complete" | "failed"): Promise<void> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref)); owner = ownerSchema.parse(inputWaitJsonSnapshot(owner));
    await this.#authority.transaction(async () => {
      const state = await this.#required(ref); this.#owner(state, owner);
      if (state.compute) throw new Error("Accounted attempts require settleAttempt; unaccounted finish is forbidden.");
      if (terminalRun(state)) conflict("run-closed");
      if (Object.values(state.requests).some(request => request.status === "pending") || Object.values(state.commands).some(command => command.state !== "done")) conflict("request-closed");
      state.status = outcome; state.owner = null;
      await this.#save(state);
    });
  }
  async recover(): Promise<RetainedRunControlV1[]> {
    return this.#authority.transaction(async () => {
      const all = await this.#runs();
      for (const state of all) {
        await this.#reconcileInputUploads(state);
        const graphRequest = state.graphInput?.requestState;
        if (!terminalRun(state) && graphRequest?.status === "pending") {
          const now = this.#at();
          if (Date.parse(now) >= Date.parse(graphRequest.request.expiresAt)) {
            state.graphInput = validateRetainedGraphInputV1({ schemaVersion: 1, invocation: state.graphInput!.invocation,
              requestState: { ...graphRequest, status: "expired", revision: graphRequest.revision + 1, updatedAt: now } });
            this.#fail(state, "input-expired", "The graph input request expired before an answer was accepted.");
            await this.#save(state);
            continue;
          }
        }
        if (!(state.owner && !processAlive(state.owner.pid))) continue;
        if (state.compute) {
          state.compute.certainty = "uncertain"; state.compute.active = null;
          this.#fail(state, "compute-accounting-uncertain", "The worker stopped without recording elapsed execution time. Automatic resumption is stopped; inspect the Run before starting a new one.");
        }
        state.owner = null;
        for (const command of Object.values(state.commands)) if (command.state === "claimed") { command.state = "pending"; delete command.owner; }
        if (!terminalRun(state) && Object.values(state.commands).some(command => command.state === "pending")) state.status = "resume_queued";
        await this.#save(state);
      }
      // A crash after checkpoint completion but before the next step still needs recovery.
      return all.filter(state => !terminalRun(state) && !state.owner && ["resume_queued", "running"].includes(state.status));
    });
  }

  #fail(state: RetainedRunControlV1, code: string, message: string, externalDiagnostic?: ExternalErrorDiagnostic): void {
    state.status = "failed"; state.failure = { code, message, ...(externalDiagnostic ? { externalDiagnostic } : {}) };
    for (const request of Object.values(state.requests)) if (request.status === "pending") {
      request.status = "cancelled"; request.revision++; request.updatedAt = this.#at();
    }
    this.#closeGraphRequest(state, "cancelled");
  }

  #closeGraphRequest(state: RetainedRunControlV1, status: "cancelled"): void {
    const graphInput = state.graphInput;
    if (graphInput?.requestState?.status !== "pending") return;
    state.graphInput = validateRetainedGraphInputV1({ schemaVersion: 1, invocation: graphInput.invocation,
      requestState: { ...graphInput.requestState, status, revision: graphInput.requestState.revision + 1, updatedAt: this.#at() } });
  }

  async blockUncertainAttempt(ref: RunRef, owner: RetainedOwnerV1): Promise<void> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref)); owner = ownerSchema.parse(inputWaitJsonSnapshot(owner));
    await this.#authority.transaction(async () => {
      const state = await this.#required(ref); this.#owner(state, owner);
      if (!state.compute) throw new Error("Attempt has no compute accounting.");
      state.compute.certainty = "uncertain";
      this.#fail(state, "compute-accounting-uncertain", "Execution time or worker teardown could not be confirmed. Automatic resumption is stopped.");
      await this.#save(state);
    });
  }

  /** Worker read-only clock source. Never returned by a public API. */
  diagnosticClockPath(ref: RunRef): string { return this.#file(validateRunRef(inputWaitJsonSnapshot(ref))); }

  async recordDiagnosticClock(ref: RunRef, owner: RetainedOwnerV1, expectedRevision: number, record: DiagnosticClockRecordV2): Promise<void> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref)); owner = ownerSchema.parse(inputWaitJsonSnapshot(owner));
    const fixed = diagnosticClockRecordSchema.parse(inputWaitJsonSnapshot(record));
    await this.#authority.transaction(async () => {
      const state = await this.#required(ref); this.#owner(state, owner);
      const compute = state.compute, active = compute?.active, previous = active?.diagnostic;
      if (!compute?.diagnosticOnly || compute.certainty !== "known" || !active || !previous) throw new Error("Diagnostic accounting unavailable.");
      if (!Number.isSafeInteger(expectedRevision) || previous.revision !== expectedRevision || fixed.revision !== expectedRevision + 1) throw new Error("Stale diagnostic clock revision.");
      if (fixed.wallMs < previous.wallMs || fixed.chargedMs < previous.chargedMs || fixed.excludedPauseMs < previous.excludedPauseMs) throw new Error("Diagnostic counters cannot decrease.");
      if (previous.revision > 0 && fixed.sampledAtMonotonicMs < previous.sampledAtMonotonicMs) throw new Error("Diagnostic monotonic sample cannot decrease.");
      active.diagnostic = fixed;
      active.deadlineAt = new Date(Date.parse(active.startedAt) + Math.min(compute.limits.attemptMs, remainingComputeMs(compute)) + fixed.excludedPauseMs).toISOString();
      await this.#save(state);
    });
  }

  /** Called only after worker/provider teardown. One durable write accounts time,
   * releases ownership and preserves a concurrently accepted resume command. */
  async settleAttempt(ref: RunRef, owner: RetainedOwnerV1, input: {
    elapsedMs: number; outcome: AccountedOutcomeV1; requestId?: string; readinessFailure?: ReadinessFailureV1; output?: JsonValue;
    diagnostic?: { wallElapsedMs: number; excludedPauseMs: number };
    externalDiagnostic?: ExternalErrorDiagnostic;
  }): Promise<RetainedRunControlV1> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref)); owner = ownerSchema.parse(inputWaitJsonSnapshot(owner));
    const fixed = z.strictObject({ elapsedMs: z.number().int().nonnegative().safe(),
      outcome: z.enum(["suspended", "completed", "failed", "cancelled", "deadline_exceeded", "accounting_uncertain"]), requestId: retainedId.optional(),
      readinessFailure: readinessFailureSchema.optional(),
      externalDiagnostic: retainedExternalDiagnosticSchema.optional(),
      diagnostic: z.strictObject({ wallElapsedMs: z.number().int().nonnegative().safe(), excludedPauseMs: z.number().int().nonnegative().safe() }).optional(),
      output: z.unknown().transform(inputWaitJsonSnapshot).optional(),
    }).parse(inputWaitJsonSnapshot(input));
    return this.#authority.transaction(async () => {
      const state = await this.#required(ref); this.#owner(state, owner);
      const compute = state.compute;
      if (!compute?.active) throw new Error("Attempt has no compute accounting.");
      if (!!fixed.diagnostic !== !!compute.diagnosticOnly) throw new Error("Settlement accounting mode differs.");
      if (fixed.diagnostic && (fixed.diagnostic.wallElapsedMs !== fixed.elapsedMs + fixed.diagnostic.excludedPauseMs ||
        fixed.diagnostic.excludedPauseMs < (compute.active.diagnostic?.excludedPauseMs ?? 0) ||
        fixed.elapsedMs < (compute.active.diagnostic?.chargedMs ?? 0) || fixed.diagnostic.wallElapsedMs < (compute.active.diagnostic?.wallMs ?? 0) ||
        compute.active.diagnostic?.clock === "paused")) throw new Error("Diagnostic settlement is not reconciled.");
      if (!terminalRun(state) && fixed.outcome === "suspended") {
        const request = fixed.requestId && state.requests[fixed.requestId];
        if (!request || !["pending", "submitted"].includes(request.status)) conflict("request-closed");
        if (request.status === "submitted" && state.commands[state.receipts[request.submissionId!].resumeCommandId].state === "done") conflict("request-closed");
      }
      if (!terminalRun(state) && fixed.outcome === "completed" &&
        (Object.values(state.requests).some(request => request.status === "pending") || Object.values(state.commands).some(command => command.state !== "done"))) conflict("request-closed");
      const allowance = Math.min(compute.limits.attemptMs, remainingComputeMs(compute));
      if (!Number.isSafeInteger(compute.spentMs + fixed.elapsedMs)) throw new Error("Elapsed execution time exceeds safe accounting range.");
      compute.spentMs += fixed.elapsedMs;
      compute.lastAttempt = { attemptId: owner.attemptId, elapsedMs: fixed.elapsedMs, endedAt: this.#at(), outcome: fixed.outcome,
        ...(fixed.diagnostic ?? {}) };
      if (fixed.diagnostic) {
        const excluded = (compute.excludedPauseMs ?? 0) + fixed.diagnostic.excludedPauseMs;
        if (!Number.isSafeInteger(excluded)) throw new Error("Diagnostic accounting exceeds safe range.");
        compute.excludedPauseMs = excluded;
      }
      compute.active = null; state.owner = null;
      for (const command of Object.values(state.commands)) if (command.state === "claimed") { command.state = "pending"; delete command.owner; }
      if (fixed.outcome === "accounting_uncertain") {
        compute.certainty = "uncertain";
        this.#fail(state, "compute-accounting-uncertain", "Execution time or worker teardown could not be confirmed. Automatic resumption is stopped.");
      } else if (!terminalRun(state)) {
        if (fixed.elapsedMs >= allowance || fixed.outcome === "deadline_exceeded") this.#fail(state, "compute-deadline-exceeded", "The attempt reached its execution time limit.");
        else if (fixed.outcome === "failed") this.#fail(state, fixed.readinessFailure ?? "attempt-failed", fixed.externalDiagnostic?.message ?? (fixed.readinessFailure
          ? readinessFailureMessage(fixed.readinessFailure) : "The workflow attempt failed. Inspect its runtime diagnostics before retrying."), fixed.externalDiagnostic);
        else if (fixed.outcome === "cancelled") {
          this.#fail(state, "attempt-cancelled", "The workflow attempt was cancelled."); state.status = "cancelled";
        } else if (fixed.outcome === "completed") {
          if (state.binding.runManifest && fixed.output === undefined) throw new Error("A published Run requires its completed output in the settlement.");
          state.status = "complete";
          if (fixed.output !== undefined) state.output = inputWaitJsonSnapshot(fixed.output);
        }
        else state.status = Object.values(state.commands).some(command => command.state === "pending") ? "resume_queued" : "waiting_for_input";
      }
      await this.#save(state); return state;
    });
  }

  async #runs(): Promise<RetainedRunControlV1[]> {
    const directory = path.join(this.#authority.root, "runs");
    const names = await fs.readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const result: RetainedRunControlV1[] = [];
    for (const name of names) if (name.endsWith(".json")) {
      const state = validateRetainedRunControl(await readDurableJson(path.join(directory, name)));
      if (name !== `${runKey(state.runRef)}.json`) throw new Error("Stored Run path differs.");
      result.push(state);
    }
    return result;
  }

  async publishBuild(input: { inputSha256: string; entryPoint: string; files: Record<string, Uint8Array>; hostRequirements: Record<string, string>; preparation?: z.infer<typeof preparationSchema> }): Promise<RetainedBuildManifestV1> {
    digest.parse(input.inputSha256); buildFile.parse(input.entryPoint);
    const files = Object.fromEntries(Object.entries(input.files).map(([name, bytes]) => [buildFile.parse(name), Uint8Array.from(bytes)]));
    if (!(input.entryPoint in files) || Object.keys(files).length === 0 || "manifest.json" in files) throw new Error("Retained build needs its entry point and cannot replace the manifest.");
    const fileMetadata = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, { sha256: byteHash(bytes), byteLength: bytes.length }]));
    const content = { inputSha256: input.inputSha256, entryPoint: input.entryPoint,
      hostRequirements: z.record(z.string(), z.string()).parse(inputWaitJsonSnapshot(input.hostRequirements)), files: fileMetadata,
      ...(input.preparation ? { preparation: preparationSchema.parse(inputWaitJsonSnapshot(input.preparation)) } : {}) };
    const buildSha256 = sha(content);
    return this.#authority.transaction(async () => {
      const previous = await this.#findBuild(buildSha256);
      if (previous) { await this.#verifyBuild(previous.directory, previous.manifest); return previous.manifest; }
      const manifest = manifestSchema.parse({ schemaVersion: 1, buildSha256, createdAt: this.#at(), ...content });
      const basic = manifest.createdAt.replace(/[-:]/g, ""), name = `${basic}-${buildSha256.slice(0, 16)}`;
      const root = path.join(this.#authority.root, "builds"), directory = path.join(root, name);
      await fs.mkdir(root, { recursive: true, mode: 0o700 });
      const stage = path.join(root, `.staging-${randomUUID()}`); await fs.mkdir(stage, { mode: 0o700 });
      try {
        const directories = new Set<string>([stage]);
        for (const [name, bytes] of Object.entries(files)) {
          const file = path.join(stage, name); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
          for (let directory = path.dirname(file); directory !== stage; directory = path.dirname(directory)) directories.add(directory);
          const handle = await fs.open(file, "wx", 0o600);
          try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        }
        await replaceDurableJson(path.join(stage, "manifest.json"), manifest);
        for (const directory of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(directory);
        await fs.rename(stage, directory);
        await syncDirectory(root);
      } finally { await fs.rm(stage, { recursive: true, force: true }); }
      return manifest;
    });
  }

  async #builds(): Promise<{ directory: string; manifest: RetainedBuildManifestV1 }[]> {
    const root = path.join(this.#authority.root, "builds"), names = await fs.readdir(root).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const result: { directory: string; manifest: RetainedBuildManifestV1 }[] = [];
    for (const name of names) {
      if (name.startsWith(".staging-") || name.startsWith(".deleted-")) continue;
      if (!/^\d{8}T\d{6}\.\d{3}Z-[a-f0-9]{16}$/.test(name)) throw new Error("Unexpected retained build directory.");
      const directory = path.join(root, name), stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Retained build must be a real directory.");
      const manifest = manifestSchema.parse(await readDurableJson(path.join(directory, "manifest.json")));
      const { schemaVersion: _, buildSha256, createdAt, ...content } = manifest;
      if (sha(content) !== buildSha256 || name !== `${createdAt.replace(/[-:]/g, "")}-${buildSha256.slice(0, 16)}` || !manifest.files[manifest.entryPoint]) throw new Error("Retained build identity differs.");
      result.push({ directory, manifest });
    }
    return result;
  }
  async #findBuild(buildSha256: string): Promise<{ directory: string; manifest: RetainedBuildManifestV1 } | undefined> {
    digest.parse(buildSha256); return (await this.#builds()).find(build => build.manifest.buildSha256 === buildSha256);
  }
  async #verifyBuild(directory: string, manifest: RetainedBuildManifestV1): Promise<void> {
    for (const [name, expected] of Object.entries(manifest.files)) {
      const file = path.join(directory, name), real = await fs.realpath(file);
      if (real !== file) throw new Error("Retained files cannot resolve through symlinks.");
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size !== expected.byteLength || byteHash(await fs.readFile(file)) !== expected.sha256) throw new Error("Retained build bytes are missing or corrupt; current source will not be substituted.");
    }
  }
  async findReusableBuild(inputSha256: string): Promise<RetainedBuildManifestV1 | undefined> {
    digest.parse(inputSha256);
    return this.#authority.transaction(async () => {
      const result = (await this.#builds()).find(build => build.manifest.inputSha256 === inputSha256);
      if (result) await this.#verifyBuild(result.directory, result.manifest);
      return result?.manifest;
    });
  }
  async preparedBuilds(keySha256: string): Promise<RetainedBuildManifestV1[]> {
    digest.parse(keySha256);
    return this.#authority.transaction(async () => (await this.#builds()).map(build => build.manifest).filter(build => build.preparation?.keySha256 === keySha256));
  }
  async readBuild(buildSha256: string): Promise<{ manifest: RetainedBuildManifestV1; files: Record<string, Uint8Array> }> {
    return this.#authority.transaction(async () => {
      const build = await this.#findBuild(buildSha256);
      if (!build) conflict("missing-build");
      await this.#verifyBuild(build.directory, build.manifest);
      const files: Record<string, Uint8Array> = {};
      for (const name of Object.keys(build.manifest.files)) files[name] = await fs.readFile(path.join(build.directory, name));
      return { manifest: build.manifest, files };
    });
  }
  /** Keeps a prepared candidate usable before a Run pins it. Holds belong to this
   * store owner only; release each handle before closing the store. Both acquiring
   * and releasing a hold serialize with cleanup and persisted Run references.
   */
  async holdBuild(buildSha256: string): Promise<() => Promise<void>> {
    digest.parse(buildSha256);
    return this.#authority.transaction(async () => {
      const build = await this.#findBuild(buildSha256);
      if (!build) conflict("missing-build");
      await this.#verifyBuild(build.directory, build.manifest);
      this.#buildHolds.set(buildSha256, (this.#buildHolds.get(buildSha256) ?? 0) + 1);
      let released: Promise<void> | undefined;
      return () => released ??= this.#authority.transaction(async () => {
        const count = this.#buildHolds.get(buildSha256)!;
        if (count === 1) this.#buildHolds.delete(buildSha256);
        else this.#buildHolds.set(buildSha256, count - 1);
      });
    });
  }
  async deleteRetainedControlData(ref: RunRef): Promise<void> {
    ref = validateRunRef(inputWaitJsonSnapshot(ref));
    await this.#authority.transaction(async () => {
      const state = await this.#required(ref);
      if (!terminalRun(state) || state.owner) conflict("owner-active");
      state.retainedDataDeleted = true;
      state.binding.invocation = null; state.binding.runConfiguration = null; state.binding.executionProfile = null;
      state.binding.nonSecretEnvironment = {}; state.binding.credentialReferences = [];
      state.requests = {}; state.commands = {};
      delete state.graphInput;
      delete state.output;
      // Explicitly delete data owned by this adapter. Keep receipt hashes and identity
      // tombstones; external checkpoints and uploaded-file deletion belong to their stores.
      await this.#save(state);
    });
  }
  async previewBuildCleanup(): Promise<BuildCleanupPreviewV1> {
    return this.#authority.transaction(async () => {
      const pinned = await this.#protectedBuilds();
      return { builds: (await this.#builds()).filter(build => !pinned.has(build.manifest.buildSha256)).map(({ manifest }) => ({ buildSha256: manifest.buildSha256,
        byteLength: Buffer.byteLength(JSON.stringify(manifest)) + Object.values(manifest.files).reduce((sum, file) => sum + file.byteLength, 0) })) };
    });
  }
  async cleanUnusedBuilds(preview: BuildCleanupPreviewV1): Promise<string[]> {
    const ids = z.array(digest).parse(preview.builds.map(build => build.buildSha256));
    return this.#authority.transaction(async () => {
      const pinned = await this.#protectedBuilds();
      const removed: string[] = [];
      for (const build of await this.#builds()) if (ids.includes(build.manifest.buildSha256) && !pinned.has(build.manifest.buildSha256)) {
        const trash = path.join(this.#authority.root, "builds", `.deleted-${randomUUID()}`);
        await fs.rename(build.directory, trash); // Removal from the build namespace is atomic with respect to pins.
        await syncDirectory(path.dirname(trash));
        await fs.rm(trash, { recursive: true }); removed.push(build.manifest.buildSha256);
      }
      return removed;
    });
  }
  /** Called only while holding the store authority, including for stale previews. */
  async #protectedBuilds(): Promise<Set<string>> {
    return new Set([...this.#buildHolds.keys(), ...(await this.#runs())
      .filter(state => !state.retainedDataDeleted).map(state => state.binding.buildSha256)]);
  }
}
