import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProjectSourceReader } from "../../cli/src/projectDeclarations.ts";
import { inspectProjectCss } from "../../cli/src/projectCssGuard.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(css: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "css-guard-")); roots.push(root);
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/view.css"), css);
  const check = () => inspectProjectCss(new ProjectSourceReader(root), "src/view.css", new Set());
  return { root, check };
}
it.each([
  '@import "./nested.css";', '@import url("./nested.css") screen;',
  '@import url( ./nested.css ) layer(theme);', '@value color from "./nested.css";',
  '.heading { composes: color from "./nested.css"; }', ':import("./nested.css") { color: value; }',
])("checks a nested CSS dependency: %s", async (css) => {
  const f = await fixture(css);
  await expect(f.check()).rejects.toThrow();
  await writeFile(path.join(f.root, "src/nested.css"), '.color { color: red; }');
  await expect(f.check()).resolves.toBeUndefined();
});
it.each([
  '@import "../private.css";', '@import url("../private.css");',
  '.heading { composes: color from "../private.css"; }',
  '@value color from "../private.css";', ':import("../private.css") { color: value; }',
  '@import "https://example.invalid/view.css";', '@import "./nested\\2e css";',
  '@import "./nested.css?inline";', '@import "/src/nested.css";',
  '@import "./%2e%2e/private.css";',
])("rejects an out-of-scope or ambiguous CSS dependency: %s", async (css) => {
  const f = await fixture(css);
  await writeFile(path.join(f.root, "private.css"), '.private { color: red; }');
  await expect(f.check()).rejects.toThrow();
});
it("checks transitive imports, cycles, size, and symlink boundaries", async () => {
  const f = await fixture('@import "./nested.css";');
  const nested = path.join(f.root, "src/nested.css");
  await writeFile(nested, '@import "./view.css";');
  await expect(f.check()).resolves.toBeUndefined();
  await writeFile(nested, '@import "../private.css";');
  await expect(f.check()).rejects.toThrow(/source must be under/);
  await writeFile(nested, ' '.repeat(1024 * 1024 + 1));
  await expect(f.check()).rejects.toThrow(/1 MiB/);
  await rm(nested);
  await writeFile(path.join(f.root, "private.css"), '.private { color: red; }');
  await symlink(path.join(f.root, "private.css"), nested);
  await expect(f.check()).rejects.toThrow(/resolved source leaves/);
});
it("keeps quoted relative paths with spaces and Unicode usable", async () => {
  const f = await fixture('@import "./theme café.css";');
  await writeFile(path.join(f.root, "src/theme café.css"), 'h1 { color: red; }');
  await expect(f.check()).resolves.toBeUndefined();
});
it("shares the existing 512-file source limit across CSS imports", async () => {
  const f = await fixture('@import "./0.css";');
  await Promise.all(Array.from({ length: 512 }, (_, i) => writeFile(path.join(f.root, `src/${i}.css`), i < 511 ? `@import "./${i + 1}.css";` : 'h1 { color: red; }')));
  await expect(f.check()).rejects.toThrow(/512-file/);
});
