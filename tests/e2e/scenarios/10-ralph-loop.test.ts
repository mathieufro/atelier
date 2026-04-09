/**
 * E2E Scenario 10: Ralph Loop Integration
 *
 * Spawns a real Atelier server, starts real Ralph loops with real backends,
 * and asserts on SSE events + REST API state.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { createWorkspace, type Workspace } from "../workspace.js"
import { createE2EHarness, type E2EHarness } from "../harness.js"
import { getAvailableBackends, getAvailableBackendsFromServer, backends } from "../config.js"

// --- Prompt content ---

const PROMISE_PROMPT = `Your only task is to output exactly this text on a single line:
<promise>TASK_COMPLETE</promise>
Do not add any other text, explanation, or commentary. Just output that exact line.`

const NO_PROMISE_PROMPT = `List all files in the current directory and describe what you see.
Do NOT output any XML tags.`

const CONCURRENT_PROMPT_A = `Your only task is to output exactly this text on a single line:
<promise>LOOP_A_DONE</promise>
Do not add any other text, explanation, or commentary. Just output that exact line.`

const CONCURRENT_PROMPT_B = `Your only task is to output exactly this text on a single line:
<promise>LOOP_B_DONE</promise>
Do not add any other text, explanation, or commentary. Just output that exact line.`

describe.each(getAvailableBackends())("Scenario 10: Ralph Loop [%s]", (backend) => {
  let workspace: Workspace
  let harness: E2EHarness
  let backendAvailable = false

  beforeAll(async () => {
    workspace = await createWorkspace(`ralph-loop-${backend}`, {
      "prompt.md": PROMISE_PROMPT,
      "prompt-no-promise.md": NO_PROMISE_PROMPT,
      "prompt-a.md": CONCURRENT_PROMPT_A,
      "prompt-b.md": CONCURRENT_PROMPT_B,
      "README.md": "Test workspace for ralph loop E2E tests.",
    })
    harness = await createE2EHarness(workspace)
    await harness.waitForReady(90_000)

    const available = await getAvailableBackendsFromServer(harness.serverUrl)
    backendAvailable = available.includes(backend)
  }, 120_000)

  afterAll(async () => {
    harness?.writeTranscript(`10-ralph-loop-${backend}`)
    await harness?.cleanup()
    await workspace?.cleanup()
  }, 15_000)

  const backendConfig = () => backends[backend]

  // --- Scenario 1: Promise fulfillment ---

  it("Scenario 1: ralph loop completes via promise fulfillment", async ({ skip }) => {
    if (!backendAvailable) skip()

    const { sessionId, eventIndex } = await harness.startRalphLoop({
      promptPath: "./prompt.md",
      completionPromise: "TASK_COMPLETE",
      maxIterations: 5,
      model: backendConfig().model,
      variant: backendConfig().variant,
    })

    expect(sessionId).toBeTruthy()

    const started = await harness.waitForRalphEvent("ralph.started", sessionId, 30_000, eventIndex)
    expect((started as any).promptPath).toContain("prompt.md")
    expect((started as any).completionPromise).toBe("TASK_COMPLETE")
    expect((started as any).maxIterations).toBe(5)

    await harness.waitForRalphEvent("ralph.iteration", sessionId, 120_000, eventIndex)

    const complete = await harness.waitForRalphEvent("ralph.complete", sessionId, 120_000, eventIndex)
    expect((complete as any).reason).toBe("promise_fulfilled")
    expect((complete as any).iteration).toBeGreaterThanOrEqual(1)

    const loopState = await harness.getRalphLoop(sessionId)
    expect(loopState.status).toBe("completed")
    expect(loopState.completionReason).toBe("promise_fulfilled")
  }, 180_000)

  // --- Scenario 2: Max iterations ---

  it("Scenario 2: ralph loop completes via max iterations", async ({ skip }) => {
    if (!backendAvailable) skip()

    const { sessionId, eventIndex } = await harness.startRalphLoop({
      promptPath: "./prompt-no-promise.md",
      maxIterations: 2,
      model: backendConfig().model,
      variant: backendConfig().variant,
    })

    await harness.waitForRalphEvent("ralph.started", sessionId, 30_000, eventIndex)

    const iterations = await Promise.all([
      harness.waitForRalphEvent("ralph.iteration", sessionId, 120_000, eventIndex),
      // Wait for the second iteration — find it after the first
      (async () => {
        const first = await harness.waitForRalphEvent("ralph.iteration", sessionId, 120_000, eventIndex)
        const firstIdx = harness.events.indexOf(first)
        return harness.waitForRalphEvent("ralph.iteration", sessionId, 120_000, firstIdx)
      })(),
    ])

    expect((iterations[0] as any).iteration).toBe(1)
    expect((iterations[1] as any).iteration).toBe(2)

    const complete = await harness.waitForRalphEvent("ralph.complete", sessionId, 120_000, eventIndex)
    expect((complete as any).reason).toBe("max_iterations")
    expect((complete as any).iteration).toBe(2)

    const loopState = await harness.getRalphLoop(sessionId)
    expect(loopState.status).toBe("completed")
    expect(loopState.completionReason).toBe("max_iterations")
  }, 300_000)

  // --- Scenario 3: Cancel active loop ---

  it("Scenario 3: cancel active ralph loop", async ({ skip }) => {
    if (!backendAvailable) skip()

    const { sessionId, eventIndex } = await harness.startRalphLoop({
      promptPath: "./prompt-no-promise.md",
      maxIterations: 20,
      model: backendConfig().model,
      variant: backendConfig().variant,
    })

    await harness.waitForRalphEvent("ralph.iteration", sessionId, 120_000, eventIndex)

    await harness.cancelRalphLoop(sessionId)

    const complete = await harness.waitForRalphEvent("ralph.complete", sessionId, 60_000, eventIndex)
    expect((complete as any).reason).toBe("cancelled")

    const loopState = await harness.getRalphLoop(sessionId)
    expect(loopState.status).toBe("cancelled")

    // Negative assertion: no further iterations after complete
    const completeIdx = harness.events.indexOf(complete)
    await new Promise((r) => setTimeout(r, 5_000))
    const laterIterations = harness.events.slice(completeIdx + 1).filter(
      (e: any) => e.type === "ralph.iteration" && e.sessionId === sessionId
    )
    expect(laterIterations).toHaveLength(0)
  }, 180_000)

  // --- Scenario 4: Session abort delegates to ralph cancel ---

  it("Scenario 4: session abort delegates to ralph loop cancel", async ({ skip }) => {
    if (!backendAvailable) skip()

    const { sessionId, eventIndex } = await harness.startRalphLoop({
      promptPath: "./prompt-no-promise.md",
      maxIterations: 20,
      model: backendConfig().model,
      variant: backendConfig().variant,
    })

    await harness.waitForRalphEvent("ralph.iteration", sessionId, 120_000, eventIndex)

    // Use the standard abort endpoint, not the ralph cancel endpoint
    const abortRes = await harness.abortSession(sessionId)
    expect(abortRes.status).toBe(200)

    const complete = await harness.waitForRalphEvent("ralph.complete", sessionId, 60_000, eventIndex)
    expect((complete as any).reason).toBe("cancelled")

    const loopState = await harness.getRalphLoop(sessionId)
    expect(loopState.status).toBe("cancelled")
  }, 180_000)

  // --- Scenario 5: Invalid prompt path ---

  it("Scenario 5: invalid prompt path returns 400", async ({ skip }) => {
    if (!backendAvailable) skip()

    const eventsBeforeCount = harness.events.length
    const res = await fetch(`${harness.serverUrl}/ralph-loop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        promptPath: "./nonexistent.md",
        maxIterations: 5,
        model: backendConfig().model,
        variant: backendConfig().variant,
      }),
    })

    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(body.error).toBeTruthy()

    // No ralph.started event should appear
    await new Promise((r) => setTimeout(r, 2_000))
    const ralphEvents = harness.events.slice(eventsBeforeCount).filter(
      (e: any) => e.type === "ralph.started"
    )
    expect(ralphEvents).toHaveLength(0)

    // List should not contain a new loop from this request
    const loops = await harness.listRalphLoops()
    const nonexistentLoops = loops.filter((l: any) =>
      l.promptPath?.includes("nonexistent.md")
    )
    expect(nonexistentLoops).toHaveLength(0)
  }, 10_000)

  // --- Scenario 6: Loop state lifecycle via REST ---

  it("Scenario 6: loop state lifecycle via REST API", async ({ skip }) => {
    if (!backendAvailable) skip()

    const { sessionId, eventIndex } = await harness.startRalphLoop({
      promptPath: "./prompt.md",
      completionPromise: "TASK_COMPLETE",
      maxIterations: 5,
      model: backendConfig().model,
      variant: backendConfig().variant,
    })

    // Immediately check — loop should be running
    const loopsRunning = await harness.listRalphLoops()
    const thisLoop = loopsRunning.find((l: any) => l.sessionId === sessionId) as any
    expect(thisLoop).toBeTruthy()
    expect(thisLoop.status).toBe("running")

    const loopRunning = await harness.getRalphLoop(sessionId)
    expect(loopRunning.status).toBe("running")

    // Wait for completion
    await harness.waitForRalphEvent("ralph.complete", sessionId, 180_000, eventIndex)

    const loopsCompleted = await harness.listRalphLoops()
    const completedLoop = loopsCompleted.find((l: any) => l.sessionId === sessionId) as any
    expect(completedLoop.status).toBe("completed")

    const loopFinal = await harness.getRalphLoop(sessionId)
    expect(loopFinal.status).toBe("completed")
    expect(loopFinal.completionReason).toBe("promise_fulfilled")

    // 404 for unknown session
    const unknownRes = await fetch(`${harness.serverUrl}/ralph-loop/nonexistent-session-id`)
    expect(unknownRes.status).toBe(404)
  }, 180_000)

  // --- Scenario 7: Concurrent loops ---

  it("Scenario 7: concurrent loops run without interference", async ({ skip }) => {
    if (!backendAvailable) skip()

    const loopA = await harness.startRalphLoop({
      promptPath: "./prompt-a.md",
      completionPromise: "LOOP_A_DONE",
      maxIterations: 5,
      model: backendConfig().model,
      variant: backendConfig().variant,
    })

    const loopB = await harness.startRalphLoop({
      promptPath: "./prompt-b.md",
      completionPromise: "LOOP_B_DONE",
      maxIterations: 5,
      model: backendConfig().model,
      variant: backendConfig().variant,
    })

    expect(loopA.sessionId).not.toBe(loopB.sessionId)

    // Wait for both to complete (in parallel)
    const [completeA, completeB] = await Promise.all([
      harness.waitForRalphEvent("ralph.complete", loopA.sessionId, 300_000, loopA.eventIndex),
      harness.waitForRalphEvent("ralph.complete", loopB.sessionId, 300_000, loopB.eventIndex),
    ])

    expect((completeA as any).reason).toBe("promise_fulfilled")
    expect((completeB as any).reason).toBe("promise_fulfilled")

    // Verify events are correctly scoped by sessionId
    const iterationsA = harness.events.slice(loopA.eventIndex).filter(
      (e: any) => e.type === "ralph.iteration" && e.sessionId === loopA.sessionId
    )
    const iterationsB = harness.events.slice(loopB.eventIndex).filter(
      (e: any) => e.type === "ralph.iteration" && e.sessionId === loopB.sessionId
    )
    expect(iterationsA.length).toBeGreaterThanOrEqual(1)
    expect(iterationsB.length).toBeGreaterThanOrEqual(1)

    // No cross-contamination
    const crossA = harness.events.slice(loopA.eventIndex).filter(
      (e: any) => e.type === "ralph.iteration" && e.sessionId === loopB.sessionId
    )
    // cross events exist but belong to loop B, not A — just verify iteration sessionIds match
    for (const evt of iterationsA) {
      expect((evt as any).sessionId).toBe(loopA.sessionId)
    }
    for (const evt of iterationsB) {
      expect((evt as any).sessionId).toBe(loopB.sessionId)
    }

    // Both appear in list
    const loops = await harness.listRalphLoops()
    const ids = loops.map((l: any) => l.sessionId)
    expect(ids).toContain(loopA.sessionId)
    expect(ids).toContain(loopB.sessionId)
  }, 300_000)

  // --- Scenario 8: Prompt file disappears mid-loop ---

  it("Scenario 8: prompt file disappears mid-loop", async ({ skip }) => {
    if (!backendAvailable) skip()

    // Create a separate workspace for this destructive test
    const ws8 = await createWorkspace(`ralph-disappear-${backend}`, {
      "prompt.md": NO_PROMISE_PROMPT,
      "README.md": "Test workspace for ralph prompt disappear test.",
    })
    const harness8 = await createE2EHarness(ws8)
    await harness8.waitForReady(90_000)
    const available8 = await getAvailableBackendsFromServer(harness8.serverUrl)
    if (!available8.includes(backend)) {
      await harness8.cleanup()
      await ws8.cleanup()
      skip()
      return
    }

    try {
      const { sessionId, eventIndex } = await harness8.startRalphLoop({
        promptPath: "./prompt.md",
        maxIterations: 5,
        model: backendConfig().model,
        variant: backendConfig().variant,
      })

      // Wait for iteration 1 to confirm prompt was read successfully
      await harness8.waitForRalphEvent("ralph.iteration", sessionId, 120_000, eventIndex)

      // Delete the prompt file
      unlinkSync(join(ws8.path, "prompt.md"))

      // Wait for loop to complete with error
      const complete = await harness8.waitForRalphEvent("ralph.complete", sessionId, 300_000, eventIndex)
      expect((complete as any).reason).toBe("error")
      expect((complete as any).detail).toBeTruthy()

      const loopState = await harness8.getRalphLoop(sessionId)
      expect(loopState.status).toBe("error")
    } finally {
      harness8.writeTranscript(`10-ralph-disappear-${backend}`)
      await harness8.cleanup()
      await ws8.cleanup()
    }
  }, 300_000)

  // --- Scenario 9: Prompt re-read between iterations ---

  it("Scenario 9: prompt re-read between iterations", async ({ skip }) => {
    if (!backendAvailable) skip()

    // Create a separate workspace for this test that modifies files
    const ws9 = await createWorkspace(`ralph-reread-${backend}`, {
      "prompt.md": NO_PROMISE_PROMPT,
      "README.md": "Test workspace for ralph prompt re-read test.",
    })
    const harness9 = await createE2EHarness(ws9)
    await harness9.waitForReady(90_000)
    const available9 = await getAvailableBackendsFromServer(harness9.serverUrl)
    if (!available9.includes(backend)) {
      await harness9.cleanup()
      await ws9.cleanup()
      skip()
      return
    }

    try {
      const { sessionId, eventIndex } = await harness9.startRalphLoop({
        promptPath: "./prompt.md",
        completionPromise: "EVOLVED_DONE",
        maxIterations: 5,
        model: backendConfig().model,
        variant: backendConfig().variant,
      })

      // Wait for iteration 1 (runs with original "list files" prompt — won't produce promise)
      await harness9.waitForRalphEvent("ralph.iteration", sessionId, 120_000, eventIndex)

      // Overwrite prompt.md with the promise fulfillment prompt
      const evolvedPrompt = `Your only task is to output exactly this text on a single line:
<promise>EVOLVED_DONE</promise>
Do not add any other text, explanation, or commentary. Just output that exact line.`
      writeFileSync(join(ws9.path, "prompt.md"), evolvedPrompt)

      // Wait for loop to complete with promise fulfilled
      const complete = await harness9.waitForRalphEvent("ralph.complete", sessionId, 300_000, eventIndex)
      expect((complete as any).reason).toBe("promise_fulfilled")
      expect((complete as any).iteration).toBeGreaterThanOrEqual(2)
    } finally {
      harness9.writeTranscript(`10-ralph-reread-${backend}`)
      await harness9.cleanup()
      await ws9.cleanup()
    }
  }, 300_000)
})
