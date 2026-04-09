import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, injectMessages, injectActiveSession, injectEvent, waitForRender } from "../helpers/inject.js"
import { makeSession, makeTextPart } from "../helpers/factories.js"

const HARNESS = "/tests/visual/harness/"

async function setup(page: any) {
  await page.goto(HARNESS)
  await page.waitForTimeout(500)
  await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
  const session = makeSession("s1", "Ralph: test")
  await injectSessions(page, [session])
  await injectActiveSession(page, "s1")
}

/** Make a user message with explicit timestamp */
function makeTimedUserMessage(sessionId: string, content: string, id: string, timestamp: number) {
  return {
    message: { id, sessionID: sessionId, role: "user", time: { created: timestamp } },
    parts: [makeTextPart(id, sessionId, content)],
  }
}

/** Make an assistant message with explicit timestamp */
function makeTimedAssistantMessage(sessionId: string, parts: any[], id: string, timestamp: number) {
  return {
    message: { id, sessionID: sessionId, role: "assistant", time: { created: timestamp } },
    parts,
  }
}

test.describe("Ralph Dividers", () => {
  test("iteration divider with max iterations", async ({ page }) => {
    await setup(page)
    // Inject ralph.started
    await injectEvent(page, {
      type: "ralph.started", sessionId: "s1", promptPath: "./p.md",
      maxIterations: 20, completionPromise: null, iteration: 1,
    })
    // Messages with known timestamps
    await injectMessages(page, "s1", [
      makeTimedUserMessage("s1", "Hello", "m1", 1000),
      makeTimedAssistantMessage("s1", [makeTextPart("m2", "s1", "Working on it...")], "m2", 3000),
    ])
    // Iteration divider between the two messages
    await injectEvent(page, {
      type: "ralph.iteration", sessionId: "s1", iteration: 3, maxIterations: 20, timestamp: 2000,
    })
    await waitForRender(page, 500)
    await expect(page.locator("text=Iteration 3/20")).toBeVisible()
    await expect(page.locator('[data-testid="message-list"]')).toHaveScreenshot("ralph-divider-iteration-with-max.png", { maxDiffPixels: 100, threshold: 0.001 })
  })

  test("iteration divider unlimited (no max)", async ({ page }) => {
    await setup(page)
    await injectEvent(page, {
      type: "ralph.started", sessionId: "s1", promptPath: "./p.md",
      maxIterations: 0, completionPromise: null, iteration: 1,
    })
    await injectMessages(page, "s1", [
      makeTimedUserMessage("s1", "Hello", "m1", 1000),
      makeTimedAssistantMessage("s1", [makeTextPart("m2", "s1", "Done with iteration")], "m2", 3000),
    ])
    await injectEvent(page, {
      type: "ralph.iteration", sessionId: "s1", iteration: 7, maxIterations: 0, timestamp: 2000,
    })
    await waitForRender(page, 500)
    await expect(page.locator("text=Iteration 7")).toBeVisible()
    await expect(page.locator('[data-testid="message-list"]')).toHaveScreenshot("ralph-divider-iteration-unlimited.png", { maxDiffPixels: 100, threshold: 0.001 })
  })

  test("complete divider — promise fulfilled", async ({ page }) => {
    await setup(page)
    await injectEvent(page, {
      type: "ralph.started", sessionId: "s1", promptPath: "./p.md",
      maxIterations: 20, completionPromise: "DONE", iteration: 1,
    })
    await injectMessages(page, "s1", [
      makeTimedAssistantMessage("s1", [makeTextPart("m1", "s1", "Task is complete.")], "m1", 1000),
    ])
    await injectEvent(page, {
      type: "ralph.complete", sessionId: "s1", iteration: 12, reason: "promise_fulfilled", timestamp: 2000,
    })
    await waitForRender(page, 500)
    await expect(page.locator("text=Loop complete: promise fulfilled (iteration 12)")).toBeVisible()
    await expect(page.locator('[data-testid="message-list"]')).toHaveScreenshot("ralph-divider-complete-promise.png", { maxDiffPixels: 100, threshold: 0.001 })
  })

  test("complete divider — max iterations", async ({ page }) => {
    await setup(page)
    await injectEvent(page, {
      type: "ralph.started", sessionId: "s1", promptPath: "./p.md",
      maxIterations: 20, completionPromise: null, iteration: 1,
    })
    await injectMessages(page, "s1", [
      makeTimedAssistantMessage("s1", [makeTextPart("m1", "s1", "Continuing work...")], "m1", 1000),
    ])
    await injectEvent(page, {
      type: "ralph.complete", sessionId: "s1", iteration: 20, reason: "max_iterations", timestamp: 2000,
    })
    await waitForRender(page, 500)
    await expect(page.locator("text=Loop complete: max iterations reached (20)")).toBeVisible()
    await expect(page.locator('[data-testid="message-list"]')).toHaveScreenshot("ralph-divider-complete-max-iters.png", { maxDiffPixels: 100, threshold: 0.001 })
  })

  test("complete divider — cancelled", async ({ page }) => {
    await setup(page)
    await injectEvent(page, {
      type: "ralph.started", sessionId: "s1", promptPath: "./p.md",
      maxIterations: 20, completionPromise: null, iteration: 1,
    })
    await injectMessages(page, "s1", [
      makeTimedAssistantMessage("s1", [makeTextPart("m1", "s1", "Working...")], "m1", 1000),
    ])
    await injectEvent(page, {
      type: "ralph.complete", sessionId: "s1", iteration: 5, reason: "cancelled", timestamp: 2000,
    })
    await waitForRender(page, 500)
    await expect(page.locator("text=Loop cancelled (iteration 5)")).toBeVisible()
    await expect(page.locator('[data-testid="message-list"]')).toHaveScreenshot("ralph-divider-cancelled.png", { maxDiffPixels: 100, threshold: 0.001 })
  })

  test("complete divider — error with detail", async ({ page }) => {
    await setup(page)
    await injectEvent(page, {
      type: "ralph.started", sessionId: "s1", promptPath: "./p.md",
      maxIterations: 10, completionPromise: null, iteration: 1,
    })
    await injectMessages(page, "s1", [
      makeTimedAssistantMessage("s1", [makeTextPart("m1", "s1", "Partial work done")], "m1", 1000),
    ])
    await injectEvent(page, {
      type: "ralph.complete", sessionId: "s1", iteration: 3, reason: "error", detail: "File not found", timestamp: 2000,
    })
    await waitForRender(page, 500)
    await expect(page.locator("text=Loop error (iteration 3): File not found")).toBeVisible()
    await expect(page.locator('[data-testid="message-list"]')).toHaveScreenshot("ralph-divider-error.png", { maxDiffPixels: 100, threshold: 0.001 })
  })

  test("interleaved dividers between messages", async ({ page }) => {
    await setup(page)
    await injectEvent(page, {
      type: "ralph.started", sessionId: "s1", promptPath: "./p.md",
      maxIterations: 20, completionPromise: "DONE", iteration: 1,
    })
    // Three messages with dividers interleaved between them
    await injectMessages(page, "s1", [
      makeTimedAssistantMessage("s1", [makeTextPart("m1", "s1", "First iteration done.")], "m1", 1000),
      makeTimedAssistantMessage("s1", [makeTextPart("m2", "s1", "Second iteration done.")], "m2", 3000),
      makeTimedAssistantMessage("s1", [makeTextPart("m3", "s1", "Third iteration done.")], "m3", 5000),
    ])
    // Iteration dividers between messages
    await injectEvent(page, {
      type: "ralph.iteration", sessionId: "s1", iteration: 1, maxIterations: 20, timestamp: 500,
    })
    await injectEvent(page, {
      type: "ralph.iteration", sessionId: "s1", iteration: 2, maxIterations: 20, timestamp: 2000,
    })
    await injectEvent(page, {
      type: "ralph.iteration", sessionId: "s1", iteration: 3, maxIterations: 20, timestamp: 4000,
    })
    // Completion after last message
    await injectEvent(page, {
      type: "ralph.complete", sessionId: "s1", iteration: 3, reason: "promise_fulfilled", timestamp: 6000,
    })
    await waitForRender(page, 500)
    await expect(page.locator("text=Iteration 1/20")).toBeVisible()
    await expect(page.locator("text=Iteration 2/20")).toBeVisible()
    await expect(page.locator("text=Iteration 3/20")).toBeVisible()
    await expect(page.locator("text=Loop complete")).toBeVisible()
    await expect(page.locator('[data-testid="message-list"]')).toHaveScreenshot("ralph-divider-interleaved.png", { maxDiffPixels: 100, threshold: 0.001 })
  })

  test("stop button shows 'Stop Loop' label when loop active", async ({ page }) => {
    await setup(page)
    // Start a ralph loop
    await injectEvent(page, {
      type: "ralph.started", sessionId: "s1", promptPath: "./p.md",
      maxIterations: 10, completionPromise: "DONE", iteration: 1,
    })
    // Set session to busy (required for stop button to appear)
    await injectEvent(page, { type: "session.busy", properties: { sessionID: "s1" }, seq: 1 })
    // Inject a message so assistant is streaming
    await injectMessages(page, "s1", [
      makeTimedAssistantMessage("s1", [makeTextPart("m1", "s1", "Working on it...")], "m1", 1000),
    ])
    await waitForRender(page, 500)
    // The stop button should say "Stop Loop"
    const stopButton = page.locator('[aria-label="Stop Loop"]')
    await expect(stopButton).toBeVisible()
    // Screenshot the full root to capture input bar with stop button
    await expect(page.locator("#root")).toHaveScreenshot("ralph-stop-button-active.png", { maxDiffPixels: 100, threshold: 0.001 })
  })
})
