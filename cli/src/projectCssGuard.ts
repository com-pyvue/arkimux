import { list, parse } from "postcss";
import type { ProjectSourceReader } from "./projectDeclarations.ts";

/** Check CSS dependency edges before Vite/PostCSS can read the imported files. */
export async function inspectProjectCss(reader: ProjectSourceReader, file: string, visited: Set<string>): Promise<void> {
  if (visited.has(file)) return;
  visited.add(file);
  const css = parse(await reader.read(file), { from: file });
  const imports: string[] = [];
  const dependency = (value: string) => {
    // Literal relative CSS paths only. Reject escapes, URLs and resolver aliases
    // instead of letting a second parser interpret a different path.
    const literal = value.trim().replace(/^url\(\s*([\s\S]*?)\s*\)$/i, "$1");
    const unquoted = /^(?:"[^"\\]*"|'[^'\\]*')$/.test(literal) ? literal.slice(1, -1) : literal;
    if (!/^\.{1,2}\/.+\.css$/.test(unquoted) || /[\\:"'%?#\u0000-\u001f\u007f]/u.test(unquoted)) {
      throw new Error(`${file}: CSS dependencies require literal relative .css paths.`);
    }
    imports.push(unquoted);
  };
  const fromClause = (value: string) => {
    const tokens = list.space(value);
    const from = tokens.lastIndexOf("from");
    if (from < 0 || tokens.slice(from + 1).join(" ") === "global") return;
    dependency(tokens.slice(from + 1).join(" "));
  };
  css.walkAtRules(rule => {
    if (rule.name.includes("\\")) throw new Error(`${file}: Escaped CSS dependency directives are unsupported.`);
    if (rule.name.toLowerCase() === "import") dependency(list.space(rule.params)[0] ?? "");
    if (rule.name.toLowerCase() === "value") fromClause(rule.params);
  });
  css.walkDecls(declaration => {
    if (["composes", "compose-with"].includes(declaration.prop)) fromClause(declaration.value);
  });
  css.walkRules(rule => {
    if (rule.selector.startsWith(":import(")) {
      const match = /^:import\(([\s\S]*)\)$/.exec(rule.selector);
      if (!match) throw new Error(`${file}: Invalid CSS module import.`);
      dependency(match[1]);
    }
  });
  for (const specifier of imports) {
    const target = await reader.resolve(file, specifier);
    await inspectProjectCss(reader, target, visited);
  }
}
