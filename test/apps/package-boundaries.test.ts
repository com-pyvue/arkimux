import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appsRoot = path.join(repositoryRoot, "apps", "packages");
const webHostRoot = path.join(repositoryRoot, "apps", "hosts", "web", "src");

describe("agent-execution application package boundaries", () => {
  it("keeps React packages independent of API implementations", async () => {
    const violations = await forbiddenImports(
      await sourceFiles(appsRoot, (file) => file.includes(`${path.sep}react${path.sep}`)),
      [/\/api(?:\/|$)/, /-api(?:\/|$)/],
    );
    expect(violations).toEqual([]);
  });

  it("keeps every browser package independent of storage and Node infrastructure", async () => {
    const browserFiles = [
      ...await sourceFiles(appsRoot, (file) => file.includes(`${path.sep}react${path.sep}`)),
      ...await sourceFiles(webHostRoot, () => true),
    ];
    const violations = await forbiddenImports(browserFiles, [
      /^node:/,
      /^hono(?:\/|$)/,
      /agent-execution\/src/,
      /\/infrastructure(?:\/|$)/,
      /-api(?:\/|$)/,
      /\/packages\/[^/]+\/api(?:\/|$)/,
    ]);
    expect(violations).toEqual([]);
  });

  it("keeps transport contracts independent of Hono, React, and application implementations", async () => {
    const violations = await forbiddenImports(
      await sourceFiles(appsRoot, (file) => file.includes(`${path.sep}contract${path.sep}`)),
      [/^hono(?:\/|$)/, /^react(?:\/|$)/, /\/api(?:\/|$)/, /\/react(?:\/|$)/],
    );
    expect(violations).toEqual([]);
  });
});

async function sourceFiles(root: string, include: (file: string) => boolean): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(location);
      else if (/\.tsx?$/.test(entry.name) && include(location)) result.push(location);
    }
  }
  await visit(root);
  return result.sort();
}

async function forbiddenImports(files: string[], patterns: RegExp[]): Promise<string[]> {
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
      const specifier = match[2];
      if (patterns.some((pattern) => pattern.test(specifier))) {
        violations.push(`${path.relative(repositoryRoot, file)} -> ${specifier}`);
      }
    }
  }
  return violations;
}
