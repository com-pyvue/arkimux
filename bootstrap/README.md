# create-arkimux

This Apache-2.0 bootstrap calls the project generator in exactly
`@com-pyvue/arkimux@0.1.0-alpha.9`. It contains no scaffold or server lifecycle
implementation. The generator owns project files, installation, and next steps.

Requires Node.js 24.0.0 or newer.

For installations using this version from an npm registry:

```sh
npm create arkimux@0.1.0-alpha.2 my-agent-app
```

The equivalent command is `npx create-arkimux@0.1.0-alpha.2 my-agent-app`.

Use `--help` for usage. Failures print the generator's error and return a nonzero
exit code. If the generator is unavailable, reinstall this bootstrap with its
dependencies and retry.
