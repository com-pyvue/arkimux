import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import candidateRunSecurityArgs from "../../cli/src/dockerMockDebuggerSecurity.json" with { type: "json" };
import publicImageSource from "../../cli/src/dockerMockDebuggerImageSource.json" with { type: "json" };

const execFile = promisify(execFileCallback);
export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
export const candidateRepository = "arkimux/mock-debugger";
export const candidatePlatform = "linux/arm64";
export const candidateBaseImage = "node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6";
export const publicImageReference = publicImageSource.imageReference;
if (!/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(publicImageReference)) {
  throw new Error("The packaged mock-debugger image source must use an immutable SHA-256 registry digest.");
}
export const publicRepository = publicImageReference.replace(/@sha256:[a-f0-9]{64}$/, "");
export const publicPlatforms = Object.freeze(["linux/amd64", "linux/arm64"]);

export { candidateRunSecurityArgs };

export const sortableTimestamp = (value = new Date()) => value.toISOString().replace(/:/g, "-");
export const sha256File = async file => createHash("sha256").update(await readFile(file)).digest("hex");

export async function docker(args, options = {}) {
  try {
    const environment = { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" };
    if (options.credentials === true) {
      if (process.env.HOME) environment.HOME = process.env.HOME;
      if (process.env.DOCKER_CONFIG) environment.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
    }
    const result = await execFile("docker", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeout ?? 10 * 60_000,
      env: environment,
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(stderr || `docker ${args[0] ?? "command"} failed.`);
  }
}

export async function writeProbeInput(directory) {
  const inputDirectory = path.join(directory, "input");
  await mkdir(inputDirectory, { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  await writeFile(path.join(inputDirectory, "probe.json"), JSON.stringify({ schemaVersion: 1, nonce }) + "\n", { flag: "wx", mode: 0o600 });
  return { inputDirectory, nonce };
}

export async function runIsolationProbe(imageReference, directory, options = {}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageReference)
    && !/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(imageReference)) {
    throw new Error("Expected an immutable Docker image ID or registry digest.");
  }
  const { inputDirectory, nonce } = await writeProbeInput(directory);
  const mount = `type=bind,src=${inputDirectory},dst=/work/input,readonly`;
  const platform = options.platform ? ["--platform", options.platform] : [];
  const result = await docker([...candidateRunSecurityArgs, ...platform, "--entrypoint", "node", "--mount", mount, imageReference,
    "--permission", "--allow-fs-read=/opt/arkimux", "--allow-fs-read=/work/input", "--allow-fs-read=/work/scratch",
    "--allow-fs-read=/proc/self/status", "--allow-fs-read=/proc/mounts", "--allow-fs-read=/sys/fs/cgroup",
    "--allow-fs-write=/work/scratch", "/opt/arkimux/isolation-probe.mjs"], { timeout: 30_000 });
  const report = JSON.parse(result.stdout);
  if (report?.kind !== "arkimux-mock-debugger-isolation" || report?.checks?.retainedInputRead !== nonce || report?.ok !== true) {
    throw new Error(`Mock-debugger isolation probe failed: ${JSON.stringify(report)}`);
  }
  return report;
}
