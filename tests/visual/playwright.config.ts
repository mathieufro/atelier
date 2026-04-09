import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "./specs",
  fullyParallel: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5199",
    screenshot: "off",
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
  webServer: {
    command: "npx serve . -l 5199 --no-clipboard",
    url: "http://localhost:5199",
    reuseExistingServer: true,
    timeout: 15_000,
    stdout: "pipe",
    cwd: process.cwd(),
  },
})
