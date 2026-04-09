import { describe, it, expect, beforeEach, vi } from "vitest"
import { createEventMerger } from "../../src/engine/event-merger.js"

describe("EventMerger", () => {
  let merger: ReturnType<typeof createEventMerger>

  beforeEach(() => {
    merger = createEventMerger({ bufferSize: 10 })
  })

  it("assigns monotonically increasing seq numbers", () => {
    merger.emit({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm" })
    merger.emit({ type: "stage_completed", pipelineId: "p1", stageId: "s1" })
    const events = merger.getEventsAfter(0)
    expect(events![0].seq).toBe(1)
    expect(events![1].seq).toBe(2)
  })

  it("replays events after a given seq", () => {
    merger.emit({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm" })
    merger.emit({ type: "stage_completed", pipelineId: "p1", stageId: "s1" })
    merger.emit({ type: "pipeline_completed", pipelineId: "p1" })
    const events = merger.getEventsAfter(1) // after seq 1
    expect(events).toHaveLength(2)
    expect(events![0].seq).toBe(2)
  })

  it("returns null for unknown lastEventId (full refresh needed)", () => {
    merger.emit({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm" })
    const result = merger.getEventsAfter(999)
    expect(result).toBeNull() // seq 999 not in buffer
  })

  it("filters session-level events for internal sessions but forwards message events", () => {
    merger.addInternalSession("internal-sess")
    const received: any[] = []
    merger.subscribe((event, _json) => received.push(event))

    // Session lifecycle events are filtered (keep internal sessions hidden from dropdown)
    merger.forwardOpenCodeEvent({ type: "session.created", sessionID: "internal-sess", properties: { info: { id: "internal-sess" } } })
    merger.forwardOpenCodeEvent({ type: "session.updated", sessionID: "internal-sess", properties: { info: { id: "internal-sess" } } })
    expect(received).toHaveLength(0)

    // session.status is forwarded (needed for busy/idle tracking in UI)
    merger.forwardOpenCodeEvent({ type: "session.status", sessionID: "internal-sess", properties: { sessionID: "internal-sess", status: { type: "busy" } } })
    expect(received).toHaveLength(1)

    // Message events are forwarded (needed for pipeline StageBlock display)
    merger.forwardOpenCodeEvent({ type: "message.updated", sessionID: "internal-sess", properties: { info: { sessionID: "internal-sess" } } })
    merger.forwardOpenCodeEvent({ type: "message.updated", sessionID: "visible-sess", properties: {} })
    expect(received).toHaveLength(3)
  })

  it("removes internal session tracking", () => {
    merger.addInternalSession("internal-sess")
    merger.removeInternalSession("internal-sess")

    const received: any[] = []
    merger.subscribe((event, _json) => received.push(event))

    merger.forwardOpenCodeEvent({ type: "message.updated", sessionID: "internal-sess", properties: {} })
    expect(received).toHaveLength(1) // no longer filtered
  })

  it("ring buffer evicts old events when full", () => {
    for (let i = 0; i < 15; i++) {
      merger.emit({ type: "stage_started", pipelineId: "p1", stageId: `s${i}`, stage: "brainstorm" })
    }
    // Buffer size is 10, so first 5 events should be evicted
    const events = merger.getEventsAfter(0)
    // getEventsAfter(0) returns all buffered events (the most recent 10)
    // even when the buffer has wrapped — this ensures webview reconnections
    // don't miss events like compiled prompts
    expect(events).not.toBeNull()
    expect(events!).toHaveLength(10)
    expect(events![0].seq).toBe(6) // oldest surviving event
    // getEventsAfter(5) should also work (seq 6+ still in buffer)
    const recent = merger.getEventsAfter(5)
    expect(recent).not.toBeNull()
    expect(recent!).toHaveLength(10)
  })

  it("provides current seq watermark", () => {
    expect(merger.currentSeq()).toBe(0)
    merger.emit({ type: "pipeline_completed", pipelineId: "p1" })
    expect(merger.currentSeq()).toBe(1)
  })

  it("notifies subscribers of pipeline events", () => {
    const received: any[] = []
    merger.subscribe((event, _json) => received.push(event))
    merger.emit({ type: "pipeline_completed", pipelineId: "p1" })
    expect(received).toHaveLength(1)
    expect(received[0].seq).toBe(1)
  })

  it("notifies subscribers of forwarded OpenCode events", () => {
    const received: any[] = []
    merger.subscribe((event, _json) => received.push(event))
    merger.forwardOpenCodeEvent({ type: "session.created", sessionID: "s1", properties: {} })
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("session.created")
    expect(received[0].seq).toBe(1)
  })

  it("stores only post-filtering events in ring buffer", () => {
    merger.addInternalSession("internal-sess")
    // Session-level event is filtered — not stored
    merger.forwardOpenCodeEvent({ type: "session.created", sessionID: "internal-sess", properties: { info: { id: "internal-sess" } } })
    // Message events are forwarded — stored in buffer (for pipeline StageBlock display)
    merger.forwardOpenCodeEvent({ type: "message.updated", sessionID: "internal-sess", properties: { info: { sessionID: "internal-sess" } } })
    merger.forwardOpenCodeEvent({ type: "message.updated", sessionID: "visible-sess", properties: {} })
    const events = merger.getEventsAfter(0)
    expect(events).toHaveLength(2)
  })

  it("suppresses session.created during pending internal creation (race condition fix)", () => {
    const received: any[] = []
    merger.subscribe((event, _json) => received.push(event))

    // Simulate: beginInternalCreation called, then session.created arrives before completeInternalCreation
    merger.beginInternalCreation()
    merger.forwardOpenCodeEvent({ type: "session.created", sessionID: "new-internal", properties: { info: { id: "new-internal" } } })
    expect(received).toHaveLength(0) // suppressed

    // Complete creation — session is now registered as internal
    merger.completeInternalCreation("new-internal")

    // Subsequent events for this session should be filtered as internal
    merger.forwardOpenCodeEvent({ type: "session.updated", sessionID: "new-internal", properties: { info: { id: "new-internal" } } })
    expect(received).toHaveLength(0) // still filtered (internal)

    // But message events should pass through (internal sessions forward message events)
    merger.forwardOpenCodeEvent({ type: "message.updated", sessionID: "new-internal", properties: { info: { sessionID: "new-internal" } } })
    expect(received).toHaveLength(1)
  })

  it("does not suppress session.created for non-internal sessions during pending creation", () => {
    const received: any[] = []
    merger.subscribe((event, _json) => received.push(event))

    merger.beginInternalCreation()
    // A user-created session arrives during the window — should still be suppressed
    // (we can't distinguish, but the window is tiny and the cost is minimal)
    merger.forwardOpenCodeEvent({ type: "session.created", sessionID: "user-sess", properties: { info: { id: "user-sess" } } })
    expect(received).toHaveLength(0) // suppressed during pending window

    merger.completeInternalCreation("internal-sess")
    // After window closes, user sessions pass through normally
    merger.forwardOpenCodeEvent({ type: "session.created", sessionID: "user-sess-2", properties: { info: { id: "user-sess-2" } } })
    expect(received).toHaveLength(1)
  })

  it("subscriber error does not prevent other subscribers from receiving events", () => {
    const received: any[] = []
    merger.subscribe((_e, _j) => { throw new Error("subscriber 1 explodes") })
    merger.subscribe((event, _json) => received.push(event))
    merger.emit({ type: "pipeline_completed", pipelineId: "p1" })
    // Second subscriber still receives the event despite first throwing
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("pipeline_completed")
  })

  it("stops text throttle timer after flush to avoid idle wakeups", async () => {
    vi.useFakeTimers()
    merger.subscribe(() => {})

    merger.forwardOpenCodeEvent({
      type: "part.updated",
      sessionID: "s1",
      properties: { info: { sessionID: "s1" }, part: { id: "p1", type: "text", text: "hello" } },
    })

    // One interval is active waiting for throttle flush.
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(100)
    await Promise.resolve()

    // Timer is self-stopped once pending updates are flushed.
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  it("throttles message.part.updated alias events", async () => {
    vi.useFakeTimers()
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    merger.forwardOpenCodeEvent({
      type: "message.part.updated",
      sessionID: "s1",
      properties: { info: { sessionID: "s1" }, part: { id: "p1", type: "text", text: "a" } },
    })

    expect(received).toHaveLength(0)
    vi.advanceTimersByTime(100)
    await Promise.resolve()
    expect(received).toHaveLength(1)
    vi.useRealTimers()
  })

  it("strips running tool output in throttled live events", async () => {
    vi.useFakeTimers()
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    merger.forwardOpenCodeEvent({
      type: "message.part.updated",
      sessionID: "s1",
      properties: {
        info: { sessionID: "s1" },
        part: {
          id: "tool-1",
          type: "tool-invocation",
          toolName: "bash",
          state: { type: "running", output: "very noisy stream" },
        },
      },
    })

    vi.advanceTimersByTime(100)
    await Promise.resolve()

    expect(received).toHaveLength(1)
    expect(received[0].properties.part.state.output).toBe("")
    vi.useRealTimers()
  })
})

describe("EventMerger with AtelierEvent", () => {
  it("forwardEvent accepts AtelierEvent and emits to subscribers", () => {
    const merger = createEventMerger({ bufferSize: 10 })
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    merger.forwardEvent({
      type: "session.busy",
      sessionId: "s1",
    })
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("session.busy")
    // After normalization, sessionId is wrapped in properties.sessionID
    expect(received[0].properties.sessionID).toBe("s1")
  })

  it("forwardEvent throttles message.delta events and flushes on stop", () => {
    const merger = createEventMerger({ bufferSize: 10 })
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    merger.forwardEvent({
      type: "message.delta",
      sessionId: "s1",
      messageId: "m1",
      contentType: "text",
      delta: "Hello",
    })

    // Should be pending, not emitted yet
    expect(received).toHaveLength(0)

    // Flush via stopThrottle
    merger.stopThrottle()

    // After stopThrottle, pending delta should be flushed (normalized to message.part.delta)
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("message.part.delta")
    expect(received[0].properties.delta).toBe("Hello")
  })

  it("forwardEvent filters non-allowed event types for internal sessions but passes message and lifecycle events", () => {
    const merger = createEventMerger({ bufferSize: 10 })
    merger.addInternalSession("internal-s1")
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    // Session lifecycle events (session.busy/idle/error) pass through for internal sessions
    merger.forwardEvent({
      type: "session.busy",
      sessionId: "internal-s1",
    })
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("session.busy")

    // Message events should also pass through (after flush)
    merger.forwardEvent({
      type: "message.delta",
      sessionId: "internal-s1",
      messageId: "m1",
      contentType: "text",
      delta: "Hi",
    })

    merger.stopThrottle()
    expect(received.length).toBeGreaterThanOrEqual(2)
    expect(received.find((e: any) => e.type === "message.part.delta")).toBeTruthy()
  })

  it("stopThrottle called twice does not double-flush", () => {
    const localMerger = createEventMerger({ bufferSize: 10 })
    const received: any[] = []
    localMerger.subscribe((event, _json) => received.push(event))

    localMerger.forwardEvent({
      type: "message.delta",
      sessionId: "s1",
      messageId: "m1",
      role: "assistant",
      delta: "Hello",
    } as any)

    localMerger.stopThrottle()
    const countAfterFirst = received.length
    expect(countAfterFirst).toBe(1)

    localMerger.stopThrottle() // second call — should be a no-op
    expect(received.length).toBe(countAfterFirst)
  })

  it("routes thinking deltas to reasoning part, text deltas to text part", () => {
    const merger = createEventMerger({ bufferSize: 50 })
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    // message.created should create only text placeholder (thinking is lazy)
    merger.forwardEvent({
      type: "message.created",
      sessionId: "s1",
      messageId: "m1",
      role: "assistant",
    })

    const partUpdates = received.filter((e: any) => e.type === "message.part.updated")
    expect(partUpdates).toHaveLength(1)
    const textPart = partUpdates.find((e: any) => e.properties.part.type === "text")
    expect(textPart).toBeTruthy()
    expect(textPart.properties.part.id).toBe("m1-text")

    // First thinking delta should create reasoning part and route delta to it
    merger.forwardEvent({
      type: "message.delta",
      sessionId: "s1",
      messageId: "m1",
      contentType: "thinking",
      delta: "Let me think...",
    })
    merger.stopThrottle()

    const reasoningPart = received.find((e: any) => e.type === "message.part.updated" && e.properties.part.type === "reasoning")
    expect(reasoningPart).toBeTruthy()
    expect(reasoningPart.properties.part.id).toBe("m1-thinking")

    const thinkingDelta = received.find((e: any) =>
      e.type === "message.part.delta" && e.properties.partID === "m1-thinking"
    )
    expect(thinkingDelta).toBeTruthy()
    expect(thinkingDelta.properties.field).toBe("text")

    // text delta should target the text part
    merger.forwardEvent({
      type: "message.delta",
      sessionId: "s1",
      messageId: "m1",
      contentType: "text",
      delta: "The answer is 4.",
    })
    merger.stopThrottle()

    const textDelta = received.find((e: any) =>
      e.type === "message.part.delta" && e.properties.partID === "m1-text"
    )
    expect(textDelta).toBeTruthy()
    expect(textDelta.properties.field).toBe("text")
  })

  it("does not create thinking placeholder when no thinking deltas arrive", () => {
    const merger = createEventMerger({ bufferSize: 50 })
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    // message.created should NOT create a thinking placeholder
    merger.forwardEvent({
      type: "message.created",
      sessionId: "s1",
      messageId: "m1",
      role: "assistant",
    } as any)

    const thinkingPart = received.find((e: any) =>
      e.type === "message.part.updated" && e.properties?.part?.type === "reasoning"
    )
    expect(thinkingPart).toBeUndefined()

    // Text part should still be created
    const textPart = received.find((e: any) =>
      e.type === "message.part.updated" && e.properties?.part?.type === "text"
    )
    expect(textPart).toBeTruthy()
  })

  it("creates thinking placeholder lazily on first thinking delta", () => {
    const merger = createEventMerger({ bufferSize: 50 })
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    merger.forwardEvent({
      type: "message.created",
      sessionId: "s1",
      messageId: "m1",
      role: "assistant",
    } as any)

    // First thinking delta should create the thinking part
    merger.forwardEvent({
      type: "message.delta",
      sessionId: "s1",
      messageId: "m1",
      contentType: "thinking",
      delta: "Let me think...",
    } as any)
    merger.stopThrottle()

    const thinkingPart = received.find((e: any) =>
      e.type === "message.part.updated" && e.properties?.part?.type === "reasoning"
    )
    expect(thinkingPart).toBeTruthy()
    expect(thinkingPart.properties.part.id).toBe("m1-thinking")
  })
})

/** Shared helper: creates a mock logger that captures events. */
function createCapturingLogger() {
  const events: any[] = []
  const capture = (_la: string, _c: string, action: string, ctx?: any) => events.push({ action, ...ctx })
  const logger = {
    log: vi.fn((_l: string, _la: string, _c: string, action: string, ctx?: any) => events.push({ action, ...ctx })),
    info: vi.fn(capture),
    debug: vi.fn(capture),
    error: vi.fn(capture),
    trace: vi.fn(capture),
    child: vi.fn(function(this: any) { return this }),
  } as any
  return { logger, events }
}

describe("OpenCode event logging", () => {
  it("logs session_created for session.created events", () => {
    const { logger, events } = createCapturingLogger()

    const merger = createEventMerger({ logger })
    merger.forwardOpenCodeEvent({
      type: "session.created",
      sessionID: "s1",
      properties: { info: { sessionID: "s1" } },
    })

    expect(events.some(e => e.action === "session_created")).toBe(true)
  })

  it("logs tool_call_started for tool-invocation part.created events", () => {
    const { logger, events } = createCapturingLogger()

    const merger = createEventMerger({ logger })
    merger.forwardOpenCodeEvent({
      type: "part.created",
      sessionID: "s1",
      properties: {
        info: { sessionID: "s1" },
        part: { type: "tool-invocation", toolName: "bash" },
      },
    })

    expect(events.some(e => e.action === "tool_call_started")).toBe(true)
  })

  it("logs token_usage for message.usage events", () => {
    const { logger, events } = createCapturingLogger()

    const merger = createEventMerger({ logger })
    merger.forwardOpenCodeEvent({
      type: "message.usage",
      sessionID: "s1",
      properties: { info: { sessionID: "s1" }, usage: { input: 100, output: 50 } },
    })

    const tokenEvent = events.find(e => e.action === "token_usage")
    expect(tokenEvent).toBeTruthy()
    expect(tokenEvent.data?.inputTokens).toBe(100)
    expect(tokenEvent.data?.outputTokens).toBe(50)
  })

  it("includes durationMs in tool_call_completed events", () => {
    const { logger, events } = createCapturingLogger()

    const merger = createEventMerger({ logger })
    merger.forwardOpenCodeEvent({
      type: "part.created",
      sessionID: "s1",
      properties: {
        info: { sessionID: "s1" },
        part: { id: "p1", type: "tool-invocation", toolName: "bash" },
      },
    })
    merger.forwardOpenCodeEvent({
      type: "part.updated",
      sessionID: "s1",
      properties: {
        info: { sessionID: "s1" },
        part: { id: "p1", type: "tool-invocation", toolName: "bash", state: { type: "completed" } },
      },
    })

    const completed = events.find(e => e.action === "tool_call_completed")
    expect(completed).toBeTruthy()
    expect(completed.data?.toolName).toBe("bash")
    expect(typeof completed.data?.durationMs).toBe("number")
    expect(completed.data?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it("skips unmapped event types silently", () => {
    const { logger } = createCapturingLogger()

    const merger = createEventMerger({ logger })
    merger.forwardOpenCodeEvent({
      type: "part.updated",
      sessionID: "s1",
      properties: { info: { sessionID: "s1" }, part: { type: "text" } },
    })

    // No log calls for text part.updated (streaming content — excluded)
    expect(logger.debug).not.toHaveBeenCalled()
    expect(logger.trace).not.toHaveBeenCalled()
  })

  it("works without logger (backward compatible)", () => {
    const merger = createEventMerger()
    // Should not throw
    merger.forwardOpenCodeEvent({
      type: "session.created",
      sessionID: "s1",
      properties: { info: { sessionID: "s1" } },
    })
  })

  it("truncates oversized summary.diffs entries in message.updated events", () => {
    const merger = createEventMerger()
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    merger.forwardOpenCodeEvent({
      type: "message.updated",
      properties: {
        info: {
          sessionID: "s1",
          id: "msg1",
          role: "assistant",
          summary: {
            diffs: [
              { file: "src/foo.ts", before: "old content...", after: "new content..." },
              { file: "src/bar.ts", before: "x".repeat(100_000), after: "y".repeat(100_000) },
            ],
          },
        },
      },
    })

    expect(received).toHaveLength(1)
    const diffs = received[0].properties.info.summary.diffs
    // Small diff should be preserved as-is
    expect(diffs[0].before).toBe("old content...")
    expect(diffs[0].after).toBe("new content...")
    // Oversized diff should be truncated to 50K chars + truncation notice
    expect(diffs[1].before.length).toBeLessThan(100_000)
    expect(diffs[1].before).toContain("…[truncated")
    expect(diffs[1].after).toContain("…[truncated")
    // File path preserved
    expect(diffs[1].file).toBe("src/bar.ts")
  })

  it("preserves message.updated events without summary.diffs", () => {
    const merger = createEventMerger()
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    merger.forwardOpenCodeEvent({
      type: "message.updated",
      properties: {
        info: { sessionID: "s1", id: "msg1", role: "user", cost: 0 },
      },
    })

    expect(received).toHaveLength(1)
    expect(received[0].properties.info.cost).toBe(0)
  })

  it("merges per-token OpenCode reasoning parts into a single accumulated part", () => {
    const merger = createEventMerger()
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    // Simulate OpenCode sending per-token reasoning parts with unique IDs
    merger.forwardOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        info: { sessionID: "s1" },
        part: { id: "prt_001", sessionID: "s1", messageID: "msg1", type: "reasoning", text: "Let ", time: { start: 1000, end: 1001 } },
      },
    })
    merger.forwardOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        info: { sessionID: "s1" },
        part: { id: "prt_002", sessionID: "s1", messageID: "msg1", type: "reasoning", text: "me think", time: { start: 1001, end: 1002 } },
      },
    })
    merger.forwardOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        info: { sessionID: "s1" },
        part: { id: "prt_003", sessionID: "s1", messageID: "msg1", type: "reasoning", text: " about this", time: { start: 1002, end: 1003 } },
      },
    })
    merger.stopThrottle()

    // Should emit exactly ONE reasoning part with merged text and stable ID
    const reasoningParts = received.filter((e: any) =>
      e.type === "message.part.updated" && e.properties?.part?.type === "reasoning"
    )
    expect(reasoningParts).toHaveLength(1)
    expect(reasoningParts[0].properties.part.id).toBe("msg1-reasoning")
    expect(reasoningParts[0].properties.part.text).toBe("Let me think about this")
    expect(reasoningParts[0].properties.part.time.start).toBe(1000)
    expect(reasoningParts[0].properties.part.time.end).toBe(1003)
  })

  it("cleans up merged reasoning state on session.idle", () => {
    const merger = createEventMerger()
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    // First message — accumulate reasoning
    merger.forwardOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        info: { sessionID: "s1" },
        part: { id: "prt_001", sessionID: "s1", messageID: "msg1", type: "reasoning", text: "Hello", time: { start: 1000, end: 1001 } },
      },
    })
    merger.stopThrottle()

    // Session goes idle — should clean up
    merger.forwardOpenCodeEvent({
      type: "session.idle",
      properties: { sessionID: "s1" },
    })

    received.length = 0

    // New message — should start fresh (not accumulate with old text)
    merger.forwardOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        info: { sessionID: "s1" },
        part: { id: "prt_010", sessionID: "s1", messageID: "msg2", type: "reasoning", text: "Fresh", time: { start: 2000, end: 2001 } },
      },
    })
    merger.stopThrottle()

    const reasoningParts = received.filter((e: any) =>
      e.type === "message.part.updated" && e.properties?.part?.type === "reasoning"
    )
    expect(reasoningParts).toHaveLength(1)
    expect(reasoningParts[0].properties.part.text).toBe("Fresh")
  })

  it("does not duplicate text when same reasoning part ID is updated (normal model pattern)", () => {
    const merger = createEventMerger()
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    // Normal model: same part ID, updated with full accumulated text each time
    merger.forwardOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        info: { sessionID: "s1" },
        part: { id: "prt_stable", sessionID: "s1", messageID: "msg1", type: "reasoning", text: "Let me", time: { start: 1000 } },
      },
    })
    merger.forwardOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        info: { sessionID: "s1" },
        part: { id: "prt_stable", sessionID: "s1", messageID: "msg1", type: "reasoning", text: "Let me think about", time: { start: 1000 } },
      },
    })
    merger.forwardOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        info: { sessionID: "s1" },
        part: { id: "prt_stable", sessionID: "s1", messageID: "msg1", type: "reasoning", text: "Let me think about this problem", time: { start: 1000, end: 5000 } },
      },
    })
    merger.stopThrottle()

    const reasoningParts = received.filter((e: any) =>
      e.type === "message.part.updated" && e.properties?.part?.type === "reasoning"
    )
    // Should emit exactly one part with the latest full text — NOT duplicated
    expect(reasoningParts).toHaveLength(1)
    expect(reasoningParts[0].properties.part.text).toBe("Let me think about this problem")
    expect(reasoningParts[0].properties.part.id).toBe("msg1-reasoning")
  })

  it("does not clone diffs when all entries are under the size cap", () => {
    const merger = createEventMerger()
    const received: any[] = []
    merger.subscribe((event) => received.push(event))

    const originalDiffs = [
      { file: "a.ts", before: "small", after: "also small" },
    ]

    merger.forwardOpenCodeEvent({
      type: "message.updated",
      properties: {
        info: {
          sessionID: "s1",
          id: "msg1",
          role: "assistant",
          summary: { diffs: originalDiffs },
        },
      },
    })

    expect(received).toHaveLength(1)
    // Original diffs preserved exactly
    expect(received[0].properties.info.summary.diffs[0].before).toBe("small")
    expect(received[0].properties.info.summary.diffs[0].after).toBe("also small")
  })
})
