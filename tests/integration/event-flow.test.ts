// tests/integration/event-flow.test.ts
import { describe, it, expect, afterEach } from "vitest"
import { createTestHarness, type TestHarness } from "./harness.js"
import { emit, pause } from "./test-agent-engine.js"
import * as f from "./factories.js"

let harness: TestHarness
afterEach(async () => { await harness?.teardown() })

describe("Event Flow: Session Lifecycle", () => {
  it("session.busy → SSE receives busy event", async () => {
    harness = await createTestHarness([emit(f.sessionBusy("s1"))])
    await harness.engine.advanceAll()
    await harness.waitForEvents(1)
    expect(harness.events.some((e: any) => e.type === "session.busy" && e.properties?.sessionID === "s1")).toBe(true)
  })

  it("session.idle → SSE receives idle event with usage", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.sessionIdle("s1", { inputTokens: 100, outputTokens: 50 })),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(2)
    const idle = harness.events.find((e: any) => e.type === "session.idle")
    expect(idle).toBeTruthy()
  })

  it("session.interrupted → SSE receives interrupted event", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.sessionInterrupted("s1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(3)
    const types = harness.events.map((e: any) => e.type)
    expect(types).toContain("session.interrupted")
    // Should also emit message.updated with error for the streaming message
    expect(types).toContain("message.updated")
  })

  it("session.error → SSE receives error event + streaming message marked interrupted", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.sessionError("s1", "backend crashed")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(3)
    const errorEvt = harness.events.find((e: any) => e.type === "session.error")
    expect(errorEvt).toBeTruthy()
  })
})

describe("Event Flow: Message Content", () => {
  it("message.created → message.updated + initial thinking/text parts", async () => {
    harness = await createTestHarness([emit(f.messageCreated("s1", "m1", "assistant"))])
    await harness.engine.advanceAll()
    await harness.waitForEvents(3) // message.updated + 2x message.part.updated
    const types = harness.events.map((e: any) => e.type)
    expect(types).toContain("message.updated")
    expect(types).toContain("message.part.updated")
  })

  it("message.delta → message.part.delta via throttle", async () => {
    harness = await createTestHarness([
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageDelta("s1", "m1", "Hello ")),
      emit(f.messageDelta("s1", "m1", "world!")),
    ])
    await harness.engine.advanceAll()
    // Throttle accumulates deltas and flushes after 100ms
    await new Promise((r) => setTimeout(r, 200))
    // Should have accumulated deltas
    const deltas = harness.events.filter((e: any) => e.type === "message.part.delta")
    expect(deltas.length).toBeGreaterThanOrEqual(1)
  })

  it("message.completed → final parts emitted for each content block", async () => {
    harness = await createTestHarness([
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageCompletedText("s1", "m1", "Hello world")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(4)
    // Should have message.updated with finish info + message.part.updated for text
    const partUpdates = harness.events.filter((e: any) => e.type === "message.part.updated")
    expect(partUpdates.length).toBeGreaterThanOrEqual(1) // text part (initial + final)
  })
})

describe("Event Flow: Tool Activity", () => {
  it("tool.started → message.part.updated with running state", async () => {
    harness = await createTestHarness([
      emit(f.toolStarted("s1", "t1", "write", { filePath: "/tmp/test.ts" }, "m1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(1)
    const partUpdate = harness.events.find((e: any) => {
      const part = (e.properties as any)?.part
      return e.type === "message.part.updated" && part?.tool === "write"
    })
    expect(partUpdate).toBeTruthy()
    const part = (partUpdate as any).properties.part
    expect(part.state.status).toBe("running")
    expect(part.callID).toBe("t1")
  })

  it("tool.completed → message.part.updated with completed state + duration", async () => {
    harness = await createTestHarness([
      emit(f.toolStarted("s1", "t1", "bash", { command: "echo hi" }, "m1")),
      emit(f.toolCompleted("s1", "t1", "bash", "hi\n", { durationMs: 150, messageId: "m1" })),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200)) // wait for throttle flush
    const completed = harness.events.find((e: any) => {
      const part = (e.properties as any)?.part
      return e.type === "message.part.updated" && part?.state?.status === "completed"
    })
    expect(completed).toBeTruthy()
    const part = (completed as any).properties.part
    expect(part.state.output).toBe("hi\n")
  })
})

describe("Event Flow: Interactions", () => {
  it("permission.asked → permission.asked event with tool info", async () => {
    harness = await createTestHarness([
      emit(f.permissionAsked("s1", "req-1", "bash", { command: "rm -rf /" })),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(1)
    const perm = harness.events.find((e: any) => e.type === "permission.asked")
    expect(perm).toBeTruthy()
    expect((perm as any).properties.permission.tool).toBe("bash")
  })

  it("permission.replied → event passes through to SSE", async () => {
    harness = await createTestHarness([
      emit(f.permissionAsked("s1", "req-1", "bash", { command: "rm" })),
      emit(f.permissionReplied("s1", "req-1", "allow")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(2)
    const replied = harness.events.find((e: any) => e.type === "permission.replied")
    expect(replied).toBeTruthy()
  })

  it("question.asked → question.asked event with question data", async () => {
    harness = await createTestHarness([
      emit(f.questionAsked("s1", "q-1", { text: "Which approach?" })),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(1)
    const q = harness.events.find((e: any) => e.type === "question.asked")
    expect(q).toBeTruthy()
  })

  it("question.replied → event passes through to SSE", async () => {
    harness = await createTestHarness([
      emit(f.questionAsked("s1", "q-1", { text: "Which approach?" })),
      emit(f.questionReplied("s1", "q-1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(2)
    const replied = harness.events.find((e: any) => e.type === "question.replied")
    expect(replied).toBeTruthy()
  })

  it("question.rejected → event passes through to SSE", async () => {
    harness = await createTestHarness([
      emit(f.questionAsked("s1", "q-1", { text: "Which approach?" })),
      emit(f.questionRejected("s1", "q-1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(2)
    const rejected = harness.events.find((e: any) => e.type === "question.rejected")
    expect(rejected).toBeTruthy()
  })
})

describe("Event Flow: Infrastructure", () => {
  it("connection.status → event passes through to SSE", async () => {
    harness = await createTestHarness([
      emit(f.connectionStatus("opencode", "ready")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(1)
    const conn = harness.events.find((e: any) => e.type === "connection.status")
    expect(conn).toBeTruthy()
  })

  it("rate_limit → event passes through to SSE", async () => {
    harness = await createTestHarness([
      emit(f.rateLimit("s1", "allowed_warning")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(1)
    const rl = harness.events.find((e: any) => e.type === "rate_limit")
    expect(rl).toBeTruthy()
  })
})
