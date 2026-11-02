import type { WorkflowRegistrySourceDiagnostic } from "../../local/src/workflowRegistryReload.ts";

// Only diagnostics created by source validators may cross into the Local UI.
// Do not infer this classification from an exception's message or properties.
const diagnostics = new WeakMap<object, Readonly<WorkflowRegistrySourceDiagnostic>>();

export class ProjectSourceError extends Error {
  constructor(value: Omit<WorkflowRegistrySourceDiagnostic, "kind">) {
    const diagnostic: WorkflowRegistrySourceDiagnostic = { kind: "source", code: value.code,
      message: value.message, file: value.file,
      ...(value.line === undefined ? {} : { line: value.line, column: value.column }) };
    const location = value.line === undefined ? value.file : `${value.file}:${value.line}:${value.column}`;
    super(`${location}: ${value.message}`);
    this.name = "ProjectSourceError";
    if (value.file.length <= 512 && /^(src|workflows)\//.test(value.file)
      && !/[\\\u0000-\u001f\u007f-\u009f]/.test(value.file)
      && value.file.split("/").every(part => part !== "" && part !== "." && part !== "..")
      && value.code.length > 0 && value.code.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(value.code)
      && value.message.length > 0 && value.message.length <= 1000 && !/[\u0000-\u001f\u007f-\u009f]/.test(value.message)
      && ((value.line === undefined && value.column === undefined)
        || (Number.isSafeInteger(value.line) && value.line! > 0 && Number.isSafeInteger(value.column) && value.column! > 0))) {
      diagnostics.set(this, Object.freeze(diagnostic));
    }
  }
}

export function projectSourceDiagnostic(error: unknown): WorkflowRegistrySourceDiagnostic | undefined {
  if (!error || typeof error !== "object") return;
  const diagnostic = diagnostics.get(error);
  return diagnostic ? { ...diagnostic } : undefined;
}
