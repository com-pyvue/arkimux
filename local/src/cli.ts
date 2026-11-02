import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerType } from "@hono/node-server";
import { CodedWorkflowRegistry } from "@com-pyvue/agent-execution-run-api";
import { createLocalFilesystemAgentExecutionApiHost } from "../../apps/hosts/api/src/localFilesystemHost.ts";
import { bootstrapLocalOperator } from "../../apps/hosts/api/src/localOperatorBootstrap.ts";
import { parseLocalFilesystemRuntimePaths, value } from "../../apps/hosts/api/src/localFilesystemRuntime.ts";
import { startAgentExecutionApiServer } from "../../apps/hosts/api/src/server.ts";
import { mountLocalWebApplication } from "./staticWeb.ts";
import { assertLegacyLocalStoreMigrated } from "./localStorePaths.ts";
import { migrateLegacyLocalStore } from "./localStoreMigration.ts";

export type LocalCliResult =
  | { kind: "serve"; server: ServerType; url: string }
  | { kind: "bootstrap"; message: string }
  | { kind: "migrate"; message: string }
  | { kind: "help"; message: string };

export function localCliUsage(): string {
  return [
    "Usage:",
    "  agent-execution-local serve --repository-root <path> --subject-id <id> [--hostname <host>] [--port <port>]",
    "  agent-execution-local bootstrap --repository-root <path> --subject-id <id> --user-id <id> (--role-id <id> | --role-family <id>) [--role-preset <id>] [--permission <permission>]",
    "  agent-execution-local migrate [--repository-root <path>]",
    "",
    "Defaults:",
    "  --repository-root current working directory",
    "  --hostname 127.0.0.1",
    "  --port 8787",
  ].join("\n");
}

export async function runLocalCli(
  args: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): Promise<LocalCliResult> {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    return { kind: "help", message: localCliUsage() };
  }
  if (command !== "serve" && command !== "bootstrap" && command !== "migrate") {
    throw new Error(`Unknown command ${command}.\n\n${localCliUsage()}`);
  }
  const packageRoot = path.dirname(fileURLToPath(moduleUrl));
  const commandArgs = withPackagedRuntimeDefaults(args.slice(1), packageRoot);
  const repositoryRoot = path.resolve(cwd, value(commandArgs, "--repository-root") ?? ".");
  if (command === "migrate") {
    const result = await migrateLegacyLocalStore(repositoryRoot);
    return { kind: "migrate", message: result.message };
  }
  await assertLegacyLocalStoreMigrated(repositoryRoot);
  if (command === "bootstrap") {
    return {
      kind: "bootstrap",
      message: await bootstrapLocalOperator(commandArgs, cwd, environment),
    };
  }

  const runtime = parseLocalFilesystemRuntimePaths(commandArgs, cwd, moduleUrl, environment);
  const port = parsePort(value(commandArgs, "--port"));
  const hostname = value(commandArgs, "--hostname") ?? "127.0.0.1";
  const webRoot = path.resolve(cwd, value(commandArgs, "--web-root") ?? path.join(packageRoot, "web"));
  const app = await createLocalFilesystemAgentExecutionApiHost({
    ...runtime,
    workflows: new CodedWorkflowRegistry(),
    environment: {
      ...environment,
      AGENT_EXECUTION_LOCAL_SUBJECT: runtime.subjectId,
      AGENT_EXECUTION_UI_PROFILE: environment.AGENT_EXECUTION_UI_PROFILE ?? "workflow-development",
    },
    onBackgroundError: (error) => console.error(error.stack ?? error.message),
  });
  mountLocalWebApplication(app, webRoot);
  const server = startAgentExecutionApiServer({ app, hostname, port });
  return { kind: "serve", server, url: `http://${hostname}:${port}` };
}

function withPackagedRuntimeDefaults(args: string[], packageRoot: string): string[] {
  return [
    ...args,
    ...missingOption(args, "--application-configuration-root", path.join(packageRoot, "config", "application-hosts")),
    ...missingOption(args, "--platform-configuration-directory", path.join(packageRoot, "config", "platform-configurations")),
    ...missingOption(args, "--platform-store-configuration-root", path.join(packageRoot, "config")),
  ];
}

function missingOption(args: string[], name: string, defaultValue: string): string[] {
  return args.includes(name) ? [] : [name, defaultValue];
}

function parsePort(requestedPort: string | undefined): number {
  const port = requestedPort === undefined ? 8787 : Number(requestedPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  return port;
}

export function isDirectCliEntry(argvEntry: string | undefined, moduleUrl: string): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync(argvEntry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return path.resolve(argvEntry) === path.resolve(fileURLToPath(moduleUrl));
  }
}

if (isDirectCliEntry(process.argv[1], import.meta.url)) {
  runLocalCli().then((result) => {
    if (result.kind === "help" || result.kind === "bootstrap" || result.kind === "migrate") {
      console.log(result.message);
      return;
    }
    console.log(`Agent Execution local portal: ${result.url}`);
    const close = () => result.server.close();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  }).catch((error) => {
    console.error((error as Error).stack ?? String(error));
    process.exitCode = 1;
  });
}
