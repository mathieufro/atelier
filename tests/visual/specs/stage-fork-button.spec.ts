import { test, expect } from "@playwright/test"
import { injectConfig, injectSessions, injectEvent, waitForRender } from "../helpers/inject.js"
import { makeStageStarted, makeStageCompleted, makeStageInterrupted } from "../helpers/factories.js"

const HARNESS = "/tests/visual/harness/"
const PID = "pipeline-1"

async function setupWithPipeline(page: any, stages: Array<{ id: string; stage: string; sessionId?: string; status: string; interrupted?: boolean }>) {
  await page.goto(HARNESS)
  await page.waitForTimeout(500)
  await injectConfig(page, { workspacePath: "/tmp", models: [], agents: [] })
  await injectSessions(page, [])
  await waitForRender(page, 500)

  // Inject stage_started events. The first one auto-activates the pipeline.
  for (const s of stages) {
    await injectEvent(page, makeStageStarted(PID, s.id, s.stage, s.sessionId))
    // Give requestAnimationFrame time to fire
    await page.waitForTimeout(100)
  }
  // Wait for rAF to flush events
  await page.waitForTimeout(500)

  // Now inject status changes
  for (const s of stages) {
    if (s.status === "completed") {
      await injectEvent(page, makeStageCompleted(PID, s.id))
      await page.waitForTimeout(100)
    }
    if (s.interrupted && s.sessionId) {
      await injectEvent(page, makeStageInterrupted(PID, s.id, s.sessionId))
      await page.waitForTimeout(100)
    }
  }
  await page.waitForTimeout(500)

  // Also inject the pipeline detail to ensure stages render
  await page.evaluate(({ pid, stageData }: any) => {
    window.__injectMessage({
      type: "pipeline",
      pipeline: {
        id: pid,
        prompt: "Test",
        title: "Test Pipeline",
        status: "running",
        currentStage: stageData.find((s: any) => s.status === "running")?.stage ?? stageData[stageData.length - 1]?.stage ?? null,
        createdAt: Date.now() - 10000,
        updatedAt: Date.now(),
        stages: stageData.map((s: any) => ({
          id: s.id,
          stage: s.stage,
          sessionId: s.sessionId,
          status: s.status,
          interrupted: s.interrupted,
          startedAt: Date.now() - 5000,
          completedAt: s.status === "completed" ? Date.now() - 1000 : undefined,
        })),
      },
    })
  }, { pid: PID, stageData: stages })
  await waitForRender(page, 1000)
}

test.describe("StageBlock fork button", () => {
  test("fork button visible on completed stage with session", async ({ page }) => {
    await setupWithPipeline(page, [
      { id: "s1", stage: "brainstorm", sessionId: "ses-1", status: "completed" },
      { id: "s2", stage: "implement", sessionId: "ses-2", status: "completed" },
    ])

    const stageEl = page.locator("[data-stage='implement']").first()
    await expect(stageEl).toBeVisible({ timeout: 10_000 })
    await expect(stageEl).toHaveScreenshot("stage-fork-button-completed.png", { maxDiffPixels: 50 })
  })

  test("fork button visible on running stage", async ({ page }) => {
    await setupWithPipeline(page, [
      { id: "s1", stage: "brainstorm", sessionId: "ses-1", status: "completed" },
      { id: "s2", stage: "implement", sessionId: "ses-2", status: "running" },
    ])

    const stageEl = page.locator("[data-stage='implement']").first()
    await expect(stageEl).toBeVisible({ timeout: 10_000 })
    await expect(stageEl).toHaveScreenshot("stage-fork-button-running.png", { maxDiffPixels: 200 })
  })

  test("fork button visible on interrupted stage", async ({ page }) => {
    await setupWithPipeline(page, [
      { id: "s1", stage: "brainstorm", sessionId: "ses-1", status: "completed" },
      { id: "s2", stage: "implement", sessionId: "ses-2", status: "running", interrupted: true },
    ])

    const stageEl = page.locator("[data-stage='implement']").first()
    await expect(stageEl).toBeVisible({ timeout: 10_000 })
    await expect(stageEl).toHaveScreenshot("stage-fork-button-interrupted.png", { maxDiffPixels: 50 })
  })

  test("no fork button when sessionId is absent", async ({ page }) => {
    await setupWithPipeline(page, [
      { id: "s1", stage: "brainstorm", status: "completed" },
    ])

    const stageEl = page.locator("[data-stage='brainstorm']").first()
    await expect(stageEl).toBeVisible({ timeout: 10_000 })
    await expect(stageEl).toHaveScreenshot("stage-no-fork-button-no-session.png", { maxDiffPixels: 50 })
  })

  test("fork button present when stage has session", async ({ page }) => {
    await setupWithPipeline(page, [
      { id: "s1", stage: "brainstorm", sessionId: "ses-1", status: "completed" },
    ])

    const stageEl = page.locator("[data-stage='brainstorm']").first()
    await expect(stageEl).toBeVisible({ timeout: 10_000 })
    const forkBtn = stageEl.locator("[data-fork-button]")
    await expect(forkBtn).toBeVisible()
  })
})
