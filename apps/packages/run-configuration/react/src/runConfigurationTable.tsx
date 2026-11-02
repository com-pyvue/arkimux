import type { RunConfigurationDefinitionDto } from "@com-pyvue/agent-execution-run-configuration-contract";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@com-pyvue/agent-execution-ui";

export interface RunConfigurationTableProps {
  label?: string;
  definitions: RunConfigurationDefinitionDto[];
  selected: ReadonlySet<string>;
  onSelectionChange(configurationId: string, selected: boolean): void;
  onView(configurationId: string): void;
  onClone(definition: RunConfigurationDefinitionDto): void;
  onArchive?(configurationId: string): void;
  onRestore?(configurationId: string): void;
}

export function RunConfigurationTable(props: RunConfigurationTableProps) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table aria-label={props.label ?? "Run configuration definitions"}>
        <TableHeader>
          <TableRow>
            <TableHead>Compare</TableHead>
            <TableHead>Definition</TableHead>
            <TableHead>Workflow</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Content hash</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.definitions.map((definition) => (
            <TableRow key={definition.configurationId}>
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={`Compare ${definition.configurationId}`}
                  checked={props.selected.has(definition.configurationId)}
                  onChange={(event) => props.onSelectionChange(definition.configurationId, event.target.checked)}
                />
              </TableCell>
              <TableCell>{definition.configurationId}</TableCell>
              <TableCell>{definition.workflow.kind}@{definition.workflow.version}</TableCell>
              <TableCell className="capitalize">{definition.lifecycleStatus}</TableCell>
              <TableCell><code className="text-xs">{shortHash(definition.contentHash)}</code></TableCell>
              <TableCell>
                <Button
                  variant="outline"
                  aria-label={`View definition ${definition.configurationId}`}
                  onClick={() => props.onView(definition.configurationId)}
                >View definition</Button>
                <Button
                  className="ml-2"
                  variant="outline"
                  aria-label={`Clone definition ${definition.configurationId}`}
                  onClick={() => props.onClone(definition)}
                >Clone</Button>
                {definition.lifecycleStatus === "active" && props.onArchive ? (
                  <Button
                    className="ml-2"
                    variant="outline"
                    aria-label={`Delete configuration ${definition.configurationId}`}
                    title="Delete archives this immutable configuration. Historical runs can still read it."
                    onClick={() => props.onArchive?.(definition.configurationId)}
                  >Delete</Button>
                ) : definition.lifecycleStatus === "archived" && props.onRestore ? (
                  <Button
                    className="ml-2"
                    variant="outline"
                    aria-label={`Restore configuration ${definition.configurationId}`}
                    onClick={() => props.onRestore?.(definition.configurationId)}
                  >Restore</Button>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
          {props.definitions.length === 0 ? (
            <TableRow><TableCell colSpan={6}>No configuration definitions on this page.</TableCell></TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  );
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…${hash.slice(-8)}`;
}
