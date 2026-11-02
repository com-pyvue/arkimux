import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";

class WorkflowEnvironmentValidationError extends Error {
  constructor(message: string) { super(message); this.name = "WorkflowEnvironmentValidationError"; }
}

export interface WorkflowEnvironmentVariableDeclaration {
  name: string;
  required: boolean;
  secret: boolean;
  type: "string" | "url";
}

/** Declares runtime names and constraints, never runtime values or defaults. */
export interface WorkflowEnvironmentDeclaration {
  schemaVersion: 1;
  variables: readonly WorkflowEnvironmentVariableDeclaration[];
}

export type ResolvedWorkflowEnvironment = Readonly<Record<string, string>>;

export function validateWorkflowEnvironmentDeclaration(value: unknown): WorkflowEnvironmentDeclaration {
  const declaration = exactRecord(value, ["schemaVersion", "variables"], "Workflow environment declaration");
  if (declaration.schemaVersion !== 1) throw new WorkflowEnvironmentValidationError("Workflow environment declaration.schemaVersion must be 1.");
  if (!Array.isArray(declaration.variables)) throw new WorkflowEnvironmentValidationError("Workflow environment declaration.variables must be an array.");

  const names = new Set<string>();
  const variables = declaration.variables.map((value, index): WorkflowEnvironmentVariableDeclaration => {
    const location = `Workflow environment declaration.variables[${index}]`;
    const variable = exactRecord(value, ["name", "required", "secret", "type"], location);
    if (typeof variable.name !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(variable.name)) {
      throw new WorkflowEnvironmentValidationError(`${location}.name must be an uppercase environment-variable name.`);
    }
    if (names.has(variable.name)) throw new WorkflowEnvironmentValidationError(`${location}.name must be unique.`);
    names.add(variable.name);
    if (typeof variable.required !== "boolean") throw new WorkflowEnvironmentValidationError(`${location}.required must be a boolean.`);
    if (typeof variable.secret !== "boolean") throw new WorkflowEnvironmentValidationError(`${location}.secret must be a boolean.`);
    if (variable.type !== "string" && variable.type !== "url") throw new WorkflowEnvironmentValidationError(`${location}.type must be string or url.`);
    return { name: variable.name, required: variable.required, secret: variable.secret, type: variable.type };
  });
  return { schemaVersion: 1, variables };
}

/** Resolves a fresh snapshot from only the supplied map; never reads process.env. */
export function resolveWorkflowEnvironment(
  declaration: WorkflowEnvironmentDeclaration,
  values: Readonly<Record<string, string | undefined>>,
): ResolvedWorkflowEnvironment {
  return resolveValidatedEnvironment(validateWorkflowEnvironmentDeclaration(declaration), values);
}

/** Loads the project's Git-ignored .env without changing or falling back to process.env. */
export async function loadLocalWorkflowEnvironment(
  projectRoot: string,
  declaration: WorkflowEnvironmentDeclaration,
): Promise<ResolvedWorkflowEnvironment> {
  const validated = validateWorkflowEnvironmentDeclaration(declaration);
  let contents: string;
  try {
    contents = await readFile(path.resolve(projectRoot, ".env"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolveValidatedEnvironment(validated, {});
    // File-system errors may contain paths; do not retain the original error.
    throw new WorkflowEnvironmentValidationError("Could not read the project's .env file.");
  }
  let values: Record<string, string | undefined>;
  try {
    values = parseEnv(contents);
  } catch {
    throw new WorkflowEnvironmentValidationError("Could not parse the project's .env file.");
  }
  return resolveValidatedEnvironment(validated, values);
}

/** Loads only the explicitly pinned secret names for a host-owned effect adapter. */
export async function loadLocalWorkflowSecretValues(
  projectRoot: string,
  names: readonly string[],
): Promise<ResolvedWorkflowEnvironment> {
  if (new Set(names).size !== names.length || names.some(name => !/^[A-Z_][A-Z0-9_]*$/.test(name))) {
    throw new WorkflowEnvironmentValidationError("Effect secret names are invalid.");
  }
  let contents: string;
  try { contents = await readFile(path.resolve(projectRoot, ".env"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && names.length === 0) return Object.freeze({});
    throw new WorkflowEnvironmentValidationError("Could not read the project's effect secrets from .env.");
  }
  let values: Record<string, string | undefined>;
  try { values = parseEnv(contents); }
  catch { throw new WorkflowEnvironmentValidationError("Could not parse the project's .env file."); }
  const selected: Record<string, string> = {};
  for (const name of names) {
    const value = values[name];
    if (typeof value !== "string" || value.length === 0) throw new WorkflowEnvironmentValidationError(`Required effect secret ${name} is missing. Set it in .env.`);
    selected[name] = value;
  }
  return Object.freeze(selected);
}

function resolveValidatedEnvironment(
  declaration: WorkflowEnvironmentDeclaration,
  values: Readonly<Record<string, string | undefined>>,
): ResolvedWorkflowEnvironment {
  if (!isRecord(values)) throw new WorkflowEnvironmentValidationError("Workflow environment values must be an object.");
  const resolved: Record<string, string> = {};
  for (const variable of declaration.variables) {
    const value = Object.hasOwn(values, variable.name) ? values[variable.name] : undefined;
    if (value === undefined || (typeof value === "string" && value.trim().length === 0)) {
      if (variable.required) throw new WorkflowEnvironmentValidationError(`Required workflow environment variable ${variable.name} is missing. Set it in .env.`);
      continue;
    }
    if (typeof value !== "string") throw new WorkflowEnvironmentValidationError(`Workflow environment variable ${variable.name} must be a string.`);
    if (variable.type === "url" && !isHttpUrlWithoutUserinfo(value)) {
      throw new WorkflowEnvironmentValidationError(`Workflow environment variable ${variable.name} must be an absolute HTTP(S) URL without userinfo.`);
    }
    resolved[variable.name] = value;
  }
  return Object.freeze(resolved);
}

function isHttpUrlWithoutUserinfo(value: string): boolean {
  // URL accepts and normalizes whitespace, backslashes, and empty userinfo;
  // reject those forms so the declared value is an unambiguous request base.
  if (!/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f\\]/u.test(value) || /^https?:\/\/[^/?#]*@/i.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && url.hostname.length > 0 && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function exactRecord(value: unknown, keys: readonly string[], location: string): Record<string, unknown> {
  if (!isRecord(value)) throw new WorkflowEnvironmentValidationError(`${location} must be an object.`);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    // Unknown field names and supplied values are deliberately excluded.
    throw new WorkflowEnvironmentValidationError(`${location} must contain only ${keys.join(", ")}.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
