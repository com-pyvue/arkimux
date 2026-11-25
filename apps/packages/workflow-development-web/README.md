# Workflow development web host

Use `WorkflowDevelopmentWebApp` to display Local Runs in your React app:

```tsx
import { WorkflowDevelopmentWebApp } from "@com-pyvue/agent-execution-workflow-development-web";
import "@com-pyvue/agent-execution-workflow-development-web/styles.css";

export default function App() {
  return <WorkflowDevelopmentWebApp apiBaseUrl="http://127.0.0.1:8787" />;
}
```

Set `apiBaseUrl` to the API address printed by Local. No custom renderer is
required. If your app defines result renderers, pass them in the optional
`resultPlugins` array. Vite includes those modules in your app's bundle; the
host does not download renderer code at runtime.
