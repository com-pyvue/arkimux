import path from "node:path";

export type ProjectSourceInventory = Readonly<Record<string, string>>;
/** Compares explicit before/after evidence; a missing baseline can never pass. */
export function guardProjectSourceEdits(before: ProjectSourceInventory | undefined, after: ProjectSourceInventory,
  options: { allowDependencyChanges?: boolean } = {}): { status: "passed" | "failed" | "boundary-not-verified"; changed: string[]; forbidden: string[] } {
  if (!before) return { status: "boundary-not-verified", changed: [], forbidden: [] };
  for (const inventory of [before, after]) for (const [file, digest] of Object.entries(inventory)) {
    if (!file || path.posix.isAbsolute(file) || path.posix.normalize(file) !== file || file.includes("\\")
      || file.startsWith("../") || file === ".." || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid source inventory path or SHA-256.");
  }
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(f => before[f] !== after[f]).sort();
  const forbidden = changed.filter(f => !(f.startsWith("workflows/") || ["src/arkimux.workflows.ts", "src/arkimux.renderers.tsx"].includes(f)
    || (options.allowDependencyChanges && ["package.json", "package-lock.json"].includes(f))));
  if (options.allowDependencyChanges && changed.includes("package.json") !== changed.includes("package-lock.json")) {
    forbidden.push("package.json and package-lock.json must change together");
  }
  return { status: forbidden.length ? "failed" : "passed", changed, forbidden };
}
