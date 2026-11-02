# Workflow development web host

This package provides the browser composition boundary used by workflow
repositories. It mounts the local Runs experience against an Agent Execution
API and accepts workflow-owned result renderers at build time.

```tsx
<WorkflowDevelopmentWebApp
  apiBaseUrl="http://127.0.0.1:8787"
  resultPlugins={[decisionBriefResultPlugin]}
/>
```

Import `@com-pyvue/agent-execution-workflow-development-web/styles.css` once in
the workflow application's browser entry point.

Renderer modules are compiled into the workflow application's own Vite bundle.
The host does not download or execute renderer code dynamically.
