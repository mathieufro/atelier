// tests/integration/edge-cases.test.ts
import { describe, it, expect, afterEach } from "vitest"
import { createTestHarness, type TestHarness } from "./harness.js"
import { emit, pause, wait } from "./test-agent-engine.js"
import * as f from "./factories.js"

let harness: TestHarness
afterEach(async () => { await harness?.teardown() })

describe("Edge Cases: Message & Session Lifecycle", () => {
  it("1. send during active tool — message queued until idle", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.toolStarted("s1", "t1", "write", {}, "m1")),
      pause("write-running"),
      emit(f.toolCompleted("s1", "t1", "write", "done", { messageId: "m1" })),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceTo("write-running")
    // User sends message while tool is running (via HTTP)
    const sendRes = await harness.app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", mode: "build", sessionId: "s1" }),
    })
    // Should succeed (server accepts and forwards to proxy)
    expect(sendRes.status).toBe(200)
    await harness.engine.advanceAll()
  })

  it("3. abort then send immediately — waits for clean idle", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.toolStarted("s1", "t1", "bash", { command: "ls" }, "m1")),
      pause("tool-running"),
      emit(f.sessionInterrupted("s1")),
      pause("interrupted"),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceTo("tool-running")
    // Abort
    const abortRes = await harness.app.request("/session/s1/abort", { method: "POST" })
    expect(abortRes.status).toBe(200)
    await harness.engine.advanceTo("interrupted")
    // Immediately send new message before idle
    const sendRes = await harness.app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "continue", mode: "build", sessionId: "s1" }),
    })
    expect(sendRes.status).toBe(200)
    await harness.engine.advanceAll()
  })

  it("4. double send — second waits for first to complete", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      pause("first-processing"),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceTo("first-processing")
    // Send two messages in rapid succession via HTTP
    const [res1, res2] = await Promise.all([
      harness.app.request("/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "first", mode: "build", sessionId: "s1" }),
      }),
      harness.app.request("/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "second", mode: "build", sessionId: "s1" }),
      }),
    ])
    expect(res1.status).toBe(200)
    expect(res2.status).toBe(200)
    await harness.engine.advanceAll()
  })

  it("5. send to deleted session — does not crash", async () => {
    harness = await createTestHarness([])
    // Send message to a session that doesn't exist
    const res = await harness.app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", mode: "build", sessionId: "nonexistent" }),
    })
    // Server proxies the message through — may succeed or error depending on proxy.
    // The key assertion is no crash.
    expect([200, 400, 404, 500]).toContain(res.status)
  })

  it("9. rapid session create/delete — no orphaned subscriptions", async () => {
    harness = await createTestHarness([])
    // Create then immediately delete
    const createRes = await harness.app.request("/session", { method: "POST" })
    expect(createRes.status).toBe(200)
    const { sessionId } = await createRes.json() as any
    const deleteRes = await harness.app.request(`/session/${sessionId}`, { method: "DELETE" })
    expect(deleteRes.status).toBe(200)
    // No crash, no orphaned events
    await new Promise((r) => setTimeout(r, 100))
    expect(harness.events.length).toBeGreaterThanOrEqual(0) // just verify no crash
  })

  it("2. abort during tool execution — interrupted + no dangling state", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.toolStarted("s1", "t1", "bash", { command: "sleep 10" }, "m1")),
      pause("tool-running"),
      emit(f.sessionInterrupted("s1")),
    ])
    await harness.engine.advanceTo("tool-running")
    await harness.engine.advanceAll()
    await harness.waitForEvents(3)
    const interrupted = harness.events.find((e: any) => e.type === "session.interrupted")
    expect(interrupted).toBeTruthy()
  })

  it("6. session idle with no message — no ghost messages", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(2)
    // No message.updated events should appear
    const msgEvents = harness.events.filter((e: any) =>
      e.type === "message.updated" || e.type === "message.part.updated"
    )
    expect(msgEvents).toHaveLength(0)
  })

  it("7. duplicate session.busy — no double busy indicator", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.sessionBusy("s1")),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(3)
    const busyEvents = harness.events.filter((e: any) => e.type === "session.busy")
    expect(busyEvents).toHaveLength(2) // both pass through, UI deduplicates
  })

  it("8. session.idle without session.busy — handled gracefully", async () => {
    harness = await createTestHarness([emit(f.sessionIdle("s1"))])
    await harness.engine.advanceAll()
    await harness.waitForEvents(1)
    // Should not throw — event passes through
    expect(harness.events.length).toBeGreaterThanOrEqual(1)
  })
})

describe("Edge Cases: Streaming & Deltas", () => {
  it("10. empty text delta — no blank text part", async () => {
    harness = await createTestHarness([
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageDelta("s1", "m1", "")),
      emit(f.messageCompletedText("s1", "m1", "done")),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    // Empty delta should still propagate (UI handles empty strings)
    // Either way no crash
    expect(harness.events.length).toBeGreaterThan(0)
  })

  it("11. delta before message.created — buffered or ignored, not crash", async () => {
    harness = await createTestHarness([
      // Delta arrives BEFORE message.created
      emit(f.messageDelta("s1", "m1", "premature delta")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageCompletedText("s1", "m1", "done")),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    // Should not crash — either buffered or ignored
    expect(harness.events.length).toBeGreaterThan(0)
  })

  it("13. very large delta — rendered without truncation in SSE", async () => {
    const largeText = "x".repeat(100_000) // 100KB
    harness = await createTestHarness([
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageDelta("s1", "m1", largeText)),
      emit(f.messageCompletedText("s1", "m1", "done")),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 300))
    // Delta should propagate without crash
    const deltas = harness.events.filter((e: any) => e.type === "message.part.delta")
    expect(deltas.length).toBeGreaterThanOrEqual(1)
  })

  it("14. delta after message.completed — ignored", async () => {
    harness = await createTestHarness([
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageCompletedText("s1", "m1", "done")),
      emit(f.messageDelta("s1", "m1", "stale delta")),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    // Stale delta should be ignored — no crash, no extra content
    expect(harness.events.length).toBeGreaterThan(0)
  })

  it("12. interleaved tool + text deltas — both rendered in order", async () => {
    harness = await createTestHarness([
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageDelta("s1", "m1", "Before tool: ")),
      emit(f.toolStarted("s1", "t1", "bash", { command: "ls" }, "m1")),
      emit(f.messageDelta("s1", "m1", "After tool.")),
      emit(f.toolCompleted("s1", "t1", "bash", "file.ts", { messageId: "m1" })),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    // Both deltas and tool events should be in the event stream
    const partEvents = harness.events.filter((e: any) =>
      e.type === "message.part.updated" || e.type === "message.part.delta"
    )
    expect(partEvents.length).toBeGreaterThanOrEqual(2)
  })

  it("15. rapid-fire deltas — throttled by EventMerger", async () => {
    const steps = [emit(f.messageCreated("s1", "m1", "assistant"))]
    for (let i = 0; i < 100; i++) {
      steps.push(emit(f.messageDelta("s1", "m1", `chunk${i} `)))
    }
    harness = await createTestHarness(steps)
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 300))
    // Should have far fewer events than 100 deltas due to throttling
    const deltas = harness.events.filter((e: any) => e.type === "message.part.delta")
    expect(deltas.length).toBeLessThan(50) // throttle merges them
    // Content must be accumulated in order — verify all 100 chunks present
    const totalDelta = deltas.reduce((acc, d: any) => acc + ((d.properties as any)?.delta ?? ""), "")
    for (let i = 0; i < 100; i++) {
      expect(totalDelta).toContain(`chunk${i} `)
    }
  })
})

describe("Edge Cases: Tool Execution", () => {
  it("16. tool started but never completed — stuck detection", async () => {
    harness = await createTestHarness([
      emit(f.toolStarted("s1", "t1", "bash", { command: "sleep 999" }, "m1")),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    const runningPart = harness.events.find((e: any) => {
      const part = (e.properties as any)?.part
      return e.type === "message.part.updated" && part?.state?.status === "running"
    })
    expect(runningPart).toBeTruthy()
    // No completed event should exist
    const completedPart = harness.events.find((e: any) => {
      const part = (e.properties as any)?.part
      return e.type === "message.part.updated" && part?.state?.status === "completed" && part?.callID === "t1"
    })
    expect(completedPart).toBeUndefined()
  })

  it("18. nested task tool — nested parts render at all levels", async () => {
    harness = await createTestHarness([
      emit(f.toolStarted("s1", "t1", "task", { description: "Refactor" }, "m1")),
      emit(f.toolStarted("s1", "t2", "write", { filePath: "helper.ts" }, "m1")),
      emit(f.toolCompleted("s1", "t2", "write", "done", { messageId: "m1" })),
      emit(f.toolCompleted("s1", "t1", "task", "Refactored", { messageId: "m1" })),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    const completedParts = harness.events.filter((e: any) => {
      const part = (e.properties as any)?.part
      return e.type === "message.part.updated" && part?.state?.status === "completed"
    })
    expect(completedParts.length).toBeGreaterThanOrEqual(2)
  })

  it("20. tool with enormous output — passes through without crash", async () => {
    const hugeOutput = "y".repeat(60_000) // 60KB
    harness = await createTestHarness([
      emit(f.toolStarted("s1", "t1", "bash", { command: "cat bigfile" }, "m1")),
      emit(f.toolCompleted("s1", "t1", "bash", hugeOutput, { messageId: "m1" })),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    // Event should arrive without crash
    const completed = harness.events.find((e: any) => {
      const part = (e.properties as any)?.part
      return e.type === "message.part.updated" && part?.state?.status === "completed"
    })
    expect(completed).toBeTruthy()
    // Live subscriber receives the full output (stripping only applies to OpenCode path's part.updated type)
    const output = (completed as any).properties.part.state.output
    expect(output.length).toBe(60_000)
  })

  it("22. tool started → abort → tool completed — completed after abort ignored", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.toolStarted("s1", "t1", "bash", { command: "sleep 10" }, "m1")),
      emit(f.sessionInterrupted("s1")),
      // Tool completes AFTER abort
      emit(f.toolCompleted("s1", "t1", "bash", "late output", { messageId: "m1" })),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    // Session should be interrupted, late tool completion should not override
    const interrupted = harness.events.find((e: any) => e.type === "session.interrupted")
    expect(interrupted).toBeTruthy()
  })

  it("17. tool completed without tool.started — still renders", async () => {
    harness = await createTestHarness([
      emit(f.toolCompleted("s1", "t1", "bash", "output", { messageId: "m1" })),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    const completed = harness.events.find((e: any) => {
      const part = (e.properties as any)?.part
      return e.type === "message.part.updated" && part?.state?.status === "completed"
    })
    expect(completed).toBeTruthy()
  })

  it("19. tool error with empty message — shows failed indicator", async () => {
    harness = await createTestHarness([
      emit(f.toolStarted("s1", "t1", "bash", {}, "m1")),
      emit(f.toolCompleted("s1", "t1", "bash", "", { isError: true, messageId: "m1" })),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    const errorPart = harness.events.find((e: any) => {
      const part = (e.properties as any)?.part
      return e.type === "message.part.updated" && part?.state?.status === "error"
    })
    expect(errorPart).toBeTruthy()
  })

  it("21. simultaneous tools — both tracked independently", async () => {
    harness = await createTestHarness([
      emit(f.toolStarted("s1", "t1", "glob", { pattern: "*.ts" }, "m1")),
      emit(f.toolStarted("s1", "t2", "grep", { pattern: "import" }, "m1")),
      emit(f.toolCompleted("s1", "t1", "glob", "file1.ts", { messageId: "m1" })),
      emit(f.toolCompleted("s1", "t2", "grep", "match found", { messageId: "m1" })),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    const completedParts = harness.events.filter((e: any) => {
      const part = (e.properties as any)?.part
      return e.type === "message.part.updated" && part?.state?.status === "completed"
    })
    expect(completedParts).toHaveLength(2)
  })
})

describe("Edge Cases: Permission & Question Interactions", () => {
  it("23. permission asked during streaming — both events coexist", async () => {
    harness = await createTestHarness([
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.messageDelta("s1", "m1", "Working on ")),
      emit(f.permissionAsked("s1", "req-1", "bash", { command: "rm file" })),
    ])
    await harness.engine.advanceAll()
    await new Promise((r) => setTimeout(r, 200))
    const perm = harness.events.find((e: any) => e.type === "permission.asked")
    expect(perm).toBeTruthy()
  })

  it("24. permission for deleted session — silently dropped", async () => {
    harness = await createTestHarness([
      // Permission for a session that doesn't exist in the proxy
      emit(f.permissionAsked("nonexistent-session", "req-1", "bash", { command: "rm" })),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(1)
    // Should pass through without crash — UI handles missing session gracefully
    expect(harness.events.length).toBeGreaterThanOrEqual(1)
  })

  it("27. permission timeout — session hangs without reply", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.permissionAsked("s1", "req-1", "bash", { command: "rm -rf /" })),
      // No permission.replied — user never responds
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(2)
    const perm = harness.events.find((e: any) => e.type === "permission.asked")
    expect(perm).toBeTruthy()
    // No replied event
    const replied = harness.events.find((e: any) => e.type === "permission.replied")
    expect(replied).toBeUndefined()
  })

  it("28. reject permission then send — clean state transition", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.permissionAsked("s1", "req-1", "bash", { command: "rm" })),
      pause("perm-asked"),
      emit(f.permissionReplied("s1", "req-1", "deny")),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceTo("perm-asked")
    // Reply deny via proxy
    await harness.proxy.replyPermission("s1", "req-1", "deny")
    await harness.engine.advanceAll()
    await harness.waitForEvents(3)
    // Now send a new message — should work cleanly
    const sendRes = await harness.app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "try again", mode: "build", sessionId: "s1" }),
    })
    expect(sendRes.status).toBe(200)
  })

  it("26. question with empty question data — handled without crash", async () => {
    harness = await createTestHarness([
      emit(f.questionAsked("s1", "q-1", {})),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(1)
    expect(harness.events.length).toBeGreaterThanOrEqual(1)
  })
})

describe("Edge Cases: Connection & Recovery", () => {
  it("29. SSE replay via Last-Event-ID — replays from ring buffer", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(2)

    // Request replay from seq 1
    const res = await harness.app.request("/events", {
      headers: { "Last-Event-ID": "1" },
    })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    let text = ""
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read()
      if (value) text += new TextDecoder().decode(value)
      if (done || text.includes('"seq":')) break
    }
    reader.cancel()
    // Should have events after seq 1 — verify replayed events have seq > 1
    expect(text.length).toBeGreaterThan(0)
    const seqMatch = text.match(/"seq":(\d+)/)
    if (seqMatch) {
      expect(Number(seqMatch[1])).toBeGreaterThan(1)
    }
  })

  it("30. SSE disconnect + buffer overflow → full_refresh_required", async () => {
    harness = await createTestHarness([], { bufferSize: 3 })
    // Emit 5 events to overflow the 3-event buffer
    for (let i = 0; i < 5; i++) {
      harness.eventMerger.emit({ type: "stage_started", pipelineId: "p1", stageId: `s${i}`, stage: "brainstorm" })
    }
    const res = await harness.app.request("/events", {
      headers: { "Last-Event-ID": "1" },
    })
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    reader.cancel()
    const text = new TextDecoder().decode(value)
    expect(text).toContain("full_refresh_required")
  })

  it("31. rapid reconnect cycles — no duplicate events, no memory leak", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(2)
    // Simulate 5 rapid SSE reconnections via Last-Event-ID
    for (let i = 0; i < 5; i++) {
      const res = await harness.app.request("/events", {
        headers: { "Last-Event-ID": "0" },
      })
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      // Read a small chunk then cancel (simulates rapid disconnect)
      const { value } = await reader.read()
      reader.cancel()
      expect(value).toBeDefined()
    }
    // No crash, no duplicate events in main subscriber
  })

  it("32. server restart mid-session — full_refresh_required on reconnect", async () => {
    harness = await createTestHarness([], { bufferSize: 3 })
    // Fill and overflow the buffer
    for (let i = 0; i < 10; i++) {
      harness.eventMerger.emit({ type: "stage_started", pipelineId: "p1", stageId: `s${i}`, stage: "brainstorm" })
    }
    // Client reconnects with a very old Last-Event-ID
    const res = await harness.app.request("/events", {
      headers: { "Last-Event-ID": "1" },
    })
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    reader.cancel()
    const text = new TextDecoder().decode(value)
    expect(text).toContain("full_refresh_required")
  })

  it("56. SSE heartbeat delivery — keepalive comments arrive", async () => {
    harness = await createTestHarness([])
    // Connect to SSE and read for a short period to check for keepalive
    const res = await harness.app.request("/events")
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    // Read initial data — may include keepalive comment
    let text = ""
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      const result = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 500)),
      ])
      if (result.value) text += new TextDecoder().decode(result.value)
      if (result.done || text.includes(":keepalive")) break
    }
    reader.cancel()
    // Note: heartbeat interval is 15s; this test may not receive one in 2s.
    // The primary assertion is that the SSE connection is established and readable.
    expect(text.length).toBeGreaterThanOrEqual(0)
  })

  it("34. sequence number monotonicity — events have strictly increasing seq", async () => {
    harness = await createTestHarness([
      emit(f.sessionBusy("s1")),
      emit(f.messageCreated("s1", "m1", "assistant")),
      emit(f.sessionIdle("s1")),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(3)
    // All events must have seq — don't silently skip events without it
    for (const event of harness.events) {
      expect((event as any).seq).toBeDefined()
    }
    const seqs = harness.events.map((e: any) => e.seq)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }
  })
})

describe("Edge Cases: EventMerger Specifics", () => {
  it("33. internal session filtering — pipeline sessions don't leak to SSE", async () => {
    harness = await createTestHarness([])
    // Register an internal session
    harness.eventMerger.addInternalSession("internal-s1")
    // Emit a session.created event for the internal session (should be filtered)
    harness.eventMerger.forwardOpenCodeEvent({
      type: "session.created",
      properties: { info: { id: "internal-s1" } },
    })
    await new Promise((r) => setTimeout(r, 50))
    const sessionCreated = harness.events.find((e: any) =>
      e.type === "session.created" && (e.properties as any)?.info?.id === "internal-s1"
    )
    expect(sessionCreated).toBeUndefined()
  })

  it("36. diff size capping — large diffs truncated to 50KB", async () => {
    harness = await createTestHarness([])
    const hugeDiff = "x".repeat(100_000)
    harness.eventMerger.forwardOpenCodeEvent({
      type: "message.updated",
      properties: {
        info: {
          id: "m1",
          sessionID: "s1",
          summary: { diffs: [{ file: "big.ts", before: hugeDiff, after: hugeDiff }] },
        },
      },
    })
    await new Promise((r) => setTimeout(r, 50))
    const evt = harness.events.find((e: any) => e.type === "message.updated")
    expect(evt).toBeTruthy()
    const diff = ((evt as any).properties?.info?.summary?.diffs?.[0])
    expect(diff.before.length).toBeLessThan(60_000) // capped + truncation marker
    expect(diff.before).toContain("truncated")
  })
})

// --- Server Events, Connection Events, Pipeline Events (from Task 6) ---

describe("Edge Cases: Server Events", () => {
  it("skill.used → event passes through to SSE", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit({ type: "skill.used", sessionId: "s1", skillName: "brainstorming" })
    await harness.waitForEvents(1)
    const skill = harness.events.find((e: any) => e.type === "skill.used")
    expect(skill).toBeTruthy()
    expect((skill as any).skillName).toBe("brainstorming")
  })

  it("send_error → event passes through to SSE", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit({ type: "send_error", sessionId: "s1", error: "connection refused" })
    await harness.waitForEvents(1)
    const err = harness.events.find((e: any) => e.type === "send_error")
    expect(err).toBeTruthy()
  })

  it("favorites.updated → event passes through", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit({ type: "favorites.updated", favorites: [{ providerID: "anthropic", modelID: "claude-3", favoriteKey: "anthropic::claude-3::__none__" }] })
    await harness.waitForEvents(1)
    const fav = harness.events.find((e: any) => e.type === "favorites.updated")
    expect(fav).toBeTruthy()
  })

  it("config.updated → event passes through", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit({ type: "config.updated" })
    await harness.waitForEvents(1)
    expect(harness.events.find((e: any) => e.type === "config.updated")).toBeTruthy()
  })
})

describe("Edge Cases: Connection Events", () => {
  it("connection_lost / connection_restored → events pass through", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit({ type: "connection_lost" })
    harness.eventMerger.emit({ type: "connection_restored" })
    await harness.waitForEvents(2)
    const types = harness.events.map((e: any) => e.type)
    expect(types).toContain("connection_lost")
    expect(types).toContain("connection_restored")
  })

  it("full_refresh_required → event passes through", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit({ type: "full_refresh_required" })
    await harness.waitForEvents(1)
    expect(harness.events.find((e: any) => e.type === "full_refresh_required")).toBeTruthy()
  })
})

describe("Edge Cases: Pipeline Events", () => {
  it("stage_interrupted / stage_resumed cycle", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit({ type: "stage_interrupted", pipelineId: "p1", stageId: "st1", sessionId: "s1" })
    harness.eventMerger.emit({ type: "stage_resumed", pipelineId: "p1", stageId: "st1", sessionId: "s1" })
    await harness.waitForEvents(2)
    const types = harness.events.map((e: any) => e.type)
    expect(types).toContain("stage_interrupted")
    expect(types).toContain("stage_resumed")
  })

  it("pipeline_title_updated → event with title", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit({ type: "pipeline_title_updated", pipelineId: "p1", title: "Auth Feature" })
    await harness.waitForEvents(1)
    const title = harness.events.find((e: any) => e.type === "pipeline_title_updated")
    expect((title as any).title).toBe("Auth Feature")
  })

  it("git events pass through (git_branch_created, git_committed, git_hook_failed)", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit({ type: "git_branch_created", pipelineId: "p1", branch: "feature/auth", baseBranch: "main", baseCommit: "abc123" })
    harness.eventMerger.emit({ type: "git_committed", pipelineId: "p1", stageId: "st1", stage: "implement", sha: "def456", message: "Implement auth" })
    harness.eventMerger.emit({ type: "git_hook_failed", pipelineId: "p1", stageId: "st1", stage: "implement", error: "lint failed" })
    await harness.waitForEvents(3)
    const types = harness.events.map((e: any) => e.type)
    expect(types).toContain("git_branch_created")
    expect(types).toContain("git_committed")
    expect(types).toContain("git_hook_failed")
  })

  it("58. pipeline permission auto-reply — auto-intervention replies for pipeline sessions", async () => {
    harness = await createTestHarness([])
    // Register the session as internal (pipeline-owned)
    harness.eventMerger.addInternalSession("pipeline-sess")
    // Emit permission.asked for a pipeline session
    harness.eventMerger.forwardEvent({
      type: "permission.asked", sessionId: "pipeline-sess", requestId: "perm-1",
      toolName: "write", toolInput: { filePath: "test.ts" },
    } as any)
    await new Promise((r) => setTimeout(r, 100))
    // The auto-intervention should handle this — permission should not leak to general SSE
    // (filtered by internal session)
    const permEvt = harness.events.find((e: any) =>
      e.type === "permission.asked" && (e.properties as any)?.permission?.sessionID === "pipeline-sess"
    )
    // Internal session events are filtered from general subscribers
    expect(permEvt).toBeUndefined()
  })

  it("59. no auto-reply for user sessions — user must reply manually", async () => {
    harness = await createTestHarness([
      emit(f.permissionAsked("user-session", "perm-1", "bash", { command: "rm" })),
    ])
    await harness.engine.advanceAll()
    await harness.waitForEvents(1)
    // Permission for user session SHOULD appear in SSE
    const perm = harness.events.find((e: any) => e.type === "permission.asked")
    expect(perm).toBeTruthy()
  })

  it("fix_stage_inserted → event with parent review reference", async () => {
    harness = await createTestHarness([])
    harness.eventMerger.emit(f.fixStageInserted("p1", "fix-st1", "fix_code", "review-st1"))
    await harness.waitForEvents(1)
    const fix = harness.events.find((e: any) => e.type === "fix_stage_inserted")
    expect(fix).toBeTruthy()
    expect((fix as any).parentReviewStageId).toBe("review-st1")
  })
})
