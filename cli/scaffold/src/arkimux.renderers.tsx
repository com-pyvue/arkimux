import { renderToStaticMarkup } from "react-dom/server";
import type { LocalResultView } from "@com-pyvue/agent-execution-local";
import { WeatherAdvisorResult } from "../workflows/weather-advisor/src/result-renderer.js";
import { GraphInvocationResult } from "../workflows/graph-invocation/src/result-renderer.js";

export const rendererDeclarations = [{
  workflowId: "weather-advisor", resultKind: "weather-advisor.result", payloadSchemaVersion: 2,
  renderer: { file: "workflows/weather-advisor/src/result-renderer.tsx", export: "WeatherAdvisorResult" },
}, {
  workflowId: "graph-invocation", resultKind: "graph-invocation.result", payloadSchemaVersion: 1,
  renderer: { file: "workflows/graph-invocation/src/result-renderer.tsx", export: "GraphInvocationResult" },
}];

export const resultViews: readonly LocalResultView[] = [{
  resultKind: "weather-advisor.result", payloadSchemaVersion: 2,
  render: (payload) => renderToStaticMarkup(<WeatherAdvisorResult payload={payload} />),
}, {
  resultKind: "graph-invocation.result", payloadSchemaVersion: 1,
  render: (payload) => renderToStaticMarkup(<GraphInvocationResult payload={payload} />),
}];
