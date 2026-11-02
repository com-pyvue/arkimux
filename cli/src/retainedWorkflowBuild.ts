/** Internal Local build preparation; intentionally not a public CLI/engine extension API. */
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { build, version as viteVersion } from "vite";
import ts from "typescript-parser";
import { hashJson } from "../../core/src/application/durableWorkflow.ts";
import { inputWaitJsonSnapshot } from "../../core/src/application/inputWait.ts";
import type { FileRetainedExecutionStoreV1, RetainedBuildManifestV1 } from "../../core/src/infrastructure/storage/fileRetainedExecutionStore.ts";
import { constructionDescriptorFile, constructionDescriptorSchema } from "../../core/src/application/retainedWorkflowConstruction.ts";
import { sourceExportV1Schema } from "../../core/src/application/workflowManifest.ts";

export interface RetainedWorkflowBuildOptions {
  readonly projectRoot: string;
  readonly entryPoint: string;
  readonly assets: readonly string[];
  /** Mandatory for the retained Run driver; omitted only by legacy source-loader callers. */
  readonly constructionExport?: string;
  readonly invocationModel?: "workflow-input" | "graph-entry";
  /** Host-owned adapter factories bundled beside, but never injected into, workflow construction. */
  readonly effectAdapterExports?: readonly { file: string; export: string }[];
  /** Declared validator objects must be the actual validators returned by construction. */
  readonly constructionValidators?: { input: { file: string; export: string }; output: { file: string; export: string } };
  readonly resultSchemaVersion?: number;
  /** Byte hashes from the source-policy check, including registry and declarations. */
  readonly validatedInputFiles?: Readonly<Record<string, string>>;
  readonly hostRequirements: Record<string, string>;
}
const hash = (value: unknown) => hashJson(inputWaitJsonSnapshot(value));
const bytesHash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const moduleExtension = /\.(?:[cm]?[jt]sx?|json)$/;
const secretSegment = /^(?:\.env(?:\..*)?|\.git|\.arkimux|\.agent-execution|\.claude|\.codex|\.ssh|\.npmrc|\.netrc|id_rsa|id_ed25519|\.?credentials?(?:\..*)?|auth\.json|\.?secrets?(?:\..*)?|login)$/i;
const forbiddenBuiltins = new Set(["fs", "fs/promises", "module", "child_process", "worker_threads", "vm", "process"]);
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, "")));
function relativeFile(value: string): string {
  if (!value || path.posix.isAbsolute(value) || value.includes("\\") || value.split("/").some(segment => !segment || segment === "." || segment === ".." || secretSegment.test(segment))) throw new Error("Build input must be a safe declared project-relative path, not credentials or Local state.");
  return value;
}
function sourcePolicy(source: string, filename: string): void {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const diagnostics = (tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) throw new Error(`${filename}: invalid retained source syntax.`);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]))) throw new Error(`${filename}: arbitrary dynamic imports cannot be retained.`);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])
        && forbiddenBuiltins.has(node.arguments[0].text.replace(/^node:/, ""))) throw new Error(`${filename}: retained workflow cannot dynamically import a forbidden host module.`);
      if (ts.isIdentifier(node.expression) && ["eval", "Function", "require"].includes(node.expression.text)) throw new Error(`${filename}: runtime code loading cannot be retained.`);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") throw new Error(`${filename}: runtime code generation cannot be retained.`);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const name = node.moduleSpecifier.text.replace(/^node:/, "");
      if (forbiddenBuiltins.has(name)) throw new Error(`${filename}: retained workflow still imports forbidden host module ${name}.`);
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process") throw new Error(`${filename}: pass declared environment values explicitly; do not capture the shell environment.`);
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) throw new Error(`${filename}: retained workflows cannot depend on import.meta environment or current source locations.`);
    ts.forEachChild(node, visit);
  };
  visit(tree);
}
function rejectBundlerEnvironment(source: string, filename: string): void {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isMetaProperty(node.expression)) {
      const property = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : undefined;
      if (property !== "url") throw new Error(`${filename}: bundler environment capture is not allowed in retained dependencies.`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
}
function removeUnusedBuiltinImports(code: string): string {
  const tree = ts.createSourceFile("entry.mjs", code, ts.ScriptTarget.Latest, true);
  // Bundled Core also exports host adapters. Tree-shaking removes their bindings but
  // can leave bare Node builtin imports; loading those unused builtins is unnecessary.
  const bare = tree.statements.filter(node => ts.isImportDeclaration(node) && !node.importClause
    && ts.isStringLiteral(node.moduleSpecifier) && builtins.has(node.moduleSpecifier.text.replace(/^node:/, "")));
  for (const node of bare.reverse()) code = code.slice(0, node.getStart(tree))
    + code.slice(node.getStart(tree), node.end).replace(/[^\r\n]/g, " ") + code.slice(node.end);
  return code;
}

/** Full input bytes are retained only for the resolved graph and declared assets.
 * Directory names and package metadata detect resolution changes when reusing a build.
 * This is a conservative trusted-source policy, not a sandbox for malicious JavaScript.
 */
export async function prepareRetainedWorkflowBuild(store: FileRetainedExecutionStoreV1, options: RetainedWorkflowBuildOptions): Promise<{ manifest: RetainedBuildManifestV1; reused: boolean }> {
  const root = await realpath(options.projectRoot), entry = relativeFile(options.entryPoint);
  if (!/^(src|workflows)\//.test(entry)) throw new Error("Retained workflow entry must be under src/ or workflows/.");
  const assets = [...new Set(options.assets.map(relativeFile))].sort();
  if (assets.some(file => !/^(src|workflows)\//.test(file))) throw new Error("Retained assets must be declared under src/ or workflows/.");
  const effectAdapterExports = (options.effectAdapterExports ?? []).map(value => sourceExportV1Schema.parse(value));
  const generatedEffectExports = effectAdapterExports.map((_reference, index) => `__arkimuxEffectAdapter${index}`);
  const construction = options.constructionExport === undefined ? undefined
    : constructionDescriptorSchema.parse(effectAdapterExports.length
      ? { schemaVersion: 2, export: options.constructionExport,
          effectAdapterEntryPoint: "effect-adapters.mjs", effectAdapters: generatedEffectExports,
          ...(options.invocationModel ? { invocationModel: options.invocationModel } : {}) }
      : { schemaVersion: 1, export: options.constructionExport,
          ...(options.invocationModel ? { invocationModel: options.invocationModel } : {}) });
  const validators = options.constructionValidators && { input: sourceExportV1Schema.parse(options.constructionValidators.input),
    output: sourceExportV1Schema.parse(options.constructionValidators.output) };
  if (validators && !construction) throw new Error("Retained validator binding requires a construction export.");
  const resultSchemaVersion = options.resultSchemaVersion;
  if (resultSchemaVersion !== undefined && (!validators || !Number.isSafeInteger(resultSchemaVersion) || resultSchemaVersion < 1)) {
    throw new Error("Retained result version requires declared validators and a positive integer.");
  }
  if (validators) for (const reference of Object.values(validators)) {
    relativeFile(reference.file);
    if (!/^(src|workflows)\//.test(reference.file)) throw new Error("Retained validators must stay in project source.");
  }
  for (const reference of effectAdapterExports) {
    relativeFile(reference.file);
    if (!/^(src|workflows)\//.test(reference.file)) throw new Error("Retained effect adapters must stay in project source.");
  }
  const validatedInputFiles = { ...options.validatedInputFiles };
  for (const [file, digest] of Object.entries(validatedInputFiles)) {
    relativeFile(file);
    if (!/^(src|workflows)\//.test(file) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid source-validation input identity.");
  }
  const settings = { contract: "retained-local-execution@1", builderRevision: 7, compiler: ts.version, bundler: viteVersion, entry, assets,
    ...(construction ? { construction } : {}),
    ...(validators ? { validators } : {}),
    ...(resultSchemaVersion === undefined ? {} : { resultSchemaVersion }),
    validatedInputFiles,
    target: "es2022", format: "es", hostRequirements: { ...options.hostRequirements } };
  const keySha256 = hash(settings);
  async function safeRead(relative: string): Promise<Buffer> {
    relativeFile(relative);
    const absolute = path.join(root, relative), resolved = await realpath(absolute), actual = path.relative(root, resolved).split(path.sep).join("/");
    relativeFile(actual);
    if (!/^(src|workflows|node_modules)\//.test(actual)) throw new Error("Retained dependency escapes permitted source roots.");
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error("Retained input must be a regular file no larger than 16 MiB.");
    return readFile(absolute);
  }
  async function resolutionDigest(): Promise<string> {
    const entries: string[] = [];
    async function walk(relative: string): Promise<void> {
      let names: string[];
      try { names = await readdir(path.join(root, relative)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const name of names.sort()) {
        if (name.startsWith(".") || secretSegment.test(name)) continue;
        const file = path.posix.join(relative, name), stat = await lstat(path.join(root, file));
        if (entries.length >= 100_000) throw new Error("Retained resolution inventory exceeds its finite bound.");
        if (stat.isSymbolicLink()) entries.push(`link:${file}:${await readlink(path.join(root, file))}`);
        else if (stat.isDirectory()) { entries.push(`dir:${file}`); await walk(file); }
        else if (stat.isFile()) entries.push(`file:${file}${name === "package.json" ? `:${bytesHash(await readFile(path.join(root, file)))}` : ""}`);
      }
    }
    for (const directory of ["src", "workflows", "node_modules"]) await walk(directory);
    for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) {
      try {
        const stat = await lstat(path.join(root, file));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Build resolution metadata must be regular project files.");
        entries.push(`${file}:${bytesHash(await readFile(path.join(root, file)))}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return hash(entries);
  }
  async function assertValidatedInputs(): Promise<void> {
    for (const [file, expected] of Object.entries(validatedInputFiles)) {
      if (bytesHash(await safeRead(file)) !== expected) throw new Error("Project changed after source validation; validate and retry.");
    }
  }
  await assertValidatedInputs();
  const resolutionSha256 = await resolutionDigest();
  for (const candidate of await store.preparedBuilds(keySha256)) {
    if (candidate.preparation!.resolutionSha256 !== resolutionSha256) continue;
    let matches = true;
    for (const [file, expected] of Object.entries(candidate.preparation!.inputFiles)) {
      try { if (bytesHash(await safeRead(file)) !== expected) { matches = false; break; } }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; matches = false; break; }
    }
    if (matches) {
      if (await resolutionDigest() !== resolutionSha256) throw new Error("Project changed while checking its retained build; retry.");
      const verified = await store.findReusableBuild(candidate.inputSha256);
      if (verified?.buildSha256 === candidate.buildSha256) {
        await assertValidatedInputs();
        return { manifest: verified, reused: true };
      }
    }
  }
  const inputFiles: Record<string, string> = { ...validatedInputFiles }, assetBytes: Record<string, Uint8Array> = {};
  for (const file of assets) { const bytes = await safeRead(file); inputFiles[file] = bytesHash(bytes); assetBytes[`assets/${file}`] = bytes; }
  const virtualEntry = "\0arkimux-retained-construction";
  const virtualEffectAdapters = "\0arkimux-retained-effect-adapters";
  const effectImports = effectAdapterExports.map((reference, index) =>
    `import { ${reference.export} as ${generatedEffectExports[index]} } from ${JSON.stringify(path.join(root, reference.file))};`).join("\n");
  const constructorWrapper = validators && construction ? `
    import { ${construction.export} as construct } from ${JSON.stringify(path.join(root, entry))};
    import { ${validators.input.export} as declaredInput } from ${JSON.stringify(path.join(root, validators.input.file))};
    import { ${validators.output.export} as declaredOutput } from ${JSON.stringify(path.join(root, validators.output.file))};
    async function checkedConstruction(context) {
      const result = await construct(context);
      if (result?.graph) {
        const sourceValidator = Symbol.for("arkimux.graph.source-validator@1");
        if (result.graph.input?.[sourceValidator] !== declaredInput || result.graph.output?.[sourceValidator] !== declaredOutput)
          throw new Error("Retained graph construction must use the declared input and result validators.");
        return result;
      }
      if (result?.workflow?.input !== declaredInput || result?.workflow?.output !== declaredOutput)
        throw new Error("Retained construction must use the declared input and result validators.");
      ${resultSchemaVersion === undefined ? "return result;" : `return { ...result, workflow: { ...result.workflow, output: { parse(value) {
        const parsed = declaredOutput.parse(value);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.schemaVersion !== ${resultSchemaVersion})
          throw new Error("Workflow result schema version does not match declared version ${resultSchemaVersion}.");
        return parsed;
      } } } };`}
    }
    export { checkedConstruction as ${construction.export} };
  ` : undefined;
  const effectAdapterWrapper = generatedEffectExports.length ? `${effectImports}\nexport { ${generatedEffectExports.join(", ")} };` : undefined;
  const runBundle = (virtualId: string, wrapper: string | undefined, entryFileName: string) => build({
    root, configFile: false, envDir: false, publicDir: false, logLevel: "silent", esbuild: false,
    define: { "process.env.NODE_ENV": JSON.stringify("production") }, ssr: { noExternal: true },
    plugins: [{ name: "arkimux-retained-inputs", enforce: "pre",
      resolveId(id) { if (wrapper && id === virtualId) return virtualId; },
      async load(id) {
        if (wrapper && id === virtualId) return wrapper;
        if (id.startsWith("\0")) return null;
        if (!path.isAbsolute(id) || id.includes("?")) throw new Error("Unsupported retained module identity.");
        const relative = relativeFile(path.relative(root, id).split(path.sep).join("/"));
        if (Object.keys(validatedInputFiles).length && !relative.startsWith("node_modules/") && !Object.hasOwn(validatedInputFiles, relative)) {
          throw new Error("Project import resolution changed after source validation; validate and retry.");
        }
        if (!moduleExtension.test(relative) || relative.endsWith(".node")) throw new Error("Only JavaScript, TypeScript and JSON dependencies can be retained.");
        const bytes = await safeRead(relative); inputFiles[relative] = bytesHash(bytes);
        if (relative.endsWith(".json")) return `export default ${JSON.stringify(JSON.parse(bytes.toString("utf8")))};`;
        rejectBundlerEnvironment(bytes.toString("utf8"), relative);
        // Package code may be tree-shaken; final output is checked too. Project code must
        // never import filesystem/process capabilities just to read implicit assets.
        if (!relative.startsWith("node_modules/")) sourcePolicy(bytes.toString("utf8"), relative);
        const compiled = ts.transpileModule(bytes.toString("utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX, sourceMap: true, inlineSources: true }, fileName: id });
        const map = JSON.parse(compiled.sourceMapText!);
        map.sources = [id];
        return { code: compiled.outputText.replace(/\/\/# sourceMappingURL=.*$/m, ""), map };
      },
    }],
    build: { ssr: wrapper ? true : path.join(root, entry), write: false, minify: false, sourcemap: "hidden", copyPublicDir: false,
      rollupOptions: { ...(wrapper ? { input: virtualId } : {}), output: { format: "es", entryFileNames: entryFileName, inlineDynamicImports: true } } },
  });
  const workflowResult = await runBundle(virtualEntry, constructorWrapper, "entry.mjs");
  const effectResult = effectAdapterWrapper
    ? await runBundle(virtualEffectAdapters, effectAdapterWrapper, "effect-adapters.mjs")
    : undefined;
  if (!("output" in workflowResult) || (effectResult && !("output" in effectResult))) {
    throw new Error("Retained build must produce finite output sets.");
  }
  if (construction && !workflowResult.output.some(item => item.type === "chunk" && item.isEntry
    && item.exports.includes(construction.export))) {
    throw new Error("Retained construction export was not found in the bundled entry point.");
  }
  if (effectResult && !effectResult.output.some(item => item.type === "chunk" && item.isEntry
    && generatedEffectExports.every(name => item.exports.includes(name)))) {
    throw new Error("Retained effect adapter exports were not found in the host bundle.");
  }
  const files: Record<string, Uint8Array> = { ...assetBytes };
  if (construction) files[constructionDescriptorFile] = Buffer.from(JSON.stringify(construction));
  const outputs = [...workflowResult.output, ...(effectResult ? effectResult.output : [])];
  for (const item of outputs) {
    if (item.type !== "chunk") {
      if (item.fileName.endsWith(".mjs.map")) continue; // Embedded after source-path normalization below.
      throw new Error("Declare asset files explicitly instead of using implicit build assets.");
    }
    if (item.imports.some(name => !builtins.has(name.replace(/^node:/, "")))) throw new Error("Retained build still depends on the current installation.");
    const code = removeUnusedBuiltinImports(item.code);
    sourcePolicy(code, item.fileName);
    // Remove build-time source-path comments only after tree-shaking has consumed
    // package purity annotations; retained code must not disclose checkout paths.
    // Blank comments without shifting any line or column in the composed map.
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code);
    const literalEnds = new Map<number, number>();
    const tree = ts.createSourceFile(item.fileName, code, ts.ScriptTarget.Latest, true);
    const protectLiterals = (node: ts.Node): void => {
      if (ts.isRegularExpressionLiteral(node) || ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        literalEnds.set(node.getStart(tree), node.end);
      } else ts.forEachChild(node, protectLiterals);
    };
    protectLiterals(tree);
    let clean = code;
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      const literalEnd = literalEnds.get(scanner.getTokenPos());
      if (literalEnd !== undefined) { scanner.setTextPos(literalEnd); continue; }
      if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
        const start = scanner.getTokenPos(), end = scanner.getTextPos();
        clean = clean.slice(0, start) + clean.slice(start, end).replace(/[^\r\n]/g, " ") + clean.slice(end);
      }
    }
    if (!item.map) throw new Error("Retained build is missing its source map.");
    const map = JSON.parse(item.map.toString());
    // Relative source identities keep checkout paths out of the retained build.
    map.sources = item.map.sources.map(source => {
      const absolute = path.resolve(root, "dist", source);
      const relative = relativeFile(path.relative(root, absolute).split(path.sep).join("/"));
      return `arkimux-source:///${relative}`;
    });
    map.sourceRoot = "";
    files[relativeFile(item.fileName)] = Buffer.from(`${clean}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`);
  }
  if (await resolutionDigest() !== resolutionSha256) throw new Error("Project dependency resolution changed during build; retry.");
  for (const [file, expected] of Object.entries(inputFiles)) if (bytesHash(await safeRead(file)) !== expected) throw new Error("Project source changed during build; retry.");
  await assertValidatedInputs();
  const inputSha256 = hash({ settings, resolutionSha256, inputFiles });
  const manifest = await store.publishBuild({ inputSha256, entryPoint: "entry.mjs", files, hostRequirements: settings.hostRequirements,
    preparation: { keySha256, resolutionSha256, inputFiles } });
  return { manifest, reused: false };
}
