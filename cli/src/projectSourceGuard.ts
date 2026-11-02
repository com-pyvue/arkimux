import ts from "typescript-parser";
import { ProjectSourceReader, inspectProjectDeclarations, hasNamedExport, type InspectedProject, type InspectedWorkflow } from "./projectDeclarations.ts";
import { resolvePublicSymbol, isSchemaOrParsedDataProperty } from "./projectSymbols.ts";
import { inspectProjectCss } from "./projectCssGuard.ts";
import { ProjectSourceError } from "./projectSourceDiagnostic.ts";

// Versioned, conservative source policy. This is not a JavaScript sandbox.
export const publicImportCatalogVersion = "public-workflow-imports@2";
const coreWorkflow = new Set([
  "defineStep", "JsonPrimitive", "JsonValue", "DeepReadonly", "ValueValidatorV1", "CancellationV1",
  "WorkflowExecutionContextV1", "StepExecutionContextV1", "StepDefinitionV1", "CompletedStepV1",
  "StepPerformanceV1", "ArtifactRefV1", "StepDetailsRefV1", "AgentSlotOperationV1", "EffectContractV1",
  "EffectAdapterV1", "EffectDefinitionV1", "EffectAdapterFactoryContextV1", "defineEffectContract", "defineEffectAdapter",
  "RetainedConstructionContextV1",
  "EffectExecutionContextV1", "RunRef", "WorkflowIdentity", "WorkflowManifestV1", "WorkflowDeclarationV1",
  "RendererDeclarationV1", "ExecutionRequirementsV1", "RequirementSetV1", "SourceBindingV1",
  "definePortableWorkflowManifest", "defineNativeWorkflowManifest", "validateWorkflowManifestV1",
  "workflowManifestDigest", "effectiveWorkflowRequirements",
  "ExternalProviderError", "ExternalErrorDiagnostic", "ExternalProviderErrorOptions",
  "getExternalErrorDiagnostic", "credentialSecretValues",
  "defineGraphValue", "defineGraph", "defineWorkflow", "graphStep", "graphSubgraph", "graphMap", "graphReduce", "graphLoop", "graphChoice",
  "graphRef", "graphValue", "GraphBindingV1", "GraphBindingValuesV1", "GraphValueContractV1", "GraphNodeV1", "GraphDefinitionV1",
  "describeGraphV1", "describeGraphEntryPresentationV1", "GraphDescriptionV1", "GraphEntryPresentationV1",
  "GraphWorkflowV1", "GraphInvocationEntryDeclarationV1", "GraphDefinitionOptionsV1", "GraphMapInputV1", "GraphMapBodyInputV1", "GraphReduceInputV1", "GraphReduceBodyInputV1",
  "GraphLoopInputV1", "GraphLoopBodyInputV1", "GraphInstanceAddressV1", "GraphInstanceSegmentV1", "GraphInvocationRequestV1",
]);
const localRegistry = new Set(["createLocalGraphWorkflow", "createLocalPortableWorkflow", "validateWorkflowEnvironmentDeclaration", "LocalResultView",
  "LocalWorkflowRegistration", "WorkflowEnvironmentDeclaration", "ResolvedWorkflowEnvironment", "withLocalWorkflowDeclaration", "LocalWorkflowDeclarationBinding"]);
const knownBindings: Record<string, string> = {
  "@temporalio/workflow": "workflow-engine", "inngest": "workflow-engine", "@mastra/core": "framework",
  "langchain": "framework", "@langchain/core": "framework", "@langchain/langgraph": "workflow-engine",
  "openai": "agent-provider", "@anthropic-ai/sdk": "agent-provider", "@anthropic-ai/claude-agent-sdk": "agent-provider",
  "@openai/codex-sdk": "agent-provider", "@earendil-works/pi-ai": "agent-provider",
  "@earendil-works/pi-coding-agent": "agent-provider", "@aws-sdk/client-lambda": "compute-provider",
  "@aws-sdk/client-ecs": "compute-provider", "@aws-sdk/client-codebuild": "compute-provider",
};
type Role = "registry" | "workflow" | "effect" | "renderer";
function importedNames(node: ts.ImportDeclaration | ts.ExportDeclaration): string[] {
  if (ts.isExportDeclaration(node)) {
    if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return ["*"];
    return node.exportClause.elements.map(e => (e.propertyName ?? e.name).text);
  }
  const clause = node.importClause;
  if (!clause) return ["*"];
  const names = clause.name ? ["default"] : [];
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) names.push("*");
    else names.push(...clause.namedBindings.elements.map(e => (e.propertyName ?? e.name).text));
  }
  return names;
}

export async function validateProjectSource(projectRoot: string, options: {
  includeRenderers?: boolean;
  /** Private loader observation, including missing import-resolution candidates. */
  observeSource?: (file: string, digest: string) => void;
} = {}): Promise<InspectedProject> {
  const reader = new ProjectSourceReader(projectRoot, options.observeSource);
  const project = await inspectProjectDeclarations(reader, options);
  const visited = new Set<string>();
  const importsSeen = new Set<string>();
  const cssVisited = new Set<string>();
  async function inspect(file: string, role: Role, workflow?: InspectedWorkflow): Promise<void> {
    const key = `${workflow?.manifest.workflowId ?? "project"}:${role}:${file}`;
    if (visited.has(key)) return;
    visited.add(key);
    const source = await reader.source(file);
    const portable = workflow?.manifest.workflowMode === "arkimux-portable";
    const stepNames = new Set<string>();
    const zodNames = new Set<string>();
    const localNames = new Set<string>();
    function collectNames(node: ts.Node): void {
      if (ts.isIdentifier(node)) localNames.add(node.text);
      ts.forEachChild(node, collectNames);
    }
    collectNames(source);
    for (const name of localNames) {
      const symbol = await resolvePublicSymbol(reader, file, name);
      if (symbol?.module === "@com-pyvue/agent-execution-core" && symbol.name === "defineStep") stepNames.add(name);
      if (symbol?.module === "zod") zodNames.add(name);
    }
    const need = (node: ts.Node, capability: string) => {
      if (portable && !workflow!.manifest.requiredCapabilities.includes(capability as never)) fail(node, `Declare required capability ${capability}.`);
    };
    const edges: { specifier: string; names: string[]; node: ts.Node }[] = [];
    const fail = (node: ts.Node, rule: string) => {
      const loc = source.getLineAndCharacterOfPosition(node.getStart(source));
      throw new ProjectSourceError({ file, code: "source-policy", message: rule,
        line: loc.line + 1, column: loc.character + 1 });
    };
    function visit(node: ts.Node): void {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) fail(node, "Use literal module imports.");
        edges.push({ specifier: (node.moduleSpecifier as ts.StringLiteral).text, names: importedNames(node), node });
      }
      if (ts.isImportEqualsDeclaration(node)) fail(node, "Use ES module imports, not require/import-equals.");
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && stepNames.has(node.expression.text)) need(node, "durable-sequential-steps@1");
      if (ts.isIdentifier(node) && stepNames.has(node.text) && !ts.isImportSpecifier(node.parent)
        && !ts.isExportSpecifier(node.parent) && !(ts.isVariableDeclaration(node.parent) && node.parent.name === node)) {
        need(node, "durable-sequential-steps@1");
      }
      if (ts.isIdentifier(node) && stepNames.has(node.text) && ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node) {
        fail(node, "Use the imported step constructor directly or through a static alias; computed constructor methods are unsupported.");
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "invoke"
        && ts.isPropertyAccessExpression(node.expression.expression) && node.expression.expression.name.text === "agents") need(node, "agent-slot-invocation@1");
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "safety" && ts.isStringLiteral(node.initializer)
        && ["read", "idempotent-write", "reconcilable-write", "unsafe-write"].includes(node.initializer.text)) need(node, `effect-${node.initializer.text}@1`);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) fail(node, "Computed dynamic imports are not supported.");
        edges.push({ specifier: (node.arguments[0] as ts.StringLiteral).text, names: ["*"], node });
      }
      if (ts.isIdentifier(node) && ["require", "eval", "Function"].includes(node.text)) fail(node, "Dynamic code/require is not supported in checked source.");
      if (role !== "registry" && ts.isIdentifier(node) && ["process", "global", "globalThis", "Deno", "Bun"].includes(node.text)) {
        fail(node, "Use declared workflow variables; direct environment/global access is not supported.");
      }
      if (portable && role === "workflow" && ts.isIdentifier(node) && ["fetch", "WebSocket", "XMLHttpRequest"].includes(node.text)) {
        fail(node, "Network operations belong in a declared typed effect.");
      }
      if ((portable || workflow?.manifest.workflowMode === "native-runtime-bound") && ts.isPropertyAssignment(node)
        && ts.isComputedPropertyName(node.name) && !ts.isStringLiteral(node.name.expression)
        && !isSchemaOrParsedDataProperty(node, source, zodNames)) {
        fail(node, "Unclassified computed property: use explicit binding fields or schema-validated data.");
      }
      const propertyName = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
        ? ts.isComputedPropertyName(node.name) && ts.isStringLiteral(node.name.expression) ? node.name.expression.text
          : ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined
        : undefined;
      const bindingProperty = (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))
        && propertyName !== undefined
        && ["model", "provider", "authProvider", "executionProvider", "modelProvider", "computeProvider", "workflowEngine"].includes(propertyName)
        && !isSchemaOrParsedDataProperty(node, source, zodNames);
      if (portable && bindingProperty) {
        fail(node, "Runtime/model bindings belong in Run Configuration, not portable workflow source.");
      }
      if (workflow?.manifest.workflowMode === "native-runtime-bound" && bindingProperty) {
        fail(node, "Move native runtime/model configuration to JSON and declare its source-binding pointers.");
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const edge of edges) {
      const spec = edge.specifier;
      importsSeen.add(JSON.stringify([file, spec]));
      if (spec.startsWith(".")) {
        const target = await reader.resolve(file, spec);
        if (target.endsWith(".css")) {
          if (role !== "renderer" && file !== "src/arkimux.renderers.tsx") fail(edge.node, "CSS imports belong in a result renderer.");
          await inspectProjectCss(reader, target, cssVisited);
          continue;
        }
        if (target.endsWith(".json")) {
          const json = JSON.parse(await reader.read(target));
          const scan = (value: unknown, pointer: string) => {
            if (!value || typeof value !== "object") return;
            for (const [name, child] of Object.entries(value)) {
              const childPointer = `${pointer}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;
              if (["model", "provider", "authProvider", "executionProvider", "modelProvider", "computeProvider", "workflowEngine"].includes(name)) {
                if (portable) fail(edge.node, "Runtime/model bindings in JSON belong outside portable workflow source.");
                if (workflow && !workflow.manifest.sourceBindings.some(b => b.id === child && b.source.file === target
                  && "pointer" in b.source && b.source.pointer === childPointer)) fail(edge.node, "Declare every native JSON source binding.");
              }
              scan(child, childPointer);
            }
          };
          scan(json, "");
          continue;
        }
        const targetSource = await reader.source(target);
        for (const name of edge.names) if (name !== "*" && !hasNamedExport(targetSource, name)) fail(edge.node, `Missing local export ${name} in ${target}.`);
        // An effect keeps its declared role on every edge, not just registry imports.
        if (workflow?.declaration.effects.some(r => r.file === target)) {
          if (role !== "registry" && role !== "effect") {
            fail(edge.node, "Workflow code cannot import a host effect adapter file. Move the typed effect contract to a separate workflow-safe module.");
          }
          await inspect(target, "effect", workflow);
          continue;
        }
        // Registry is the composition root; each declared source keeps its own policy.
        if (role === "registry") {
          const owners = project.workflows.filter(w => [w.declaration.definition, w.declaration.inputValidator,
            w.declaration.resultValidator, ...w.declaration.effects, ...(w.declaration.construction ? [w.declaration.construction] : [])].some(r => r.file === target));
          if (owners.length) {
            for (const owner of owners) await inspect(target, owner.declaration.effects.some(r => r.file === target) ? "effect" : "workflow", owner);
            continue;
          }
          if (project.renderers.some(r => r.renderer.file === target)) { await inspect(target, "renderer"); continue; }
        }
        await inspect(target, role === "registry" ? "workflow" : role, workflow);
        continue;
      }
      if (spec.startsWith("@com-pyvue/agent-execution-")) {
        const allowed = spec === "@com-pyvue/agent-execution-core" ? coreWorkflow
          : spec === "@com-pyvue/agent-execution-local" && (role === "registry" || role === "renderer") ? localRegistry : undefined;
        if (!allowed || edge.names.some(n => !allowed.has(n))) fail(edge.node, "Unsupported ArkiMux import. Use the documented workflow exports; engine, storage, host and provider implementations are private to workflow source.");
        continue;
      }
      if (spec === "zod") continue;
      if ((role === "renderer" || role === "registry") && ["react", "react/jsx-runtime", "react-dom/server"].includes(spec)) continue;
      if (role === "registry" && ["node:path", "node:fs/promises"].includes(spec)) continue;
      if (role === "effect" && ["node:url", "node:buffer", "node:http", "node:https", "undici"].includes(spec)) continue;
      if (workflow?.manifest.workflowMode === "native-runtime-bound") {
        const binding = workflow.manifest.sourceBindings.find(b => b.source.file === file && "import" in b.source && b.source.import === spec);
        if (binding && (!knownBindings[spec] || binding.kind === knownBindings[spec])) continue;
        fail(edge.node, "Declare this native source binding with its exact file, import and kind.");
      }
      fail(edge.node, knownBindings[spec] ? "Portable source cannot import an engine, framework, agent/model SDK or compute provider."
        : "unclassified-dependency: use an approved pure/effect dependency or declare a native source binding.");
    }
  }
  await inspect("src/arkimux.workflows.ts", "registry");
  if (project.rendererRegistryPresent && !project.rendererRegistryEmpty) await inspect("src/arkimux.renderers.tsx", "registry");
  for (const workflow of project.workflows) {
    if (workflow.declaration.construction) await inspect(workflow.declaration.construction.file, "workflow", workflow);
    for (const r of [workflow.declaration.definition, workflow.declaration.inputValidator, workflow.declaration.resultValidator]) await inspect(r.file, "workflow", workflow);
    for (const r of workflow.declaration.effects) await inspect(r.file, "effect", workflow);
    for (const binding of workflow.manifest.sourceBindings) {
      if ("import" in binding.source) {
        if (!importsSeen.has(JSON.stringify([binding.source.file, binding.source.import]))) throw new Error(`${binding.source.file}: declared binding import is absent from the checked graph.`);
      } else {
        if (!binding.source.file.endsWith(".json")) throw new Error("Binding pointers must reference JSON files.");
        let value: unknown = JSON.parse(await reader.read(binding.source.file));
        for (const part of binding.source.pointer.slice(1).split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"))) {
          value = value !== null && typeof value === "object" && Object.hasOwn(value, part) ? (value as Record<string, unknown>)[part] : undefined;
        }
        if (value !== binding.id) throw new Error(`${binding.source.file}: binding pointer does not match its ID.`);
      }
    }
  }
  return { ...project, sourceDigests: reader.contentDigests() };
}
