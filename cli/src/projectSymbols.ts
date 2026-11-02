import ts from "typescript-parser";
import { ProjectSourceReader } from "./projectDeclarations.ts";

export function unwrapExpression(node: ts.Expression): ts.Expression {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}

/** Resolve only static names; never import or evaluate a project module. */
export async function resolvePublicSymbol(reader: ProjectSourceReader, file: string, name: string,
  exportedOnly = false, seen = new Set<string>()): Promise<{ module: string; name: string } | undefined> {
  const key = `${file}:${exportedOnly}:${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const source = await reader.source(file);
  async function fromModule(specifier: string, imported: string) {
    if (!specifier.startsWith(".")) return { module: specifier, name: imported };
    const target = await reader.resolve(file, specifier);
    if (target.endsWith(".json") || target.endsWith(".css")) return undefined;
    return resolvePublicSymbol(reader, target, imported, true, seen);
  }
  for (const statement of source.statements) {
    if (!exportedOnly && ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.name?.text === name) return fromModule(statement.moduleSpecifier.text, "default");
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings) && clause.namedBindings.name.text === name) {
        return fromModule(statement.moduleSpecifier.text, "*");
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const item = clause.namedBindings.elements.find(e => e.name.text === name);
        if (item) return fromModule(statement.moduleSpecifier.text, (item.propertyName ?? item.name).text);
      }
    }
    if (exportedOnly && ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const item = statement.exportClause.elements.find(e => e.name.text === name);
      if (item) {
        const original = (item.propertyName ?? item.name).text;
        if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) return fromModule(statement.moduleSpecifier.text, original);
        return resolvePublicSymbol(reader, file, original, false, seen);
      }
    }
    if (ts.isVariableStatement(statement) && (!exportedOnly || statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))) {
      const item = statement.declarationList.declarations.find(d => ts.isIdentifier(d.name) && d.name.text === name);
      if (item?.initializer) {
        const value = unwrapExpression(item.initializer);
        if (ts.isIdentifier(value)) return resolvePublicSymbol(reader, file, value.text, false, seen);
      }
    }
  }
  return undefined;
}

/** Explicit schema construction and schema.parse data are not runtime bindings. */
export function isSchemaOrParsedDataProperty(node: ts.ObjectLiteralElementLike, source: ts.SourceFile, zodNames: Set<string>): boolean {
  const variables = new Map<string, ts.Expression>();
  for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
    for (const d of statement.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) variables.set(d.name.text, d.initializer);
  }
  function schema(expression: ts.Expression, seen = new Set<string>()): boolean {
    const value = unwrapExpression(expression);
    if (ts.isIdentifier(value)) {
      if (zodNames.has(value.text)) return true;
      if (seen.has(value.text)) return false;
      seen.add(value.text);
      const initializer = variables.get(value.text);
      return !!initializer && schema(initializer, seen);
    }
    if (ts.isPropertyAccessExpression(value)) return schema(value.expression, seen);
    if (ts.isCallExpression(value)) {
      if (ts.isPropertyAccessExpression(value.expression) && ["parse", "safeParse", "parseAsync", "safeParseAsync"].includes(value.expression.name.text)) return false;
      return schema(value.expression, seen);
    }
    return false;
  }
  // A reserved field whose value is a schema is schema data, not a model ID.
  if (ts.isPropertyAssignment(node) && schema(node.initializer)) return true;
  if (ts.isShorthandPropertyAssignment(node) && schema(node.name)) return true;
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent)) {
      return ts.isPropertyAccessExpression(parent.expression)
        && ["parse", "safeParse", "parseAsync", "safeParseAsync"].includes(parent.expression.name.text)
        && schema(parent.expression.expression);
    }
    if (!ts.isObjectLiteralExpression(parent) && !ts.isPropertyAssignment(parent)
      && !ts.isArrayLiteralExpression(parent) && !ts.isParenthesizedExpression(parent)
      && !ts.isAsExpression(parent) && !ts.isSatisfiesExpression(parent)) return false;
  }
  return false;
}
