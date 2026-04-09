import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, injectMessages, injectActiveSession, injectEvent, waitForRender } from "../helpers/inject.js"
import { makeSession, makeAssistantMessage, makeUserMessage, makeTextPart, makeReasoningPart, makeToolRunning } from "../helpers/factories.js"

const HARNESS = "/tests/visual/harness/"

async function setup(page: any) {
  await page.goto(HARNESS)
  await page.waitForTimeout(500)
  await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
  const session = makeSession("s1")
  await injectSessions(page, [session])
  await injectActiveSession(page, "s1")
}

test.describe("Streaming States", () => {
  test("streaming dots — Generating placeholder with pulsing dot", async ({ page }) => {
    await setup(page)
    // User sent a message, session is busy, assistant has no parts yet → "Generating..." placeholder
    await injectMessages(page, "s1", [
      makeUserMessage("s1", "Explain how this works"),
      makeAssistantMessage("s1", [
        // Empty text part filtered by visibleParts → triggers showPlaceholder
        makeTextPart("m2", "s1", ""),
      ], "m2"),
    ])
    // Set session to busy — this enables isStreaming on the last message
    await injectEvent(page, { type: "session.busy", properties: { sessionID: "s1" }, seq: 1 })
    await waitForRender(page, 500)
    // Should show: user bubble, "Generating..." with pulsing dot, "Queue another message..." input, stop button
    await expect(page.locator(".dots")).toBeVisible()
    await expect(page.locator("#root")).toHaveScreenshot("streaming-dots.png", { maxDiffPixels: 200 })
  })

  test("thinking state — Thinking with animated ellipsis mid-stream", async ({ page }) => {
    await setup(page)
    // Assistant is actively thinking — reasoning part has no end time
    await injectMessages(page, "s1", [
      makeUserMessage("s1", "Think step by step about this problem"),
      makeAssistantMessage("s1", [
        makeReasoningPart("m2", "s1", "Let me analyze the requirements carefully...", true), // streaming=true → no end time
        makeTextPart("m2", "s1", ""), // empty text filtered out
      ], "m2"),
    ])
    await injectEvent(page, { type: "session.busy", properties: { sessionID: "s1" }, seq: 1 })
    await waitForRender(page, 500)
    // Should show: user bubble, "Thinking..." with animated dots, pulsing dot
    await expect(page.locator("text=Thinking")).toBeVisible()
    await expect(page.locator("#root")).toHaveScreenshot("streaming-thinking.png", { maxDiffPixels: 200 })
  })

  test("tool running — active tool with command and Generating trailing placeholder", async ({ page }) => {
    await setup(page)
    // Assistant wrote some text, then started a tool — session still busy
    await injectMessages(page, "s1", [
      makeUserMessage("s1", "Run the test suite"),
      makeAssistantMessage("s1", [
        makeTextPart("m2", "s1", "Let me run the tests for you."),
        makeToolRunning("m2", "s1", "bash", { command: "npm test" }),
      ], "m2"),
    ])
    await injectEvent(page, { type: "session.busy", properties: { sessionID: "s1" }, seq: 1 })
    await waitForRender(page, 500)
    // Should show: user bubble, text part, Bash tool header with command "npm test" in card, pulsing dot, stop button
    await expect(page.locator("text=Bash")).toBeVisible()
    await expect(page.locator("text=npm test").first()).toBeVisible()
    await expect(page.locator("#root")).toHaveScreenshot("streaming-tool-running.png", { maxDiffPixels: 200 })
  })
})
