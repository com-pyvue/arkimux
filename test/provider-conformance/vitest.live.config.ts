import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const testRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  cacheDir: path.join(tmpdir(), "arkimux-provider-live-conformance-vitest-cache"),
  root: testRoot,
  test: {
    environment: "node",
    include: ["live/*.acceptance.test.ts"],
    fileParallelism: false,
    maxConcurrency: 1,
    passWithNoTests: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
