# Workflow development web host

This React component is used within the ArkiMux repository workspace. It is
not available for public npm installation. In the workspace, use
`WorkflowDevelopmentWebApp` to display Local Runs:

```tsx
import { WorkflowDevelopmentWebApp } from "@com-pyvue/agent-execution-workflow-development-web";
import "@com-pyvue/agent-execution-workflow-development-web/styles.css";

export default function App() {
  return <WorkflowDevelopmentWebApp apiBaseUrl="http://127.0.0.1:8787" />;
}
```

Set `apiBaseUrl` to the API address printed by Local. Local accepts browser
requests from its own origin. If you serve your React app separately, use
`http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173`, or
`http://127.0.0.1:4173`. Setting `apiBaseUrl` does not grant access from a
different origin.

No custom renderer is required. If your app defines result renderers, pass them in the optional
`resultPlugins` array. Vite includes those modules in your app's bundle; the
host does not download renderer code at runtime.
