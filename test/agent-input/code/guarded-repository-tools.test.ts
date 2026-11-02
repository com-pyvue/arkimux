import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGuardedRepositoryHandlers,
  DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS,
  GUARDED_REPOSITORY_TOOL_GUIDANCE,
  prepareGuardedRepositoryExtension,
  renderGuardedRepositoryExtension,
  type GuardedRepositoryToolLimits,
} from "../../../agent-input/code/src/index.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "system-model-builder-v2-guarded-tools-"));
  directories.push(directory);
  return directory;
}

function testLimits(overrides: Partial<GuardedRepositoryToolLimits> = {}): GuardedRepositoryToolLimits {
  return {
    ...DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS,
    defaultPageSize: 1,
    maxPageSize: 2,
    defaultReadLines: 2,
    maxReadLines: 3,
    maxBatchPaths: 3,
    maxBatchFileBytes: 1_024,
    maxFileBytes: 2_048,
    maxSearchFileBytes: 2_048,
    maxSearchFiles: 100,
    maxSearchBytesPerPage: 4_096,
    maxResultBytes: 4_096,
    maxSearchLineBytes: 256,
    maxQueryLength: 40,
    ...overrides,
  };
}

async function fixture(): Promise<{ root: string; auditPath: string; outsidePath: string }> {
  const directory = await temporaryDirectory();
  const root = path.join(directory, "snapshot");
  const outsidePath = path.join(directory, "outside.ts");
  const auditPath = path.join(directory, "repository-tools.jsonl");
  await fs.mkdir(path.join(root, "infra"), { recursive: true });
  await fs.writeFile(path.join(root, "infra", "a.ts"), [
    "export class FirstStack {}",
    "const ordinary = true",
    "export class NestedStack {}",
    "",
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(root, "infra", "b.ts"), "export class OtherStack {}\n", "utf8");
  await fs.writeFile(path.join(root, "README.md"), "fixture\n", "utf8");
  await fs.writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
  await fs.writeFile(path.join(root, "large.ts"), "x".repeat(3_000), "utf8");
  await fs.writeFile(outsidePath, "outside secret\n", "utf8");
  await fs.symlink(outsidePath, path.join(root, "escape.ts"));
  await fs.writeFile(auditPath, "", "utf8");
  return { root, auditPath, outsidePath };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("guarded repository tools", () => {
  it("keeps missing-file errors relative and masks unexpected filesystem details", async () => {
    const { root, auditPath } = await fixture();
    const handlers = createGuardedRepositoryHandlers({ snapshotRoot: root, auditPath, filesystem: fs, pathApi: path, limits: testLimits() });
    await expect(handlers.repo_read({ path: "missing.ts" })).rejects.toThrow("Repository path missing.ts does not exist.");
    expect(await fs.readFile(auditPath, "utf8")).not.toContain(root);
    const broken = createGuardedRepositoryHandlers({ snapshotRoot: root, auditPath, pathApi: path, limits: testLimits(), filesystem: {
      ...fs, stat: async () => { throw new Error(`private filesystem failure ${root}`); },
    } });
    await expect(broken.repo_read({ path: "README.md" })).rejects.toThrow("The repository operation could not be completed. Try again or check the project files.");
    expect(await fs.readFile(auditPath, "utf8")).not.toContain("private filesystem failure");
    const noAudit = createGuardedRepositoryHandlers({ snapshotRoot: root, auditPath, pathApi: path, limits: testLimits(), filesystem: {
      ...fs, appendFile: async () => { throw new Error(`private audit failure ${auditPath}`); },
    } });
    await expect(noAudit.repo_read({ path: "README.md" })).rejects.toThrow("The repository operation could not be recorded. Check local storage and try again.");
  });
  it("paginates deterministic listings, searches, reads, and batch reads", async () => {
    const { root, auditPath } = await fixture();
    const handlers = createGuardedRepositoryHandlers({
      snapshotRoot: root,
      auditPath,
      filesystem: fs,
      pathApi: path,
      limits: testLimits(),
    });

    const firstList = await handlers.repo_list({ path: "infra", limit: 1 }) as {
      entries: Array<{ path: string }>;
      nextCursor: string;
    };
    expect(firstList.entries).toEqual([{ path: "infra/a.ts", kind: "file" }]);
    const secondList = await handlers.repo_list({ path: "infra", limit: 1, cursor: firstList.nextCursor }) as {
      entries: Array<{ path: string }>;
      nextCursor?: string;
    };
    expect(secondList.entries).toEqual([{ path: "infra/b.ts", kind: "file" }]);
    expect(secondList).not.toHaveProperty("nextCursor");

    const firstRead = await handlers.repo_read({ path: "infra/a.ts", maxLines: 2 }) as {
      content: string;
      nextStartLine: number;
    };
    expect(firstRead.content).toContain("1: export class FirstStack");
    expect(firstRead.nextStartLine).toBe(3);
    const secondRead = await handlers.repo_read({
      path: "infra/a.ts",
      startLine: firstRead.nextStartLine,
      maxLines: 2,
    }) as { content: string };
    expect(secondRead.content).toContain("3: export class NestedStack");

    const firstSearch = await handlers.repo_search({ query: "Stack", path: "infra", limit: 1 }) as {
      matches: Array<{ path: string; line: number }>;
      nextCursor: string;
    };
    expect(firstSearch.matches).toEqual([{ path: "infra/a.ts", line: 1, text: "export class FirstStack {}" }]);
    const secondSearch = await handlers.repo_search({
      query: "Stack",
      path: "infra",
      limit: 1,
      cursor: firstSearch.nextCursor,
    }) as { matches: Array<{ path: string; line: number }> };
    expect(secondSearch.matches).toEqual([{ path: "infra/a.ts", line: 3, text: "export class NestedStack {}" }]);

    const firstBatch = await handlers.repo_batch_read({
      paths: ["infra/a.ts", "infra/b.ts"],
      maxLinesPerFile: 1,
      limit: 1,
    }) as { results: Array<{ path: string }>; nextCursor: string };
    expect(firstBatch.results[0]?.path).toBe("infra/a.ts");
    const secondBatch = await handlers.repo_batch_read({
      paths: ["infra/a.ts", "infra/b.ts"],
      maxLinesPerFile: 1,
      limit: 1,
      cursor: firstBatch.nextCursor,
    }) as { results: Array<{ path: string }>; nextCursor?: string };
    expect(secondBatch.results[0]?.path).toBe("infra/b.ts");
    expect(secondBatch).not.toHaveProperty("nextCursor");

    const audit = (await fs.readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(audit).toHaveLength(8);
    expect(audit.every((entry) => entry.status === "complete")).toBe(true);
    expect(audit.map((entry) => entry.tool)).toEqual([
      "repo_list",
      "repo_list",
      "repo_read",
      "repo_read",
      "repo_search",
      "repo_search",
      "repo_batch_read",
      "repo_batch_read",
    ]);
  });

  it("rejects absolute paths, traversal, symlink escapes, binary files, and oversized reads", async () => {
    const { root, auditPath, outsidePath } = await fixture();
    const handlers = createGuardedRepositoryHandlers({
      snapshotRoot: root,
      auditPath,
      filesystem: fs,
      pathApi: path,
      limits: testLimits(),
    });

    await expect(handlers.repo_read({ path: outsidePath })).rejects.toThrow("must be relative");
    await expect(handlers.repo_read({ path: "../outside.ts" })).rejects.toThrow("parent traversal");
    await expect(handlers.repo_read({ path: "escape.ts" })).rejects.toThrow("symlink outside");
    await expect(handlers.repo_read({ path: "binary.bin" })).rejects.toThrow("binary");
    await expect(handlers.repo_read({ path: "large.ts" })).rejects.toThrow("read limit");
    await expect(handlers.repo_batch_read({ paths: ["infra/a.ts", "../outside.ts"] })).rejects.toThrow("parent traversal");

    const audit = (await fs.readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(audit).toHaveLength(6);
    expect(audit.every((entry) => entry.status === "rejected")).toBe(true);
    expect(audit.every((entry) => typeof entry.rejectionReason === "string")).toBe(true);
    expect(audit.at(-1)?.requestedPaths).toEqual(["infra/a.ts", "../outside.ts"]);
  });

  it("binds cursors to one request and emits a loadable ephemeral extension", async () => {
    const { root, auditPath } = await fixture();
    const handlers = createGuardedRepositoryHandlers({
      snapshotRoot: root,
      auditPath,
      filesystem: fs,
      pathApi: path,
      limits: testLimits(),
    });
    const first = await handlers.repo_search({ query: "Stack", path: "infra", limit: 1 }) as {
      nextCursor: string;
    };
    await expect(handlers.repo_search({
      query: "ordinary",
      path: "infra",
      cursor: first.nextCursor,
    })).rejects.toThrow("belongs to a different request");

    const source = renderGuardedRepositoryExtension();
    await expect(transform(source, { loader: "ts", format: "esm" })).resolves.toEqual(expect.objectContaining({
      code: expect.stringContaining("repo_batch_read"),
    }));
    expect(source).toContain('name: "repo_list"');
    expect(source).toContain('name: "repo_search"');
    expect(source).toContain('name: "repo_read"');
    expect(source).toContain('name: "repo_batch_read"');
    expect(source).toContain(JSON.stringify(GUARDED_REPOSITORY_TOOL_GUIDANCE.search));
    expect(source).toContain(JSON.stringify(GUARDED_REPOSITORY_TOOL_GUIDANCE.read));
    expect(source).toContain(JSON.stringify(GUARDED_REPOSITORY_TOOL_GUIDANCE.batchRead));
    expect(source).toContain("The path must be a directory");
    expect(source).toContain("Prefer this tool when the exact file path is already known");

    const bundled = await build({
      entryPoints: [path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../../agent-input/code/src/infrastructure/repository/guardedRepositoryTools.ts",
      )],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      write: false,
    });
    const bundledModule = await import(`data:text/javascript;base64,${Buffer.from(
      bundled.outputFiles[0]?.text ?? "",
      "utf8",
    ).toString("base64")}`) as { renderGuardedRepositoryExtension(): string };
    const bundledSource = bundledModule.renderGuardedRepositoryExtension();
    await expect(transform(bundledSource, { loader: "ts", format: "esm" })).resolves.toEqual(
      expect.objectContaining({ code: expect.stringContaining("repo_batch_read") }),
    );

    const extensionDirectory = await temporaryDirectory();
    const extensionPath = await prepareGuardedRepositoryExtension(extensionDirectory);
    await expect(fs.readFile(extensionPath, "utf8")).resolves.toBe(source);
    const mode = (await fs.stat(extensionPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
