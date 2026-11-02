import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import {
  docker,
  publicRepository,
  repositoryRoot,
  runIsolationProbe,
  sortableTimestamp,
} from "./lib/mock-debugger-candidate.mjs";
import { prepareMockDebuggerImageContext } from "./lib/mock-debugger-image-context.mjs";
import {
  digestFromBuildMetadata,
  publicManifestReference,
  releaseBuildArguments,
  releasePlatformManifests,
  validateReleaseTag,
} from "./lib/mock-debugger-release.mjs";

const execFile = promisify(execFileCallback);
const tag = validateReleaseTag(process.argv.find(value => value.startsWith("--tag="))?.slice("--tag=".length) ?? "");
const confirmedRepository = process.argv.find(value => value.startsWith("--confirm-push="))?.slice("--confirm-push=".length);
const confirmed = confirmedRepository === publicRepository;
const timestamp = sortableTimestamp();
const outputDirectory = path.join(repositoryRoot, ".codex-temp", "mock-debugger-publications", timestamp);
const contextDirectory = path.join(outputDirectory, "image-context");
const metadataFile = path.join(outputDirectory, "build-metadata.json");
const taggedReference = `${publicRepository}:${tag}`;
const builderName = `arkimux-mock-debugger-${randomUUID()}`;

if (!confirmed) {
  process.stdout.write(JSON.stringify({
    action: "no-push",
    reason: `Publishing requires --confirm-push=${publicRepository}.`,
    repository: publicRepository,
    taggedReference,
    platforms: ["linux/amd64", "linux/arm64"],
  }, null, 2) + "\n");
  process.exit(0);
}

const git = async args => (await execFile("git", args, {
  cwd: repositoryRoot,
  encoding: "utf8",
  env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
})).stdout.trim();
if (await git(["status", "--porcelain"])) throw new Error("Refusing to publish from a dirty Git worktree. Commit the exact reviewed source first.");
const sourceCommit = await git(["rev-parse", "HEAD"]);
if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Could not resolve the exact source commit for publication.");

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await prepareMockDebuggerImageContext(contextDirectory);
await docker(["buildx", "create", "--name", builderName, "--driver", "docker-container"]);
let builderRemoved = false;
try {
  await docker(["buildx", "inspect", "--bootstrap", builderName], { timeout: 5 * 60_000 });
  await docker(releaseBuildArguments({ tag, metadataFile, contextDirectory, builderName }), { timeout: 30 * 60_000, credentials: true });
} finally {
  try {
    await docker(["buildx", "rm", builderName], { timeout: 60_000 });
    builderRemoved = true;
  } catch (error) {
    process.stderr.write(`Warning: ${error instanceof Error ? error.message : "the temporary Buildx builder could not be removed."}\n`);
  }
}

const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
const digest = digestFromBuildMetadata(metadata);
const manifestReference = publicManifestReference(digest);
const rawIndex = JSON.parse((await docker(["buildx", "imagetools", "inspect", "--raw", manifestReference])).stdout);
const platforms = releasePlatformManifests(rawIndex);
const isolation = [];
for (const platform of platforms) {
  const platformReference = publicManifestReference(platform.digest);
  const probeDirectory = path.join(outputDirectory, platform.platform.replace("/", "-"));
  await mkdir(probeDirectory, { recursive: true, mode: 0o700 });
  await docker(["pull", "--platform", platform.platform, platformReference], { timeout: 10 * 60_000 });
  isolation.push({ ...platform, report: await runIsolationProbe(platformReference, probeDirectory, { platform: platform.platform }) });
}

const evidence = {
  schemaVersion: 1,
  kind: "arkimux-mock-debugger-public-image",
  publishedAt: new Date().toISOString(),
  sourceCommit,
  repository: publicRepository,
  tag,
  taggedReference,
  builderRemoved,
  manifestReference,
  digest,
  platforms,
  isolation,
};
const evidenceFile = path.join(outputDirectory, "publication-evidence.json");
await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify({ evidenceFile, taggedReference, manifestReference, platforms }, null, 2) + "\n");
