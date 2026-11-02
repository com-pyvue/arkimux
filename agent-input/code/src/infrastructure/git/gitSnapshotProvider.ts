import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type {
  CodeSnapshot,
  CodeSnapshotProvider,
  CodeSnapshotRequest,
} from "../../application/codeSnapshot.ts";
import { gitCommand, type GitCommand } from "./gitCommand.ts";

const execFileAsync = promisify(execFile);

type SnapshotCleanup = () => Promise<void>;

export class GitCodeSnapshotProvider implements CodeSnapshotProvider {
  constructor(private readonly git: GitCommand = gitCommand) {}

  async prepare(request: CodeSnapshotRequest): Promise<CodeSnapshot> {
    const repositoryRoot = path.resolve(request.repositoryRoot);
    const outputRoot = path.resolve(request.outputRoot);
    const hash = await this.git(["rev-parse", "--verify", `${request.ref}^{commit}`], repositoryRoot);
    const shortHash = await this.git(["rev-parse", "--short=9", hash], repositoryRoot);
    const commitOutputDir = path.join(outputRoot, shortHash);
    const outputDir = path.join(commitOutputDir, request.executionId);
    const root = path.join(outputDir, "commit-tree");

    await fs.mkdir(commitOutputDir, { recursive: true });
    try {
      await fs.mkdir(outputDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Code snapshot run directory already exists: ${outputDir}`);
      }
      throw error;
    }

    let cleanup: SnapshotCleanup;
    try {
      cleanup = await this.prepareSourceTree(repositoryRoot, hash, outputDir, root);
    } catch (error) {
      await fs.rm(outputDir, { recursive: true, force: true });
      throw error;
    }
    let disposed = false;

    return {
      root,
      commit: { hash, shortHash },
      dispose: async () => {
        if (disposed || request.keepSnapshot) return;
        await cleanup();
        disposed = true;
      },
    };
  }

  private async prepareSourceTree(
    repositoryRoot: string,
    commit: string,
    outputDir: string,
    root: string,
  ): Promise<SnapshotCleanup> {
    try {
      await this.git(["worktree", "add", "--detach", root, commit], repositoryRoot);
      return async () => {
        await this.git(["worktree", "remove", "--force", root], repositoryRoot).catch(() => undefined);
      };
    } catch {
      await fs.mkdir(root, { recursive: true });
      const archive = path.join(outputDir, "commit-tree.tar");
      try {
        await this.git(["archive", "--format=tar", `--output=${archive}`, commit], repositoryRoot);
        await execFileAsync("tar", ["-xf", archive, "-C", root], { cwd: repositoryRoot });
      } finally {
        await fs.rm(archive, { force: true });
      }
      return async () => {
        await fs.rm(root, { recursive: true, force: true });
      };
    }
  }
}
