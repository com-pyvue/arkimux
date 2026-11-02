import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerType } from "@hono/node-server";
import { CodedWorkflowRegistry } from "@com-pyvue/agent-execution-run-api";
import { createLocalFilesystemAgentExecutionApiHost } from "./localFilesystemHost.ts";
import { parseLocalFilesystemRuntimePaths, value } from "./localFilesystemRuntime.ts";
import { startAgentExecutionApiServer } from "./server.ts";

export interface LocalFilesystemServerInvocation {
  hostname: string;
  port: number;
  runtime: ReturnType<typeof parseLocalFilesystemRuntimePaths>;
}

export function parseLocalFilesystemServerArgs(
  args: string[],
  cwd: string,
  moduleUrl: string,
  environment: NodeJS.ProcessEnv,
): LocalFilesystemServerInvocation {
  const requestedPort = value(args, "--port");
  const port = requestedPort === undefined ? 8787 : Number(requestedPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  return {
    hostname: value(args, "--hostname") ?? "127.0.0.1",
    port,
    runtime: parseLocalFilesystemRuntimePaths(args, cwd, moduleUrl, environment),
  };
}

export async function runLocalFilesystemServer(
  args: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ server: ServerType; url: string }> {
  const invocation = parseLocalFilesystemServerArgs(args, cwd, import.meta.url, environment);
  const app = await createLocalFilesystemAgentExecutionApiHost({
    ...invocation.runtime,
    workflows: new CodedWorkflowRegistry(),
    environment: {
      ...environment,
      AGENT_EXECUTION_LOCAL_SUBJECT: invocation.runtime.subjectId,
    },
    onBackgroundError: (error) => console.error(error.stack ?? error.message),
  });
  const server = startAgentExecutionApiServer({
    app,
    hostname: invocation.hostname,
    port: invocation.port,
  });
  return { server, url: `http://${invocation.hostname}:${invocation.port}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLocalFilesystemServer().then(({ server, url }) => {
    console.log(`Agent Execution API: ${url}`);
    const close = () => server.close();
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  }).catch((error) => {
    console.error((error as Error).stack ?? String(error));
    process.exitCode = 1;
  });
}
