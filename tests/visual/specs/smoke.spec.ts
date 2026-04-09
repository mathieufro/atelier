import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, injectActiveSession, injectMessages, waitForRender } from "../helpers/inject.js"
import { makeSession, makeAssistantMessage, makeTextPart } from "../helpers/factories.js"

test("webview loads in harness", async ({ page }) => {
  await page.goto("/tests/visual/harness/")
  // The webview should render the app root div
  const root = page.locator("#root")
  await expect(root).toBeAttached({ timeout: 5000 })
  const title = await page.title()
  expect(title).toContain("Atelier")
})

test("inject messages and verify rendering", async ({ page }) => {
  await page.goto("/tests/visual/harness/")
  await page.waitForTimeout(500) // wait for JS to initialize
  const session = makeSession("s1", "Test Chat")
  await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
  await injectSessions(page, [session])
  await injectActiveSession(page, "s1")
  await injectMessages(page, "s1", [
    { message: { id: "m1", sessionID: "s1", role: "assistant", time: { created: Date.now() } }, parts: [makeTextPart("m1", "s1", "Hello world")] },
  ])
  await waitForRender(page)
  // Verify the root is attached and has content
  const root = page.locator("#root")
  await expect(root).toBeAttached()
  // The root should have rendered children after injection
  const innerHTML = await root.innerHTML()
  expect(innerHTML.length).toBeGreaterThan(0)
})
