import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HeadlessDebuggerError } from "../../local/src/headlessDebuggerContracts.ts";
import dockerMockDebuggerSecurityArgs from "./dockerMockDebuggerSecurity.json" with { type: "json" };

const pinnedImagePattern = /^[a-z0-9][a-z0-9./_-]*@sha256:([a-f0-9]{64})$/;
const candidateImagePattern = /^[a-z0-9][a-z0-9./_-]*:[a-z0-9][a-z0-9._-]*$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const dockerOutputLimit = 64 * 1024;
const candidateArchiveByteLimit = 1024 * 1024 * 1024;

export interface DockerCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type DockerCommandRunner = (args: readonly string[]) => Promise<DockerCommandResult>;

export interface DockerMockDebuggerPreflight {
  imageReference: string;
  imageDigest: string;
  dockerServerVersion: string;
}

export type DebugImageSource = {
  kind: "registry";
  imageReference: string;
} | {
  kind: "candidate-archive";
  archiveUrl: string;
  archiveSha256: string;
  imageReference: string;
  imageId: string;
};

export interface EnsuredDebugImage {
  sourceKind: DebugImageSource["kind"];
  manifestReference: string;
  runtimeReference: string;
  imageIdentity: string;
  dockerServerVersion: string;
  acquired: boolean;
}

export interface DebugImageDependencies {
  run: DockerCommandRunner;
  downloadCandidateArchive: (url: string, target: string) => Promise<string>;
  makeTemporaryDirectory: () => Promise<string>;
  removeTemporaryDirectory: (directory: string) => Promise<void>;
}

/**
 * The eventual container launcher must use this base. The preflight validates
 * Docker and the immutable image before it copies any retained workflow source
 * or starts a container.
 */
export const dockerMockDebuggerRunSecurityArgs = Object.freeze([...dockerMockDebuggerSecurityArgs]);

function unavailable(message: string): HeadlessDebuggerError {
  return new HeadlessDebuggerError("debugger_unavailable", message, "after_action");
}

async function dockerServerVersion(run: DockerCommandRunner): Promise<string> {
  const version = await run(["version", "--format", "{{.Server.Version}}"]).catch(() => ({ code: null, stdout: "", stderr: "" }));
  const value = version.stdout.trim();
  if (version.code !== 0 || !value) throw unavailable("Docker is not available. Start Docker Desktop, then retry the mock debug session.");
  return value;
}

async function registryImageStatus(imageReference: string, run: DockerCommandRunner): Promise<"match" | "missing" | "mismatch"> {
  const inspected = await run(["image", "inspect", imageReference, "--format", "{{json .RepoDigests}}"]).catch(() => ({ code: null, stdout: "", stderr: "" }));
  if (inspected.code !== 0) return "missing";
  try {
    const repoDigests: unknown = JSON.parse(inspected.stdout.trim());
    return Array.isArray(repoDigests) && repoDigests.includes(imageReference) ? "match" : "mismatch";
  } catch {
    throw unavailable("Docker could not verify the mock-debug image digest. Reinstall the supported ArkiMux debug image, then retry.");
  }
}

async function candidateImageId(imageReference: string, run: DockerCommandRunner): Promise<string | null> {
  const inspected = await run(["image", "inspect", imageReference, "--format", "{{.Id}}"]).catch(() => ({ code: null, stdout: "", stderr: "" }));
  return inspected.code === 0 && imageIdPattern.test(inspected.stdout.trim()) ? inspected.stdout.trim() : null;
}

function candidateArchiveUrl(url: string): URL {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw unavailable("The installed CLI contains an invalid mock-debug candidate archive URL. Install a supported ArkiMux CLI build."); }
  if (parsed.protocol !== "https:") throw unavailable("The mock-debug candidate archive must use HTTPS.");
  return parsed;
}

async function downloadCandidateArchive(url: string, target: string): Promise<string> {
  const parsed = candidateArchiveUrl(url);
  let response: Response;
  try { response = await fetch(parsed, { redirect: "follow" }); }
  catch { throw unavailable("The mock-debug candidate archive could not be downloaded. Check network access, then retry."); }
  if (!response.ok || !response.body) throw unavailable("The mock-debug candidate archive could not be downloaded. Check the candidate release, then retry.");
  if (new URL(response.url).protocol !== "https:") throw unavailable("The mock-debug candidate archive redirected outside HTTPS and was rejected.");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > candidateArchiveByteLimit) throw unavailable("The mock-debug candidate archive exceeds the supported size limit.");

  const digest = createHash("sha256");
  let totalBytes = 0;
  const file = await open(target, "wx", 0o600);
  try {
    const reader = response.body.getReader();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      totalBytes += item.value.byteLength;
      if (totalBytes > candidateArchiveByteLimit) {
        await reader.cancel();
        throw unavailable("The mock-debug candidate archive exceeds the supported size limit.");
      }
      digest.update(item.value);
      await file.write(item.value);
    }
  } finally {
    await file.close();
  }
  return digest.digest("hex");
}

function boundedAppend(current: string, chunk: Buffer | string): string {
  if (current.length >= dockerOutputLimit) return current;
  return (current + String(chunk)).slice(0, dockerOutputLimit);
}

/** Runs one outer Docker CLI command. It never starts a container. */
export const runDockerCommand: DockerCommandRunner = async (args) => await new Promise((resolve) => {
  let child;
  try {
    child = spawn("docker", [...args], { stdio: ["ignore", "pipe", "pipe"], shell: false });
  } catch {
    resolve({ code: null, stdout: "", stderr: "" });
    return;
  }
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout = boundedAppend(stdout, chunk); });
  child.stderr.on("data", chunk => { stderr = boundedAppend(stderr, chunk); });
  let settled = false;
  const finish = (code: number | null) => {
    if (settled) return;
    settled = true;
    resolve({ code, stdout, stderr });
  };
  child.once("error", () => finish(null));
  child.once("close", code => finish(code));
});

const defaultDebugImageDependencies: DebugImageDependencies = {
  run: runDockerCommand,
  downloadCandidateArchive,
  makeTemporaryDirectory: async () => await mkdtemp(path.join(tmpdir(), "arkimux-debug-image-")),
  removeTemporaryDirectory: async directory => { await rm(directory, { recursive: true, force: true }); },
};

/**
 * Fail closed before workflow preparation. A caller supplies the exact image
 * reference from a future packaged debug-image manifest; tags are forbidden.
 */
export async function preflightDockerMockDebugger(
  imageReference: string,
  run: DockerCommandRunner = runDockerCommand,
): Promise<DockerMockDebuggerPreflight> {
  const match = pinnedImagePattern.exec(imageReference);
  if (!match) throw unavailable("The installed CLI does not contain a valid pinned Docker mock-debug image. Install a supported ArkiMux CLI build.");

  const version = await dockerServerVersion(run);
  const status = await registryImageStatus(imageReference, run);
  if (status === "missing") {
    throw unavailable("The pinned Docker mock-debug image is not installed. Install the supported ArkiMux debug image, then retry.");
  }
  if (status === "mismatch") throw unavailable("The installed Docker mock-debug image does not match the CLI's pinned digest. Reinstall the supported ArkiMux debug image, then retry.");
  return { imageReference, imageDigest: match[1], dockerServerVersion: version };
}

/**
 * Resolves both private candidate archives and final registry images to one
 * locally verified image reference. It never starts project code.
 */
export async function ensureDebugImage(
  source: DebugImageSource,
  dependencies: Partial<DebugImageDependencies> = {},
): Promise<EnsuredDebugImage> {
  const deps = { ...defaultDebugImageDependencies, ...dependencies };
  const registryMatch = source.kind === "registry" ? pinnedImagePattern.exec(source.imageReference) : null;
  if (source.kind === "registry" && !registryMatch) {
    throw unavailable("The installed CLI does not contain a valid pinned Docker mock-debug image. Install a supported ArkiMux CLI build.");
  }
  if (source.kind === "candidate-archive" && (!candidateImagePattern.test(source.imageReference)
    || !sha256Pattern.test(source.archiveSha256)
    || !imageIdPattern.test(source.imageId))) {
    throw unavailable("The installed CLI does not contain a valid mock-debug candidate image manifest. Install a supported ArkiMux CLI build.");
  }
  if (source.kind === "candidate-archive") candidateArchiveUrl(source.archiveUrl);
  const version = await dockerServerVersion(deps.run);

  if (source.kind === "registry") {
    if (await registryImageStatus(source.imageReference, deps.run) === "match") {
      return { sourceKind: source.kind, manifestReference: source.imageReference, runtimeReference: source.imageReference, imageIdentity: `sha256:${registryMatch![1]}`, dockerServerVersion: version, acquired: false };
    }
    const pulled = await deps.run(["pull", source.imageReference]).catch(() => ({ code: null, stdout: "", stderr: "" }));
    if (pulled.code !== 0 || await registryImageStatus(source.imageReference, deps.run) !== "match") {
      throw unavailable("The pinned Docker mock-debug image could not be acquired or verified. Check registry access, then retry.");
    }
    return { sourceKind: source.kind, manifestReference: source.imageReference, runtimeReference: source.imageReference, imageIdentity: `sha256:${registryMatch![1]}`, dockerServerVersion: version, acquired: true };
  }
  const existing = await candidateImageId(source.imageReference, deps.run);
  if (existing === source.imageId) {
    return { sourceKind: source.kind, manifestReference: source.imageReference, runtimeReference: source.imageId, imageIdentity: source.imageId, dockerServerVersion: version, acquired: false };
  }
  if (existing) throw unavailable("A different Docker image already uses the mock-debug candidate reference. Remove that image or install a fresh candidate.");

  let directory: string;
  try { directory = await deps.makeTemporaryDirectory(); }
  catch { throw unavailable("ArkiMux could not create a private temporary directory for the mock-debug image."); }
  try {
    const archive = path.join(directory, "mock-debug-image.tar");
    let archiveSha256: string;
    try { archiveSha256 = await deps.downloadCandidateArchive(source.archiveUrl, archive); }
    catch (error) {
      if (error instanceof HeadlessDebuggerError) throw error;
      throw unavailable("The mock-debug candidate archive could not be downloaded. Check the candidate release, then retry.");
    }
    if (archiveSha256 !== source.archiveSha256) throw unavailable("The mock-debug candidate archive failed its SHA-256 check and was not loaded.");
    const loaded = await deps.run(["load", "--input", archive]).catch(() => ({ code: null, stdout: "", stderr: "" }));
    if (loaded.code !== 0) throw unavailable("Docker could not load the verified mock-debug candidate archive.");
    if (await candidateImageId(source.imageReference, deps.run) !== source.imageId) {
      throw unavailable("The loaded mock-debug candidate image does not match its expected image ID and was rejected.");
    }
    return { sourceKind: source.kind, manifestReference: source.imageReference, runtimeReference: source.imageId, imageIdentity: source.imageId, dockerServerVersion: version, acquired: true };
  } finally {
    try { await deps.removeTemporaryDirectory(directory); }
    catch { throw unavailable("ArkiMux could not remove the temporary mock-debug image archive. Remove it manually before retrying."); }
  }
}
