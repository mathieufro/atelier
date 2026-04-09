import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, waitForRender } from "../helpers/inject.js"

test("onboarding card renders when no models available", async ({ page }) => {
  await page.goto("/tests/visual/harness/")
  await page.waitForTimeout(500)

  // Boot with sessions but no models → triggers onboarding card
  await injectSessions(page, [{ id: "s1", parentID: "", title: "Test", time: { created: Date.now(), updated: Date.now() } }])
  await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [], emptyModels: true })
  await waitForRender(page)

  await expect(page.locator("#root")).toHaveScreenshot("onboarding-card.png", {
    maxDiffPixels: 100,
  })
})

test("connecting-to-backends state before config arrives", async ({ page }) => {
  await page.goto("/tests/visual/harness/")
  await page.waitForTimeout(500)

  // Only inject sessions, no config → "Connecting to backends..." state
  await injectSessions(page, [{ id: "s1", parentID: "", title: "Test", time: { created: Date.now(), updated: Date.now() } }])
  await waitForRender(page)

  await expect(page.locator("#root")).toHaveScreenshot("connecting-to-backends.png", {
    maxDiffPixels: 100,
  })
})
