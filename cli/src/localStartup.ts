import type { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";

interface LocalStartupMessage {
  kind: "arkimux-local-ready";
  token: string;
  pid: number;
  projectRoot: string;
  url: string;
}

interface LocalStartupAuthorization {
  kind: "arkimux-local-start-authorized";
  token: string;
  pid: number;
  projectRoot: string;
  url: string;
}

interface LocalStartupAuthorizationRequest {
  kind: "arkimux-local-awaiting-authorization";
  token: string;
  pid: number;
  projectRoot: string;
  url: string;
}

export async function waitForOwnedWorkflowApi(input: {
  url: string;
  child: ChildProcess;
  token: string;
  projectRoot: string;
  timeoutMs?: number;
  deadline?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  authorizeStart?: boolean;
  automaticPort?: boolean;
}): Promise<string> {
  if (!input.child.pid) throw new Error("Local server process did not report a PID.");
  const timeoutMs = input.timeoutMs ?? 30_000;
  const pollIntervalMs = input.pollIntervalMs ?? 200;
  const fetchImpl = input.fetchImpl ?? fetch;
  const deadline = input.deadline ?? Date.now() + timeoutMs;
  const expected: LocalStartupMessage = {
    kind: "arkimux-local-ready",
    token: input.token,
    pid: input.child.pid,
    projectRoot: canonicalPath(input.projectRoot),
    url: input.url,
  };
  const url = await waitForStartupMessage(
    input.child,
    expected,
    remainingTime(deadline),
    input.authorizeStart ?? false,
    input.automaticPort === true && input.url === "http://127.0.0.1:0",
  );

  let last = "not reachable";
  while (Date.now() < deadline) {
    const exit = childExit(input.child);
    if (exit) throw new Error(`Local server exited with ${exit}.`);
    try {
      const { response, value } = await runBeforeDeadline(deadline, async (signal) => {
        const response = await fetchImpl(`${url}/api/v1/workflows`, { signal });
        const value = response.ok
          ? await response.json() as { items?: Array<{ workflow?: { kind?: string; version?: number } }> }
          : undefined;
        return { response, value };
      });
      if (response.ok) {
        if (value?.items?.some(({ workflow }) => typeof workflow?.kind === "string" && Number.isInteger(workflow.version))) {
          const completedExit = childExit(input.child);
          if (completedExit) throw new Error(`Local server exited with ${completedExit}.`);
          return url;
        }
        last = "No workflow is registered";
      } else last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`The newly spawned local server did not become ready within ${Math.ceil(timeoutMs / 1_000)} seconds: ${last}.`);
}

export function describeLocalStartupFailure(input: {
  error: unknown;
  port: number;
  logPath: string;
  logOutput: string;
}): Error {
  if (/EADDRINUSE|address already in use/i.test(input.logOutput)) {
    return new Error([
      "Local server could not start.",
      `Port ${input.port} is already in use.`,
      "Stop the existing ArkiMux server or start this project with another port.",
    ].join("\n"));
  }
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const details = safeTail(input.logOutput);
  return new Error(`${message}${details ? ` See ${input.logPath}: ${details}` : ` See ${input.logPath}.`}`);
}

function waitForStartupMessage(
  child: ChildProcess,
  expected: LocalStartupMessage,
  timeoutMs: number,
  authorizeStart: boolean,
  automaticPort: boolean,
): Promise<string> {
  const existingExit = childExit(child);
  if (existingExit) return Promise.reject(new Error(`Local server exited before proving readiness (${existingExit}).`));
  return new Promise((resolve, reject) => {
    let settled = false;
    let authorizationSent = false;
    const timeout = setTimeout(() => finish(new Error(
      `The newly spawned local server did not prove readiness within ${Math.ceil(timeoutMs / 1_000)} seconds.`,
    )), timeoutMs);
    const onMessage = (message: unknown) => {
      if (isAuthorizationRequest(message)) {
        if (!authorizeStart || !sameStartupIdentity(message, expected)) {
          finish(new Error("Local server authorization request does not match the newly spawned process and project."));
          return;
        }
        if (!authorizationSent) {
          authorizationSent = true;
          sendStartupAuthorization(child, expected, finish);
        }
        return;
      }
      if (!isStartupMessage(message)) return;
      const readyExpected = automaticPort && isBoundLoopbackUrl(message.url)
        ? { ...expected, url: message.url } : expected;
      if ((automaticPort && (!authorizationSent || !isBoundLoopbackUrl(message.url)))
        || !sameStartupMessage(message, readyExpected)) {
        finish(new Error("Local server startup message does not match the newly spawned process and project."));
        return;
      }
      finish(undefined, message.url);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(
      `Local server exited before proving readiness (${code === null ? `signal ${signal ?? "unknown"}` : `status ${code}`}).`,
    ));
    const onError = (error: Error) => finish(new Error(`Local server process could not start: ${error.message}`));
    const finish = (error?: Error, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(url!);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function isBoundLoopbackUrl(value: unknown): value is string {
  if (typeof value !== "string" || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value)) return false;
  return Number(value.slice(value.lastIndexOf(":") + 1)) <= 65535;
}

function sendStartupAuthorization(
  child: ChildProcess,
  expected: LocalStartupMessage,
  finish: (error?: Error) => void,
): void {
  if (!child.connected || typeof child.send !== "function") {
    finish(new Error("Local server process disconnected before startup was authorized."));
    return;
  }
  const authorization: LocalStartupAuthorization = {
    ...expected,
    kind: "arkimux-local-start-authorized",
  };
  child.send(authorization, (error) => {
    if (error) finish(new Error(`Local server startup could not be authorized: ${error.message}`));
  });
}

function childExit(child: ChildProcess): string | undefined {
  if (child.exitCode !== null) return `status ${child.exitCode}`;
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  return undefined;
}

function isStartupMessage(value: unknown): value is LocalStartupMessage {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: unknown }).kind === "arkimux-local-ready";
}

function isAuthorizationRequest(value: unknown): value is LocalStartupAuthorizationRequest {
  if (!value || typeof value !== "object") return false;
  return (value as { kind?: unknown }).kind === "arkimux-local-awaiting-authorization";
}

function sameStartupMessage(actual: LocalStartupMessage, expected: LocalStartupMessage): boolean {
  return actual.kind === expected.kind && sameStartupIdentity(actual, expected);
}

function sameStartupIdentity(
  actual: Omit<LocalStartupMessage | LocalStartupAuthorizationRequest, "kind">,
  expected: LocalStartupMessage,
): boolean {
  return actual.token === expected.token
    && actual.pid === expected.pid
    && typeof actual.projectRoot === "string"
    && canonicalPath(actual.projectRoot) === expected.projectRoot
    && actual.url === expected.url;
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function safeTail(value: string): string {
  return value.trim().slice(-2_000).replace(/[\r\n]+/g, " ");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBeforeDeadline<T>(
  deadline: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const remaining = remainingTime(deadline);
  if (remaining === 0) throw new Error("startup deadline reached");
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("startup deadline reached"));
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function remainingTime(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}
