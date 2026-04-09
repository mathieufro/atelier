import { describe, it, expect, afterEach, vi } from "vitest"
import { createTestHarness, type TestHarness } from "./harness.js"
import * as fs from "node:fs"
import * as path from "node:path"

let harness: TestHarness

afterEach(async () => {
  await harness?.teardown()
})

describe("Ralph Loop Integration", () => {
  it("60. full lifecycle: start → iteration events → max completion", async () => {

    // Create harness with no scenario (we control via Ralph controller)
    harness = await createTestHarness([])

    // Create prompt file inside the harness workspace (validateWithinWorkspace requires it)
    const promptPath = path.join(harness.workspacePath, "task.md")
    fs.writeFileSync(promptPath, "Build the feature")

    // Override engine methods to complete immediately
    const engine = harness.engine
    // Make getSessionOutput return empty text (no promise match)
    ;(engine as any).getSessionOutput = vi.fn().mockResolvedValue({ text: "done working", tokens: { input: 10, output: 5 } })

    // Pass a model that resolves to "opencode" — the harness registers its TestAgentEngine under "opencode", not "claude-code"
    const res = await harness.app.request("/ralph-loop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promptPath: "task.md", maxIterations: 2, model: { providerID: "openai", modelID: "gpt-4o-mini" } }),
    })
    expect(res.status).toBe(200)
    const { sessionId } = await res.json()

    // Wait for loop to complete
    await vi.waitFor(() => {
      expect(harness.ralphController.getLoop(sessionId)?.status).toBe("completed")
    }, { timeout: 3000 })

    // Verify events were emitted
    await harness.waitForEvents(4, 1000) // session.updated + ralph.started + 2x ralph.iteration + ralph.complete (at minimum)
    const ralphEvents = harness.events.filter((e: any) =>
      typeof e.type === "string" && e.type.startsWith("ralph.")
    )
    expect(ralphEvents.some((e: any) => e.type === "ralph.started")).toBe(true)
    expect(ralphEvents.filter((e: any) => e.type === "ralph.iteration")).toHaveLength(2)
    expect(ralphEvents.some((e: any) => e.type === "ralph.complete" && e.reason === "max_iterations")).toBe(true)
  })

  it("61. abort during loop cancels via ralph controller", async () => {
    harness = await createTestHarness([])
    const promptPath = path.join(harness.workspacePath, "task.md")
    fs.writeFileSync(promptPath, "Build forever")

    // Make waitForIdle hang so the loop stays running
    ;(harness.engine as any).waitForIdle = vi.fn().mockImplementation(() => new Promise(() => {}))
    const sendSpy = vi.spyOn(harness.engine, "sendMessage")

    // Pass a model that resolves to "opencode" — the harness registers its TestAgentEngine under "opencode", not "claude-code"
    const res = await harness.app.request("/ralph-loop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promptPath: "task.md", model: { providerID: "openai", modelID: "gpt-4o-mini" } }),
    })
    const { sessionId } = await res.json()

    // Wait for the loop to start working
    await vi.waitFor(() => {
      expect(sendSpy).toHaveBeenCalled()
    })

    // Abort via the standard abort endpoint
    const abortRes = await harness.app.request(`/session/${sessionId}/abort`, { method: "POST" })
    expect(abortRes.status).toBe(200)

    // Loop should be cancelled
    expect(harness.ralphController.getLoop(sessionId)?.status).toBe("cancelled")
  })

  it("62. GET /ralph-loop lists active and completed loops", async () => {
    harness = await createTestHarness([])
    fs.writeFileSync(path.join(harness.workspacePath, "a.md"), "task a")
    ;(harness.engine as any).getSessionOutput = vi.fn().mockResolvedValue({ text: "", tokens: { input: 0, output: 0 } })

    // Start a loop
    await harness.app.request("/ralph-loop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promptPath: "a.md", maxIterations: 1, model: { providerID: "openai", modelID: "gpt-4o-mini" } }),
    })

    // Wait for first to complete
    await vi.waitFor(() => {
      const loops = harness.ralphController.listLoops()
      expect(loops.some(l => l.status === "completed")).toBe(true)
    }, { timeout: 2000 })

    const listRes = await harness.app.request("/ralph-loop")
    const body = await listRes.json()
    expect(body.loops.length).toBeGreaterThanOrEqual(1)
  })
})
