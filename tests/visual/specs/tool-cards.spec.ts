import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, injectMessages, injectActiveSession, waitForRender } from "../helpers/inject.js"
import { makeSession, makeAssistantMessage, makeToolRunning, makeToolCompleted, makeToolError } from "../helpers/factories.js"

const HARNESS = "/tests/visual/harness/"

async function setup(page: any) {
  await page.goto(HARNESS)
  await page.waitForTimeout(500)
  await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
  const session = makeSession("s1")
  await injectSessions(page, [session])
  await injectActiveSession(page, "s1")
}

test.describe("Tool Cards: bash", () => {
  test("running state", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeToolRunning("m1", "s1", "bash", { command: "npm test" }),
      ], "m1"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("tool-bash-running.png", { maxDiffPixels: 100 })
  })

  test("completed state", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeToolCompleted("m1", "s1", "bash", "All 42 tests passed\n", { command: "npm test" }),
      ], "m1"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("tool-bash-completed.png", { maxDiffPixels: 100 })
  })

  test("error state", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeToolError("m1", "s1", "bash", "Command failed with exit code 1"),
      ], "m1"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("tool-bash-error.png", { maxDiffPixels: 100 })
  })
})

test.describe("Tool Cards: write", () => {
  test("completed state", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeToolCompleted("m1", "s1", "write", "42 lines written", { filePath: "src/index.ts", content: "export const x = 1" }),
      ], "m1"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("tool-write-completed.png", { maxDiffPixels: 100 })
  })
})

test.describe("Tool Cards: edit", () => {
  test("completed state with diff", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeToolCompleted("m1", "s1", "edit", "+1/-1 lines changed", { filePath: "src/index.ts", oldString: "const x = 1", newString: "const x = 2" }),
      ], "m1"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("tool-edit-completed.png", { maxDiffPixels: 100 })
  })
})

test.describe("Tool Cards: glob", () => {
  test("completed state", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeToolCompleted("m1", "s1", "glob", "12 files matched", { pattern: "**/*.ts" }),
      ], "m1"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("tool-glob-completed.png", { maxDiffPixels: 100 })
  })
})

test.describe("Tool Cards: grep", () => {
  test("completed state", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeToolCompleted("m1", "s1", "grep", "3 matches found", { pattern: "import.*foo" }),
      ], "m1"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("tool-grep-completed.png", { maxDiffPixels: 100 })
  })
})
