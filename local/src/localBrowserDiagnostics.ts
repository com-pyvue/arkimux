import type { FrameworkErrorObserver } from "../../core/src/application/frameworkErrors.ts";
import { deserializeFrameworkError } from "./localFrameworkWorkerError.ts";

/** Accept bounded browser details for local inspection without classifying their source. */
export function createBrowserDiagnosticReceiver(report: FrameworkErrorObserver) {
  return async (value: unknown): Promise<boolean> => {
    const error = deserializeFrameworkError(value, { maxMessageLength: 4096, maxStackLength: 12000, maxBytes: 16 * 1024 });
    if (!error) return false;
    await report(error, "browser");
    return true;
  };
}
