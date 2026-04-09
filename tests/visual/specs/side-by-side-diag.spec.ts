import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, injectMessages, injectActiveSession, waitForRender } from "../helpers/inject.js"
import { makeSession, makeAssistantMessage, makeToolCompleted } from "../helpers/factories.js"

const HARNESS = "/tests/visual/harness/"

async function setup(page: any) {
  await page.goto(HARNESS)
  await page.waitForTimeout(500)
  await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
  const session = makeSession("s1")
  await injectSessions(page, [session])
  await injectActiveSession(page, "s1")
}

// Multi-line edit with mixed changes (both additions and removals) — snake_case
// keys match Claude Code backend format
const CLAUDE_EDIT_INPUT = {
  file_path: "src/utils.ts",
  old_string: "function add(a: number, b: number) {\n  return a + b\n}\n\nfunction subtract(a: number, b: number) {\n  return a - b\n}",
  new_string: "function add(a: number, b: number): number {\n  return a + b\n}\n\nfunction subtract(a: number, b: number): number {\n  return a - b\n}",
}

// camelCase keys — OpenCode backend format
const OPENCODE_EDIT_INPUT = {
  filePath: "src/utils.ts",
  oldString: "function add(a: number, b: number) {\n  return a + b\n}\n\nfunction subtract(a: number, b: number) {\n  return a - b\n}",
  newString: "function add(a: number, b: number): number {\n  return a + b\n}\n\nfunction subtract(a: number, b: number): number {\n  return a - b\n}",
}

/** Query the DOM for side-by-side rendering info */
async function getDiffInfo(page: any) {
  return page.evaluate(() => {
    const containers = document.querySelectorAll('.relative.overflow-hidden')
    let containerWidth = 0
    for (const c of containers) {
      const rect = c.getBoundingClientRect()
      if (rect.width > 0) containerWidth = rect.width
    }
    // SideBySide component renders as .flex-1.min-w-0 columns
    const sideBySideColumns = document.querySelectorAll('.flex-1.min-w-0')
    return { containerWidth: Math.round(containerWidth), sideBySideColumnCount: sideBySideColumns.length }
  })
}

test.describe("Edit diff: side-by-side at wide viewport", () => {
  test("renders side-by-side with snake_case input (Claude Code backend) at 800px", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 })
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeToolCompleted("m1", "s1", "edit", "+2/-2 lines changed", CLAUDE_EDIT_INPUT),
      ], "m1"),
    ])
    await waitForRender(page, 500)

    const info = await getDiffInfo(page)
    expect(info.containerWidth).toBeGreaterThan(500)
    expect(info.sideBySideColumnCount).toBe(2)
    await expect(page.locator("#root")).toHaveScreenshot("edit-side-by-side-claude-800.png", { maxDiffPixels: 100 })
  })

  test("renders side-by-side with camelCase input (OpenCode backend) at 800px", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 })
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeToolCompleted("m1", "s1", "edit", "+2/-2 lines changed", OPENCODE_EDIT_INPUT),
      ], "m1"),
    ])
    await waitForRender(page, 500)

    const info = await getDiffInfo(page)
    expect(info.containerWidth).toBeGreaterThan(500)
    expect(info.sideBySideColumnCount).toBe(2)
    await expect(page.locator("#root")).toHaveScreenshot("edit-side-by-side-opencode-800.png", { maxDiffPixels: 100 })
  })

  test("renders inline at narrow viewport (400px)", async ({ page }) => {
    await page.setViewportSize({ width: 400, height: 600 })
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeToolCompleted("m1", "s1", "edit", "+2/-2 lines changed", CLAUDE_EDIT_INPUT),
      ], "m1"),
    ])
    await waitForRender(page, 500)

    const info = await getDiffInfo(page)
    expect(info.containerWidth).toBeLessThanOrEqual(500)
    expect(info.sideBySideColumnCount).toBe(0)
    await expect(page.locator("#root")).toHaveScreenshot("edit-inline-claude-400.png", { maxDiffPixels: 100 })
  })

  test("pure addition (empty old_string) stays inline even at wide viewport", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 600 })
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeToolCompleted("m1", "s1", "edit", "+3 lines added", {
          file_path: "src/new.ts",
          old_string: "",
          new_string: "export function hello() {\n  return 'world'\n}\n",
        }),
      ], "m1"),
    ])
    await waitForRender(page, 500)

    const info = await getDiffInfo(page)
    // Pure additions have no mixed changes → stays inline even at wide widths
    expect(info.sideBySideColumnCount).toBe(0)
  })
})
