import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build as bundle } from "esbuild";
import {
  publicImageReference,
  repositoryRoot,
  runIsolationProbe,
  sortableTimestamp,
} from "./lib/mock-debugger-candidate.mjs";

const timestamp = sortableTimestamp();
const outputDirectory = path.join(repositoryRoot, ".codex-temp", "mock-debugger-public-image-probes", timestamp);
const bundledModule = path.join(outputDirectory, "docker-mock-debugger.mjs");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await bundle({
  entryPoints: [path.join(repositoryRoot, "cli/src/dockerMockDebugger.ts")],
  outfile: bundledModule,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  packages: "bundle",
  sourcemap: false,
  logLevel: "silent",
});

const { ensureDebugImage } = await import(pathToFileURL(bundledModule).href);
const image = await ensureDebugImage({ kind: "registry", imageReference: publicImageReference });
const isolation = await runIsolationProbe(image.runtimeReference, outputDirectory);
const evidence = {
  schemaVersion: 1,
  kind: "arkimux-mock-debugger-public-image-acquisition",
  checkedAt: new Date().toISOString(),
  image,
  isolation,
};
const evidenceFile = path.join(outputDirectory, "public-image-acquisition.json");
await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify({ evidenceFile, image, isolation: isolation.ok }, null, 2) + "\n");
