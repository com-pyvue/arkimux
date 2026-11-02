import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HeadlessDebuggerError, headlessDebuggerErrorCodes } from "../../local/src/headlessDebuggerContracts.ts";
import {
  dockerMockDebuggerBootstrapByteLimit,
  dockerMockDebuggerBridgeMessageByteLimit,
  dockerMockDebuggerRetainedCodeByteLimit,
  validDockerMockDebuggerAssetPath,
  parseDockerMockDebuggerBootstrap,
  type DockerMockDebuggerBootstrap,
  type DockerMockDebuggerBridgeMethod,
  type DockerMockDebuggerBridgeParams,
} from "./dockerMockDebuggerBridgeContracts.ts";
import {
  dockerMockDebuggerRunSecurityArgs,
  runDockerCommand,
  type DockerCommandRunner,
  type EnsuredDebugImage,
} from "./dockerMockDebugger.ts";

const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const pinnedImagePattern = /^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/;
const bridgeTimeoutMs = 15_000;
const requestTimeoutMs = 5_000;
const publicErrorCodes = new Set<string>(headlessDebuggerErrorCodes);
type ClientBridgeMethod = Exclude<DockerMockDebuggerBridgeMethod, "session.close">;

type SpawnDocker = (args: readonly string[]) => ChildProcessWithoutNullStreams;
export interface DockerMockDebuggerLauncherDependencies {
  spawnDocker: SpawnDocker;
  runDocker: DockerCommandRunner;
  makeInputDirectory: () => Promise<string>;
  removeInputDirectory: (directory: string) => Promise<void>;
}

export interface DockerMockDebuggerBridgeSession {
  readonly containerName: string;
  readonly imageIdentity: string;
  readonly ready: unknown;
  request<M extends ClientBridgeMethod>(method: M, params: DockerMockDebuggerBridgeParams<M>): Promise<unknown>;
  close(): Promise<void>;
}

export function describeDockerMockDebuggerAssets(assets: Readonly<Record<string, Uint8Array>>): DockerMockDebuggerBootstrap["assets"] {
  return Object.entries(assets).sort(([left], [right]) => left.localeCompare(right)).map(([assetPath, bytes]) => {
    if (!validDockerMockDebuggerAssetPath(assetPath) || !(bytes instanceof Uint8Array)) {
      throw unavailable("The mock debug retained assets are invalid.");
    }
    return { path: assetPath, byteLength: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}

function unavailable(message: string): HeadlessDebuggerError {
  return new HeadlessDebuggerError("debugger_unavailable", message, "after_action");
}

function cleanupUnconfirmed(): HeadlessDebuggerError {
  return new HeadlessDebuggerError("cleanup_unconfirmed",
    "The mock debug container cleanup could not be confirmed. Stop the container before retrying.", "after_action");
}

const defaults: DockerMockDebuggerLauncherDependencies = {
  spawnDocker: args => spawn("docker", [...args], { stdio: ["pipe", "pipe", "pipe"], shell: false }),
  runDocker: runDockerCommand,
  makeInputDirectory: async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "arkimux-mock-debug-input-"));
    await chmod(directory, 0o700);
    return directory;
  },
  removeInputDirectory: async directory => { await rm(directory, { recursive: true, force: true }); },
};

function validRuntimeImage(image: EnsuredDebugImage): boolean {
  if (!imageIdPattern.test(image.imageIdentity)) return false;
  return image.sourceKind === "candidate-archive"
    ? image.runtimeReference === image.imageIdentity
    : pinnedImagePattern.test(image.runtimeReference) && image.runtimeReference.endsWith(image.imageIdentity.slice("sha256:".length));
}

export async function launchDockerMockDebugger(
  options: { image: EnsuredDebugImage; bootstrap: DockerMockDebuggerBootstrap; retainedCode: string;
    retainedAssets?: Readonly<Record<string, Uint8Array>> },
  dependencies: Partial<DockerMockDebuggerLauncherDependencies> = {},
): Promise<DockerMockDebuggerBridgeSession> {
  const deps = { ...defaults, ...dependencies };
  if (!validRuntimeImage(options.image)) throw unavailable("The verified mock-debug image identity is invalid.");
  let bootstrap: DockerMockDebuggerBootstrap;
  try { bootstrap = parseDockerMockDebuggerBootstrap(options.bootstrap); }
  catch { throw unavailable("The mock debug retained input is invalid."); }
  const bootstrapBytes = Buffer.from(JSON.stringify(bootstrap) + "\n");
  const retainedBytes = Buffer.from(options.retainedCode);
  const retainedAssets = options.retainedAssets ?? {};
  let describedAssets: DockerMockDebuggerBootstrap["assets"];
  try { describedAssets = describeDockerMockDebuggerAssets(retainedAssets); }
  catch { throw unavailable("The mock debug retained assets are invalid."); }
  if (JSON.stringify(describedAssets) !== JSON.stringify(bootstrap.assets)) {
    throw unavailable("The mock debug retained assets do not match their retained manifest.");
  }
  if (bootstrapBytes.length > dockerMockDebuggerBootstrapByteLimit || retainedBytes.length < 1
    || retainedBytes.length > dockerMockDebuggerRetainedCodeByteLimit) throw unavailable("The mock debug retained input exceeds its supported limit.");

  let inputDirectory: string;
  try { inputDirectory = await deps.makeInputDirectory(); }
  catch { throw unavailable("ArkiMux could not create the private mock debug input directory."); }
  if (inputDirectory.includes(",") || !path.isAbsolute(inputDirectory)
    || path.dirname(inputDirectory) !== path.resolve(tmpdir())
    || !path.basename(inputDirectory).startsWith("arkimux-mock-debug-input-")) {
    throw unavailable("ArkiMux created an invalid mock debug input directory.");
  }
  const containerName = `arkimux-mock-debug-${randomUUID()}`;
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed = false, closing: Promise<void> | undefined;
  let partial = Buffer.alloc(0), readyValue: unknown;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let readyResolve!: (value: unknown) => void, readyReject!: (error: Error) => void;
  const ready = new Promise<unknown>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const readyTimer = setTimeout(() => readyReject(unavailable("The mock debug container did not become ready.")), bridgeTimeoutMs);

  const failPending = (error: Error) => {
    clearTimeout(readyTimer); readyReject(error);
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  };
  const acceptMessage = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable("The mock debug container returned an invalid message.");
    const message = value as Record<string, unknown>;
    if (message.schemaVersion !== 1) throw unavailable("The mock debug container returned an unsupported message.");
    if (message.event === "bridge.ready") {
      if (readyValue !== undefined || message.sessionId !== bootstrap.caseId || !message.result || typeof message.result !== "object"
        || (message.result as Record<string, unknown>).kind !== "arkimux-mock-debugger-retained-bridge"
        || (message.result as Record<string, unknown>).ok !== true || (message.result as Record<string, unknown>).simulated !== true) {
        throw unavailable("The mock debug container returned an invalid readiness message.");
      }
      readyValue = message.result; clearTimeout(readyTimer); readyResolve(readyValue); return;
    }
    if (typeof message.id !== "string" || typeof message.ok !== "boolean") throw unavailable("The mock debug container returned an invalid response.");
    const item = pending.get(message.id); if (!item) throw unavailable("The mock debug container returned an unknown response.");
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.ok) item.resolve(message.result);
    else {
      const error = message.error && typeof message.error === "object" && !Array.isArray(message.error)
        ? message.error as Record<string, unknown> : {};
      if (typeof error.code !== "string" || !publicErrorCodes.has(error.code) || typeof error.message !== "string"
        || Buffer.byteLength(error.message) > 4096 || typeof error.retry !== "string"
        || !["never", "after_action", "same_identity"].includes(error.retry)) {
        item.reject(unavailable("The mock debug container rejected its internal request."));
      } else item.reject(new HeadlessDebuggerError(error.code as ConstructorParameters<typeof HeadlessDebuggerError>[0], error.message,
        error.retry as ConstructorParameters<typeof HeadlessDebuggerError>[2]));
    }
  };
  const onData = (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset), end = newline === -1 ? bytes.length : newline;
      if (partial.length + end - offset > dockerMockDebuggerBridgeMessageByteLimit) {
        failPending(unavailable("The mock debug container exceeded its message limit.")); child?.kill("SIGKILL"); return;
      }
      partial = Buffer.concat([partial, bytes.subarray(offset, end)]);
      if (newline === -1) return;
      try { acceptMessage(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(partial))); }
      catch (error) { failPending(error instanceof Error ? error : unavailable("The mock debug container returned an invalid response.")); child?.kill("SIGKILL"); return; }
      partial = Buffer.alloc(0); offset = newline + 1;
    }
  };
  const cleanup = async () => {
    child?.stdout.off("data", onData);
    child?.kill("SIGKILL");
    let containerRemoved = true;
    if (child) {
      await deps.runDocker(["rm", "--force", "--volumes", containerName]).catch(() => ({ code: null, stdout: "", stderr: "" }));
      const inspected = await deps.runDocker(["container", "inspect", containerName]).catch(() => ({ code: null, stdout: "", stderr: "" }));
      containerRemoved = inspected.code !== null && inspected.code !== 0;
    }
    let directoryRemoved = true;
    try { await deps.removeInputDirectory(inputDirectory); } catch { directoryRemoved = false; }
    if (!containerRemoved || !directoryRemoved) throw cleanupUnconfirmed();
  };

  try {
    await writeFile(path.join(inputDirectory, "bootstrap.json"), bootstrapBytes, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(inputDirectory, "entry.mjs"), retainedBytes, { flag: "wx", mode: 0o600 });
    for (const [assetPath, bytes] of Object.entries(retainedAssets)) {
      const target = path.join(inputDirectory, "assets", assetPath);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    }
    const mount = `type=bind,src=${inputDirectory},dst=/work/input,readonly`;
    child = deps.spawnDocker([...dockerMockDebuggerRunSecurityArgs, "--name", containerName, "--mount", mount, options.image.runtimeReference]);
    child.stdout.on("data", onData);
    child.stderr.on("data", () => { /* Docker and project stderr are never exposed. */ });
    child.once("error", () => failPending(unavailable("The mock debug container could not start.")));
    child.once("close", () => {
      if (!closed) failPending(unavailable("The mock debug container stopped unexpectedly."));
    });
    await ready;
  } catch (error) {
    clearTimeout(readyTimer); closed = true;
    let cleanupError: unknown;
    try { await cleanup(); } catch (caught) { cleanupError = caught; }
    if (cleanupError) throw cleanupError;
    throw error instanceof HeadlessDebuggerError ? error : unavailable("The mock debug container could not start.");
  }

  const sendRequest = async <M extends DockerMockDebuggerBridgeMethod>(method: M, params: DockerMockDebuggerBridgeParams<M>): Promise<unknown> => {
    if (closed || !child?.stdin.writable) throw unavailable("The mock debug container is closed.");
    const id = `request-${randomUUID()}`;
    const encoded = JSON.stringify({ schemaVersion: 1, id, method, params }) + "\n";
    if (Buffer.byteLength(encoded) > dockerMockDebuggerBridgeMessageByteLimit) throw unavailable("The mock debug request exceeds its message limit.");
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(unavailable("The mock debug container did not answer.")); }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
    });
    try {
      await new Promise<void>((resolve, reject) => child!.stdin.write(encoded,
        error => error ? reject(unavailable("The mock debug request could not be sent.")) : resolve()));
    } catch (error) {
      const item = pending.get(id); if (item) clearTimeout(item.timer);
      pending.delete(id);
      throw error;
    }
    return await response;
  };
  const close = async () => {
    if (closing) return await closing;
    closing = (async () => {
      try { if (!closed) await sendRequest("session.close", {}); }
      catch { /* Confirmed forced cleanup is sufficient after an unexpected container exit. */ }
      finally {
        closed = true;
        failPending(unavailable("The mock debug container is closed."));
        await cleanup();
      }
    })();
    return await closing;
  };
  const request = async <M extends ClientBridgeMethod>(method: M, params: DockerMockDebuggerBridgeParams<M>) => await sendRequest(method, params);
  return { containerName, imageIdentity: options.image.imageIdentity, ready: readyValue, request, close };
}
