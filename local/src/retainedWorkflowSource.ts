import type { FileRetainedExecutionStoreV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { sameOwner, terminalRun, type RetainedOwnerV1 } from "../../core/src/application/retainedExecution.ts";
import type { RunRef } from "../../core/src/domain/runIdentity.ts";

/** Internal source loader for the future V2 host. Only a fenced owner may load a
 * Run's pinned code. No resolver consults the editable project or node_modules.
 * Loading trusted workflow code is execution, not an HTTP read operation.
 */
export async function loadRetainedWorkflowSource(store: FileRetainedExecutionStoreV1, ref: RunRef, owner: RetainedOwnerV1): Promise<{
  readonly module: Readonly<Record<string, unknown>>;
  readonly readAsset: (declaredPath: string) => Uint8Array;
}> {
  const state = await store.read(ref);
  if (!state || terminalRun(state) || state.retainedDataDeleted || !sameOwner(state.owner, owner)) throw new Error("Retained code requires the current live Run owner.");
  const build = await store.readBuild(state.binding.buildSha256);
  const code = build.files[build.manifest.entryPoint];
  // Preparation emits one ESM file with only Node builtin external imports. A data
  // URL cannot resolve relative or package imports into the current installation.
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const current = await store.read(ref);
  if (!current || terminalRun(current) || !sameOwner(current.owner, owner)) throw new Error("Run ownership changed before retained code loading.");
  const module = await import(url) as Record<string, unknown>;
  return { module, readAsset(declaredPath: string) {
    const bytes = build.files[`assets/${declaredPath}`];
    if (!bytes) throw new Error("Asset was not declared in this retained build.");
    return Uint8Array.from(bytes);
  } };
}
