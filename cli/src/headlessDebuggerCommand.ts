import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { headlessDebuggerErrorCodes, parseHeadlessRequest, type HeadlessProtocolVersion } from "../../local/src/headlessDebuggerContracts.ts";

export const headlessDebuggerMessageLimit = 1024 * 1024;

export interface HeadlessDebuggerClient {
  request(method: string, params: unknown, schemaVersion?: HeadlessProtocolVersion): Promise<unknown>;
  close(): Promise<void>;
}

interface TransportOptions {
  createClient(onChange: (sessionId: string, revision: number) => void): Promise<HeadlessDebuggerClient>;
  input: Readable;
  output: Pick<Writable, "write" | "on" | "removeListener">;
  diagnostics: Pick<Writable, "write">;
  signals?: Pick<EventEmitter, "on" | "removeListener">;
}

const methodParams: Record<string, string[]> = {
  "session.create": ["authorization", "manifest"],
  "session.open": ["sessionId"],
  "session.inspect": [],
  "session.close": [],
  "case.run": ["caseId"],
  "case.respond": ["caseId", "expectedRevision", "requestId", "response", "submissionId"],
  "case.cancel": ["caseId"],
  "evidence.read": ["caseId", "evidenceId", "limit", "offset"],
};
const liveMethods = new Set([
  "debug.sources", "debug.source.read", "debug.breakpoints.set", "debug.inspect", "debug.pause", "debug.continue",
  "debug.step", "debug.stack", "debug.scopes", "debug.properties", "debug.evaluate", "debug.variable.set",
]);
const publicCodes = new Set<string>(headlessDebuggerErrorCodes);

function failure(id: string | null, code: string, message: string, retry = "never", schemaVersion: HeadlessProtocolVersion = 1) {
  return { schemaVersion, id, ok: false, error: { code, message, retry } };
}

function safeFailure(id: string, error: unknown, schemaVersion: HeadlessProtocolVersion = 1) {
  if (error && typeof error === "object" && "code" in error && "message" in error && "retry" in error
      && typeof error.code === "string" && publicCodes.has(error.code)
      && typeof error.message === "string" && error.message.length <= 4096
      && ["never", "after_action", "same_identity"].includes(String(error.retry))) {
    return failure(id, error.code, error.message, String(error.retry), schemaVersion);
  }
  return failure(id, "internal_error", "The diagnostic request could not complete. Inspect the same session before retrying.", "same_identity", schemaVersion);
}

/** Transport only: session rules and retained execution belong to the Local Library. */
export async function runHeadlessDebuggerTransport(options: TransportOptions): Promise<number> {
  let exitCode = 0;
  let stopping = false;
  let brokenOutput = false;
  let client: HeadlessDebuggerClient | undefined;
  let protocolVersion: HeadlessProtocolVersion | undefined;
  const deferredChanges = new Map<string, number>();
  let partial = Buffer.alloc(0);
  const outstanding = new Set<string>();
  const pending = new Set<Promise<void>>();
  let settle!: () => void;
  const stopped = new Promise<void>((resolve) => { settle = resolve; });
  let writes = Promise.resolve();
  let releaseWrite: (() => void) | undefined;
  const diagnostic = (message: string) => { try { options.diagnostics.write(`${message}\n`); } catch { /* No raw fallback. */ } };

  const send = (payload: unknown): Promise<void> => {
    const schemaVersion = protocolVersion ?? (payload && typeof payload === "object" && "schemaVersion" in payload && payload.schemaVersion === 2 ? 2 : 1);
    const versionedPayload = payload && typeof payload === "object" ? { ...payload, schemaVersion } : payload;
    let encoded: string;
    try { encoded = JSON.stringify(versionedPayload); } catch {
      encoded = JSON.stringify(failure(null, "internal_error", "The diagnostic response could not be encoded.", "same_identity", schemaVersion));
    }
    if (Buffer.byteLength(encoded, "utf8") > headlessDebuggerMessageLimit) {
      const id = payload && typeof payload === "object" && "id" in payload && typeof payload.id === "string" ? payload.id : null;
      encoded = JSON.stringify(failure(id, "evidence_too_large", "The response exceeds the message limit. Read evidence in pages or reduce the case set.", "after_action", schemaVersion));
      if (Buffer.byteLength(encoded, "utf8") > headlessDebuggerMessageLimit) {
        encoded = JSON.stringify(failure(null, "message_too_large", "The request ID leaves insufficient space for a bounded response.", "never", schemaVersion));
      }
    }
    const line = `${encoded}\n`;
    writes = writes.then(async () => {
      if (brokenOutput) return;
      await new Promise<void>((resolve) => {
        const finish = () => { if (releaseWrite === finish) releaseWrite = undefined; resolve(); };
        releaseWrite = finish;
        try {
          options.output.write(line, (error?: Error | null) => {
            if (error) outputFailed();
            finish();
          });
        } catch { outputFailed(); finish(); }
      });
    });
    return writes;
  };

  const stop = (code: number) => {
    if (code !== 0 && exitCode === 0) exitCode = code;
    if (stopping) return;
    stopping = true;
    options.input.pause();
    settle();
  };
  const outputFailed = () => { brokenOutput = true; releaseWrite?.(); stop(1); };
  const interrupted = () => stop(130);
  const terminated = () => stop(143);
  const inputFailed = () => { diagnostic("The diagnostic input stream failed."); stop(1); };
  options.output.on("error", outputFailed);
  options.signals?.on("SIGINT", interrupted);
  options.signals?.on("SIGTERM", terminated);

  const processLine = (bytes: Buffer) => {
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {
      void send(failure(null, "invalid_request", "Each line must be one UTF-8 JSON request object."));
      return;
    }
    const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    const id = typeof object?.id === "string" && object.id.length > 0 ? object.id : null;
    const responseVersion = object?.schemaVersion === 2 ? 2 : 1;
    if (!object || id === null || Object.keys(object).sort().join(",") !== "id,method,params,schemaVersion"
        || typeof object.method !== "string" || !object.params || typeof object.params !== "object" || Array.isArray(object.params)) {
      void send(failure(id, "invalid_request", "A request requires exactly schemaVersion, id, method and object params.", "never", responseVersion));
      return;
    }
    if (object.schemaVersion !== 1 && object.schemaVersion !== 2) {
      void send(failure(id, "unsupported_version", "Only schemaVersion 1 or 2 is supported."));
      return;
    }
    const requestedVersion = object.schemaVersion;
    if (protocolVersion !== undefined && requestedVersion !== protocolVersion) {
      void send(failure(id, "unsupported_version", "This process already selected another protocol version. Start a new debugger process to change versions."));
      return;
    }
    if (!Object.hasOwn(methodParams, object.method) && !(requestedVersion === 2 && liveMethods.has(object.method))) {
      void send(failure(id, "unsupported_operation", "This diagnostic method is not supported.", "never", requestedVersion));
      return;
    }
    let request;
    try { request = parseHeadlessRequest(object); }
    catch (error) { void send(safeFailure(id, error, requestedVersion)); return; }
    if (outstanding.has(id)) {
      void send(failure(id, "invalid_request", "Request IDs must be unique among outstanding requests."));
      return;
    }
    if (protocolVersion === undefined) {
      protocolVersion = requestedVersion;
      for (const [sessionId, revision] of deferredChanges) void send({ schemaVersion: protocolVersion, event: "session.changed", sessionId, revision });
      deferredChanges.clear();
    }
    outstanding.add(id);
    const method = request.method;
    // Stop accepting more lines at close, but finish its response before teardown.
    if (method === "session.close") stop(0);
    const operation = Promise.resolve().then(async () => {
      try {
        const result = request.schemaVersion === 2
          ? await client!.request(method, request.params, 2)
          : await client!.request(method, request.params);
        await send({ schemaVersion: request.schemaVersion, id, ok: true, result });
      } catch (error) {
        if (method === "session.close") exitCode = 1;
        await send(safeFailure(id, error, request.schemaVersion));
      }
      finally { outstanding.delete(id); }
    });
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  };

  const onData = (chunk: Buffer | string) => {
    if (stopping) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    let offset = 0;
    while (offset < bytes.length && !stopping) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      if (partial.length + end - offset > headlessDebuggerMessageLimit) {
        void send(failure(null, "message_too_large", "The request exceeds the 1 MiB UTF-8 message limit."));
        partial = Buffer.alloc(0);
        stop(2);
        return;
      }
      partial = Buffer.concat([partial, bytes.subarray(offset, end)]);
      if (newline === -1) return;
      processLine(partial);
      partial = Buffer.alloc(0);
      offset = newline + 1;
    }
  };
  const onEnd = () => {
    if (!stopping && partial.length > 0) processLine(partial);
    partial = Buffer.alloc(0);
    stop(0);
  };

  try {
    client = await options.createClient((sessionId, revision) => {
      if (stopping) return;
      if (protocolVersion === undefined) deferredChanges.set(sessionId, revision);
      else void send({ schemaVersion: protocolVersion, event: "session.changed", sessionId, revision });
    });
    if (!stopping) {
      options.input.on("data", onData);
      options.input.on("end", onEnd);
      options.input.on("error", inputFailed);
      if (options.input.readableEnded) onEnd();
      else options.input.resume();
    }
    await stopped;
    // Let already-framed requests enter the client, then begin cleanup alongside
    // their responses. Waiting for a form validator first would prevent close
    // from aborting it on EOF, signals or a disconnected protocol output.
    await Promise.resolve();
    const cleanup = Promise.resolve().then(() => client!.close());
    await Promise.all([cleanup, ...pending]);
  } catch {
    diagnostic(client ? "Diagnostic cleanup could not be confirmed." : "The diagnostic host could not start. Check the project and storage, then retry.");
    exitCode = 1;
  } finally {
    options.input.pause();
    options.input.removeListener("data", onData);
    options.input.removeListener("end", onEnd);
    options.input.removeListener("error", inputFailed);
    options.signals?.removeListener("SIGINT", interrupted);
    options.signals?.removeListener("SIGTERM", terminated);
    await writes;
    options.output.removeListener("error", outputFailed);
  }
  return exitCode;
}

export async function runHeadlessDebuggerCommand(
  args: string[], cwd: string, packageRoot: string,
  createClient: (options: { projectRoot: string; packageVersion: string; onChange: (sessionId: string, revision: number) => void }) => Promise<HeadlessDebuggerClient>,
): Promise<number> {
  if (args.length !== 3 || args[0] !== "stdio" || args[1] !== "--project" || !args[2] || args[2].startsWith("--")) {
    process.stderr.write("Usage: arkimux debug stdio --project PATH\n");
    return 2;
  }
  let projectRoot: string;
  let packageVersion: string;
  try {
    projectRoot = await realpath(path.resolve(cwd, args[2]));
    if (!(await stat(projectRoot)).isDirectory()) throw new Error("not-directory");
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (typeof manifest.version !== "string") throw new Error("missing-version");
    packageVersion = manifest.version;
  } catch {
    process.stderr.write("The diagnostic project or installed package is not available. Check --project and the project-pinned CLI.\n");
    return 2;
  }
  const originalOutput = process.stdout.write;
  const originalError = process.stderr.write;
  const output = { write: originalOutput.bind(process.stdout), on: process.stdout.on.bind(process.stdout), removeListener: process.stdout.removeListener.bind(process.stdout) };
  const diagnostics = { write: originalError.bind(process.stderr) };
  // Project constructors are trusted executable code, but their logs are not protocol data.
  // Only captured protocol/diagnostic writers may emit during this command.
  const discard: typeof process.stdout.write = (...values: any[]) => {
    const callback = values[values.length - 1];
    if (typeof callback === "function") queueMicrotask(() => callback());
    return true;
  };
  process.stdout.write = discard;
  process.stderr.write = discard;
  try {
    return await runHeadlessDebuggerTransport({
      input: process.stdin, output, diagnostics, signals: process,
      async createClient(onChange) {
        return createClient({ projectRoot, packageVersion, onChange });
      },
    });
  } finally {
    process.stdout.write = originalOutput;
    process.stderr.write = originalError;
  }
}
