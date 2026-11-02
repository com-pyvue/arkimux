import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RunApiClient } from "@com-pyvue/agent-execution-run-contract";
import { CodedWorkflowRegistry } from "@com-pyvue/agent-execution-run-api";
import { createLocalFilesystemAgentExecutionApiHost } from "./localFilesystemHost.ts";
import { parseLocalFilesystemRuntimePaths, value } from "./localFilesystemRuntime.ts";
import { benchmarkRunQueries } from "./runQueryBenchmark.ts";

export async function benchmarkLocalRunQueries(
  args: string[] = process.argv.slice(2),
  cwd: string = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const runtime = parseLocalFilesystemRuntimePaths(args, cwd, import.meta.url, environment);
  const host = await createLocalFilesystemAgentExecutionApiHost({
    ...runtime,
    workflows: new CodedWorkflowRegistry(),
    environment: {
      ...environment,
      AGENT_EXECUTION_LOCAL_SUBJECT: runtime.subjectId,
    },
  });
  const client = new RunApiClient({
    baseUrl: "http://local.agent-execution",
    fetch: async (input, init) => host.request(input, init),
  });
  const result = await benchmarkRunQueries(client, {
    ...(value(args, "--iterations") === undefined ? {} : { iterations: Number(value(args, "--iterations")) }),
    ...(value(args, "--page-size") === undefined ? {} : { pageSize: Number(value(args, "--page-size")) }),
    ...(value(args, "--comparison-size") === undefined
      ? {}
      : { comparisonSize: Number(value(args, "--comparison-size")) }),
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const output = value(args, "--output");
  if (output !== undefined) {
    const outputPath = path.resolve(cwd, output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
  }
  return serialized;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  benchmarkLocalRunQueries().then((result) => process.stdout.write(result)).catch((error) => {
    console.error((error as Error).stack ?? String(error));
    process.exitCode = 1;
  });
}
