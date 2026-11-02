import type { ArkiMuxCliResult } from "@com-pyvue/arkimux";

export interface BootstrapDependencies {
  runCli?(args: string[], cwd: string): Promise<ArkiMuxCliResult>;
  stdout?(message: string): void;
  stderr?(message: string): void;
  nodeVersion?: string;
}

export function main(args?: string[], cwd?: string, dependencies?: BootstrapDependencies): Promise<number>;
