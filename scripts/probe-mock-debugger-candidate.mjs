import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { docker, repositoryRoot, runIsolationProbe, sha256File, sortableTimestamp } from "./lib/mock-debugger-candidate.mjs";

const manifestArgument = process.argv.find(value => value.startsWith("--manifest="))?.slice("--manifest=".length);
if (!manifestArgument) throw new Error("Usage: node scripts/probe-mock-debugger-candidate.mjs --manifest=/absolute/path/manifest.json");
const manifestFile = path.resolve(manifestArgument);
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
if (manifest?.kind !== "arkimux-mock-debugger-private-candidate" || !/^sha256:[a-f0-9]{64}$/.test(manifest.imageId)) {
  throw new Error("Invalid mock-debugger candidate manifest.");
}
const archive = path.join(path.dirname(manifestFile), manifest.archiveFile);
if (await sha256File(archive) !== manifest.archiveSha256) throw new Error("Candidate archive SHA-256 mismatch.");
await docker(["load", "--input", archive]);
const installedId = (await docker(["image", "inspect", manifest.imageReference, "--format", "{{.Id}}"])).stdout;
if (installedId !== manifest.imageId) throw new Error("Installed candidate image ID mismatch.");

const outputDirectory = path.join(repositoryRoot, ".codex-temp", "mock-debugger-probes", sortableTimestamp());
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const isolation = await runIsolationProbe(manifest.imageId, outputDirectory);
const evidence = {
  schemaVersion: 1,
  kind: "arkimux-mock-debugger-isolation-evidence",
  checkedAt: new Date().toISOString(),
  manifestFile,
  archiveSha256: manifest.archiveSha256,
  imageReference: manifest.imageReference,
  imageId: manifest.imageId,
  isolation,
};
const evidenceFile = path.join(outputDirectory, "isolation-evidence.json");
await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify({ evidenceFile, imageId: manifest.imageId, isolation: isolation.ok }, null, 2) + "\n");
