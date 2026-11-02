import type { AgentSlotDto } from "@com-pyvue/agent-execution-run-contract";
import type {
  JsonObject,
  JsonValue,
} from "@com-pyvue/agent-execution-run-configuration-contract";
import type { AgentTemplateDefinitionDto, ExecutionProviderEditorDescriptorDto } from "@com-pyvue/agent-execution-agent-template-contract";
import { useId } from "react";
import { Field, Select, Badge, Card, CardContent, CardHeader, CardTitle, Input } from "@com-pyvue/agent-execution-ui";

export interface StructuredRunConfigurationEditorProps {
  definition: JsonObject;
  agentSlots: readonly AgentSlotDto[];
  providers: readonly ExecutionProviderEditorDescriptorDto[];
  templates: readonly AgentTemplateDefinitionDto[];
  selectedTemplates: Readonly<Record<string, string>>;
  comparisonConfigurationId: string;
  comparisonDefinitions: readonly { configurationId: string; definition: JsonObject }[];
  onComparisonConfigurationChange(configurationId: string): void;
  onTemplateChange(slotId: string, templateId: string): void;
  onChange(definition: JsonObject): void;
}

export function StructuredRunConfigurationEditor({
  definition,
  agentSlots,
  providers,
  templates,
  selectedTemplates,
  comparisonConfigurationId,
  comparisonDefinitions,
  onComparisonConfigurationChange,
  onTemplateChange,
  onChange,
}: StructuredRunConfigurationEditorProps) {
  const comparisonDefinition = comparisonDefinitions.find(({ configurationId }) => configurationId === comparisonConfigurationId)?.definition;
  const connectionDriven = providers.length === 0 || providers.some((provider) => provider.connectionDriven);
  const connections = providers.flatMap((provider) => (provider.authProviderOptions ?? []).map((connection) => ({ ...connection, provider })));

  function updatePolicy(slotId: string, policy: JsonObject) {
    onChange(withAgentPolicy(definition, slotId, policy));
  }

  return <section aria-label="Structured run configuration editor" className="space-y-4">
    <div className="grid gap-3 rounded-lg border bg-muted/20 p-4 md:grid-cols-2">
      <Field name="definition.configurationId" className="space-y-1 text-sm font-medium">
              Configuration ID
        <Input
          aria-label="Configuration ID"
          value={stringValue(definition.configurationId)}
          onChange={(event) => onChange({ ...definition, configurationId: event.target.value })}
        />
      </Field>
      <Field name="comparison" className="space-y-1 text-sm font-medium">
              Compare with existing configuration
        <Select
          aria-label="Compare with existing configuration"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={comparisonConfigurationId}
          onChange={(event) => onComparisonConfigurationChange(event.target.value)}
        >
          <option value="">Do not compare</option>
          {comparisonDefinitions.map(({ configurationId }) => <option key={configurationId} value={configurationId}>{configurationId}</option>)}
        </Select>
      </Field>
      <p className="text-sm text-muted-foreground md:col-span-2">Publishing creates a complete immutable version. Comparison is read-only and never changes this draft.</p>
    </div>

    <div className="space-y-4">
      {agentSlots.map((slot) => {
        const policy = agentPolicy(definition, slot.slotId) ?? emptyPolicy(providers[0]);
        const execution = objectValue(policy.execution);
        const providerId = stringValue(execution.provider);
        const descriptor = providers.find((candidate) => candidate.providerId === providerId);
        const parameters = objectValue(execution.parameters);
        const requiredModelProvider = modelProviderForAuthentication(
          descriptor,
          stringValue(execution.authProvider),
        );
        const selectedTemplateId = selectedTemplates[slot.slotId] ?? "";
        const comparisonPolicy = agentPolicy(comparisonDefinition, slot.slotId);
        const comparisonTemplateId = templateIdForSlot(comparisonDefinition, slot.slotId);
        return <div key={slot.slotId} className={comparisonDefinition ? "grid gap-4 xl:grid-cols-2" : ""}>
        <Card>
          <CardHeader className="gap-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle>{slot.title}</CardTitle>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{slot.slotId}</p>
              </div>
              <Badge>{descriptor?.displayName ?? providerId}</Badge>
            </div>
            {slot.description ? <p className="text-sm text-muted-foreground">{slot.description}</p> : null}
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {connectionDriven ? <Field name={`definition.agents.${slot.slotId}.execution.authProvider`} className="space-y-1 text-sm font-medium md:col-span-2">
              Connection
              <Select aria-label={`${slot.title} Connection`} className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={connections.some((connection) => connection.value === execution.authProvider && connection.provider.providerId === providerId) ? stringValue(execution.authProvider) : ""}
                onChange={(event) => {
                  const connection = connections.find(({ value }) => value === event.target.value);
                  if (connection) updatePolicy(slot.slotId, withConnection(policy, connection.provider, connection.value));
                }}>
                <option value="" disabled>Choose an active Connection…</option>
                {connections.map((connection) => <option key={connection.value} value={connection.value}>{connection.label} · {connection.provider.displayName}</option>)}
              </Select>
              {!connections.some((connection) => connection.value === execution.authProvider && connection.provider.providerId === providerId)
                ? <p role="alert">This slot needs an active compatible Connection. Choose one here or add it in Connections.</p>
                : <p className="text-xs text-muted-foreground">{descriptor?.displayName} parameter schema v{descriptor?.schemaVersion}. Test login and model access in Connections before invoking.</p>}
            </Field> : null}
            <Field name={`definition.agentTemplateProvenance.${slot.slotId}`} className="space-y-1 text-sm font-medium md:col-span-2">
              Agent Template
              <Select
                aria-label={`${slot.title} Agent Template`}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={!connectionDriven || templates.some((template) => template.templateId === selectedTemplateId && template.redactedDefinition.providerSchema.executionProvider === providerId) ? selectedTemplateId : ""}
                onChange={(event) => onTemplateChange(slot.slotId, event.target.value)}
              >
                <option value="">Choose a template…</option>
                {templates.filter((template) => !connectionDriven || template.redactedDefinition.providerSchema.executionProvider === providerId).map((template) => <option key={template.templateId} value={template.templateId}>
                  {template.title} · {template.redactedDefinition.providerSchema.executionProvider}
                </option>)}
              </Select>
            </Field>
            <Field name={`definition.agents.${slot.slotId}.execution.provider`} className="space-y-1 text-sm font-medium">
              Runtime provider
              <Input aria-label={`${slot.title} runtime provider`} value={descriptor?.displayName ?? providerId} disabled />
            </Field>
            {!connectionDriven ? <Field name={`definition.agents.${slot.slotId}.execution.authProvider`} className="space-y-1 text-sm font-medium">
              Authentication
              <SuggestionSelect
                aria-label={`${slot.title} authentication`}
                value={stringValue(execution.authProvider)}
                suggestions={descriptor?.allowsCustomAuthProvider === false
                  ? declaredAuthSuggestions(descriptor)
                  : authSuggestions(providerId, descriptor, templates, comparisonDefinitions)}
                allowsCustomValue={descriptor?.allowsCustomAuthProvider ?? true}
                onValueChange={(value) => updatePolicy(
                  slot.slotId,
                  withAuthenticationProvider(policy, descriptor, value),
                )}
              />
            </Field> : null}
            {descriptor?.fields.map((field) => <Field name={`definition.agents.${slot.slotId}.execution.parameters.${field.key}`} key={field.key} className="space-y-1 text-sm font-medium">
              {field.label}
              {field.kind === "enum" ? <Select
                aria-label={`${slot.title} ${field.label}`}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={stringValue(parameters[field.key])}
                onChange={(event) => updatePolicy(slot.slotId, withParameter(policy, field.key, event.target.value))}
              >
                {!field.required ? <option value="">Default</option> : null}
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select> : <SuggestionSelect
                aria-label={`${slot.title} ${field.label}`}
                placeholder={field.placeholder}
                value={stringValue(parameters[field.key])}
                suggestions={parameterSuggestions(
                  providerId,
                  field.key,
                  [
                    ...(field.key === "provider" && requiredModelProvider
                      ? [{ value: requiredModelProvider }]
                      : [
                        ...(field.suggestions ?? []),
                        ...(field.conditionalSuggestions ?? [])
                          .filter(({ parameterKey, parameterValue }) => parameters[parameterKey] === parameterValue)
                          .flatMap(({ options }) => options),
                      ]),
                  ],
                  templates,
                  comparisonDefinitions,
                  field.allowsCustomValue,
                )}
                allowsCustomValue={field.allowsCustomValue}
                onValueChange={(value) => updatePolicy(slot.slotId, withParameter(policy, field.key, value))}
              />}
            </Field>)}
            <Field name={`definition.agents.${slot.slotId}.timeoutMs`} className="space-y-1 text-sm font-medium">
              Timeout in minutes
              <Input
                aria-label={`${slot.title} timeout in minutes`}
                type="number"
                min="1"
                value={String(Math.max(1, Math.round(numberValue(policy.timeoutMs, 300_000) / 60_000)))}
                onChange={(event) => updatePolicy(slot.slotId, {
                  ...policy,
                  timeoutMs: Math.max(1, Number(event.target.value) || 1) * 60_000,
                })}
              />
            </Field>
          </CardContent>
        </Card>
        {comparisonDefinition ? <ComparisonAgentSlotCard
          slot={slot}
          configurationId={comparisonConfigurationId}
          policy={comparisonPolicy}
          currentPolicy={policy}
          templateId={comparisonTemplateId}
          currentTemplateId={selectedTemplateId}
          providers={providers}
        /> : null}
        </div>;
      })}
    </div>
  </section>;
}

function ComparisonAgentSlotCard(props: {
  slot: AgentSlotDto;
  configurationId: string;
  policy: JsonObject | undefined;
  currentPolicy: JsonObject;
  templateId: string;
  currentTemplateId: string;
  providers: readonly ExecutionProviderEditorDescriptorDto[];
}) {
  if (!props.policy) {
    return <Card aria-label={`${props.slot.title} comparison`} className="border-amber-500/60 bg-amber-500/5">
      <CardHeader><div><CardTitle>Compared with {props.configurationId}</CardTitle><p className="mt-1 text-sm text-muted-foreground">{props.slot.title}</p></div><Badge variant="warning">Missing slot</Badge></CardHeader>
      <CardContent><p className="text-sm">This Agent Slot is not configured in the compared configuration.</p></CardContent>
    </Card>;
  }
  const fields = comparisonFields(props.policy, props.currentPolicy, props.templateId, props.currentTemplateId, props.providers);
  const changed = fields.filter((field) => field.different).length;
  return <Card aria-label={`${props.slot.title} comparison`}>
    <CardHeader className="gap-2">
      <div><CardTitle>Compared with {props.configurationId}</CardTitle><p className="mt-1 text-sm text-muted-foreground">{props.slot.title} · view only</p></div>
      <Badge variant={changed === 0 ? "success" : "warning"}>{changed === 0 ? "Matches draft" : `${changed} changed`}</Badge>
    </CardHeader>
    <CardContent className="grid gap-3 md:grid-cols-2">
      {fields.map((field) => <div
        key={field.key}
        aria-label={`${props.slot.title} compared ${field.label}`}
        data-different={field.different || undefined}
        className={`rounded-md border p-3 ${field.different ? "border-amber-500/60 bg-amber-500/10" : "bg-muted/20"} ${field.wide ? "md:col-span-2" : ""}`}
      >
        <div className="flex items-center justify-between gap-2"><p className="text-sm font-medium">{field.label}</p>{field.different ? <Badge variant="warning">Draft: {display(field.current)}</Badge> : null}</div>
        <p className="mt-1 break-words text-sm">{display(field.value)}</p>
      </div>)}
    </CardContent>
  </Card>;
}

function comparisonFields(
  before: JsonObject,
  after: JsonObject,
  beforeTemplateId: string,
  afterTemplateId: string,
  providers: readonly ExecutionProviderEditorDescriptorDto[],
): Array<{ key: string; label: string; value: JsonValue | undefined; current: JsonValue | undefined; different: boolean; wide?: boolean }> {
  const beforeExecution = objectValue(before.execution);
  const afterExecution = objectValue(after.execution);
  const beforeParameters = objectValue(beforeExecution.parameters);
  const afterParameters = objectValue(afterExecution.parameters);
  const beforeProviderId = stringValue(beforeExecution.provider);
  const afterProviderId = stringValue(afterExecution.provider);
  const beforeDescriptor = providers.find((provider) => provider.providerId === beforeProviderId);
  const afterDescriptor = providers.find((provider) => provider.providerId === afterProviderId);
  const parameterKeys = [...new Set([
    ...(beforeDescriptor?.fields.map(({ key }) => key) ?? []),
    ...(afterDescriptor?.fields.map(({ key }) => key) ?? []),
    ...Object.keys(beforeParameters),
    ...Object.keys(afterParameters),
  ])];
  const field = (key: string, label: string, value: JsonValue | undefined, current: JsonValue | undefined, wide = false, trackDifference = true) => ({
    key,
    label,
    value,
    current,
    different: trackDifference && JSON.stringify(value) !== JSON.stringify(current),
    wide,
  });
  return [
    field("agent-template", "Agent Template", beforeTemplateId, afterTemplateId, true, false),
    field("runtime-provider", "Runtime provider", beforeDescriptor?.displayName ?? beforeProviderId, afterDescriptor?.displayName ?? afterProviderId),
    field("authentication", "Authentication", beforeExecution.authProvider, afterExecution.authProvider),
    ...parameterKeys.map((key) => field(
      `parameter-${key}`,
      beforeDescriptor?.fields.find((candidate) => candidate.key === key)?.label
        ?? afterDescriptor?.fields.find((candidate) => candidate.key === key)?.label
        ?? key,
      beforeParameters[key],
      afterParameters[key],
    )),
    field("timeout", "Timeout in minutes", timeoutMinutes(before.timeoutMs), timeoutMinutes(after.timeoutMs)),
  ];
}

function timeoutMinutes(value: JsonValue | undefined): number {
  return Math.max(1, Math.round(numberValue(value, 300_000) / 60_000));
}

function emptyPolicy(descriptor?: ExecutionProviderEditorDescriptorDto): JsonObject {
  if (!descriptor) return { timeoutMs: 300_000, execution: { provider: "", authProvider: "", parameters: {} } };
  return policyForProvider({ timeoutMs: 300_000, execution: { parameters: {} } }, descriptor);
}

function policyForProvider(
  current: JsonObject,
  descriptor?: ExecutionProviderEditorDescriptorDto,
): JsonObject {
  if (!descriptor) return current;
  const currentExecution = objectValue(current.execution);
  const currentParameters = objectValue(currentExecution.parameters);
  const parameters = Object.fromEntries(descriptor.fields.map((field) => [
    field.key,
    currentParameters[field.key] ?? (field.kind === "string" ? field.defaultValue ?? (field.required ? field.suggestions?.[0]?.value ?? "" : "") : field.required ? field.options[0]?.value ?? "" : ""),
  ]).filter(([, value]) => value !== ""));
  return {
    ...current,
    timeoutMs: numberValue(current.timeoutMs, 300_000),
    execution: {
      provider: descriptor.providerId,
      authProvider: descriptor.defaultAuthProviderId,
      parameters,
    },
  };
}

function withParameter(policy: JsonObject, key: string, value: string): JsonObject {
  const execution = objectValue(policy.execution);
  const parameters = objectValue(execution.parameters);
  const nextParameters = { ...parameters };
  if (value === "") delete nextParameters[key]; else nextParameters[key] = value;
  return { ...policy, execution: { ...execution, parameters: nextParameters } };
}

export function withAuthenticationProvider(
  policy: JsonObject,
  descriptor: ExecutionProviderEditorDescriptorDto | undefined,
  authProvider: string,
): JsonObject {
  const execution = objectValue(policy.execution);
  const parameters = { ...objectValue(execution.parameters) };
  const requiredModelProvider = modelProviderForAuthentication(descriptor, authProvider);
  if (requiredModelProvider && descriptor?.fields.some((field) => field.key === "provider")) {
    parameters.provider = requiredModelProvider;
    const models = modelOptions(descriptor, requiredModelProvider);
    if (models.length > 0 && !models.includes(stringValue(parameters.model))) {
      parameters.model = models[0]!;
    }
  }
  return { ...policy, execution: { ...execution, authProvider, parameters } };
}

function withConnection(policy: JsonObject, descriptor: ExecutionProviderEditorDescriptorDto, authProvider: string): JsonObject {
  const execution = objectValue(policy.execution);
  // Values belonging to a different runtime/model provider are not portable defaults.
  const sameType = execution.provider === descriptor.providerId
    && modelProviderForAuthentication(descriptor, stringValue(execution.authProvider)) === modelProviderForAuthentication(descriptor, authProvider);
  const next = sameType ? policy : policyForProvider({ ...policy, execution: { parameters: {} } }, descriptor);
  return withAuthenticationProvider(next, descriptor, authProvider);
}

function modelProviderForAuthentication(
  descriptor: ExecutionProviderEditorDescriptorDto | undefined,
  authProvider: string,
): string | undefined {
  return descriptor?.authProviderOptions
    ?.find(({ value }) => value === authProvider)
    ?.modelProvider;
}

function modelOptions(
  descriptor: ExecutionProviderEditorDescriptorDto | undefined,
  modelProvider: string,
): string[] {
  const modelField = descriptor?.fields.find((field) => field.key === "model" && field.kind === "string");
  if (!modelField || modelField.kind !== "string") return [];
  return uniqueStrings([
    ...(modelField.suggestions?.map(({ value }) => value) ?? []),
    ...(modelField.conditionalSuggestions ?? [])
      .filter(({ parameterKey, parameterValue }) => parameterKey === "provider" && parameterValue === modelProvider)
      .flatMap(({ options }) => options.map(({ value }) => value)),
  ]);
}

function withAgentPolicy(definition: JsonObject, slotId: string, policy: JsonObject): JsonObject {
  return { ...definition, agents: { ...objectValue(definition.agents), [slotId]: policy } };
}

function agentPolicy(definition: JsonObject | undefined, slotId: string): JsonObject | undefined {
  if (!definition) return undefined;
  const candidate = objectValue(definition.agents)[slotId];
  return isObject(candidate) ? candidate : undefined;
}

function templateIdForSlot(definition: JsonObject | undefined, slotId: string): string {
  if (!definition) return "";
  return stringValue(objectValue(objectValue(definition.agentTemplateProvenance)[slotId]).templateId);
}

function SuggestionSelect(props: {
  "aria-label": string;
  value: string;
  suggestions: readonly string[];
  allowsCustomValue: boolean;
  placeholder?: string;
  onValueChange(value: string): void;
}) {
  const customId = useId();
  const custom = props.allowsCustomValue && (props.value === "" || !props.suggestions.includes(props.value));
  return <div className="space-y-2">
    <Select
      aria-label={props["aria-label"]}
      className="h-9 w-full rounded-md border bg-background px-3 text-sm"
      value={custom ? "__custom__" : props.value}
      onChange={(event) => props.onValueChange(event.target.value === "__custom__" ? "" : event.target.value)}
    >
      {!custom && !props.suggestions.includes(props.value) ? <option value={props.value} disabled>{props.value ? `${props.value} (unavailable)` : "Choose a value…"}</option> : null}
      {props.suggestions.map((value) => <option key={value} value={value}>{value}</option>)}
      {props.allowsCustomValue ? <option value="__custom__">Custom…</option> : null}
    </Select>
    {custom ? <Input id={customId}
      aria-label={`${props["aria-label"]} custom value`}
      value={props.value}
      placeholder={props.placeholder}
      onChange={(event) => props.onValueChange(event.target.value)}
    /> : null}
  </div>;
}

function declaredAuthSuggestions(
  descriptor: ExecutionProviderEditorDescriptorDto,
): string[] {
  return uniqueStrings([
    ...(descriptor.authProviderOptions?.map(({ value }) => value) ?? []),
    descriptor.defaultAuthProviderId,
  ]);
}

function authSuggestions(
  providerId: string,
  descriptor: ExecutionProviderEditorDescriptorDto | undefined,
  templates: readonly AgentTemplateDefinitionDto[],
  definitions: readonly { definition: JsonObject }[],
): string[] {
  return uniqueStrings([
    ...(descriptor?.authProviderOptions?.map(({ value }) => value) ?? []),
    descriptor?.defaultAuthProviderId,
    ...templates.filter((template) => template.redactedDefinition.providerSchema.executionProvider === providerId)
      .map((template) => objectValue(template.redactedDefinition.policy.execution).authProvider),
    ...definitionPolicies(definitions).filter((policy) => objectValue(policy.execution).provider === providerId)
      .map((policy) => objectValue(policy.execution).authProvider),
  ]);
}

function parameterSuggestions(
  providerId: string,
  key: string,
  declared: readonly { value: string }[],
  templates: readonly AgentTemplateDefinitionDto[],
  definitions: readonly { definition: JsonObject }[],
  allowsCustomValue: boolean,
): string[] {
  return uniqueStrings([
    ...declared.map(({ value }) => value),
    ...(allowsCustomValue ? [
    ...templates.filter((template) => template.redactedDefinition.providerSchema.executionProvider === providerId)
      .map((template) => objectValue(objectValue(template.redactedDefinition.policy.execution).parameters)[key]),
    ...definitionPolicies(definitions).filter((policy) => objectValue(policy.execution).provider === providerId)
      .map((policy) => objectValue(objectValue(policy.execution).parameters)[key]),
    ] : []),
  ]);
}

function definitionPolicies(definitions: readonly { definition: JsonObject }[]): JsonObject[] {
  return definitions.flatMap(({ definition }) => Object.values(objectValue(definition.agents)).filter(isObject));
}

function uniqueStrings(values: readonly (JsonValue | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))].sort();
}

function objectValue(value: JsonValue | undefined): JsonObject {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function display(value: JsonValue | undefined): string {
  if (value === undefined || value === "") return "default";
  if (typeof value === "number" && value >= 60_000) return `${Math.round(value / 60_000)} min`;
  return String(value);
}
