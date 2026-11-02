import path from "node:path";
import { fileURLToPath } from "node:url";

export interface LocalFilesystemRuntimePaths {
  repositoryRoot: string;
  applicationConfigurationRoot: string;
  platformConfigurationDirectory: string;
  platformStoreConfigurationRoot: string;
  applicationConfigurationId?: string;
  subjectId: string;
}

export function parseLocalFilesystemRuntimePaths(
  args: string[],
  cwd: string,
  moduleUrl: string,
  environment: NodeJS.ProcessEnv,
): LocalFilesystemRuntimePaths {
  const appsRoot = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../../..");
  const subjectId = value(args, "--subject-id") ?? environment.AGENT_EXECUTION_LOCAL_SUBJECT;
  if (!subjectId) {
    throw new Error("--subject-id or AGENT_EXECUTION_LOCAL_SUBJECT is required.");
  }
  return {
    repositoryRoot: path.resolve(cwd, value(args, "--repository-root") ?? "."),
    applicationConfigurationRoot: path.resolve(
      cwd,
      value(args, "--application-configuration-root")
        ?? path.join(appsRoot, "config", "application-hosts"),
    ),
    platformConfigurationDirectory: path.resolve(
      cwd,
      value(args, "--platform-configuration-directory")
        ?? path.join(appsRoot, "config", "platform-configurations"),
    ),
    platformStoreConfigurationRoot: path.resolve(
      cwd,
      value(args, "--platform-store-configuration-root") ?? appsRoot,
    ),
    ...(value(args, "--application-configuration-id") === undefined
      ? {}
      : { applicationConfigurationId: value(args, "--application-configuration-id") }),
    subjectId,
  };
}

export function value(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const candidate = args[index + 1];
  if (!candidate || candidate.startsWith("--")) throw new Error(`${name} requires a value.`);
  return candidate;
}

export function values(args: string[], name: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const candidate = args[index + 1];
    if (!candidate || candidate.startsWith("--")) throw new Error(`${name} requires a value.`);
    result.push(candidate);
  }
  return result;
}
