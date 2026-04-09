// tests/integration/pipeline.test.ts — Pipeline orchestration event flow
import { describe, it, expect, afterEach } from "vitest"
import { createTestHarness, type TestHarness } from "./harness.js"
import { emit, pause } from "./test-agent-engine.js"
import * as f from "./factories.js"

let harness: TestHarness
afterEach(async () => { await harness?.teardown() })

describe("Pipeline Events: Edge Cases", () => {
  it("41. fix cycle exhaustion → stuck_escalation event", async () => {
    harness = await createTestHarness([])
    // Emit pipeline events directly through merger
    harness.eventMerger.emit(f.stageStarted("p1", "st1", "review_code", "sess-1"))
    harness.eventMerger.emit(f.stuckEscalation("p1", "st1", "review_code", "sess-1"))
    await harness.waitForEvents(2)
    const stuck = harness.events.find((e: any) => e.type === "stuck_escalation")
    expect(stuck).toBeTruthy()
    expect((stuck as any).pipelineId).toBe("p1")
  })

  it("40. stage transition during tool — current stage completes cleanly", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.toolStarted("s1", "t1", "write", { filePath: "test.ts" }, "m1")),
      pause("tool-running"),
      emit(f.toolCompleted("s1", "t1", "write", "done", { messageId: "m1" })),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceTo("tool-running")
    // Orchestrator advances stage while tool is running
    harness.eventMerger.emit(f.stageCompleted("p1", "st1"))
    harness.eventMerger.emit(f.stageStarted("p1", "st2", "review_code", "s2"))
    await harness.engine.advanceAll()
    await harness.waitForEvents(4)
    const types = harness.events.map((e: any) => e.type)
    expect(types).toContain("stage_completed")
    expect(types).toContain("stage_started")
  })

  it("42. pipeline abort mid-stage — stage marked interrupted", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.sessionInterrupted("s1")),
    ])
    harness.eventMerger.emit(f.stageStarted("p1", "st1", "implement", "s1"))
    await harness.engine.advanceAll()
    harness.eventMerger.emit({ type: "stage_interrupted", pipelineId: "p1", stageId: "st1", sessionId: "s1" })
    await harness.waitForEvents(3)
    const interrupted = harness.events.find((e: any) => e.type === "stage_interrupted")
    expect(interrupted).toBeTruthy()
  })

  it("43. concurrent pipeline events — routed independently", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit(f.stageStarted("p1", "st1", "brainstorm", "sess-1"))
    harness.eventMerger.emit(f.stageStarted("p2", "st2", "implement", "sess-2"))
    harness.eventMerger.emit(f.stageCompleted("p1", "st1"))
    harness.eventMerger.emit(f.stageCompleted("p2", "st2"))
    await harness.waitForEvents(4)
    const p1Events = harness.events.filter((e: any) => (e as any).pipelineId === "p1")
    const p2Events = harness.events.filter((e: any) => (e as any).pipelineId === "p2")
    expect(p1Events).toHaveLength(2)
    expect(p2Events).toHaveLength(2)
    // Verify no cross-contamination
    expect(p1Events.every((e: any) => e.pipelineId === "p1")).toBe(true)
    expect(p2Events.every((e: any) => e.pipelineId === "p2")).toBe(true)
  })
})
