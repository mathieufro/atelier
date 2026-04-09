import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./scenarios",
  fullyParallel: false, // E2E scenarios are expensive — run sequentially
  retries: 0,
  workers: 1,
  timeout: 120_000, // 2 minute timeout per scenario
  reporter: "list",
  use: {
    screenshot: "only-on-failure",
    launchOptions: {
      args: ["--font-render-hinting=none"],
    },
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 400, height: 800 } },
    },
  ],
})
