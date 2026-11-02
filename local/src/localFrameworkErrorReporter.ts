import { LocalFrameworkDiagnostics } from "./localFrameworkDiagnostics.ts";
import { isExcludedFrameworkError, type FrameworkErrorObserver } from "../../core/src/application/frameworkErrors.ts";

/** One reporter per Local process. Exact Error identity is deduplicated across
 * nested boundaries; distinct occurrences remain distinct. No recursive reports. */
export function createLocalFrameworkErrorReporter(options: {
  diagnostics: LocalFrameworkDiagnostics;
  version: string;
}) {
  const seen = new WeakSet<object>();
  let active = 0;
  const claim = (error: unknown): boolean => {
    const related = new Set<Error>();
    const leaves = new Set<Error>();
    const visit = (value: unknown) => {
      if (!(value instanceof Error) || related.has(value) || related.size >= 20) return;
      related.add(value);
      const children = [value.cause, ...(value instanceof AggregateError ? value.errors : [])].filter(child => child instanceof Error);
      if (!children.length) leaves.add(value);
      for (const child of children) visit(child);
    };
    visit(error);
    if ((error instanceof Error && seen.has(error)) || (leaves.size > 0 && [...leaves].every(value => seen.has(value)))) return false;
    for (const value of related) seen.add(value);
    return true;
  };
  const report: FrameworkErrorObserver = async (error, operation) => {
    try {
      if (isExcludedFrameworkError(error) || active >= 20 || !claim(error)) return;
      active++;
      try {
        await options.diagnostics.record({ arkimuxVersion: options.version,
          component: operation === "browser" ? "local-browser" : operation === "storage" ? "local-store" : operation === "registry" ? "workflow-registry" : operation === "telemetry" ? "telemetry" : "local-server",
          operation, error });
      } finally { active--; }
    } catch { /* A full disk, malformed Error must not change application behavior. */ }
  };
  const reportFatal = (error: unknown): void => {
    try {
      if (isExcludedFrameworkError(error) || !claim(error)) return;
      options.diagnostics.recordFatal({ arkimuxVersion: options.version, component: "local-server", operation: "process",
        error });
    } catch { /* Preserve Node's original fatal outcome even if storage failed. */ }
  };
  return { report, reportFatal };
}
