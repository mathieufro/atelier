import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, injectActiveSession, waitForRender } from "../helpers/inject.js"
import { makeSession } from "../helpers/factories.js"

const HARNESS = "/tests/visual/harness/"

async function setup(page: any) {
  await page.goto(HARNESS)
  await page.waitForTimeout(500)
  await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
  const session = makeSession("s1")
  await injectSessions(page, [session])
  await injectActiveSession(page, "s1")
}

test.describe("Input Bar", () => {
  test("empty state", async ({ page }) => {
    await setup(page)
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("input-bar-empty.png", { maxDiffPixels: 100 })
  })

  test("with models dropdown", async ({ page }) => {
    await setup(page)
    await injectConfig(page, {
      workspacePath: "/tmp",
      models: [
        { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", providerID: "anthropic" },
        { id: "gpt-4o", name: "GPT-4o", providerID: "openai" },
      ],
      agents: [],
    })
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("input-bar-models.png", { maxDiffPixels: 100 })
  })

  test("file context pill - on with selection", async ({ page }) => {
    await setup(page)
    await waitForRender(page)
    await page.evaluate(() => {
      (window as any).__injectMessage({
        type: "activeFileContext",
        path: "/workspace/src/components/App.tsx",
        relativePath: "src/components/App.tsx",
        startLine: 12,
        endLine: 25,
      })
    })
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("input-bar-file-context-on-selection.png", { maxDiffPixels: 100 })
  })

  test("file context pill - on without selection", async ({ page }) => {
    await setup(page)
    await waitForRender(page)
    await page.evaluate(() => {
      (window as any).__injectMessage({
        type: "activeFileContext",
        path: "/workspace/src/App.tsx",
        relativePath: "src/App.tsx",
      })
    })
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("input-bar-file-context-on-no-selection.png", { maxDiffPixels: 100 })
  })

  test("file context pill - off (strikethrough)", async ({ page }) => {
    await setup(page)
    await waitForRender(page)
    await page.evaluate(() => {
      (window as any).__injectMessage({
        type: "activeFileContext",
        path: "/workspace/src/App.tsx",
        relativePath: "src/App.tsx",
        startLine: 1,
        endLine: 10,
      })
    })
    await waitForRender(page)
    const pill = page.locator("[data-testid='file-context-pill']")
    await pill.click()
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("input-bar-file-context-off.png", { maxDiffPixels: 100 })
  })

  test("file context pill - hidden when no file", async ({ page }) => {
    await setup(page)
    await waitForRender(page)
    await page.evaluate(() => {
      (window as any).__injectMessage({ type: "activeFileContext", path: null })
    })
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("input-bar-file-context-hidden.png", { maxDiffPixels: 100 })
  })
})
