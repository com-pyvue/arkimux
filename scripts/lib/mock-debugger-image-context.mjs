import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { build as bundle } from "esbuild";
import { repositoryRoot } from "./mock-debugger-candidate.mjs";

export async function prepareMockDebuggerImageContext(contextDirectory) {
  await mkdir(contextDirectory, { recursive: true, mode: 0o700 });
  await copyFile(path.join(repositoryRoot, "containers/mock-debugger/Dockerfile"), path.join(contextDirectory, "Dockerfile"));
  await copyFile(path.join(repositoryRoot, "containers/mock-debugger/isolation-probe.mjs"), path.join(contextDirectory, "isolation-probe.mjs"));
  for (const [entry, outfile] of [
    ["cli/src/dockerMockDebuggerBroker.ts", "broker.mjs"],
    ["local/src/retainedAttemptWorker.ts", "retained-attempt-worker.mjs"],
  ]) {
    await bundle({
      entryPoints: [path.join(repositoryRoot, entry)],
      outfile: path.join(contextDirectory, outfile),
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      packages: "bundle",
      sourcemap: false,
      logLevel: "silent",
    });
  }
}
