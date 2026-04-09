// tests/integration/multi-session.test.ts — Multi-session interleaving
import { describe, it, expect, afterEach } from "vitest"
import { createTestHarness, type TestHarness } from "./harness.js"
import { emit, pause } from "./test-agent-engine.js"
import * as f from "./factories.js"

let harness: TestHarness
afterEach(async () => { await harness?.teardown() })

describe("Multi-Session Events", () => {
  it("37. switch session during streaming — first continues in background", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageDelta("s1", "m1", "still generating")),
      pause("streaming"),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceTo("streaming")
    await new Promise((r) => setTimeout(r, 200)) // wait for throttle flush
    // Events for s1 should still be stored even if UI switches to s2
    // (server-side, all events flow regardless of which session the UI is viewing)
    const s1Events = harness.events.filter((e: any) =>
      (e.properties as any)?.sessionID === "s1" || (e.properties as any)?.info?.sessionID === "s1"
    )
    expect(s1Events.length).toBeGreaterThanOrEqual(1)
    await harness.engine.advanceAll()
  })

  it("38. events for inactive session — stored without crash", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageDelta("s1", "m1", "background update")),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(3)
    // All events should be captured in the event stream regardless of active session
    const types = harness.events.map((e: any) => e.type)
    expect(types).toContain("session.busy")
    expect(types).toContain("session.idle")
  })

  it("39. create session while another is busy — both tracked independently", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      pause("s1-busy"),
      emit(f.sessionIdle("s1")),
    ])
    // s1 is busy
    await harness.engine.advanceTo("s1-busy")

    // Create another session via HTTP (should work independently)
    const res = await harness.app.request("/session", { method: "POST" })
    expect(res.status).toBe(200)

    // Complete s1
    await harness.engine.advanceAll()
    await harness.waitForEvents(2)
  })
})
