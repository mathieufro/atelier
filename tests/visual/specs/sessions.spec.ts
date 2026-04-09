import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, waitForRender } from "../helpers/inject.js"
import { makeSession } from "../helpers/factories.js"

const HARNESS = "/tests/visual/harness/"

test.describe("Sessions", () => {
  test("session list with multiple sessions", async ({ page }) => {
    await page.goto(HARNESS)
    await page.waitForTimeout(500)
    await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
    await injectSessions(page, [
      makeSession("s1", "Refactor Auth Module"),
      makeSession("s2", "Fix Login Bug"),
      makeSession("s3", "Add Dark Mode"),
    ])
    await waitForRender(page)
    await page.locator("[data-testid='session-dropdown'] button").first().click()
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("sessions-list.png", { maxDiffPixels: 100 })
  })

  test("empty session list", async ({ page }) => {
    await page.goto(HARNESS)
    await page.waitForTimeout(500)
    await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
    await injectSessions(page, [])
    await waitForRender(page)
    await page.locator("[data-testid='session-dropdown'] button").first().click()
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("sessions-empty.png", { maxDiffPixels: 100 })
  })
})
