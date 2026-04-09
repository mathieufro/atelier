import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, injectMessages, injectActiveSession, waitForRender } from "../helpers/inject.js"
import { makeSession, makeAssistantMessage, makeUserMessage, makeTextPart, makeReasoningPart } from "../helpers/factories.js"

const HARNESS = "/tests/visual/harness/"

async function setup(page: any) {
  await page.goto(HARNESS)
  await page.waitForTimeout(500)
  await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
  const session = makeSession("s1")
  await injectSessions(page, [session])
  await injectActiveSession(page, "s1")
}

test.describe("Message Parts: Text", () => {
  test("short text", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [makeTextPart("m1", "s1", "Hello world!")], "m1"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("msg-text-short.png", { maxDiffPixels: 100 })
  })

  test("long text with code block", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [makeTextPart("m1", "s1", "Here's the code:\n\n```typescript\nfunction hello() {\n  console.log('Hello world')\n}\n```\n\nThis function prints a greeting.")], "m1"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("msg-text-code-block.png", { maxDiffPixels: 100 })
  })

  test("text with list", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [makeTextPart("m1", "s1", "Here are the steps:\n\n1. First step\n2. Second step\n3. Third step")], "m1"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("msg-text-list.png", { maxDiffPixels: 100 })
  })
})

test.describe("Message Parts: Reasoning", () => {
  test("completed reasoning", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeReasoningPart("m1", "s1", "I need to think about the best approach to solve this problem.", false),
        makeTextPart("m1", "s1", "Based on my analysis, the solution is..."),
      ], "m1"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("msg-reasoning-completed.png", { maxDiffPixels: 100 })
  })
})

test.describe("Message Parts: User Messages", () => {
  test("user message", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeUserMessage("s1", "Can you help me refactor this code?"),
    ])
    await waitForRender(page)
    await expect(page.locator("#root")).toHaveScreenshot("msg-user.png", { maxDiffPixels: 100 })
  })
})
