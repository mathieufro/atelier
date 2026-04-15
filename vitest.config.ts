import { defineConfig } from "vitest/config"
import solidPlugin from "vite-plugin-solid"
import { fileURLToPath } from "node:url"

function resolvePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url))
}

export default defineConfig({
  plugins: [solidPlugin()],
  resolve: {
    alias: {
      "@atelier/core": resolvePath("./packages/core/src"),
      "@atelier/ui": resolvePath("./packages/ui/src"),
      "@atelier/server": resolvePath("./server/src"),
      vscode: resolvePath("./extension/src/__mocks__/vscode.ts"),
      "solid-js/web": resolvePath("./packages/ui/node_modules/solid-js/web"),
      "solid-js/store": resolvePath("./packages/ui/node_modules/solid-js/store"),
      "solid-js": resolvePath("./packages/ui/node_modules/solid-js"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [],
    include: ["packages/*/tests/**/*.test.{ts,tsx}", "packages/ui/src/**/*.test.{ts,tsx}", "extension/tests/**/*.test.ts", "server/tests/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/e2e/**/*.test.ts"],
    exclude: ["extension/src/e2e/**", "server/src/e2e/**", "tests/e2e/scenarios/**"],
    environmentMatchGlobs: [
      ["server/tests/**/*.test.ts", "node"],
      ["tests/integration/**/*.test.ts", "node"],
      ["tests/e2e/**/*.test.ts", "node"],
      ["packages/*/tests/**/*.test.ts", "node"],
    ],
    poolMatchGlobs: [
      ["server/tests/**/*.test.ts", "forks"],
      ["tests/integration/**/*.test.ts", "forks"],
      ["tests/e2e/**/*.test.ts", "forks"],
      ["packages/*/tests/**/*.test.ts", "forks"],
    ],
    server: {
      deps: {
        external: [/^bun:.*/],
      },
    },
  },
})
