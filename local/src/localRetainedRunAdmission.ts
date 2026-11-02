/** Internal reservation helper. Does not publish a Run or dispatch an attempt. */
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { validateRunRef, type RunRef } from "../../core/src/domain/runIdentity.ts";
import { validateWorkflowInvocationV1, type WorkflowInvocationV1 } from "../../core/src/application/durableWorkflowInvocation.ts";
import { runConfigurationContentHash } from "../../core/src/application/runConfiguration.ts";
import { hashJson, type JsonValue } from "../../core/src/application/durableWorkflow.ts";
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import { executableBindingSchema, type ExecutableBindingV1 } from "../../core/src/application/retainedExecution.ts";
import { constructionDescriptorFile, constructionDescriptorSchema } from "../../core/src/application/retainedWorkflowConstruction.ts";
import type { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { validateRetainedGraphInputV1, type RetainedGraphInputV1 } from "../../core/src/application/retainedGraphInput.ts";
import type { RunConfigurationReference } from "../../core/src/domain/runConfigurationReference.ts";
import type { GraphEntryBoundaryV1 } from "../../core/src/application/graphInvocation.ts";
import { localGraphDescriptionSchema, localGraphEntryPresentationSchema } from "./graphDescription.ts";

export type RetainedAdmissionFailure = "invalid-binding" | "invalid-construction" | "invalid-input"
  | "slot-mismatch" | "validation-timeout" | "validation-cancelled" | "worker-unavailable";
const messages: Record<RetainedAdmissionFailure, string> = {
  "invalid-binding": "The retained Run settings do not match its invocation or build. No Run was reserved.",
  "invalid-construction": "The retained constructor could not create the declared workflow. No Run was reserved.",
  "invalid-input": "The retained workflow rejected the input. No Run was reserved.",
  "slot-mismatch": "The retained prompts do not match the declared and configured agent slots. No Run was reserved.",
  "validation-timeout": "Retained workflow validation timed out. No Run was reserved.",
  "validation-cancelled": "Retained workflow validation was cancelled. No Run was reserved.",
  "worker-unavailable": "The retained validation worker could not run. No Run was reserved.",
};
export class RetainedRunAdmissionError extends Error {
  constructor(readonly code: RetainedAdmissionFailure) { super(messages[code]); }
}
const fail = (code: RetainedAdmissionFailure): never => { throw new RetainedRunAdmissionError(code); };
const slotIds = z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).refine(ids => new Set(ids).size === ids.length);
const localJson: z.ZodType<JsonValue> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string(),
  z.array(localJson), z.record(z.string(), localJson)]));
const localId = z.string().min(1).max(256).regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/)
  .refine(value => !["constructor", "prototype", "__proto__"].includes(value));
const localGraphOccurrence = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("subgraph") }).strict(),
  z.object({ kind: z.literal("choice"), case: localId }).strict(),
  z.object({ kind: z.literal("map"), index: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.literal("reduce"), index: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.literal("loop"), iteration: z.number().int().nonnegative().safe() }).strict(),
]);
const localGraphAddress = z.object({ schemaVersion: z.literal(1), path: z.array(z.object({
  nodeId: localId, occurrence: localGraphOccurrence.optional(),
}).strict()).min(1) }).strict();
const localWorkflowInvocationEntry = z.object({
  presentation: localGraphEntryPresentationSchema.optional(),
  id: localId, label: z.string().min(1), nodeKind: z.enum(["step", "subgraph", "map", "reduce", "loop", "choice"]),
  entry: z.union([z.object({ kind: z.literal("default") }).strict(),
    z.object({ kind: z.literal("selected"), address: localGraphAddress }).strict()]),
  requirements: z.array(z.object({ id: z.string().min(1).max(1000),
    role: z.enum(["entry-input", "root-scope-input", "skipped-node-input", "skipped-node-output", "control-input",
      "map-completed-outputs", "reduce-accumulator", "loop-iteration"]),
    address: localGraphAddress.optional(), contractVersion: localId,
    schema: z.record(z.string(), localJson), provenance: z.literal("caller-supplied"),
  }).strict()).min(1),
}).strict();
export type LocalWorkflowInvocationEntry = z.infer<typeof localWorkflowInvocationEntry>;
const same = (left: unknown, right: unknown) => hashJson(inputWaitJsonSnapshot(left)) === hashJson(inputWaitJsonSnapshot(right));

/** Validate in a disposable worker before the first durable Run write. The original
 * input is pinned, not the validator's transformed output: each attempt parses it once.
 * Callers supply a checked build and declared slot IDs, never a live workflow factory.
 * Credential values must already have been excluded from the non-secret binding.
 */
export async function reserveLocalRetainedRun(store: FileRetainedExecutionStoreV1, options: {
  runRef: RunRef; binding: ExecutableBindingV1; agentSlotIds: readonly string[];
  workerPath?: string; validationTimeoutMs?: number; signal?: AbortSignal;
  /** Acquire the shared Run-ID reservation only after validation, before committing. */
  beforeReserve?(): Promise<void>;
}) {
  // Snapshot all caller data before the first await so validation and reservation agree.
  let ref!: RunRef, binding!: ExecutableBindingV1, expectedSlots!: string[], invocation!: WorkflowInvocationV1;
  const timeoutMs = options.validationTimeoutMs ?? 10_000;
  const signal = options.signal;
  const beforeReserve = options.beforeReserve;
  const workerPath = options.workerPath ?? fileURLToPath(new URL("./retained-attempt-worker.js", import.meta.url));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) fail("invalid-binding");
  if (signal?.aborted) fail("validation-cancelled");
  try {
    ref = validateRunRef(inputWaitJsonSnapshot(options.runRef));
    binding = executableBindingSchema.parse(inputWaitJsonSnapshot(options.binding));
    expectedSlots = slotIds.parse([...options.agentSlotIds]).sort();
    invocation = validateWorkflowInvocationV1(binding.invocation);
    const config = z.object({ configurationId: z.string(), workflow: z.unknown(), agents: z.record(z.string(), z.unknown()) }).parse(binding.runConfiguration);
    z.object({ maxScratchBytes: z.number().int().positive().safe() }).parse(binding.executionProfile);
    if (!same(invocation.runRef, ref) || !same(binding.workflow, invocation.workflow)
      || !same(config.workflow, invocation.workflow) || config.configurationId !== invocation.runConfiguration.configurationId
      || runConfigurationContentHash(binding.runConfiguration) !== invocation.runConfiguration.contentHash) fail("invalid-binding");
    if (binding.runManifest && (!same(binding.runManifest.runRef, ref) || !same(binding.runManifest.workflow, invocation.workflow)
      || !same(binding.runManifest.runConfiguration, invocation.runConfiguration) || binding.runManifest.createdAt !== invocation.createdAt)) fail("invalid-binding");
    if (!same(Object.keys(config.agents).sort(), expectedSlots)) fail("slot-mismatch");
  } catch (error) { if (error instanceof RetainedRunAdmissionError) throw error; fail("invalid-binding"); }
  let payload: { kind: "validate-construction"; code: string; construction: unknown; invocation: WorkflowInvocationV1;
    runConfiguration: ExecutableBindingV1["runConfiguration"];
    assets: Record<string, Uint8Array>; agentSlotIds: string[] };
  try {
    const build = await store.readBuild(binding.buildSha256);
    if (Object.entries(build.manifest.hostRequirements).some(([name, value]) => binding.hostRequirements[name] !== value)) fail("invalid-binding");
    const descriptor = build.files[constructionDescriptorFile];
    if (!descriptor) fail("invalid-construction");
    payload = { kind: "validate-construction", code: Buffer.from(build.files[build.manifest.entryPoint]).toString("utf8"),
      construction: constructionDescriptorSchema.parse(JSON.parse(Buffer.from(descriptor).toString("utf8"))),
      invocation, runConfiguration: binding.runConfiguration,
      assets: Object.fromEntries(Object.entries(build.files).filter(([name]) => name.startsWith("assets/"))
        .map(([name, bytes]) => [name.slice("assets/".length), bytes])), agentSlotIds: expectedSlots };
  } catch (error) { if (error instanceof RetainedRunAdmissionError) throw error; fail("invalid-binding"); }
  if (signal?.aborted) fail("validation-cancelled");
  // No project cwd, HOME, provider key, shell configuration, storage path or RPC
  // capability is sent to this validation-only process.
  let child: ReturnType<typeof fork>;
  try {
    child = fork(workerPath, [], { execArgv: [], cwd: fileURLToPath(new URL(".", import.meta.url)),
      stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
      env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8", TZ: "UTC" } });
  } catch { throw new RetainedRunAdmissionError("worker-unavailable"); }
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const rejectCode = (code: RetainedAdmissionFailure) => reject(new RetainedRunAdmissionError(code));
      abort = () => rejectCode("validation-cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => rejectCode("validation-timeout"), timeoutMs);
      child.once("error", () => rejectCode("worker-unavailable"));
      child.once("exit", () => rejectCode("worker-unavailable"));
      child.on("message", message => {
        const value = message as { kind?: string; code?: string } | null;
        if (value?.kind === "construction-valid") resolve();
        else if (value?.kind === "construction-invalid" && ["invalid-construction", "invalid-input", "slot-mismatch"].includes(value.code ?? "")) rejectCode(value.code as RetainedAdmissionFailure);
        else rejectCode("worker-unavailable");
      });
      if (signal?.aborted) { abort(); return; }
      try { child.send(payload, error => { if (error) rejectCode("worker-unavailable"); }); }
      catch { rejectCode("worker-unavailable"); }
    });
  } finally {
    clearTimeout(timeout); if (abort) signal?.removeEventListener("abort", abort);
    child.kill("SIGKILL"); await closed;
  }
  if (signal?.aborted) fail("validation-cancelled");
  // The store atomically re-verifies the build and rejects conflicting Run bindings.
  await beforeReserve?.();
  return store.createRun(ref, binding);
}

type GraphConstructionIdentity = {
  runRef: RunRef;
  runConfiguration: RunConfigurationReference;
  executableBindingId: string;
  buildSha256: string;
  createdAt: string;
  requestId: string;
};

/** Constructs and validates the graph only in the disposable worker, then
 * returns the immutable input state that the API process may persist. */
export async function prepareLocalRetainedGraphInput(store: FileRetainedExecutionStoreV1, options: {
  buildSha256: string;
  hostRequirements: Record<string, string>;
  runConfiguration: ExecutableBindingV1["runConfiguration"];
  request: unknown;
  identity: GraphConstructionIdentity;
  agentSlotIds: readonly string[];
  workerPath?: string;
  signal?: AbortSignal;
}): Promise<RetainedGraphInputV1> {
  const payload = await graphWorkerPayload(store, options);
  const result = await runGraphWorker({ ...payload, kind: "prepare-graph-invocation",
    request: inputWaitJsonSnapshot(options.request), identity: inputWaitJsonSnapshot(options.identity),
    agentSlotIds: slotIds.parse([...options.agentSlotIds]).sort() }, "graph-invocation-valid", options);
  try { return validateRetainedGraphInputV1((result as { graphInput?: unknown }).graphInput); }
  catch { return fail("invalid-input"); }
}

/** Lists selectable root graph entries and their complete caller boundary in
 * the same disposable worker used for graph admission. */
export async function describeLocalRetainedGraph(store: FileRetainedExecutionStoreV1, options: {
  buildSha256: string;
  hostRequirements: Record<string, string>;
  runConfiguration: ExecutableBindingV1["runConfiguration"];
  agentSlotIds: readonly string[];
  workerPath?: string;
  signal?: AbortSignal;
}) {
  const payload = await graphWorkerPayload(store, options);
  const result = await runGraphWorker({ ...payload, kind: "describe-graph-invocation",
    agentSlotIds: slotIds.parse([...options.agentSlotIds]).sort() }, "graph-invocation-described", options);
  try { return z.object({ entries: z.array(localWorkflowInvocationEntry).min(1), graph: localGraphDescriptionSchema }).parse(result); }
  catch { return fail("invalid-input"); }
}

/** Compatibility wrapper for callers that only need the entry catalog. */
export async function describeLocalRetainedGraphEntries(store: FileRetainedExecutionStoreV1, options: Parameters<typeof describeLocalRetainedGraph>[1]): Promise<LocalWorkflowInvocationEntry[]> {
  return (await describeLocalRetainedGraph(store, options)).entries;
}

/** Reconstructs the retained graph and applies its exact entry validators in a
 * disposable worker. The API process receives only normalized JSON. */
export async function validateLocalRetainedGraphBoundary(store: FileRetainedExecutionStoreV1, options: {
  binding: ExecutableBindingV1;
  graphInput: RetainedGraphInputV1;
  boundary: unknown;
  workerPath?: string;
  signal?: AbortSignal;
}): Promise<GraphEntryBoundaryV1> {
  const payload = await graphWorkerPayload(store, { buildSha256: options.binding.buildSha256,
    hostRequirements: options.binding.hostRequirements,
    runConfiguration: options.binding.runConfiguration });
  const result = await runGraphWorker({ ...payload, kind: "validate-graph-boundary",
    graphInput: validateRetainedGraphInputV1(options.graphInput), boundary: inputWaitJsonSnapshot(options.boundary) },
  "graph-boundary-valid", options);
  return inputWaitJsonSnapshot((result as { boundary?: unknown }).boundary) as unknown as GraphEntryBoundaryV1;
}

async function graphWorkerPayload(store: FileRetainedExecutionStoreV1, options: {
  buildSha256: string; hostRequirements: Record<string, string>;
  runConfiguration: ExecutableBindingV1["runConfiguration"];
}) {
  try {
    const build = await store.readBuild(options.buildSha256);
    if (Object.entries(build.manifest.hostRequirements).some(([name, value]) => options.hostRequirements[name] !== value)) fail("invalid-binding");
    const descriptor = build.files[constructionDescriptorFile];
    if (!descriptor) fail("invalid-construction");
    return { code: Buffer.from(build.files[build.manifest.entryPoint]).toString("utf8"),
      construction: constructionDescriptorSchema.parse(JSON.parse(Buffer.from(descriptor).toString("utf8"))),
      runConfiguration: inputWaitJsonSnapshot(options.runConfiguration),
      assets: Object.fromEntries(Object.entries(build.files).filter(([name]) => name.startsWith("assets/"))
        .map(([name, bytes]) => [name.slice("assets/".length), bytes])) };
  } catch (error) { if (error instanceof RetainedRunAdmissionError) throw error; return fail("invalid-binding"); }
}

async function runGraphWorker(payload: Record<string, unknown>, successKind: string, options: {
  workerPath?: string; signal?: AbortSignal;
}): Promise<unknown> {
  if (options.signal?.aborted) fail("validation-cancelled");
  const workerPath = options.workerPath ?? fileURLToPath(new URL("./retained-attempt-worker.js", import.meta.url));
  let child!: ReturnType<typeof fork>;
  try { child = fork(workerPath, [], { execArgv: [], cwd: fileURLToPath(new URL(".", import.meta.url)),
    stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced",
    env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8", TZ: "UTC" } }); }
  catch { fail("worker-unavailable"); }
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  let result: unknown;
  try {
    result = await new Promise((resolve, reject) => {
      const rejectCode = (code: RetainedAdmissionFailure) => reject(new RetainedRunAdmissionError(code));
      abort = () => rejectCode("validation-cancelled");
      options.signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => rejectCode("validation-timeout"), 10_000);
      child.once("error", () => rejectCode("worker-unavailable"));
      child.once("exit", () => rejectCode("worker-unavailable"));
      child.on("message", message => {
        const value = message as { kind?: string; code?: string } | null;
        if (value?.kind === successKind) resolve(value);
        else if (value?.kind === "construction-invalid"
          && ["invalid-binding", "invalid-construction", "invalid-input", "slot-mismatch"].includes(value.code ?? "")) {
          rejectCode(value.code as RetainedAdmissionFailure);
        }
        else if (value?.kind?.endsWith("-invalid")) rejectCode("invalid-input");
        else rejectCode("worker-unavailable");
      });
      try { child.send(payload, error => { if (error) rejectCode("worker-unavailable"); }); }
      catch { rejectCode("worker-unavailable"); }
    });
  } finally {
    clearTimeout(timeout); if (abort) options.signal?.removeEventListener("abort", abort);
    child.kill("SIGKILL"); await closed;
  }
  if (options.signal?.aborted) fail("validation-cancelled");
  return result;
}
