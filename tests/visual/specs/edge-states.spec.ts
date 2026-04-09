import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, injectActiveSession, injectMessages, injectEvent, waitForRender } from "../helpers/inject.js"
import { makeSession, makeAssistantMessage, makeUserMessage, makeTextPart, makeToolCompleted, makeToolError, makeToolRunning } from "../helpers/factories.js"

const HARNESS = "/tests/visual/harness/"

async function setup(page: any) {
  await page.goto(HARNESS)
  await page.waitForTimeout(500)
  await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
  const session = makeSession("s1")
  await injectSessions(page, [session])
  await injectActiveSession(page, "s1")
}

test.describe("Edge States", () => {
  test("error state — tool error with failed banner", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeTextPart("m1", "s1", "Let me run that command."),
        makeToolError("m1", "s1", "bash", "Command failed: exit code 1\nPermission denied: /etc/shadow"),
      ], "m1"),
    ])
    await waitForRender(page, 500)
    await expect(page.locator("#root")).toHaveScreenshot("edge-session-error.png", { maxDiffPixels: 200 })
  })

  test("interrupted state", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [makeTextPart("m1", "s1", "I was working on—")], "m1"),
    ])
    await injectEvent(page, {
      type: "session.interrupted",
      properties: { sessionID: "s1" },
      seq: 1,
    })
    await waitForRender(page, 500)
    await expect(page.locator("#root")).toHaveScreenshot("edge-interrupted.png", { maxDiffPixels: 200 })
  })
})

test.describe("Compositions", () => {
  test("full conversation with mixed parts", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeUserMessage("s1", "Can you read the config file?"),
      makeAssistantMessage("s1", [
        makeTextPart("m2", "s1", "Sure, let me read it."),
        makeToolCompleted("m2", "s1", "read", "export default { port: 3000 }", { filePath: "config.ts" }),
        makeTextPart("m2", "s1", "The config sets the port to 3000."),
      ], "m2"),
      makeUserMessage("s1", "Now update the port to 8080"),
      makeAssistantMessage("s1", [
        makeTextPart("m4", "s1", "I'll update the port."),
        makeToolCompleted("m4", "s1", "edit", "+1/-1 changed", { filePath: "config.ts", oldString: "port: 3000", newString: "port: 8080" }),
        makeTextPart("m4", "s1", "Done! The port has been updated to 8080."),
      ], "m4"),
    ])
    await waitForRender(page, 500)
    await expect(page.locator("#root")).toHaveScreenshot("composition-conversation.png", { maxDiffPixels: 200 })
  })

  test("multiple tools in sequence", async ({ page }) => {
    await setup(page)
    await injectMessages(page, "s1", [
      makeAssistantMessage("s1", [
        makeTextPart("m1", "s1", "I'll search for the files and fix them."),
        makeToolCompleted("m1", "s1", "glob", "3 files", { pattern: "**/*.test.ts" }),
        makeToolCompleted("m1", "s1", "grep", "found import", { pattern: "import.*old" }),
        makeToolRunning("m1", "s1", "edit", { filePath: "src/a.ts" }),
      ], "m1"),
    ])
    await waitForRender(page, 500)
    await expect(page.locator("#root")).toHaveScreenshot("composition-multi-tool.png", { maxDiffPixels: 200 })
  })
})
