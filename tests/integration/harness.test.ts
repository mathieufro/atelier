// tests/integration/harness.test.ts
import { describe, it, expect, afterEach } from "vitest"
import { createTestHarness, type TestHarness } from "./harness.js"
import { emit, pause } from "./test-agent-engine.js"
import { sessionBusy, sessionIdle, messageCreated } from "./factories.js"

describe("Test Harness", () => {
  let harness: TestHarness

  afterEach(async () => {
    await harness?.teardown()
  })

  it("creates a server with TestAgentEngine and captures SSE events", async () => {
    harness = await createTestHarness([
      emit(sessionBusy("s1")),
      emit(sessionIdle("s1")),
    ])

    await harness.engine.advanceAll()
    // Wait for events to propagate through SSE
    await harness.waitForEvents(2, 1000)

    expect(harness.events.length).toBeGreaterThanOrEqual(2)
  })

  it("smoke: forwardEvent normalizes at least one event to subscriber", async () => {
    harness = await createTestHarness([
      emit(sessionBusy("s1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(1, 2000)
    // Smoke assertion: verify the normalization pipeline actually produces events.
    // If forwardEvent() doesn't normalize AtelierEvent types, this will timeout.
    expect(harness.events.length).toBeGreaterThanOrEqual(1)
    // Verify normalized shape has a type field
    expect(harness.events[0]).toHaveProperty("type")
  })

  it("engine events flow through EventMerger to SSE subscriber", async () => {
    harness = await createTestHarness([
      emit(sessionBusy("s1")),
      emit(messageCreated("s1", "m1", "assistant")),
      pause("after-create"),
      emit(sessionIdle("s1")),
    ])

    await harness.engine.advanceTo("after-create")
    await harness.waitForEvents(1, 500) // at least session.busy normalized

    // After advancing past pause, should eventually get idle
    await harness.engine.advanceAll()
    await harness.waitForEvents(2, 1000)

    const types = harness.events.map((e: any) => e.type)
    expect(types).toContain("session.busy")
  })

  it("HTTP endpoints work alongside SSE", async () => {
    harness = await createTestHarness([])
    const res = await harness.app.request("/health")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.status).toBe("ready")
  })
})
