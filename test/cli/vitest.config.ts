import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    include: ["test/cli/**/*.test.ts"],
    environment: "node",
  },
});
