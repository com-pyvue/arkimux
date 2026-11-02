import { constants, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { agentProcessDetached } from "./agentProcessLifetime.ts";

export interface ResolvedCliExecutable {
  command: string;
  source: "explicit" | "repository-local" | "path";
}

export interface CliExecutableProbeResult {
  available: boolean;
  versionOutput?: string;
  message?: string;
}

export async function resolveCliExecutable(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<ResolvedCliExecutable | undefined> {
  if (path.isAbsolute(command)) {
    return await executable(command) ? { command, source: "explicit" } : undefined;
  }
  if (command.includes("/") || command.includes("\\")) {
    const resolved = path.resolve(cwd, command);
    return await executable(resolved) ? { command: resolved, source: "explicit" } : undefined;
  }
  for (const name of executableNames(command, environment)) {
    const local = path.join(cwd, "node_modules", ".bin", name);
    if (await executable(local)) return { command: local, source: "repository-local" };
  }
  for (const directory of (environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of executableNames(command, environment)) {
      const candidate = path.join(directory, name);
      if (await executable(candidate)) return { command: candidate, source: "path" };
    }
  }
  return undefined;
}

export function probeCliExecutable(
  executablePath: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 5_000,
  requiredVersion?: string,
): Promise<CliExecutableProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let failure: CliExecutableProbeResult | undefined;
    const child = spawn(executablePath, ["--version"], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: agentProcessDetached(),
    });
    const terminate = () => {
      if (!child.pid) return;
      try {
        if (agentProcessDetached()) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          failure = { available: false, message: `Command ${executablePath} cleanup could not be confirmed.` };
        }
      }
    };
    const timer = setTimeout(() => {
      failure = {
        available: false,
        message: `Command ${executablePath} did not complete --version within ${timeoutMs}ms.`,
      };
      terminate();
    }, timeoutMs);
    child.once("exit", () => { if (agentProcessDetached()) terminate(); });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < 2_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 2_000) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => { failure = {
      available: false,
      message: `Command ${executablePath} could not start: ${error.message}`,
    }; });
    child.once("close", (code, signal) => {
      if (failure) return finish(failure);
      const versionOutput = (stdout.trim() || stderr.trim()).slice(0, 2_000);
      if (code === 0) {
        if (requiredVersion !== undefined && !versionMatches(versionOutput, requiredVersion)) {
          return finish({
            available: false,
            versionOutput,
            message: `Command ${executablePath} version ${versionOutput || "unknown"} does not match required version ${requiredVersion}.`,
          });
        }
        return finish({ available: true, ...(versionOutput ? { versionOutput } : {}) });
      }
      const detail = stderr.trim() || stdout.trim();
      finish({
        available: false,
        message: `Command ${executablePath} --version exited with ${code ?? signal ?? "unknown status"}${detail ? `: ${detail}` : "."}`,
      });
    });

    function finish(result: CliExecutableProbeResult) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }
  });
}

function versionMatches(output: string, requiredVersion: string): boolean {
  const escaped = requiredVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`).test(output);
}

async function executable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(command: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32" || path.extname(command)) return [command];
  return (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((extension) => `${command}${extension.toLowerCase()}`);
}
