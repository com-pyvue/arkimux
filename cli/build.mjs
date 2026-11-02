import { spawnSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "..");
const dist = path.join(packageRoot, "dist");
const packages = path.join(packageRoot, "packages");
const npmCache = path.join(os.tmpdir(), "arkimux-cli-build-npm-cache");

await rm(dist, { recursive: true, force: true });
await rm(packages, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await mkdir(packages, { recursive: true });

await Promise.all([
  ["src/cli.ts", "dist/cli.js"],
  ["src/index.ts", "dist/index.js"],
  ["src/createProject.ts", "dist/create.js"],
  ["src/localServer.ts", "dist/local-server.js"],
  // The headless command resolves its worker beside the bundled CLI, not in a project package.
  ["../local/src/retainedAttemptWorker.ts", "dist/retained-attempt-worker.js"],
].map(async ([entry, output]) => build({
  entryPoints: [path.join(packageRoot, entry)],
  outfile: path.join(packageRoot, output),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: ["typescript-parser", "vite", "postcss"],
  sourcemap: "external", sourcesContent: false,
  logLevel: "info",
  banner: output.endsWith("cli.js") ? { js: "#!/usr/bin/env node" } : undefined,
})));
await copyFile(path.join(packageRoot, "src/public.d.ts"), path.join(dist, "index.d.ts"));
await chmod(path.join(dist, "cli.js"), 0o755);

// Remove artifacts from older Local builds before packaging an existing dist.
const localDist = path.join(repositoryRoot, "local/dist");
for (const file of ["cli-host", "local-diagnostic-ownership.json", "telemetry-diagnostics.json", "telemetry-diagnostic-manifest.json"]) {
  await rm(path.join(localDist, file), { recursive: true, force: true });
}

const candidateDirectories = ["core", "apps/packages/run/contract", "local"];
const candidatePackages = [];
for (const directory of candidateDirectories) {
  const stageParent = await mkdtemp(path.join(os.tmpdir(), "arkimux-candidate-package-"));
  const stage = path.join(stageParent, "package");
  try {
    await cp(path.join(repositoryRoot, directory), stage, {
      recursive: true,
      filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
    });
    if (directory === "local") {
      const manifestFile = path.join(stage, "package.json");
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      delete manifest.dependencies["@com-pyvue/agent-execution-core"];
      delete manifest.dependencies["@com-pyvue/agent-execution-run-contract"];
      await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    const packed = spawnSync("npm", ["pack", stage, "--pack-destination", packages, "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCache },
    });
    if (packed.status !== 0) throw new Error(`Could not pack ${directory}: ${packed.stderr || packed.stdout}`);
    const [result] = JSON.parse(packed.stdout);
    candidatePackages.push({
      name: result.name,
      version: result.version,
      file: result.filename,
      integrity: result.integrity,
    });
  } finally {
    await rm(stageParent, { recursive: true, force: true });
  }
}
await writeFile(path.join(packages, "candidate-packages.json"), `${JSON.stringify({
  schemaVersion: 1,
  packages: candidatePackages,
}, null, 2)}\n`);
