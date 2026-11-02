import { useEffect, useId, useRef, useState } from "react";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomBehavior } from "d3-zoom";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import type { GraphDescriptionDto, GraphRequirementDto, WorkflowInvocationEntryDto } from "@com-pyvue/agent-execution-run-contract";
import { Button, ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { graphRequirementTitle } from "./graphRequirementField.tsx";

type Node = GraphDescriptionDto["nodes"][number];
type Edge = GraphDescriptionDto["edges"][number];

function fieldPath(path: Edge["targetPath"]): string {
  return path.map((part, index) => {
    if (typeof part === "number") return `[${part}]`;
    if (/^[A-Za-z_$][\w$]*$/.test(part)) return `${index ? "." : ""}${part}`;
    return `[${JSON.stringify(part)}]`;
  }).join("");
}

function edgeLabel(edge: Edge): string {
  if (edge.kind === "order") return "After";
  return edge.targetPath.length ? fieldPath(edge.targetPath) : "Whole input";
}

function edgeDescription(edge: Edge, nodes: Node[]): string {
  const name = (id: string) => { const node = nodes.find(node => node.id === id); return node ? `${node.title} (${node.nodeId})` : id; };
  const path = (port: string, parts: Edge["sourcePath"]) => `${port}${parts.length && typeof parts[0] === "string" && /^[A-Za-z_$][\w$]*$/.test(parts[0]) ? "." : ""}${fieldPath(parts)}`;
  return edge.kind === "order" ? `${name(edge.target)} runs after ${name(edge.source)}. No data is supplied.`
    : `${name(edge.source)} ${path(edge.sourcePort, edge.sourcePath)} → ${name(edge.target)} ${path("input", edge.targetPath)}`;
}

/** The graph is a server-produced description of the executable declaration.
 * ELK owns placement, React owns elements, D3 owns only the viewport transform. */
export function WorkflowDiagram(props: { graph: GraphDescriptionDto; entry?: WorkflowInvocationEntryDto;
  focusedRequirementId?: string; onRequirement?(id: string): void }) {
  const { graph, entry } = props;
  const [selectedId, setSelectedId] = useState<string>();
  const [expanded, setExpanded] = useState<string[]>([]);
  const root = useRef<HTMLElement>(null);
  const target = entry?.presentation?.requirementTargets.find(item => item.requirementId === props.focusedRequirementId);
  const focusedId = target?.nodeId ?? selectedId ?? entry?.presentation?.selectedNodeId;
  const selected = graph.nodes.find(node => node.id === focusedId);
  const focusedRequirement = entry?.requirements.find(item => item.id === props.focusedRequirementId);
  const visible = new Set([graph.rootScopeId, ...expanded]);
  // Expand the ancestry of a scoped entry or a located field without enumerating iterations.
  for (const id of [entry?.presentation?.selectedNodeId, focusedId]) {
    let scope = graph.scopes.find(scope => scope.id === graph.nodes.find(node => node.id === id)?.scopeId);
    while (scope) {
      visible.add(scope.id);
      scope = graph.scopes.find(parent => parent.id === graph.nodes.find(node => node.id === scope?.parentNodeId)?.scopeId);
    }
  }
  useEffect(() => { setSelectedId(undefined); setExpanded([]); }, [graph.declarationSha256, entry?.id]);
  useEffect(() => {
    if (props.focusedRequirementId) root.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [props.focusedRequirementId]);
  function status(node: Node): string {
    if (node.id === entry?.presentation?.selectedNodeId) return "Starting here";
    if (node.kind === "input") return "Input";
    const scope = entry?.presentation?.scopes.find(scope => scope.scopeId === node.scopeId);
    if (scope) return scope.activeNodeIds.includes(node.id) ? "Continuation" : "Skipped";
    return node.scopeId === graph.rootScopeId ? "Definition" : "Body definition";
  }
  const scopes = graph.scopes.filter(scope => visible.has(scope.id));
  return <section ref={root} aria-label="Workflow diagram" className="space-y-3 rounded-xl border bg-card p-4">
    <div><h2 className="font-semibold">Workflow</h2><p className="text-sm text-muted-foreground">
      {entry ? `Starting at ${entry.label}. The workflow continues to its result. Gray steps are skipped; their needed values come from your input.`
        : "Generated from the workflow code. Select a node to inspect its inputs, outputs, and nested bodies."}
    </p></div>
    <p className="text-xs text-muted-foreground">Solid arrows carry data · Dashed arrows require order · Local V2 executes serially. Branches and repeated bodies are definitions, not a record of executed work.</p>
    {scopes.map(scope => <div key={scope.id} className={scope.parentNodeId ? "rounded-lg border p-3" : ""}>
      <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{scope.parentNodeId ? scope.title : "Workflow overview"}</h3>
        {scope.parentNodeId && expanded.includes(scope.id) && !entry?.presentation?.selectedNodeId.startsWith(`${scope.id}/`) && !focusedId?.startsWith(`${scope.id}/`) ? <Button type="button" variant="ghost" size="sm" onClick={() => setExpanded(current => current.filter(id => id !== scope.id && !id.startsWith(`${scope.id}/`)))}>Collapse</Button> : null}
      </div>
      <ScopeDiagram graph={graph} scopeId={scope.id} selectedId={focusedId} status={status} onSelect={id => { setSelectedId(id); props.onRequirement?.(""); }} />
    </div>)}
    {focusedRequirement ? <p role="status" className="rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950">
      <strong>{graphRequirementTitle(focusedRequirement)}</strong>: {requirementExplanation(focusedRequirement)}
      {selected ? ` This supplies ${selected.title}${target ? ` ${target.port}` : ""}.` : ""}
    </p> : null}
    {entry?.requirements.length ? <div className="space-y-2"><h3 className="text-sm font-medium">Values supplied by you ({entry.requirements.length})</h3>
      <div className="flex flex-wrap gap-2">{entry.requirements.map(requirement => <Button key={requirement.id} type="button" variant="outline" size="sm"
        aria-pressed={props.focusedRequirementId === requirement.id} onClick={() => props.onRequirement?.(requirement.id)}>{graphRequirementTitle(requirement)}</Button>)}</div>
    </div> : null}
    {selected ? <div className="space-y-3 rounded-lg border p-3" aria-label="Selected workflow node">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium">{selected.title} · {status(selected)}</h3>
        {selected.bodyScopeIds.map(id => <Button key={id} type="button" variant="outline" size="sm" onClick={() => setExpanded(current => [...new Set([...current, id])])}>
          Expand {graph.scopes.find(scope => scope.id === id)?.title ?? "body"}</Button>)}
      </div>
      {(["inputSchema", "outputSchema"] as const).map(key => <details key={key}><summary className="cursor-pointer text-sm font-medium">{key === "inputSchema" ? "Input" : "Output"} schema</summary>
        {typeof selected[key].description === "string" ? <p className="my-2 text-sm">{selected[key].description}</p> : null}
        <pre className="mt-2 max-h-72 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify(selected[key], null, 2)}</pre>
      </details>)}
    </div> : null}
  </section>;
}

function ScopeDiagram(props: { graph: GraphDescriptionDto; scopeId: string; selectedId?: string;
  status(node: Node): string; onSelect(id: string): void }) {
  const [layout, setLayout] = useState<ElkNode>();
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(800);
  const svg = useRef<SVGSVGElement>(null), viewport = useRef<SVGGElement>(null);
  const behavior = useRef<ZoomBehavior<SVGSVGElement, unknown>>(undefined);
  const marker = useId().replace(/:/g, "");
  const nodes = props.graph.nodes.filter(node => node.scopeId === props.scopeId);
  const edges = props.graph.edges.filter(edge => edge.scopeId === props.scopeId);
  useEffect(() => {
    if (!layout || !svg.current) return;
    const element = svg.current;
    const measure = () => { const value = element.getBoundingClientRect().width; if (value > 0) setWidth(value); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [layout]);
  useEffect(() => {
    let cancelled = false;
    setFailed(false); setLayout(undefined);
    void import("elkjs/lib/elk.bundled.js").then(async ({ default: ELK }) => {
      if (cancelled) return;
      const elk = new ELK();
      // The bundled ELK uses its in-process worker shim (no Worker lifecycle).
      return elk.layout({ id: props.scopeId,
        layoutOptions: { "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.spacing.nodeNode": "28",
          "elk.layered.spacing.nodeNodeBetweenLayers": "65", "elk.edgeRouting": "ORTHOGONAL" },
        children: nodes.map(node => ({ id: node.id, width: 172, height: 76 })),
        edges: edges.map(edge => {
          const full = edgeLabel(edge), text = full.length > 40 ? `${full.slice(0, 39)}…` : full;
          return { id: edge.id, sources: [edge.source], targets: [edge.target],
            labels: [{ id: `${edge.id}-label`, text, width: text.length * 7.5 + 12, height: 22,
              layoutOptions: { "elk.edgeLabels.placement": "CENTER" } }] };
        }),
      });
    }).then(result => { if (!cancelled) setLayout(result); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [props.graph, props.scopeId]);
  useEffect(() => {
    if (!layout || !svg.current || !viewport.current) return;
    const element = svg.current, group = viewport.current;
    const instance = zoom<SVGSVGElement, unknown>().extent([[0, 0], [width, 260]])
      .scaleExtent([0.25, 4]).filter(event => event.type === "wheel" ? event.ctrlKey || event.metaKey
        : !event.button && !(event.target instanceof Element && event.target.closest('[role="button"]')))
      .on("zoom", event => select(group).attr("transform", event.transform.toString()));
    behavior.current = instance;
    const scale = Math.max(0.85, Math.min(1, width / (layout.width ?? width), 260 / (layout.height ?? 260)));
    select(element).call(instance).call(instance.transform, zoomIdentity.translate(0, Math.max(0, (260 - (layout.height ?? 260) * scale) / 2)).scale(scale));
    return () => { select(element).on(".zoom", null); behavior.current = undefined; };
  }, [layout, width]);
  useEffect(() => {
    const node = layout?.children?.find(node => node.id === props.selectedId);
    if (!node || !svg.current || !behavior.current) return;
    select(svg.current).call(behavior.current.transform, zoomIdentity.translate(width / 2 - (node.x ?? 0) - 86, 130 - (node.y ?? 0) - 38));
  }, [layout, width, props.selectedId]);
  if (failed) return <ErrorNotification description="The workflow diagram could not be laid out. Input fields remain available." />;
  if (!layout) return <p className="p-4 text-sm text-muted-foreground">Laying out workflow…</p>;
  return <div>
    <div className="my-2 flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="ghost" aria-label="Zoom in" onClick={() => { if (svg.current && behavior.current) select(svg.current).call(behavior.current.scaleBy, 1.3); }}>+</Button>
      <Button type="button" size="sm" variant="ghost" aria-label="Zoom out" onClick={() => { if (svg.current && behavior.current) select(svg.current).call(behavior.current.scaleBy, 1 / 1.3); }}>−</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => {
        if (svg.current && behavior.current) {
          const scale = Math.min(1, width / (layout.width ?? width), 260 / (layout.height ?? 260));
          select(svg.current).call(behavior.current.transform, zoomIdentity.translate((width - (layout.width ?? width) * scale) / 2, (260 - (layout.height ?? 260) * scale) / 2).scale(scale));
        }
      }}>Fit</Button>
      <span className="text-xs text-muted-foreground">Drag to pan · Ctrl/⌘ + scroll to zoom</span>
    </div>
    <svg ref={svg} viewBox={`0 0 ${width} 260`} className="h-[260px] w-full rounded-lg border bg-background"
      role="group" aria-label="Workflow nodes and connections">
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
      <g ref={viewport}>
        {layout.edges?.map(edge => {
          const declaration = edges.find(item => item.id === edge.id)!;
          const description = edgeDescription(declaration, nodes);
          return <g key={edge.id} className="workflow-graph-edge" role="img" tabIndex={0} aria-label={description}><title>{description}</title>
            {edge.sections?.map((section, index) => <path key={index} d={[section.startPoint, ...(section.bendPoints ?? []), section.endPoint].map((point, i) => `${i ? "L" : "M"} ${point.x} ${point.y}`).join(" ")}
              fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray={declaration.kind === "order" ? "5 4" : undefined} markerEnd={`url(#${marker})`} />)}
            {edge.labels?.map(label => <g key={label.id} transform={`translate(${label.x ?? 0} ${label.y ?? 0})`}>
              <rect width={label.width} height={label.height} rx={4} fill="var(--background)" />
              <text x={6} y={15} fill="var(--foreground)" fontSize={12} fontFamily="monospace">{label.text}</text>
            </g>)}
          </g>;
        })}
        {layout.children?.map(placed => {
          const node = nodes.find(node => node.id === placed.id)!, state = props.status(node), focused = node.id === props.selectedId;
          return <g key={node.id} transform={`translate(${placed.x ?? 0} ${placed.y ?? 0})`} role="button" tabIndex={0}
            className="workflow-graph-node" data-kind={node.kind} data-state={state}
            aria-label={`${node.title}, ${node.kind}, ${state}`} aria-pressed={focused} onClick={() => props.onSelect(node.id)}
            onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelect(node.id); } }}>
            <rect className="workflow-graph-node-halo" x={-4} y={-4} width={180} height={84} rx={13} />
            <rect className="workflow-graph-node-frame" width={172} height={76} rx={9} />
            <text x={12} y={22} fill="var(--card-foreground)" fontSize={14} fontWeight={600}>{node.title.length > 20 ? `${node.title.slice(0, 19)}…` : node.title}</text>
            <text x={12} y={42} fill="var(--card-foreground)" fontSize={11}>{node.kind}{node.bodyScopeIds.length ? " · expandable" : ""}</text>
            <text x={12} y={61} fill="var(--graph-node-color)" fontSize={11}>{state}</text>
          </g>;
        })}
      </g>
    </svg>
  </div>;
}

function requirementExplanation(requirement: GraphRequirementDto): string {
  switch (requirement.role) {
    case "entry-input": return "Input passed to the selected starting step.";
    case "root-scope-input": return "Workflow input still referenced by the continuation.";
    case "skipped-node-input": return "The remaining workflow reads this skipped step’s input.";
    case "skipped-node-output": return "The remaining workflow reads this skipped step’s output.";
    case "control-input": return "The enclosing map, reduce, or loop needs this input to continue.";
    case "map-completed-outputs": return "Supply the earlier map items’ outputs; those items will not be rerun.";
    case "reduce-accumulator": return "The reduce continues from this supplied accumulator.";
    case "loop-iteration": return "The loop continues from this iteration.";
  }
}
