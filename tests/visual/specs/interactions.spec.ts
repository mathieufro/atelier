import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, injectActiveSession, injectEvent, waitForRender } from "../helpers/inject.js"
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

test.describe("Interactions: Permissions", () => {
  test("permission banner displayed", async ({ page }) => {
    await setup(page)
    await injectEvent(page, {
      type: "permission.asked",
      properties: {
        id: "perm-1",
        sessionID: "s1",
        permission: "bash",
        patterns: ["*"],
        metadata: { command: "rm -rf /tmp/test" },
        always: [],
      },
      seq: 1,
    })
    await waitForRender(page, 500)
    await expect(page.locator("#root")).toHaveScreenshot("interaction-permission.png", { maxDiffPixels: 200 })
  })
})

test.describe("Interactions: Questions", () => {
  test("question banner displayed", async ({ page }) => {
    await setup(page)
    await injectEvent(page, {
      type: "question.asked",
      properties: {
        id: "q-1",
        sessionID: "s1",
        questions: [
          {
            question: "Which approach would you prefer?",
            header: "Approach",
            options: [
              { label: "Option A", description: "First approach" },
              { label: "Option B", description: "Second approach" },
            ],
          },
        ],
      },
      seq: 1,
    })
    await waitForRender(page, 500)
    await expect(page.locator("#root")).toHaveScreenshot("interaction-question.png", { maxDiffPixels: 200 })
  })
})
