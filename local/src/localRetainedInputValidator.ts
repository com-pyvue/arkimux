import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { validateWorkflowInvocationV1 } from "../../core/src/application/durableWorkflowInvocation.ts";
import { inputWaitJsonSnapshot, type InputResponseV1 } from "../../core/src/application/inputWait.ts";
import { constructionDescriptorFile } from "../../core/src/application/retainedWorkflowConstruction.ts";
import type { RetainedRunControlV1 } from "../../core/src/application/retainedExecution.ts";
import { FileStepCheckpointStoreV2 } from "../../core/src/infrastructure/storage/fileDurableExecutionStore.ts";
import type { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { resolveLocalDurableExecutionPaths } from "./localDurableWorkflowRuntime.ts";
import { activeComputeLimitsSchema } from "../../core/src/application/activeCompute.ts";

const validationTimeoutMs = 10_000;

export class RetainedInputValidationError extends Error {
  constructor(readonly code: "invalid-response" | "validation-unavailable") { super(code); }
}

export async function validateLocalRetainedInput(options: { projectRoot: string; executionDataRoot?: string; store: FileRetainedExecutionStoreV1;
  control: RetainedRunControlV1; requestId: string; response: InputResponseV1; signal: AbortSignal; workerPath?: string }) {
  const control = structuredClone(options.control);
  const profile = control.binding.executionProfile as { computeLimits?: unknown };
  const limits = activeComputeLimitsSchema.parse(profile.computeLimits);
  const build = await options.store.readBuild(control.binding.buildSha256);
  const root = resolveLocalDurableExecutionPaths(options.projectRoot, control.runRef, options.executionDataRoot).root;
  const storage = new FileStepCheckpointStoreV2({ root });
  const names = await readdir(path.join(root, "steps")).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const checkpoints = [];
  for (const name of names.filter(name => name.endsWith(".json") && !name.startsWith("."))) {
    const stepId = decodeURIComponent(name.slice(0, -5));
    const saved = await storage.read({ runRef: control.runRef, stepId });
    if (!saved || saved.ref.runRef.executionId !== control.runRef.executionId || saved.ref.stepId !== stepId) throw new RetainedInputValidationError("validation-unavailable");
    if (saved.completed) checkpoints.push(saved.completed);
  }
  const payload = { kind: "validate-response", code: Buffer.from(build.files[build.manifest.entryPoint]).toString("utf8"),
    construction: JSON.parse(Buffer.from(build.files[constructionDescriptorFile]).toString("utf8")),
    invocation: validateWorkflowInvocationV1(control.binding.invocation),
    runConfiguration: control.binding.runConfiguration, requests: control.requests, buildSha256: control.binding.buildSha256,
    assets: Object.fromEntries(Object.entries(build.files).filter(([name]) => name.startsWith("assets/")).map(([name, bytes]) => [name.slice(7), bytes])),
    checkpoints, requestId: options.requestId, response: inputWaitJsonSnapshot(options.response),
    validationDeadlineAt: new Date(Date.now() + validationTimeoutMs).toISOString(), finalizationReserveMs: limits.finalizationReserveMs };
  if (options.signal.aborted) throw new RetainedInputValidationError("validation-unavailable");
  const child = fork(options.workerPath ?? fileURLToPath(new URL("./retained-attempt-worker.js", import.meta.url)), [], {
    execArgv: [], cwd: fileURLToPath(new URL(".", import.meta.url)), serialization: "advanced",
    stdio: ["ignore", "ignore", "ignore", "ipc"], env: { PATH: process.env.PATH ?? "", LANG: "en_US.UTF-8", TZ: "UTC" },
  });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined, abort: (() => void) | undefined;
  try {
    return await new Promise<InputResponseV1>((resolve, reject) => {
      abort = () => reject(new RetainedInputValidationError("validation-unavailable"));
      options.signal.addEventListener("abort", abort, { once: true }); timer = setTimeout(abort, validationTimeoutMs);
      child.once("error", abort); child.once("exit", abort);
      child.once("message", message => {
        const reply = message as { kind?: string; code?: string; response?: InputResponseV1 };
        if (reply?.kind === "response-valid" && reply.response) resolve(reply.response);
        else reject(new RetainedInputValidationError(reply?.code === "invalid-response" ? "invalid-response" : "validation-unavailable"));
      });
      if (options.signal.aborted) { abort(); return; }
      child.send(payload, error => { if (error) abort?.(); });
    });
  } finally { clearTimeout(timer); if (abort) options.signal.removeEventListener("abort", abort); child.kill("SIGKILL"); await closed; }
}
