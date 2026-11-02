import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const testRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  cacheDir: path.join(tmpdir(), "code-capabilities-tests-vitest-cache"),
  root: testRoot,
  test: {
    environment: "node",
    include: ["*.test.ts"],
  },
});
