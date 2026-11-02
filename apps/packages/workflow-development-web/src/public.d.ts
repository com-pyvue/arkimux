import type { RunApiClientOptions } from "@com-pyvue/agent-execution-run-contract";
import type { AnyResultReactPlugin } from "@com-pyvue/agent-execution-result-presentation";
import type { ReactElement } from "react";

export interface WorkflowDevelopmentWebAppProps {
  apiBaseUrl: string;
  resultPlugins?: readonly AnyResultReactPlugin[];
  sessionKey?: string;
  requestInit?: RunApiClientOptions["requestInit"];
}

export declare function WorkflowDevelopmentWebApp(
  props: WorkflowDevelopmentWebAppProps,
): ReactElement;
