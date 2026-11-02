import type { RunApiClientOptions } from "@com-pyvue/agent-execution-run-contract";
import type { AnyResultReactPlugin } from "@com-pyvue/agent-execution-result-presentation";
import { RuntimeConfiguredAgentExecutionWebApp } from "@com-pyvue/agent-execution-web-host";
import "./styles.css";

export interface WorkflowDevelopmentWebAppProps {
  apiBaseUrl: string;
  resultPlugins?: readonly AnyResultReactPlugin[];
  sessionKey?: string;
  requestInit?: RunApiClientOptions["requestInit"];
}

/**
 * Build-time workflow portal composition.
 *
 * Workflow repositories own the Vite application and supply renderer plugins.
 * The API host still owns authentication, authorization, run queries, and UI
 * profile selection.
 */
export function WorkflowDevelopmentWebApp({
  apiBaseUrl,
  resultPlugins = [],
  sessionKey = "local-workflow-development",
  requestInit = async () => ({ credentials: "include" }),
}: WorkflowDevelopmentWebAppProps) {
  return <RuntimeConfiguredAgentExecutionWebApp
    apiBaseUrl={apiBaseUrl}
    session={{ cacheKey: sessionKey, requestInit }}
    resultPlugins={resultPlugins}
  />;
}
