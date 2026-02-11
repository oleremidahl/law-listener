import path from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
  test: {
    name: "unit",
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["lib/query.ts", "lib/pagination.ts", "lib/env.ts"],
      thresholds: {
        lines: 70,
      },
    },
  },
})
