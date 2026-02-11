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
    name: "component",
    environment: "jsdom",
    include: ["test/component/**/*.test.tsx"],
    setupFiles: ["test/setup/component.ts"],
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["components/proposals/**/*.tsx"],
      exclude: ["components/proposals/status-badge.tsx"],
      thresholds: {
        lines: 70,
      },
    },
  },
})
