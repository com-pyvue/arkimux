# Project work

Add workflow source under workflows/ and register it in src/arkimux.workflows.ts.
Register optional React result views in src/arkimux.renderers.tsx.
Keep the literal workflowDeclarations and rendererDeclarations arrays in those
registries in sync with the files, exports, result identities and agent slots.
Update each workflow's manifest.json with its required capabilities and limits.
Pass environmentFile from its static declaration when registering a manifest-
backed portable workflow. Its environment option must match that names-only file.
Published payload schemaVersion must match the declared result schema version.
Use public package imports and named durable steps. Keep runtime, Connection,
model, engine, and storage choices outside portable workflow source.
Keep provider keys out of source, prompts, fixtures, and results. Workflow
variables belong in ignored .env; environment.json declares names only.
Run npm run validate after edits. Restart the server after workflow or .env edits.
Renderer registry, imported renderer components and CSS update automatically;
the Local API stays running. A broken renderer leaves the original JSON usable.
Do not edit node_modules or ArkiMux internals to add a workflow.
Increment the workflow contract and affected step/effect definition versions
when changing their behavior. Interrupted runs must not resume against changed
definitions. Never change a published Run Configuration in place.

## Debug workflows safely

When asked to diagnose workflow logic, use the checked-in
`arkimux-workflow-debugger` skill at
`.agents/skills/arkimux-workflow-debugger/SKILL.md`. It drives the ArkiMux
Docker Mock Live Debugger and explains its required authorization, declared
mocks, breakpoint controls, verification loop, and report format.

Do not debug workflow logic through a normal Run, a real provider, credentials,
the network, or an IDE-only session. Mock-debug results are simulated. The
developer decides whether the supplied expectations describe the correct
business outcome.
