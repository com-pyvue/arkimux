import type { GraphRequirementDto, JsonValue } from "@com-pyvue/agent-execution-run-contract";
import { Button, Field, Textarea } from "@com-pyvue/agent-execution-ui";

export function GraphRequirementField(props: {
  requirement: GraphRequirementDto;
  name: string;
  value: string;
  onChange(value: string): void;
  onLocate?(): void;
}) {
  const schema = props.requirement.schema;
  const title = graphRequirementTitle(props.requirement);
  const description = schemaText(schema.description) ?? fallbackDescription(props.requirement.role);
  const examples = schemaExamples(schema);
  const fields = schemaFields(schema);
  return <section className="space-y-2">
    {props.onLocate ? <Button type="button" size="sm" variant="ghost" onClick={props.onLocate}>Show {title} on workflow</Button> : null}
    <Field name={props.name}>
      <span>{title}</span>
      <span className="text-xs font-normal text-muted-foreground">{description}</span>
      <Textarea className="min-h-28 font-mono text-xs" value={props.value}
        onChange={event => props.onChange(event.target.value)} placeholder="Enter JSON" />
    </Field>
    {examples.length ? <details className="font-normal">
      <summary className="cursor-pointer text-xs text-muted-foreground">{examples.length === 1 ? "Example input" : "Example inputs"}</summary>
      <div className="mt-2 space-y-3">{examples.map((example, index) => <div key={index} className="space-y-2 rounded border p-3">
        <pre className="overflow-auto text-xs">{JSON.stringify(example, null, 2)}</pre>
        <Button type="button" size="sm" variant="outline" onClick={() => props.onChange(JSON.stringify(example, null, 2))}>
          {examples.length === 1 ? "Use example" : `Use example ${index + 1}`}
        </Button>
      </div>)}</div>
    </details> : null}
    {fields.length ? <details className="font-normal">
      <summary className="cursor-pointer text-xs text-muted-foreground">Input fields</summary>
      <dl className="mt-2 space-y-2 rounded border p-3 text-xs">{fields.map(field => <div key={field.path}>
        <dt><code>{field.path}</code>{field.required ? " · required" : ""}{field.type ? ` · ${field.type}` : ""}</dt>
        <dd className="text-muted-foreground">{field.description ?? "No description provided by this schema."}</dd>
      </div>)}</dl>
    </details> : null}
    <details className="font-normal"><summary className="cursor-pointer text-xs text-muted-foreground">Technical details</summary>
      <pre className="mt-2 overflow-auto rounded bg-muted p-3 text-xs">{JSON.stringify({ id: props.requirement.id,
        role: props.requirement.role, provenance: props.requirement.provenance,
        contractVersion: props.requirement.contractVersion, address: props.requirement.address,
        schema: props.requirement.schema }, null, 2)}</pre>
    </details>
  </section>;
}

export function graphRequirementTitle(requirement: GraphRequirementDto): string {
  return schemaText(requirement.schema.title) ?? fallbackTitle(requirement);
}

type SchemaField = { path: string; required: boolean; type?: string; description?: string };

function schemaFields(schema: Readonly<Record<string, JsonValue>>): SchemaField[] {
  const result: SchemaField[] = [];
  visitProperties(schema, "", result);
  return result;
}

function visitProperties(schema: Readonly<Record<string, JsonValue>>, prefix: string, result: SchemaField[]): void {
  const properties = record(schema.properties);
  if (!properties) return;
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  for (const [name, value] of Object.entries(properties)) {
    const property = record(value);
    if (!property) continue;
    const path = prefix ? `${prefix}.${name}` : name;
    result.push({ path, required: required.has(name), type: schemaType(property), description: schemaText(property.description) });
    visitProperties(property, path, result);
    const items = record(property.items);
    if (items) visitProperties(items, `${path}[]`, result);
  }
}

function schemaExamples(schema: Readonly<Record<string, JsonValue>>): JsonValue[] {
  return Array.isArray(schema.examples) ? schema.examples : [];
}

function schemaType(schema: Readonly<Record<string, JsonValue>>): string | undefined {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.enum)) return "choice";
  return undefined;
}

function fallbackTitle(requirement: GraphRequirementDto): string {
  const target = requirement.address?.path.at(-1)?.nodeId;
  const name = target ? humanize(target) : undefined;
  switch (requirement.role) {
    case "entry-input": return name ? `${name} input` : "Starting step input";
    case "root-scope-input": return "Workflow input";
    case "skipped-node-input": return name ? `${name} input` : "Earlier step input";
    case "skipped-node-output": return name ? `${name} output` : "Earlier step output";
    case "control-input": return name ? `${name} input` : "Control input";
    case "map-completed-outputs": return "Earlier map outputs";
    case "reduce-accumulator": return "Current reduce accumulator";
    case "loop-iteration": return "Current loop iteration";
  }
}

function fallbackDescription(role: GraphRequirementDto["role"]): string {
  switch (role) {
    case "entry-input": return "Input passed to the selected starting step.";
    case "root-scope-input": return "Original workflow input still needed after the selected starting step.";
    case "skipped-node-input": return "Input of an earlier skipped step that the remaining graph still needs.";
    case "skipped-node-output": return "Output of an earlier skipped step that the remaining graph still needs.";
    case "control-input": return "Complete input of the enclosing control execution.";
    case "map-completed-outputs": return "Outputs already produced before the selected map item.";
    case "reduce-accumulator": return "Accumulator value immediately before the selected reduce item.";
    case "loop-iteration": return "Zero-based iteration number of the selected loop execution.";
  }
}

function humanize(value: string): string {
  const words = value.replace(/[._-]+/g, " ").trim();
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Step";
}

function schemaText(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function record(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, JsonValue>>
    : undefined;
}
