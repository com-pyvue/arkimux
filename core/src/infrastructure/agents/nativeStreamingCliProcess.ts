import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentExecutionArtifacts,
  AgentExecutionRequest,
} from "../../application/agentProvider.ts";
import type { AgentExecutionProviderRuntimeConfig } from "./agentProviderConfigProvider.ts";
import { agentProcessDetached, agentProcessLifetime, assertAgentNotCancelled } from "./agentProcessLifetime.ts";
import { createRetainedAgentOutput } from "./retainedAgentOutput.ts";
import { credentialSecretValues } from "../../application/externalError.ts";

export interface NativeCliSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  artifacts: AgentExecutionArtifacts;
  elapsedMs: number;
}

export function allowlistedAgentEnvironment(
  runtimeConfig: AgentExecutionProviderRuntimeConfig,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(runtimeConfig.environmentAllowlist.flatMap((name) => {
    const value = environment[name];
    return value === undefined ? [] : [[name, value]];
  }));
}

export function nativeCliArtifactSummary(artifacts: AgentExecutionArtifacts): string {
  return [
    `events: ${artifacts.eventsPath}`,
    `stderr: ${artifacts.stderrPath}`,
    `lastMessage: ${artifacts.lastMessagePath}`,
    `heartbeat: ${artifacts.heartbeatPath}`,
  ].join("\n");
}

export async function runStreamingCli(
  request: AgentExecutionRequest,
  runtimeConfig: AgentExecutionProviderRuntimeConfig,
  childEnvironment: NodeJS.ProcessEnv,
  options: {
    providerId: string;
    args: string[];
    stdin?: string;
    model?: string;
    reasoningEffort?: string;
    secretValues?: readonly string[];
  },
): Promise<NativeCliSpawnResult> {
  assertAgentNotCancelled(request.signal);
  const artifactPrefix = request.artifactPrefix
    ?? path.join(os.tmpdir(), `agent-execution-agent-${process.pid}-${randomUUID()}`);
  const artifacts: AgentExecutionArtifacts = {
    eventsPath: `${artifactPrefix}.events.jsonl`,
    stderrPath: `${artifactPrefix}.stderr.log`,
    lastMessagePath: `${artifactPrefix}.last-message.txt`,
    heartbeatPath: `${artifactPrefix}.heartbeat.json`,
  };
  await fs.mkdir(path.dirname(artifactPrefix), { recursive: true });
  await fs.writeFile(artifacts.eventsPath, "", "utf8");
  await fs.writeFile(artifacts.stderrPath, "", "utf8");
  await fs.rm(artifacts.lastMessagePath, { force: true });
  assertAgentNotCancelled(request.signal);

  return new Promise((resolve, reject) => {
    const eventsStream = createWriteStream(artifacts.eventsPath, { flags: "a" });
    const stderrStream = createWriteStream(artifacts.stderrPath, { flags: "a" });
    const retained = createRetainedAgentOutput(eventsStream, stderrStream, options.secretValues ?? credentialSecretValues(childEnvironment));
    const child = spawn(runtimeConfig.command, options.args, {
      cwd: request.cwd,
      env: childEnvironment,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: agentProcessDetached(),
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lineBuffer = "";
    let lastEventAt: string | undefined;
    let lastEventType: string | undefined;
    const startedAt = Date.now();
    const heartbeat = (status: string) => {
      return {
        providerId: options.providerId,
        label: request.label,
        attempt: request.attempt,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        status,
        pid: child.pid,
        elapsedMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
        lastEventAt,
        lastEventType: typeof lastEventType === "string" ? retained.redact(lastEventType) : undefined,
        lastStderrLine: retained.lastStderrLine,
        artifacts,
        updatedAt: new Date().toISOString(),
      };
    };
    const lifetime = agentProcessLifetime({ child, signal: request.signal, timeoutMs: request.timeoutMs,
      heartbeatIntervalMs: runtimeConfig.heartbeatIntervalMs, heartbeatPath: artifacts.heartbeatPath, heartbeat, streams: [eventsStream, stderrStream] });

    const stdoutStream = child.stdout!;
    const stderrOutputStream = child.stderr!;
    stdoutStream.setEncoding("utf8");
    stderrOutputStream.setEncoding("utf8");
    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutBytes += Buffer.byteLength(chunk);
      retained.stdout(chunk);
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        lastEventAt = new Date().toISOString();
        try {
          const event = JSON.parse(line) as { type?: string; role?: string };
          lastEventType = event.type ?? event.role ?? "json-event";
        } catch {
          lastEventType = "unparseable-json-event";
        }
      }
    });
    stderrOutputStream.on("data", (chunk: string) => {
      stderr += chunk;
      stderrBytes += Buffer.byteLength(chunk);
      retained.stderr(chunk);
    });
    child.once("close", async (exitCode, signal) => {
      try { retained.finish(); await lifetime.finish(exitCode); } catch (error) { reject(error); return; }
      resolve({ stdout, stderr, exitCode, signal, timedOut: lifetime.timedOut, cancelled: lifetime.cancelled, artifacts, elapsedMs: Date.now() - startedAt });
    });

    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}
