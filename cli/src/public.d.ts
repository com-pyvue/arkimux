export interface ArkiMuxCliResult {
  kind: "create" | "local-start" | "local-debug" | "local-stop" | "local-migrate" | "project-validate" | "debug-stdio" | "help";
  message: string;
  exitCode?: number;
  projectRoot?: string;
  url?: string;
}

export interface ArkiMuxCliDependencies {
  environment?: NodeJS.ProcessEnv;
  now?: () => Date;
  nodeVersion?: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export function arkimuxCliUsage(): string;
export function validateArkiMuxProjectSource(projectRoot: string, options?: { includeRenderers?: boolean }): Promise<void>;
export function createProjectResultViewSource(projectRoot: string): Promise<{
  snapshot(): { revision: number; status: "ready" | "unavailable" | "error"; views: readonly {
    resultKind: string; payloadSchemaVersion: number; render(payload: unknown): string | Promise<string>;
  }[] };
  close(): Promise<void>;
}>;
export type ProjectSourceInventory = Readonly<Record<string, string>>;
export function guardProjectSourceEdits(before: ProjectSourceInventory | undefined, after: ProjectSourceInventory,
  options?: { allowDependencyChanges?: boolean }): { status: "passed" | "failed" | "boundary-not-verified"; changed: string[]; forbidden: string[] };
export function runArkiMuxCli(
  args?: string[],
  cwd?: string,
  dependencies?: ArkiMuxCliDependencies,
  moduleUrl?: string,
): Promise<ArkiMuxCliResult>;
