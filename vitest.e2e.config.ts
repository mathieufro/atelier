import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["tests/e2e/scenarios/**/*.test.ts"],
    testTimeout: 180_000, // 3 min per test — real backends are slow
    hookTimeout: 120_000, // 2 min for server startup in beforeAll
    pool: "forks",
    fileParallelism: false,
  },
})
