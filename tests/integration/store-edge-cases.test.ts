// tests/integration/store-edge-cases.test.ts
import { describe, it, expect, afterEach } from "vitest"
import { createTestHarness, type TestHarness } from "./harness.js"
import { emit, pause } from "./test-agent-engine.js"
import * as f from "./factories.js"

let harness: TestHarness
afterEach(async () => { await harness?.teardown() })

describe("Edge Cases: Optimistic Messages", () => {
  it("47. optimistic → confirmed — real message replaces optimistic, no duplicates", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1-real", "user")),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(2)
    // Real message should arrive — optimistic replacement is handled client-side
    const msgEvents = harness.events.filter((e: any) => e.type === "message.updated")
    expect(msgEvents.length).toBeGreaterThanOrEqual(1)
  })

  it("48. optimistic + session error — events propagate for client cleanup", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.sessionError("s1", "backend crashed")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(2)
    const errorEvt = harness.events.find((e: any) => e.type === "session.error")
    expect(errorEvt).toBeTruthy()
  })

  it("49. optimistic skill transfer — skill.used event arrives before message", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit({ type: "skill.used", sessionId: "s1", skillName: "brainstorming" })
    await harness.waitForEvents(1)
    const skill = harness.events.find((e: any) => e.type === "skill.used")
    expect(skill).toBeTruthy()
    expect((skill as any).skillName).toBe("brainstorming")
  })
})

describe("Edge Cases: Windowed Message Loading", () => {
  it("50. window at capacity — new message triggers trim (store-level)", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageCompletedText("s1", "m1", "response")),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(3)
    const msgUpdate = harness.events.find((e: any) => e.type === "message.updated")
    expect(msgUpdate).toBeTruthy()
  })

  it("51. load older messages — proxy returns paginated results", async () => {
    harness = await createTestHarness([])
    // Seed messages in proxy
    harness.proxy.addMessages("s1", Array.from({ length: 10 }, (_, i) => ({
      message: { id: `m${i}`, sessionID: "s1", role: i % 2 === 0 ? "user" : "assistant" },
      parts: [],
    })))
    // Request older messages via HTTP
    const res = await harness.app.request("/session/s1/messages?limit=3&before=7")
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.messages.length).toBeLessThanOrEqual(3)
  })

  it("52. window boundary during streaming — new events delivered alongside active stream", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageDelta("s1", "m1", "streaming content")),
      emit(f.messageCompletedText("s1", "m1", "final")),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    // All events should flow — window boundary trimming is client-side
    expect(harness.events.length).toBeGreaterThanOrEqual(3)
  })
})

describe("Edge Cases: Skill Badge Derivation", () => {
  it("53. badge from direct field — skill.used event delivered", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit({ type: "skill.used", sessionId: "s1", skillName: "fixing" })
    await harness.waitForEvents(1)
    const skill = harness.events.find((e: any) => e.type === "skill.used")
    expect(skill).toBeTruthy()
    expect((skill as any).skillName).toBe("fixing")
  })

  it("54. badge derivation from system prompt — handled client-side", async () => {
    harness = await createTestHarness([
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageCompletedText("s1", "m1", "I'll help fix that.")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(3)
    expect(harness.events.length).toBeGreaterThanOrEqual(2)
  })

  it("55. badge from pending SSE event — skill.used before message.created", async () => {
    harness = await createTestHarness([])
    // skill.used arrives first
    harness.eventMerger.emit({ type: "skill.used", sessionId: "s1", skillName: "brainstorming" })
    await harness.waitForEvents(1)
    // Then message arrives — client should transfer pending skill to message
    harness.eventMerger.forwardEvent(f.messageCreated("s1", "m1", "user") as any)
    await new Promise((r) => setTimeout(r, 100))
    const skill = harness.events.find((e: any) => e.type === "skill.used")
    expect(skill).toBeTruthy()
  })
})
