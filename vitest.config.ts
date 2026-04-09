import { defineConfig } from "vitest/config"
import solidPlugin from "vite-plugin-solid"

export default defineConfig({
  plugins: [solidPlugin()],
  resolve: {
    alias: {
      "@atelier/core": new URL("./packages/core/src", import.meta.url).pathname,
      "@atelier/ui": new URL("./packages/ui/src", import.meta.url).pathname,
      "@atelier/server": new URL("./server/src", import.meta.url).pathname,
      vscode: new URL("./extension/src/__mocks__/vscode.ts", import.meta.url).pathname,
      "solid-js/web": new URL("./packages/ui/node_modules/solid-js/web", import.meta.url).pathname,
      "solid-js/store": new URL("./packages/ui/node_modules/solid-js/store", import.meta.url).pathname,
      "solid-js": new URL("./packages/ui/node_modules/solid-js", import.meta.url).pathname,
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
    ],
    poolMatchGlobs: [
      ["server/tests/**/*.test.ts", "forks"],
      ["tests/integration/**/*.test.ts", "forks"],
      ["tests/e2e/**/*.test.ts", "forks"],
    ],
    server: {
      deps: {
        external: [/^bun:.*/],
      },
    },
  },
})
