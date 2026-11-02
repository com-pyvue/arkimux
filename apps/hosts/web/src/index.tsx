import { useEffect, useMemo, useState } from "react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RunApiClient, type RunApiClientOptions } from "@com-pyvue/agent-execution-run-contract";
import { RoleApiClient } from "@com-pyvue/agent-execution-role-contract";
import { RunConfigurationApiClient } from "@com-pyvue/agent-execution-run-configuration-contract";
import { AgentTemplateApiClient } from "@com-pyvue/agent-execution-agent-template-contract";
import { AgentAuthenticationApiClient } from "@com-pyvue/agent-execution-agent-authentication-contract";
import { UserApiClient } from "@com-pyvue/agent-execution-user-contract";
import { ResultRendererRegistry, type AnyResultReactPlugin } from "@com-pyvue/agent-execution-result-presentation";
import { RunDetailPage, RunFeature, WorkflowCatalogFeature, WorkflowDetailFeature, workflowDevelopmentRunColumns } from "@com-pyvue/agent-execution-run-react";
import { RoleFeature } from "@com-pyvue/agent-execution-role-react";
import { AgentTemplateFeature } from "@com-pyvue/agent-execution-agent-template-react";
import { AgentAuthenticationFeature } from "@com-pyvue/agent-execution-agent-authentication-react";
import { UserFeature } from "@com-pyvue/agent-execution-user-react";
import { Button, Input, Toaster, ErrorNotification } from "@com-pyvue/agent-execution-ui";
import { LocalWorkflowRegistryNotice } from "./localWorkflowRegistry.tsx";
import { LocalPrivacySettings, LocalPrivacyTerms, LocalUsageSharingPrompt } from "./localUsageSharing.tsx";
import { LocalDiagnosticsSettings } from "./localFrameworkDiagnostics.tsx";
import {
  validateAgentExecutionUiConfiguration,
  type AgentExecutionUiConfiguration,
  type AgentExecutionUiFeature,
} from "@com-pyvue/agent-execution-ui-profile-contract";

export interface AuthenticatedWebSession {
  cacheKey: string;
  requestInit?: RunApiClientOptions["requestInit"];
}

export interface AgentExecutionWebAppProps {
  apiBaseUrl: string;
  session: AuthenticatedWebSession;
  resultPlugins: readonly AnyResultReactPlugin[];
  resultRendererUnavailableReason?: string;
  resultRendererUnavailableTone?: "error" | "warning";
  uiConfiguration: AgentExecutionUiConfiguration;
  onSignOut?(): void;
}

export interface RuntimeConfiguredAgentExecutionWebAppProps extends Omit<AgentExecutionWebAppProps, "uiConfiguration"> {
  fetch?: typeof fetch;
}

export function AgentExecutionWebApp(props: AgentExecutionWebAppProps) {
  return <BrowserRouter><SessionRunApplication key={props.session.cacheKey} {...props} /></BrowserRouter>;
}

export function RuntimeConfiguredAgentExecutionWebApp(props: RuntimeConfiguredAgentExecutionWebAppProps) {
  const [configuration, setConfiguration] = useState<AgentExecutionUiConfiguration>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const supplied = await props.session.requestInit?.() ?? {};
        const headers = new Headers(supplied.headers);
        headers.set("accept", "application/json");
        const response = await (props.fetch ?? globalThis.fetch)(
          `${props.apiBaseUrl.replace(/\/$/, "")}/api/v1/ui-configuration`,
          { ...supplied, headers, signal: controller.signal },
        );
        if (!response.ok) throw new Error(`UI configuration request failed with status ${response.status}.`);
        setConfiguration(validateAgentExecutionUiConfiguration(await response.json()));
      } catch (caught) {
        if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
    return () => controller.abort();
  }, [props.apiBaseUrl, props.fetch, props.session.cacheKey]);
  if (error) return <><Toaster /><UiConfigurationBoundary title="Unable to load portal configuration" detail={error} /></>;
  if (!configuration) return <UiConfigurationBoundary title="Loading portal…" />;
  const { fetch: _fetch, ...applicationProps } = props;
  return <AgentExecutionWebApp {...applicationProps} uiConfiguration={configuration} />;
}

function SessionRunApplication({ apiBaseUrl, session, resultPlugins, resultRendererUnavailableReason, resultRendererUnavailableTone, uiConfiguration, onSignOut }: AgentExecutionWebAppProps) {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: 1, staleTime: 5_000 } },
  }));
  const [runClient] = useState(() => new RunApiClient({ baseUrl: apiBaseUrl, requestInit: session.requestInit }));
  const [userClient] = useState(() => new UserApiClient({ baseUrl: apiBaseUrl, requestInit: session.requestInit }));
  const [roleClient] = useState(() => new RoleApiClient({ baseUrl: apiBaseUrl, requestInit: session.requestInit }));
  const [runConfigurationClient] = useState(() => new RunConfigurationApiClient({
    baseUrl: apiBaseUrl,
    requestInit: session.requestInit,
  }));
  const [agentTemplateClient] = useState(() => new AgentTemplateApiClient({ baseUrl: apiBaseUrl, requestInit: session.requestInit }));
  const [agentAuthenticationClient] = useState(() => new AgentAuthenticationApiClient({ baseUrl: apiBaseUrl, requestInit: session.requestInit }));
  const registry = useMemo(() => new ResultRendererRegistry(resultPlugins, { unavailableReason: resultRendererUnavailableReason, unavailableTone: resultRendererUnavailableTone }), [resultPlugins, resultRendererUnavailableReason, resultRendererUnavailableTone]);
  const features = new Set<AgentExecutionUiFeature>(uiConfiguration.features);
  const workflowDevelopment = uiConfiguration.profile === "workflow-development";
  const navigation = navigationItems(uiConfiguration);
  const landingRoute = workflowDevelopment
    ? features.has("agent-authentication") ? "/connections" : "/runs"
    : "/projections";
  return (
    <div className={theme === "dark" ? "dark min-h-screen bg-background text-foreground" : "min-h-screen bg-background text-foreground"}>
      <QueryClientProvider client={queryClient}>
        <Toaster />
        {workflowDevelopment ? <LocalUsageSharingPrompt apiBaseUrl={apiBaseUrl} session={session} /> : null}
        <div className="min-h-screen md:grid md:grid-cols-[16rem_minmax(0,1fr)]">
          <header className="flex items-center justify-between border-b px-4 py-3 md:hidden">
            <span className="font-semibold">Agent Execution</span>
            <Button
              variant="outline"
              aria-controls="agent-execution-navigation"
              aria-expanded={navigationOpen}
              onClick={() => setNavigationOpen((current) => !current)}
            >{navigationOpen ? "Close menu" : "Open menu"}</Button>
          </header>
          <aside
            id="agent-execution-navigation"
            className={`${navigationOpen ? "flex" : "hidden"} flex-col border-b bg-muted/30 p-4 md:sticky md:top-0 md:flex md:h-screen md:border-b-0 md:border-r`}
          >
            <div className="mb-6 hidden md:block">
              <p className="font-semibold">Agent Execution</p>
              <p className="text-sm text-muted-foreground">{workflowDevelopment ? "Workflow development" : "Operations portal"}</p>
            </div>
            <nav aria-label="Agent execution applications" className="flex flex-1 flex-col gap-1">
              {navigation.map(({ to, label }) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setNavigationOpen(false)}
                  className={({ isActive }) => `rounded-md px-3 py-2 text-sm font-medium ${isActive ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
                >{label}</NavLink>
              ))}
            </nav>
            <Button className="mt-4" variant="outline" onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}>
              Use {theme === "light" ? "dark" : "light"} theme
            </Button>
            {onSignOut ? <Button className="mt-2" variant="outline" onClick={onSignOut}>Sign out</Button> : null}
          </aside>
          <div className="min-w-0">
          {workflowDevelopment ? <LocalWorkflowRegistryNotice apiBaseUrl={apiBaseUrl} requestInit={session.requestInit} /> : null}
          <Routes>
            {features.has("runs") ? <Route path="/runs" element={<RunFeature
              client={runClient}
              resultRenderers={registry}
              columnPreferenceKey={session.cacheKey}
              defaultColumns={workflowDevelopment ? workflowDevelopmentRunColumns : undefined}
              renderRunLink={(executionId, label) => <Link className="font-medium underline underline-offset-4" to={`/runs/${encodeURIComponent(executionId)}`}>{label}</Link>}
            />} /> : null}
            {features.has("runs") ? <Route path="/runs/:executionId" element={<RoutedRunDetail client={runClient} registry={registry} />} /> : null}
            {features.has("users") ? <Route path="/users" element={<UserFeature client={userClient} />} /> : null}
            {features.has("roles") ? <Route path="/roles" element={<RoleFeature client={roleClient} />} /> : null}
            {features.has("agent-templates") ? <Route path="/agent-templates" element={<AgentTemplateFeature client={agentTemplateClient} />} /> : null}
            {features.has("agent-authentication") ? <Route path="/authentication" element={workflowDevelopment ? <Navigate to="/connections" replace /> : <AgentAuthenticationFeature client={agentAuthenticationClient} />} /> : null}
            {workflowDevelopment && features.has("agent-authentication") ? <Route path="/connections" element={<AgentAuthenticationFeature client={agentAuthenticationClient} connectionsFirst />} /> : null}
            {workflowDevelopment && features.has("workflows") ? <Route path="/workflows" element={<RoutedWorkflowCatalog runClient={runClient} />} /> : null}
            {workflowDevelopment && features.has("workflows") ? <Route path="/workflows/:workflowKind/:workflowVersion" element={<RoutedWorkflowDetail runClient={runClient} runConfigurationClient={runConfigurationClient} agentTemplateClient={agentTemplateClient} registry={registry} />} /> : null}
            {workflowDevelopment ? <Route path="/settings/privacy" element={<LocalPrivacySettings apiBaseUrl={apiBaseUrl} session={session} />} /> : null}
            {workflowDevelopment ? <Route path="/settings/privacy/terms" element={<LocalPrivacyTerms apiBaseUrl={apiBaseUrl} session={session} />} /> : null}
            {workflowDevelopment ? <Route path="/settings/diagnostics" element={<LocalDiagnosticsSettings apiBaseUrl={apiBaseUrl} session={session} />} /> : null}
            <Route path="*" element={<Navigate to={landingRoute} replace />} />
          </Routes>
          </div>
        </div>
      </QueryClientProvider>
    </div>
  );
}

function navigationItems(configuration: AgentExecutionUiConfiguration): Array<{ to: string; label: string }> {
  const features = new Set<AgentExecutionUiFeature>(configuration.features);
  const connectionsFirst = configuration.profile === "workflow-development" && features.has("agent-authentication");
  return [
    ...(connectionsFirst ? [{ to: "/connections", label: "Connections" }] : []),
    ...(features.has("runs") ? [{ to: "/runs", label: "Runs" }] : []),
    ...(features.has("users") ? [{ to: "/users", label: "Users" }] : []),
    ...(features.has("roles") ? [{ to: "/roles", label: "Roles" }] : []),
    ...(features.has("agent-templates") ? [{ to: "/agent-templates", label: "Agent Templates" }] : []),
    ...(features.has("agent-authentication") && !connectionsFirst ? [{ to: "/authentication", label: "Authentication" }] : []),
    ...(configuration.profile === "workflow-development" && features.has("workflows") ? [{ to: "/workflows", label: "Workflows" }] : []),
    ...(configuration.profile === "workflow-development" ? [{ to: "/settings/privacy", label: "Settings" }] : []),
  ];
}

function RoutedWorkflowCatalog(props: {
  runClient: RunApiClient;
}) {
  const navigate = useNavigate();
  return <WorkflowCatalogFeature
    {...props}
    onOpenWorkflow={({ workflow }) => navigate(`/workflows/${encodeURIComponent(workflow.kind)}/${workflow.version}`)}
  />;
}

function RoutedWorkflowDetail(props: {
  runClient: RunApiClient;
  runConfigurationClient: RunConfigurationApiClient;
  agentTemplateClient: AgentTemplateApiClient;
  registry: ResultRendererRegistry;
}) {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const { workflowKind, workflowVersion } = useParams();
  if (!workflowKind || !workflowVersion || !Number.isInteger(Number(workflowVersion))) {
    return <Navigate to="/workflows" replace />;
  }
  const workflowPath = `/workflows/${encodeURIComponent(workflowKind)}/${workflowVersion}`;
  const tab = search.get("tab") === "runs" ? "runs" : "configurations";
  return <WorkflowDetailFeature
    {...props}
    workflowKind={workflowKind}
    workflowVersion={Number(workflowVersion)}
    resultRenderers={props.registry}
    defaultRunColumns={workflowDevelopmentRunColumns}
    tab={tab}
    onTabChange={(next) => navigate(`${workflowPath}${next === "runs" ? "?tab=runs" : ""}`, { replace: true })}
    backLink={<Link className="font-medium underline underline-offset-4" to="/workflows">← Back to workflows</Link>}
    renderRunLink={(executionId, label) => <Link className="font-medium underline underline-offset-4" to={`/runs/${encodeURIComponent(executionId)}`}>{label}</Link>}
    onRunSubmitted={() => navigate(`${workflowPath}?tab=runs`)}
  />;
}

function UiConfigurationBoundary({ title, detail }: { title: string; detail?: string }) {
  return <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground"><section className="w-full max-w-md rounded-xl border bg-card p-8 shadow-sm"><h1 className="text-2xl font-semibold">{title}</h1>{detail ? <ErrorNotification description={detail} /> : null}</section></main>;
}

function RoutedRunDetail({ client, registry }: { client: RunApiClient; registry: ResultRendererRegistry }) {
  const navigate = useNavigate();
  const { executionId } = useParams();
  if (!executionId) return <Navigate to="/runs" replace />;
  return <RunDetailPage
    client={client}
    executionId={executionId}
    registry={registry}
    backLink={<Link className="font-medium underline underline-offset-4" to="/runs">← Back to runs</Link>}
    renderRunLink={(linkedExecutionId, label) => <Link className="font-medium underline underline-offset-4" to={`/runs/${encodeURIComponent(linkedExecutionId)}`}>{label}</Link>}
    onRunSubmitted={(newExecutionId) => navigate(`/runs/${encodeURIComponent(newExecutionId)}`)}
  />;
}
