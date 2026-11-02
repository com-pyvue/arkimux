import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import ts from "typescript-parser";
import { createHash } from "node:crypto";
import { projectSourcePathV1Schema, rendererDeclarationV1Schema,
  validateWorkflowManifestV1, workflowManifestDigest,
  type WorkflowManifestV1, type RendererDeclarationV1 } from "../../core/src/application/workflowManifest.ts";
import { workflowDeclarationWithConstructionSchema, type WorkflowDeclarationWithConstruction } from "../../core/src/application/retainedWorkflowDeclaration.ts";
import { validateWorkflowEnvironmentDeclaration } from "../../local/src/workflowEnvironment.ts";
import { ProjectSourceError } from "./projectSourceDiagnostic.ts";

export interface InspectedWorkflow { declaration: WorkflowDeclarationWithConstruction; manifest: WorkflowManifestV1; digest: string }
export interface InspectedProject { workflows: InspectedWorkflow[]; renderers: RendererDeclarationV1[]; rendererRegistryPresent: boolean; rendererRegistryEmpty?: boolean;
  /** Present after full source-policy validation; hashes the bytes actually inspected. */
  sourceDigests?: Readonly<Record<string, string>>;
}

/** Reads bounded project source only. No imports, evaluation, environment or runtime-store reads. */
export class ProjectSourceReader {
  private files = new Map<string, string>();
  private sources = new Map<string, ts.SourceFile>();
  private digests = new Map<string, string>();
  constructor(readonly root: string, private readonly observe?: (file: string, digest: string) => void) {}
  contentDigests(): Readonly<Record<string, string>> { return Object.freeze(Object.fromEntries(this.digests)); }
  async read(file: string): Promise<string> {
    projectSourcePathV1Schema.parse(file);
    if (!/^(?:src|workflows)\//.test(file)) throw new Error(`${file}: source must be under src/ or workflows/.`);
    try {
      const contents = await this.readSource(file);
      this.observe?.(file, this.digests.get(file)!);
      return contents;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.observe?.(file, "missing");
      // Keep ENOENT for optional registries and import-resolution alternatives.
      throw Object.assign(new ProjectSourceError({ file, code: "source-missing",
        message: "Referenced project file is missing. Finish creating it; Local will retry the pending registry update automatically." }),
      { code: "ENOENT" });
    }
  }
  private async readSource(file: string): Promise<string> {
    if (this.files.has(file)) return this.files.get(file)!;
    if (this.files.size >= 512) throw new Error("Project source exceeds the 512-file validation limit.");
    const absolute = path.resolve(this.root, file);
    const resolved = await realpath(absolute);
    const relative = path.relative(await realpath(this.root), resolved);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error(`${file}: source escapes project.`);
    projectSourcePathV1Schema.parse(relative.split(path.sep).join("/"));
    if (!/^(?:src|workflows)\//.test(relative.split(path.sep).join("/"))) throw new Error(`${file}: resolved source leaves src/ or workflows/.`);
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error(`${file}: expected a regular file no larger than 1 MiB.`);
    const bytes = await readFile(absolute);
    if (bytes.length > 1024 * 1024) throw new Error(`${file}: source grew beyond the 1 MiB validation limit.`);
    const contents = bytes.toString("utf8");
    this.digests.set(file, createHash("sha256").update(bytes).digest("hex"));
    this.files.set(file, contents);
    return contents;
  }
  async source(file: string): Promise<ts.SourceFile> {
    const cached = this.sources.get(file);
    if (cached) return cached;
    const source = ts.createSourceFile(file, await this.read(file), ts.ScriptTarget.Latest, true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics.length) {
      const diagnostic = diagnostics[0];
      const loc = diagnostic.start === undefined ? undefined : source.getLineAndCharacterOfPosition(diagnostic.start);
      throw new ProjectSourceError({ file, code: `TS${diagnostic.code}`,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        ...(loc ? { line: loc.line + 1, column: loc.character + 1 } : {}) });
    }
    this.sources.set(file, source);
    return source;
  }
  async resolve(from: string, specifier: string): Promise<string> {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    projectSourcePathV1Schema.parse(base);
    const candidates = /\.jsx?$/.test(base) ? [base.replace(/\.jsx?$/, ".ts"), base.replace(/\.jsx?$/, ".tsx"), base]
      : /\.[a-z]+$/.test(base) ? [base] : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
    const found: string[] = [];
    for (const file of candidates) {
      try { await this.read(file); found.push(file); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    if (found.length !== 1) throw new ProjectSourceError({ file: from, code: "source-import",
      message: `Unresolved or ambiguous local import ${specifier}. Check that it resolves to exactly one project file.` });
    return found[0];
  }
}

function sourceFailure(node: ts.Node, message: string): never {
  const source = node.getSourceFile();
  const loc = ts.isSourceFile(node) ? undefined : source.getLineAndCharacterOfPosition(node.getStart(source));
  throw new ProjectSourceError({ file: source.fileName, code: "source-declaration", message,
    ...(loc ? { line: loc.line + 1, column: loc.character + 1 } : {}) });
}

function literal(node: ts.Expression): unknown {
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(x => {
    if (!ts.isExpression(x) || ts.isSpreadElement(x)) sourceFailure(x, "Declaration arrays require literals without spreads.");
    return literal(x);
  });
  if (ts.isObjectLiteralExpression(node)) {
    const entries = node.properties.map(p => {
      if (!ts.isPropertyAssignment(p) || !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) sourceFailure(p, "Declarations require literal property assignments.");
      return [p.name.text, literal(p.initializer)] as const;
    });
    if (new Set(entries.map(([k]) => k)).size !== entries.length) sourceFailure(node, "Duplicate declaration property.");
    return Object.fromEntries(entries);
  }
  return sourceFailure(node, "Declarations require JSON literals, not calls, imported values or computed expressions.");
}

const exported = (node: ts.Node) => ts.canHaveModifiers(node)
  && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
export function hasNamedExport(source: ts.SourceFile, name: string): boolean {
  return source.statements.some(node => {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      return node.exportClause.elements.some(e => e.name.text === name);
    }
    if (!exported(node)) return false;
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name);
    return "name" in node && !!node.name && ts.isIdentifier(node.name as ts.Node) && (node.name as ts.Identifier).text === name;
  });
}
export function readStaticArray(source: ts.SourceFile, name: string): unknown[] {
  const declarations = source.statements.filter(ts.isVariableStatement).filter(exported)
    .flatMap(s => s.declarationList.declarations).filter(d => ts.isIdentifier(d.name) && d.name.text === name);
  if (declarations.length !== 1 || !declarations[0].initializer) sourceFailure(source, `Export one literal ${name} array.`);
  const value = literal(declarations[0].initializer);
  if (!Array.isArray(value)) sourceFailure(declarations[0], `${name} must be an array.`);
  return value;
}

export async function inspectProjectDeclarations(reader: ProjectSourceReader, options: { includeRenderers?: boolean } = {}): Promise<InspectedProject> {
  const registry = await reader.source("src/arkimux.workflows.ts");
  if (!hasNamedExport(registry, "loadProjectWorkflows")) sourceFailure(registry, "Missing loadProjectWorkflows export.");
  const declarations = readStaticArray(registry, "workflowDeclarations").map(x => workflowDeclarationWithConstructionSchema.parse(x));
  const workflows: InspectedWorkflow[] = [];
  for (const declaration of declarations) {
    const manifest = validateWorkflowManifestV1(JSON.parse(await reader.read(declaration.manifest)));
    const environment = validateWorkflowEnvironmentDeclaration(JSON.parse(await reader.read(declaration.environment)));
    for (const reference of [declaration.definition, declaration.inputValidator, declaration.resultValidator, ...declaration.effects,
      ...(declaration.construction ? [declaration.construction] : [])]) {
      if (!hasNamedExport(await reader.source(reference.file), reference.export)) throw new ProjectSourceError({ file: reference.file,
        code: "source-export", message: `missing export ${reference.export}.` });
    }
    if (workflows.some(w => w.manifest.workflowId === manifest.workflowId)) sourceFailure(registry, `Duplicate workflow ID ${manifest.workflowId}.`);
    if (workflows.some(w => w.declaration.result.kind === declaration.result.kind && w.declaration.result.schemaVersion === declaration.result.schemaVersion)) {
      sourceFailure(registry, `Duplicate result kind/version ${declaration.result.kind}.`);
    }
    workflows.push({ declaration, manifest, digest: workflowManifestDigest(manifest) });
  }
  if (options.includeRenderers === false) return { workflows, renderers: [], rendererRegistryPresent: false };
  let rendererSource: ts.SourceFile;
  try { rendererSource = await reader.source("src/arkimux.renderers.tsx"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { workflows, renderers: [], rendererRegistryPresent: false }; throw e; }
  const renderers = readStaticArray(rendererSource, "rendererDeclarations").map(x => rendererDeclarationV1Schema.parse(x));
  // An explicitly empty registry is disabled. Check both exports without
  // evaluating the module or following its unused imports.
  if (renderers.length === 0) {
    if (readStaticArray(rendererSource, "resultViews").length !== 0) throw new Error("Empty rendererDeclarations requires an empty resultViews array.");
    return { workflows, renderers, rendererRegistryPresent: true, rendererRegistryEmpty: true };
  }
  const seen = new Set<string>();
  for (const renderer of renderers) {
    const w = workflows.find(w => w.manifest.workflowId === renderer.workflowId);
    if (!w || w.declaration.result.kind !== renderer.resultKind || w.declaration.result.schemaVersion !== renderer.payloadSchemaVersion) {
      throw new Error(`Renderer references unknown workflow result ${renderer.workflowId}.`);
    }
    const key = JSON.stringify([renderer.resultKind, renderer.payloadSchemaVersion]);
    if (seen.has(key)) throw new Error("Duplicate renderer result kind/version.");
    seen.add(key);
    if (!hasNamedExport(await reader.source(renderer.renderer.file), renderer.renderer.export)) throw new Error("Renderer export not found.");
  }
  return { workflows, renderers, rendererRegistryPresent: true };
}
