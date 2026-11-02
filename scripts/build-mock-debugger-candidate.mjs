import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  candidateBaseImage,
  candidatePlatform,
  candidateRepository,
  docker,
  repositoryRoot,
  runIsolationProbe,
  sha256File,
  sortableTimestamp,
} from "./lib/mock-debugger-candidate.mjs";
import { prepareMockDebuggerImageContext } from "./lib/mock-debugger-image-context.mjs";

const requestedOutput = process.argv.find(value => value.startsWith("--output="))?.slice("--output=".length);
const timestamp = sortableTimestamp();
const outputDirectory = path.resolve(repositoryRoot, requestedOutput || path.join(".codex-temp", "mock-debugger-candidates", timestamp));
const imageReference = `${candidateRepository}:candidate-${timestamp.toLowerCase()}`;
const archive = path.join(outputDirectory, "mock-debugger-image.tar");
const contextDirectory = path.join(outputDirectory, "image-context");
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await prepareMockDebuggerImageContext(contextDirectory);

await docker([
  "build", "--platform", candidatePlatform, "--pull", "--tag", imageReference,
  "--file", path.join(contextDirectory, "Dockerfile"), contextDirectory,
]);
const imageId = (await docker(["image", "inspect", imageReference, "--format", "{{.Id}}"])).stdout;
if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error("Docker returned an invalid image ID.");

await docker(["save", "--output", archive, imageReference]);
const archiveSha256 = await sha256File(archive);
const isolation = await runIsolationProbe(imageId, outputDirectory);
const manifest = {
  schemaVersion: 1,
  kind: "arkimux-mock-debugger-private-candidate",
  createdAt: new Date().toISOString(),
  platform: candidatePlatform,
  baseImage: candidateBaseImage,
  imageReference,
  imageId,
  archiveFile: path.basename(archive),
  archiveSha256,
  isolation,
};
const manifestFile = path.join(outputDirectory, "manifest.json");
await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify({ outputDirectory, manifestFile, imageReference, imageId, archiveSha256 }, null, 2) + "\n");
