import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommandOptions {
  allowFailure?: boolean;
  maxBuffer?: number;
}

export type GitCommand = (
  args: string[],
  cwd: string,
  options?: GitCommandOptions,
) => Promise<string>;

export const gitCommand: GitCommand = async (
  args,
  cwd,
  options = {},
) => {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    });
    return result.stdout.trimEnd();
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
};
