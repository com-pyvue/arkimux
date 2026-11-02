import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { RuntimeConfiguredAgentExecutionWebApp } from "./index.tsx";
import "./styles.css";
import { watchLocalResultPlugins } from "./localResultPlugins.tsx";
import type { AnyResultReactPlugin } from "@com-pyvue/agent-execution-result-presentation";
import { LocalBrowserErrorReporting } from "./localBrowserErrorReporting.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Agent Execution web host requires #root.");

const localApiBaseUrl = import.meta.env.VITE_AGENT_EXECUTION_API_BASE_URL ?? (import.meta.env.DEV ? "http://localhost:8787" : globalThis.location.origin);
createRoot(root).render(<StrictMode>{
  <LocalBrowserErrorReporting apiBaseUrl={localApiBaseUrl} session={{ cacheKey: "local-fixed-identity", requestInit: () => ({ credentials: "include" }) }}>
    <ConfiguredApplication />
  </LocalBrowserErrorReporting>}</StrictMode>);

function ConfiguredApplication() {
  const [localPlugins, setLocalPlugins] = useState<AnyResultReactPlugin[]>([]);
  const [rendererIssue, setRendererIssue] = useState<string>();
  const [rendererTone, setRendererTone] = useState<"error" | "warning">();
  useEffect(() => { return watchLocalResultPlugins(localApiBaseUrl, (plugins, issue, tone) => { setLocalPlugins(plugins); setRendererIssue(issue); setRendererTone(tone); }); }, [localApiBaseUrl]);
  return <RuntimeConfiguredAgentExecutionWebApp
    apiBaseUrl={localApiBaseUrl}
    session={{ cacheKey: import.meta.env.VITE_AGENT_EXECUTION_SESSION_KEY ?? "local-fixed-identity", requestInit: () => ({ credentials: "include" }) }}
    resultPlugins={localPlugins}
    resultRendererUnavailableReason={rendererIssue}
    resultRendererUnavailableTone={rendererTone}
  />;
}
