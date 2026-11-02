import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  gitCommand,
  type GitCommand,
} from "../../../agent-input/code/src/index.ts";
import { GitCodeSnapshotProvider } from "../../../agent-input/code/src/index.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "system-model-builder-v2-snapshot-"));
  directories.push(directory);
  return directory;
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false);
}

async function fixtureRepository(root: string): Promise<{ repositoryRoot: string; commit: string }> {
  const repositoryRoot = path.join(root, "repository");
  await fs.mkdir(repositoryRoot, { recursive: true });
  await gitCommand(["init"], repositoryRoot);
  await gitCommand(["config", "user.email", "snapshot-test@example.com"], repositoryRoot);
  await gitCommand(["config", "user.name", "Snapshot Test"], repositoryRoot);
  await fs.writeFile(path.join(repositoryRoot, "source.txt"), "committed\n", "utf8");
  await gitCommand(["add", "source.txt"], repositoryRoot);
  await gitCommand(["commit", "-m", "fixture"], repositoryRoot);
  const commit = await gitCommand(["rev-parse", "HEAD"], repositoryRoot);
  return { repositoryRoot, commit };
}

function archiveFallbackGit(): GitCommand {
  return async (args, cwd, options) => {
    if (args[0] === "worktree" && args[1] === "add") {
      throw new Error("worktree preparation unavailable in fixture");
    }
    return gitCommand(args, cwd, options);
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("GitCodeSnapshotProvider", () => {
  it("prepares the requested commit rather than dirty working-tree content and disposes it", async () => {
    const root = await temporaryDirectory();
    const { repositoryRoot, commit } = await fixtureRepository(root);
    const outputRoot = path.join(root, "output");
    await fs.writeFile(path.join(repositoryRoot, "source.txt"), "dirty\n", "utf8");

    const snapshot = await new GitCodeSnapshotProvider().prepare({
      repositoryRoot,
      ref: "HEAD",
      outputRoot,
      executionId: "run-one",
      keepSnapshot: false,
    });

    expect(snapshot.commit.hash).toBe(commit);
    expect(snapshot.root).toBe(path.join(outputRoot, snapshot.commit.shortHash, "run-one", "commit-tree"));
    await expect(fs.readFile(path.join(snapshot.root, "source.txt"), "utf8")).resolves.toBe("committed\n");
    expect(await exists(snapshot.root)).toBe(true);

    await snapshot.dispose();

    expect(await exists(snapshot.root)).toBe(false);
  });

  it("falls back to an archive snapshot when detached worktree preparation fails", async () => {
    const root = await temporaryDirectory();
    const { repositoryRoot } = await fixtureRepository(root);
    const outputRoot = path.join(root, "output");
    const snapshot = await new GitCodeSnapshotProvider(archiveFallbackGit()).prepare({
      repositoryRoot,
      ref: "HEAD",
      outputRoot,
      executionId: "run-two",
      keepSnapshot: false,
    });

    await expect(fs.readFile(path.join(snapshot.root, "source.txt"), "utf8")).resolves.toBe("committed\n");
    expect(await exists(path.join(path.dirname(snapshot.root), "commit-tree.tar"))).toBe(false);

    await snapshot.dispose();

    expect(await exists(snapshot.root)).toBe(false);
  });

  it("retains a snapshot when retention is requested", async () => {
    const root = await temporaryDirectory();
    const { repositoryRoot } = await fixtureRepository(root);
    const snapshot = await new GitCodeSnapshotProvider(archiveFallbackGit()).prepare({
      repositoryRoot,
      ref: "HEAD",
      outputRoot: path.join(root, "output"),
      executionId: "retained-run",
      keepSnapshot: true,
    });

    await snapshot.dispose();

    expect(await exists(snapshot.root)).toBe(true);
  });

  it("refuses to reuse an existing run directory", async () => {
    const root = await temporaryDirectory();
    const { repositoryRoot } = await fixtureRepository(root);
    const request = {
      repositoryRoot,
      ref: "HEAD",
      outputRoot: path.join(root, "output"),
      executionId: "duplicate-run",
      keepSnapshot: false,
    };
    const snapshot = await new GitCodeSnapshotProvider(archiveFallbackGit()).prepare(request);

    await expect(new GitCodeSnapshotProvider(archiveFallbackGit()).prepare(request))
      .rejects.toThrow("Code snapshot run directory already exists");

    await snapshot.dispose();
  });
});
