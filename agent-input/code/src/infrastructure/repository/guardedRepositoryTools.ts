import { promises as fs } from "node:fs";
import path from "node:path";

export const GUARDED_REPOSITORY_TOOL_NAMES = [
  "repo_list",
  "repo_search",
  "repo_read",
  "repo_batch_read",
] as const;

export const GUARDED_REPOSITORY_TOOL_GUIDANCE = {
  search: [
    "Use repo_search only when the location of required literal evidence is unknown.",
    "repo_search.path must identify a directory, never a file. Use repo_read for one known file and repo_batch_read for several known files.",
    "Do not invoke repo_search merely to re-check a known file for facts already visible in a completed read.",
    "Follow nextCursor until absent when completeness matters.",
  ],
  read: [
    "Prefer repo_read whenever the exact repository-relative file path is known.",
    "Continue from nextStartLine only when the remaining file content is needed.",
  ],
  batchRead: [
    "Prefer repo_batch_read when several exact repository-relative file paths are known.",
    "Follow nextCursor until absent when every requested file matters.",
  ],
} as const;

export interface GuardedRepositoryToolLimits {
  defaultPageSize: number;
  maxPageSize: number;
  defaultReadLines: number;
  maxReadLines: number;
  maxBatchPaths: number;
  maxBatchFileBytes: number;
  maxFileBytes: number;
  maxSearchFileBytes: number;
  maxSearchFiles: number;
  maxSearchBytesPerPage: number;
  maxResultBytes: number;
  maxSearchLineBytes: number;
  maxQueryLength: number;
}

export const DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS: GuardedRepositoryToolLimits = {
  defaultPageSize: 100,
  maxPageSize: 200,
  defaultReadLines: 400,
  maxReadLines: 1_000,
  maxBatchPaths: 20,
  maxBatchFileBytes: 32 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
  maxSearchFileBytes: 2 * 1024 * 1024,
  maxSearchFiles: 20_000,
  maxSearchBytesPerPage: 25 * 1024 * 1024,
  maxResultBytes: 128 * 1024,
  maxSearchLineBytes: 4 * 1024,
  maxQueryLength: 500,
};

export interface GuardedRepositoryHandlerDependencies {
  snapshotRoot: string;
  auditPath: string;
  filesystem: typeof fs;
  pathApi: typeof path;
  limits: GuardedRepositoryToolLimits;
  now?: () => number;
}

export interface GuardedRepositoryHandlers {
  repo_list(input: unknown, signal?: AbortSignal): Promise<unknown>;
  repo_search(input: unknown, signal?: AbortSignal): Promise<unknown>;
  repo_read(input: unknown, signal?: AbortSignal): Promise<unknown>;
  repo_batch_read(input: unknown, signal?: AbortSignal): Promise<unknown>;
}

/**
 * This factory is deliberately self-contained. Its compiled source is embedded
 * into the ephemeral Pi extension, so unit tests and Pi execute the same path
 * validation, pagination, reading, searching, and audit implementation.
 */
export function createGuardedRepositoryHandlers(
  dependencies: GuardedRepositoryHandlerDependencies,
): GuardedRepositoryHandlers {
  // Only these authored request/limit messages may cross the tool boundary.
  class RepositoryRequestError extends Error {}
  const {
    snapshotRoot,
    auditPath,
    filesystem,
    pathApi,
    limits,
    now = () => Date.now(),
  } = dependencies;
  const rootPromise = filesystem.realpath(snapshotRoot);

  function record(value: unknown, location: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new RepositoryRequestError(`${location} must be an object.`);
    }
    return value as Record<string, unknown>;
  }

  function onlyKeys(value: Record<string, unknown>, allowed: string[], location: string): void {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw new RepositoryRequestError(`${location} contains unsupported fields [${unknown.join(", ")}].`);
  }

  function optionalString(value: unknown, location: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new RepositoryRequestError(`${location} must be a string.`);
    return value;
  }

  function requiredString(value: unknown, location: string): string {
    const parsed = optionalString(value, location);
    if (parsed === undefined || parsed.length === 0) throw new RepositoryRequestError(`${location} must be a non-empty string.`);
    return parsed;
  }

  function optionalBoolean(value: unknown, location: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") throw new RepositoryRequestError(`${location} must be a boolean.`);
    return value;
  }

  function optionalInteger(
    value: unknown,
    location: string,
    minimum: number,
    maximum: number,
  ): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
      throw new RepositoryRequestError(`${location} must be an integer from ${minimum} through ${maximum}.`);
    }
    return value;
  }

  function requestedPaths(toolName: string, input: unknown): string[] {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return [];
    const value = input as Record<string, unknown>;
    if (toolName === "repo_batch_read" && Array.isArray(value.paths)) {
      return value.paths.filter((item): item is string => typeof item === "string").slice(0, limits.maxBatchPaths);
    }
    return typeof value.path === "string" ? [value.path] : [];
  }

  function byteLength(value: string): number {
    return Buffer.byteLength(value, "utf8");
  }

  function encodeCursor(operation: string, key: string, state: Record<string, number>): string {
    return Buffer.from(JSON.stringify({ operation, key, state }), "utf8").toString("base64url");
  }

  function decodeCursor(
    cursor: string | undefined,
    operation: string,
    key: string,
  ): Record<string, number> {
    if (cursor === undefined) return {};
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
        operation?: unknown;
        key?: unknown;
        state?: unknown;
      };
      if (parsed.operation !== operation || parsed.key !== key || typeof parsed.state !== "object" || parsed.state === null) {
        throw new RepositoryRequestError("mismatch");
      }
      const state = parsed.state as Record<string, unknown>;
      if (Object.values(state).some((value) => typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
        throw new RepositoryRequestError("invalid state");
      }
      return state as Record<string, number>;
    } catch {
      throw new RepositoryRequestError(`${operation}.cursor is invalid or belongs to a different request.`);
    }
  }

  function isInside(root: string, target: string): boolean {
    const relative = pathApi.relative(root, target);
    return relative === "" || (!relative.startsWith(`..${pathApi.sep}`) && relative !== ".." && !pathApi.isAbsolute(relative));
  }

  async function resolveRepositoryPath(
    repositoryPath: string | undefined,
    expected: "file" | "directory" | "either",
  ): Promise<{ absolutePath: string; relativePath: string }> {
    const rawPath = repositoryPath ?? "";
    if (rawPath.includes("\0")) throw new RepositoryRequestError("Repository paths must not contain null bytes.");
    if (pathApi.isAbsolute(rawPath) || pathApi.win32.isAbsolute(rawPath)) {
      throw new RepositoryRequestError(`Repository path ${rawPath} must be relative to the immutable snapshot.`);
    }
    if (rawPath.split(/[\\/]+/).includes("..")) {
      throw new RepositoryRequestError(`Repository path ${rawPath} must not contain parent traversal.`);
    }
    const root = await rootPromise;
    const lexicalTarget = pathApi.resolve(root, rawPath || ".");
    if (!isInside(root, lexicalTarget)) {
      throw new RepositoryRequestError(`Repository path ${rawPath} escapes the immutable snapshot.`);
    }
    let absolutePath: string;
    try {
      absolutePath = await filesystem.realpath(lexicalTarget);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new RepositoryRequestError(`Repository path ${rawPath || "."} does not exist.`);
      throw error;
    }
    if (!isInside(root, absolutePath)) {
      throw new RepositoryRequestError(`Repository path ${rawPath} resolves through a symlink outside the immutable snapshot.`);
    }
    const stat = await filesystem.stat(absolutePath);
    if (expected === "file" && !stat.isFile()) throw new RepositoryRequestError(`Repository path ${rawPath} is not a file.`);
    if (expected === "directory" && !stat.isDirectory()) throw new RepositoryRequestError(`Repository path ${rawPath || "."} is not a directory.`);
    return {
      absolutePath,
      relativePath: pathApi.relative(root, absolutePath).split(pathApi.sep).join("/"),
    };
  }

  function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new RepositoryRequestError("Repository operation was aborted.");
  }

  async function readUtf8File(absolutePath: string, maximumBytes: number): Promise<string> {
    const stat = await filesystem.stat(absolutePath);
    if (stat.size > maximumBytes) {
      throw new RepositoryRequestError(`Repository file exceeds the ${maximumBytes}-byte read limit.`);
    }
    const content = await filesystem.readFile(absolutePath);
    if (content.subarray(0, Math.min(content.length, 8_192)).includes(0)) {
      throw new RepositoryRequestError("Repository file is binary and cannot be read as source text.");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new RepositoryRequestError("Repository file is not valid UTF-8 source text.");
    }
  }

  async function readPage(
    repositoryPath: string,
    startLine: number,
    maxLines: number,
    maximumResultBytes: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    throwIfAborted(signal);
    const resolved = await resolveRepositoryPath(repositoryPath, "file");
    const content = await readUtf8File(resolved.absolutePath, limits.maxFileBytes);
    const lines = content.split(/\r?\n/);
    const startIndex = startLine - 1;
    if (startIndex > lines.length) {
      throw new RepositoryRequestError(`repo_read.startLine ${startLine} is beyond the file's ${lines.length} lines.`);
    }
    const selected: string[] = [];
    let resultBytes = 0;
    let index = startIndex;
    while (index < lines.length && selected.length < maxLines) {
      throwIfAborted(signal);
      const rendered = `${index + 1}: ${lines[index] ?? ""}`;
      const renderedBytes = byteLength(`${rendered}\n`);
      if (renderedBytes > maximumResultBytes && selected.length === 0) {
        throw new RepositoryRequestError(`Repository line ${index + 1} exceeds the ${maximumResultBytes}-byte result limit.`);
      }
      if (resultBytes + renderedBytes > maximumResultBytes) break;
      selected.push(rendered);
      resultBytes += renderedBytes;
      index += 1;
    }
    return {
      path: resolved.relativePath,
      startLine,
      endLine: selected.length === 0 ? startLine - 1 : startLine + selected.length - 1,
      totalLines: lines.length,
      content: selected.join("\n"),
      ...(index < lines.length ? { nextStartLine: index + 1 } : {}),
    };
  }

  async function listFiles(directory: string, signal?: AbortSignal): Promise<string[]> {
    const root = await rootPromise;
    const files: string[] = [];
    async function visit(current: string): Promise<void> {
      throwIfAborted(signal);
      const entries = await filesystem.readdir(current, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        throwIfAborted(signal);
        const child = pathApi.join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await visit(child);
        } else if (entry.isFile()) {
          files.push(pathApi.relative(root, child).split(pathApi.sep).join("/"));
          if (files.length > limits.maxSearchFiles) {
            throw new RepositoryRequestError(`Repository search scope exceeds the ${limits.maxSearchFiles}-file limit.`);
          }
        }
      }
    }
    await visit(directory);
    return files;
  }

  async function repoList(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const value = record(input, "repo_list");
    onlyKeys(value, ["path", "cursor", "limit"], "repo_list");
    const repositoryPath = optionalString(value.path, "repo_list.path") ?? "";
    const cursor = optionalString(value.cursor, "repo_list.cursor");
    const limit = optionalInteger(value.limit, "repo_list.limit", 1, limits.maxPageSize) ?? limits.defaultPageSize;
    const resolved = await resolveRepositoryPath(repositoryPath, "directory");
    const key = resolved.relativePath;
    const offset = decodeCursor(cursor, "repo_list", key).offset ?? 0;
    throwIfAborted(signal);
    const entries = await filesystem.readdir(resolved.absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const page = entries.slice(offset, offset + limit).map((entry) => ({
      path: [resolved.relativePath, entry.name].filter(Boolean).join("/"),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other",
    }));
    const nextOffset = offset + page.length;
    return {
      path: resolved.relativePath,
      entries: page,
      ...(nextOffset < entries.length ? { nextCursor: encodeCursor("repo_list", key, { offset: nextOffset }) } : {}),
    };
  }

  async function repoSearch(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const value = record(input, "repo_search");
    onlyKeys(value, ["query", "path", "caseSensitive", "cursor", "limit"], "repo_search");
    const query = requiredString(value.query, "repo_search.query");
    if (query.length > limits.maxQueryLength) {
      throw new RepositoryRequestError(`repo_search.query exceeds the ${limits.maxQueryLength}-character limit.`);
    }
    const repositoryPath = optionalString(value.path, "repo_search.path") ?? "";
    const caseSensitive = optionalBoolean(value.caseSensitive, "repo_search.caseSensitive") ?? false;
    const cursor = optionalString(value.cursor, "repo_search.cursor");
    const limit = optionalInteger(value.limit, "repo_search.limit", 1, limits.maxPageSize) ?? limits.defaultPageSize;
    const resolved = await resolveRepositoryPath(repositoryPath, "directory");
    const files = await listFiles(resolved.absolutePath, signal);
    const key = JSON.stringify({ path: resolved.relativePath, query, caseSensitive });
    const state = decodeCursor(cursor, "repo_search", key);
    let fileIndex = state.fileIndex ?? 0;
    let lineIndex = state.lineIndex ?? 0;
    let scannedBytes = 0;
    let scannedFiles = 0;
    let skippedLargeFiles = 0;
    const matches: Record<string, unknown>[] = [];
    const normalizedQuery = caseSensitive ? query : query.toLocaleLowerCase();

    while (fileIndex < files.length) {
      throwIfAborted(signal);
      const relativeFile = files[fileIndex] as string;
      const file = await resolveRepositoryPath(relativeFile, "file");
      const stat = await filesystem.stat(file.absolutePath);
      if (stat.size > limits.maxSearchFileBytes) {
        skippedLargeFiles += 1;
        fileIndex += 1;
        lineIndex = 0;
        continue;
      }
      if (scannedFiles > 0 && scannedBytes + stat.size > limits.maxSearchBytesPerPage) break;
      let content: string;
      try {
        content = await readUtf8File(file.absolutePath, limits.maxSearchFileBytes);
      } catch (error) {
        if ((error as Error).message.includes("binary") || (error as Error).message.includes("UTF-8")) {
          fileIndex += 1;
          lineIndex = 0;
          continue;
        }
        throw error;
      }
      scannedBytes += stat.size;
      scannedFiles += 1;
      const lines = content.split(/\r?\n/);
      while (lineIndex < lines.length) {
        throwIfAborted(signal);
        const line = lines[lineIndex] ?? "";
        const candidate = caseSensitive ? line : line.toLocaleLowerCase();
        if (candidate.includes(normalizedQuery)) {
          let renderedLine = line;
          let truncated = false;
          while (byteLength(renderedLine) > limits.maxSearchLineBytes) {
            renderedLine = renderedLine.slice(0, Math.max(0, Math.floor(renderedLine.length * 0.8)));
            truncated = true;
          }
          const match = {
            path: file.relativePath,
            line: lineIndex + 1,
            text: renderedLine,
            ...(truncated ? { truncated: true } : {}),
          };
          const projectedBytes = byteLength(JSON.stringify([...matches, match]));
          if (matches.length > 0 && projectedBytes > limits.maxResultBytes) {
            return {
              query,
              path: resolved.relativePath,
              matches,
              scannedFiles,
              scannedBytes,
              skippedLargeFiles,
              nextCursor: encodeCursor("repo_search", key, { fileIndex, lineIndex }),
            };
          }
          matches.push(match);
          if (matches.length >= limit) {
            const nextLineIndex = lineIndex + 1;
            const nextState = nextLineIndex < lines.length
              ? { fileIndex, lineIndex: nextLineIndex }
              : { fileIndex: fileIndex + 1, lineIndex: 0 };
            return {
              query,
              path: resolved.relativePath,
              matches,
              scannedFiles,
              scannedBytes,
              skippedLargeFiles,
              nextCursor: encodeCursor("repo_search", key, nextState),
            };
          }
        }
        lineIndex += 1;
      }
      fileIndex += 1;
      lineIndex = 0;
    }

    return {
      query,
      path: resolved.relativePath,
      matches,
      scannedFiles,
      scannedBytes,
      skippedLargeFiles,
      ...(fileIndex < files.length
        ? { nextCursor: encodeCursor("repo_search", key, { fileIndex, lineIndex }) }
        : {}),
    };
  }

  async function repoRead(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const value = record(input, "repo_read");
    onlyKeys(value, ["path", "startLine", "maxLines"], "repo_read");
    const repositoryPath = requiredString(value.path, "repo_read.path");
    const startLine = optionalInteger(value.startLine, "repo_read.startLine", 1, Number.MAX_SAFE_INTEGER) ?? 1;
    const maxLines = optionalInteger(value.maxLines, "repo_read.maxLines", 1, limits.maxReadLines)
      ?? limits.defaultReadLines;
    return readPage(
      repositoryPath,
      startLine,
      maxLines,
      Math.max(1_024, limits.maxResultBytes - 4_096),
      signal,
    );
  }

  async function repoBatchRead(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const value = record(input, "repo_batch_read");
    onlyKeys(value, ["paths", "startLine", "maxLinesPerFile", "cursor", "limit"], "repo_batch_read");
    if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.some((item) => typeof item !== "string")) {
      throw new RepositoryRequestError("repo_batch_read.paths must be a non-empty array of repository-relative strings.");
    }
    if (value.paths.length > limits.maxBatchPaths) {
      throw new RepositoryRequestError(`repo_batch_read.paths exceeds the ${limits.maxBatchPaths}-path limit.`);
    }
    const paths = value.paths as string[];
    const startLine = optionalInteger(value.startLine, "repo_batch_read.startLine", 1, Number.MAX_SAFE_INTEGER) ?? 1;
    const maxLines = optionalInteger(value.maxLinesPerFile, "repo_batch_read.maxLinesPerFile", 1, limits.maxReadLines)
      ?? Math.min(limits.defaultReadLines, 200);
    const cursor = optionalString(value.cursor, "repo_batch_read.cursor");
    const limit = optionalInteger(value.limit, "repo_batch_read.limit", 1, limits.maxBatchPaths)
      ?? Math.min(paths.length, 10);
    const key = JSON.stringify({ paths, startLine, maxLines });
    const offset = decodeCursor(cursor, "repo_batch_read", key).offset ?? 0;
    const results: Record<string, unknown>[] = [];
    const perFileResultBytes = Math.min(
      limits.maxBatchFileBytes,
      Math.max(1_024, Math.floor(limits.maxResultBytes / limit) - 1_024),
    );
    let index = offset;
    while (index < paths.length && results.length < limit) {
      throwIfAborted(signal);
      const repositoryPath = paths[index] as string;
      results.push(await readPage(repositoryPath, startLine, maxLines, perFileResultBytes, signal));
      index += 1;
    }
    return {
      results,
      ...(index < paths.length ? { nextCursor: encodeCursor("repo_batch_read", key, { offset: index }) } : {}),
    };
  }

  async function audited(
    toolName: string,
    input: unknown,
    signal: AbortSignal | undefined,
    operation: (value: unknown, operationSignal?: AbortSignal) => Promise<unknown>,
  ): Promise<unknown> {
    const startedAt = now();
    try {
      const result = await operation(input, signal);
      const resultBytes = byteLength(JSON.stringify(result));
      if (resultBytes > limits.maxResultBytes) {
        throw new RepositoryRequestError(`${toolName} result exceeds the ${limits.maxResultBytes}-byte result limit.`);
      }
      await filesystem.appendFile(auditPath, `${JSON.stringify({
        at: new Date(startedAt).toISOString(),
        tool: toolName,
        requestedPaths: requestedPaths(toolName, input),
        status: "complete",
        resultBytes,
        elapsedMs: Math.max(0, now() - startedAt),
      })}\n`, "utf8");
      return result;
    } catch (error) {
      const message = error instanceof RepositoryRequestError ? error.message : "The repository operation could not be completed. Try again or check the project files.";
      await filesystem.appendFile(auditPath, `${JSON.stringify({
        at: new Date(startedAt).toISOString(),
        tool: toolName,
        requestedPaths: requestedPaths(toolName, input),
        status: "rejected",
        rejectionReason: message,
        resultBytes: 0,
        elapsedMs: Math.max(0, now() - startedAt),
      })}\n`, "utf8").catch(() => { throw new RepositoryRequestError("The repository operation could not be recorded. Check local storage and try again."); });
      throw new RepositoryRequestError(message);
    }
  }

  return {
    repo_list: (input, signal) => audited("repo_list", input, signal, repoList),
    repo_search: (input, signal) => audited("repo_search", input, signal, repoSearch),
    repo_read: (input, signal) => audited("repo_read", input, signal, repoRead),
    repo_batch_read: (input, signal) => audited("repo_batch_read", input, signal, repoBatchRead),
  };
}

export function renderGuardedRepositoryExtension(): string {
  const factorySource = createGuardedRepositoryHandlers.toString();
  return `import { Type } from "@earendil-works/pi-ai";
import { promises as filesystem } from "node:fs";
import pathApi from "node:path";

const createGuardedRepositoryHandlers = ${factorySource};
const snapshotRoot = process.env.CODE_CAPABILITIES_SNAPSHOT_ROOT;
const auditPath = process.env.CODE_CAPABILITIES_REPOSITORY_TOOL_AUDIT;
if (!snapshotRoot || !auditPath) throw new Error("Guarded repository extension requires runner-owned snapshot and audit paths.");
const handlers = createGuardedRepositoryHandlers({
  snapshotRoot,
  auditPath,
  filesystem,
  pathApi,
  limits: ${JSON.stringify(DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS)},
});

const result = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: {} });

export default function guardedRepositoryExtension(pi) {
  pi.registerTool({
    name: "repo_list",
    label: "Repository List",
    description: "List one immutable-snapshot directory. Results are sorted and paginated with nextCursor.",
    promptSnippet: "List entries in one immutable repository directory",
    promptGuidelines: ["Use repo_list to navigate the immutable repository snapshot. Follow nextCursor until absent when completeness matters."],
    parameters: Type.Object({
      path: Type.Optional(Type.String()),
      cursor: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: ${DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS.maxPageSize} })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) { return result(await handlers.repo_list(params, signal)); },
  });
  pi.registerTool({
    name: "repo_search",
    label: "Repository Search",
    description: "Search UTF-8 source lines for a literal string beneath one immutable-snapshot directory when the matching file is not yet known. The path must be a directory. Results are paginated with nextCursor.",
    promptSnippet: "Search immutable repository source text for a literal string",
    promptGuidelines: ${JSON.stringify(GUARDED_REPOSITORY_TOOL_GUIDANCE.search)},
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: ${DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS.maxQueryLength} }),
      path: Type.Optional(Type.String()),
      caseSensitive: Type.Optional(Type.Boolean()),
      cursor: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: ${DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS.maxPageSize} })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) { return result(await handlers.repo_search(params, signal)); },
  });
  pi.registerTool({
    name: "repo_read",
    label: "Repository Read",
    description: "Read numbered UTF-8 source lines from one known immutable-snapshot file. Prefer this tool when the exact file path is already known. Continue from nextStartLine when present.",
    promptSnippet: "Read a bounded line range from an immutable repository file",
    promptGuidelines: ${JSON.stringify(GUARDED_REPOSITORY_TOOL_GUIDANCE.read)},
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      maxLines: Type.Optional(Type.Integer({ minimum: 1, maximum: ${DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS.maxReadLines} })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) { return result(await handlers.repo_read(params, signal)); },
  });
  pi.registerTool({
    name: "repo_batch_read",
    label: "Repository Batch Read",
    description: "Read bounded numbered source ranges from several known immutable-snapshot files. Prefer this tool when the exact file paths are already known. File results are paginated with nextCursor.",
    promptSnippet: "Read bounded source ranges from several immutable repository files",
    promptGuidelines: ${JSON.stringify(GUARDED_REPOSITORY_TOOL_GUIDANCE.batchRead)},
    parameters: Type.Object({
      paths: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: ${DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS.maxBatchPaths} }),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      maxLinesPerFile: Type.Optional(Type.Integer({ minimum: 1, maximum: ${DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS.maxReadLines} })),
      cursor: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: ${DEFAULT_GUARDED_REPOSITORY_TOOL_LIMITS.maxBatchPaths} })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) { return result(await handlers.repo_batch_read(params, signal)); },
  });
}
`;
}

export async function prepareGuardedRepositoryExtension(directory: string): Promise<string> {
  const extensionPath = path.join(directory, "guarded-repository-extension.ts");
  await fs.writeFile(extensionPath, renderGuardedRepositoryExtension(), { encoding: "utf8", mode: 0o600 });
  return extensionPath;
}
