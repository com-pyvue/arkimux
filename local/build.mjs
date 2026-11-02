import { chmod, copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "..");
const dist = path.join(packageRoot, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [path.join(packageRoot, "src", "cli.ts")],
  outfile: path.join(dist, "cli.js"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: "external", sourcesContent: false,
  logLevel: "info",
  packages: "bundle",
  external: ["@napi-rs/keyring"],
  banner: { js: "#!/usr/bin/env node" },
});
await build({
  entryPoints: { index: path.join(packageRoot, "src", "index.ts"),
    "development-server": path.join(packageRoot, "src", "developmentServer.ts") },
  outdir: dist,
  splitting: true,
  chunkNames: "shared-[hash]",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: "external", sourcesContent: false,
  logLevel: "info",
  packages: "bundle",
  external: ["@napi-rs/keyring"],
});
await copyFile(path.join(packageRoot, "src", "public.d.ts"), path.join(dist, "index.d.ts"));
await build({
  entryPoints: [path.join(packageRoot, "src", "retainedAttemptWorker.ts")],
  outfile: path.join(dist, "retained-attempt-worker.js"),
  bundle: true, platform: "node", target: "node24", format: "esm", logLevel: "info", packages: "bundle", external: ["@napi-rs/keyring"],
  sourcemap: "external", sourcesContent: false,
});
await chmod(path.join(dist, "cli.js"), 0o755);
await build({entryPoints:{telemetry:path.join(packageRoot,'src/localEventTelemetry.ts'),'telemetry-state':path.join(packageRoot,'src/localTelemetryState.ts'),'telemetry-transport':path.join(packageRoot,'src/localTelemetryTransport.ts')},outdir:path.join(dist,'testing'),bundle:true,splitting:true,format:'esm',platform:'node',target:'node24',packages:'bundle',external:['@napi-rs/keyring']});
await Promise.all([
  cp(path.join(repositoryRoot, "apps", "dist", "hosts", "web"), path.join(dist, "web"), { recursive: true }),
  cp(path.join(repositoryRoot, "apps", "config"), path.join(dist, "config"), { recursive: true }),
]);
