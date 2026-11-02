/** Internal host composition shared by HTTP and headless callers. Not a public SDK. */
import { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { LocalRetainedRunOrchestrator } from "./localRetainedRunOrchestrator.ts";
import { LocalRetainedWorkflowRunnerV1, type HeadlessRuntimeDebugger } from "./localRetainedWorkflowRunner.ts";
import { resolveLocalExecutionDataPaths } from "./localStorePaths.ts";
import type { LocalDebugger } from "./localDebugger.ts";
import type { DeepReadonly } from "../../core/src/application/durableWorkflow.ts";
import type { ExecutableBindingV1 } from "../../core/src/application/retainedExecution.ts";

export async function createLocalRetainedRuntime(options: {
  projectRoot: string; executionDataRoot?: string; workerPath?: string; debuggerSession?: LocalDebugger;
  liveDebugger?: HeadlessRuntimeDebugger;
  onFrameworkError?: import("../../core/src/application/frameworkErrors.ts").FrameworkErrorObserver;
  resolveEffectCredentials?(binding: DeepReadonly<ExecutableBindingV1>, signal: AbortSignal):
    Promise<Readonly<Record<string, string>>>;
  onFirstValidTypedResult?(event: { elapsedMs: number }): Promise<void>;
  onRunSettled?(event: { executionId: string; status: "complete" | "failed" | "cancelled"; elapsedMs: number }): Promise<void>;
}) {
  const hostRequirements = { node: process.versions.node.split(".")[0] };
  const store = await FileRetainedExecutionStoreV1.open(resolveLocalExecutionDataPaths(options.projectRoot, options.executionDataRoot).retained);
  try {
    const runner = new LocalRetainedWorkflowRunnerV1({ ...options, store });
    const runs = new LocalRetainedRunOrchestrator({ ...options, store, runner, hostRequirements });
    let closing: Promise<void> | undefined, recovery: Promise<void> | undefined, reconciliation: Promise<void> | undefined;
    return {
      store, runs, hostRequirements,
      async retainedRunIds(): Promise<ReadonlySet<string>> {
        return new Set((await store.listRuns()).map(run => run.runRef.executionId));
      },
      recover(): Promise<void> {
        if (closing) return Promise.reject(new Error("Retained runtime is closing."));
        return recovery ??= runs.recover();
      },
      reconcile(): Promise<void> {
        if (closing) return Promise.reject(new Error("Retained runtime is closing."));
        return reconciliation ??= runs.reconcile();
      },
      close(): Promise<void> {
        return closing ??= (async () => {
          // Finish admissions, owned workers and projection writes before releasing storage.
          await runs.close();
          await recovery?.catch(() => {});
          await reconciliation?.catch(() => {});
          await store.close();
        })();
      },
    };
  } catch (error) {
    await store.close();
    throw error;
  }
}
