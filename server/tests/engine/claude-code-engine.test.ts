import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ClaudeCodeEngine } from "../../src/engine/claude-code-engine.js"
import { SessionMetadataStore } from "../../src/engine/session-metadata-store.js"
import * as processPlatform from "@atelier/core/process-platform"
import type { AtelierEvent } from "@atelier/core"
import type { DetectorNormalizedEvent } from "../../src/orchestration/idle-detector-events.js"
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Mock SDK query that yields canned messages
function createMockQuery(messages: unknown[]) {
  let interrupted = false
  const generator = (async function* () {
    for (const msg of messages) {
      if (interrupted) return
      yield msg
    }
  })()
  return Object.assign(generator, {
    interrupt: vi.fn().mockImplementation(async () => { interrupted = true }),
    close: vi.fn(),
  })
}

function createMockSpawnedChild() {
  const proc = new EventEmitter() as any
  ;(proc as any).stdout = new EventEmitter()
  ;(proc as any).stderr = new EventEmitter()
  ;(proc as any).kill = vi.fn()
  ;(proc as any).pid = 4321
  return proc
}

describe("ClaudeCodeEngine", () => {
  let engine: ClaudeCodeEngine
  let events: AtelierEvent[]
  let mockQueryFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    events = []
    mockQueryFn = vi.fn()
    engine = new ClaudeCodeEngine({ queryFactory: mockQueryFn })
    engine.setRawEventCallback((event) => events.push(event as AtelierEvent))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("creates a session with pending status", async () => {
    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    expect(session.id).toBeTruthy()
    expect(typeof session.id).toBe("string")
  })

  it("sendMessage spawns query on first call (pending -> active)", async () => {
    const resultMsg = {
      type: "result",
      subtype: "success",
      result: "Done!",
      usage: { input_tokens: 100, output_tokens: 50 },
      cost_usd: 0.005,
      duration_ms: 3000,
    }
    mockQueryFn.mockReturnValue(createMockQuery([
      { type: "system", subtype: "init" },
      resultMsg,
    ]))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    await engine.sendMessage(session.id, { content: "Hello" })
    await engine.waitForIdle(session.id)

    // Verify events were emitted
    const busyEvent = events.find((e) => e.type === "session.busy")
    expect(busyEvent).toBeTruthy()

    const idleEvent = events.find((e) => e.type === "session.idle")
    expect(idleEvent).toBeTruthy()
    if (idleEvent?.type === "session.idle") {
      expect(idleEvent.usage.inputTokens).toBe(100)
      expect(idleEvent.usage.outputTokens).toBe(50)
      expect(idleEvent.costUsd).toBe(0.005)
    }
  })

  it("getSessionOutput returns last result", async () => {
    mockQueryFn.mockReturnValue(createMockQuery([
      { type: "system", subtype: "init" },
      {
        type: "result",
        subtype: "success",
        result: "The answer is 42",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engine.sendMessage(session.id, { content: "What is 6*7?" })
    await engine.waitForIdle(session.id)

    const output = await engine.getSessionOutput(session.id)
    expect(output.text).toBe("The answer is 42")
    expect(output.tokens.input).toBe(10)
    expect(output.tokens.output).toBe(5)
  })

  it("fetchSupportedModels uses process.execPath and parses helper JSON", async () => {
    const child = createMockSpawnedChild()
    const spawnSpy = vi.fn().mockReturnValue(child)
    const helperEngine = new ClaudeCodeEngine({ queryFactory: mockQueryFn, spawnFactory: spawnSpy as any })

    const promise = helperEngine.fetchSupportedModels()
    ;(child.stdout as EventEmitter).emit("data", Buffer.from(JSON.stringify({
      models: [{ value: "claude-sonnet", displayName: "Claude Sonnet", description: "test" }],
    })))
    ;(child as unknown as EventEmitter).emit("exit", 0)

    await expect(promise).resolves.toEqual([
      { value: "claude-sonnet", displayName: "Claude Sonnet", description: "test" },
    ])
    expect(spawnSpy).toHaveBeenCalledWith(
      process.execPath,
      ["run", expect.stringContaining("fetch-claude-models.ts")],
      expect.objectContaining({ windowsHide: true, env: process.env }),
    )
  })

  it("fetchSupportedModels rejects helper-reported errors", async () => {
    const child = createMockSpawnedChild()
    const helperEngine = new ClaudeCodeEngine({ queryFactory: mockQueryFn, spawnFactory: vi.fn().mockReturnValue(child) as any })

    const promise = helperEngine.fetchSupportedModels()
    const assertion = expect(promise).rejects.toThrow("helper failed")
    ;(child.stdout as EventEmitter).emit("data", Buffer.from(JSON.stringify({ error: "helper failed" })))
    ;(child.stderr as EventEmitter).emit("data", Buffer.from("details"))
    ;(child as unknown as EventEmitter).emit("exit", 1)

    await assertion
  })

  it("fetchSupportedModels times out and kills the helper", async () => {
    vi.useFakeTimers()
    const child = createMockSpawnedChild()
    const helperEngine = new ClaudeCodeEngine({ queryFactory: mockQueryFn, spawnFactory: vi.fn().mockReturnValue(child) as any })

    const promise = helperEngine.fetchSupportedModels()
    const assertion = expect(promise).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(15_000)

    await assertion
    expect((child as any).kill).toHaveBeenCalledWith("SIGKILL")
  })

  it("does not emit synthetic user message.completed for normal sessions", async () => {
    mockQueryFn.mockReturnValue(createMockQuery([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", result: "ok", usage: { input_tokens: 1, output_tokens: 1 } },
    ]))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    await engine.sendMessage(session.id, { content: "Hello" })
    await engine.waitForIdle(session.id)

    const userCompleted = events.filter((e) => e.type === "message.completed" && (e as any).role === "user")
    expect(userCompleted).toHaveLength(0)
  })

  it("emits synthetic user message.completed for pipeline-owned sessions", async () => {
    mockQueryFn.mockReturnValue(createMockQuery([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", result: "ok", usage: { input_tokens: 1, output_tokens: 1 } },
    ]))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
      parentID: "pipeline-123",
    })

    await engine.sendMessage(session.id, {
      content: "You are in pipeline mode\n\n---\n\nImplement the stage",
    })
    await engine.waitForIdle(session.id)

    const userCompleted = events.filter((e) => e.type === "message.completed" && (e as any).role === "user")
    expect(userCompleted).toHaveLength(1)
    const msg = userCompleted[0] as Extract<AtelierEvent, { type: "message.completed" }>
    expect(msg.contentBlocks[0]).toEqual({
      type: "text",
      text: "You are in pipeline mode\n\n---\n\nImplement the stage",
    })
  })

  it("interruptSession interrupts the query handle and session remains usable", async () => {
    // Create a generator that:
    // 1. Yields system.init + blocks (simulating busy agent)
    // 2. After interrupt, yields a result (simulating SDK interrupt behavior)
    // 3. Then waits for next channel message and yields another result
    let resolveBlock: () => void
    const blockPromise = new Promise<void>((r) => { resolveBlock = r })
    let yieldFollowUp: ((msg: unknown) => void) | undefined
    const generator = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-int-1" }
      await blockPromise // Block until interrupt unblocks us
      yield { type: "result", subtype: "success", result: "interrupted", usage: { input_tokens: 1, output_tokens: 1 } }
      // Wait for next message from channel (follow-up after interrupt)
      const msg: unknown = await new Promise((r) => { yieldFollowUp = r })
      yield msg
      yield { type: "result", subtype: "success", result: "resumed", usage: { input_tokens: 1, output_tokens: 1 } }
    })()
    const mockQuery = Object.assign(generator, {
      interrupt: vi.fn().mockImplementation(async () => { resolveBlock!() }),
      close: vi.fn(),
    })
    mockQueryFn.mockReturnValue(mockQuery)

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engine.sendMessage(session.id, { content: "do something" })

    // Give event loop a tick to start iterating
    await new Promise((r) => setTimeout(r, 10))

    await engine.interruptSession(session.id)
    expect(mockQuery.interrupt).toHaveBeenCalled()

    // Wait for interrupt result to be processed
    await new Promise((r) => setTimeout(r, 20))

    // Session should still be usable — send another message through the same channel.
    // The event loop is still alive, process still running (no respawn).
    await engine.sendMessage(session.id, { content: "continue" })
    // Feed the follow-up through to the generator
    yieldFollowUp?.({ type: "assistant", message: { id: "msg2", role: "assistant", content: [{ type: "text", text: "ok" }] } })
    await engine.waitForIdle(session.id)

    // Only one query was created — no respawn
    expect(mockQueryFn).toHaveBeenCalledTimes(1)
  })

  it("query error emits session.error then session.idle", async () => {
    const errorQuery = (async function* () {
      yield { type: "system", subtype: "init" }
      throw new Error("subprocess crashed")
    })()
    mockQueryFn.mockReturnValue(Object.assign(errorQuery, {
      interrupt: vi.fn(),
      close: vi.fn(),
    }))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engine.sendMessage(session.id, { content: "hello" })

    // Wait for the event loop to process the error
    await new Promise((r) => setTimeout(r, 50))

    const errorEvent = events.find((e) => e.type === "session.error")
    expect(errorEvent).toBeTruthy()
    if (errorEvent?.type === "session.error") {
      expect(errorEvent.error).toContain("subprocess crashed")
    }

    const idleEvents = events.filter((e) => e.type === "session.idle")
    expect(idleEvents).toHaveLength(1) // Must be exactly one, not two (bug #5.1)
  })

  it("error after result still emits session.idle (spec invariant)", async () => {
    const errorAfterResultQuery = (async function* () {
      yield { type: "system", subtype: "init" }
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        usage: { input_tokens: 10, output_tokens: 5 },
      }
      throw new Error("late error after result")
    })()
    mockQueryFn.mockReturnValue(Object.assign(errorAfterResultQuery, {
      interrupt: vi.fn(),
      close: vi.fn(),
    }))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engine.sendMessage(session.id, { content: "hello" })

    await new Promise((r) => setTimeout(r, 50))

    const errorEvent = events.find((e) => e.type === "session.error")
    expect(errorEvent).toBeTruthy()

    // Must have at least 2 idle events: one from result, one from error (spec invariant)
    const idleEvents = events.filter((e) => e.type === "session.idle")
    expect(idleEvents.length).toBeGreaterThanOrEqual(2)
  })

  it("translates stream_event text_delta to message.delta", async () => {
    mockQueryFn.mockReturnValue(createMockQuery([
      { type: "system", subtype: "init" },
      {
        type: "assistant",
        message: {
          id: "msg1",
          role: "assistant",
          content: [{ type: "text", text: "Hello world" }],
        },
        session_id: "s1",
      },
      {
        type: "result",
        subtype: "success",
        result: "Hello world",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engine.sendMessage(session.id, { content: "hi" })
    await engine.waitForIdle(session.id)

    const msgCompleted = events.find((e) => e.type === "message.completed" && (e as any).role === "assistant")
    expect(msgCompleted).toBeTruthy()
    if (msgCompleted?.type === "message.completed") {
      expect(msgCompleted.role).toBe("assistant")
      expect(msgCompleted.contentBlocks).toBeDefined()
    }
  })

  it("permission callback works for interactive sessions", async () => {
    let canUseToolFn: ((toolName: string, input: unknown, options: unknown) => Promise<unknown>) | undefined

    mockQueryFn.mockImplementation((opts: { options?: { canUseTool?: typeof canUseToolFn } }) => {
      canUseToolFn = opts.options?.canUseTool
      return createMockQuery([
        { type: "system", subtype: "init" },
        {
          type: "result",
          subtype: "success",
          result: "done",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ])
    })

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    })

    let permissionEvents: AtelierEvent[] = []
    engine.setPermissionCallback((sessionId, requestId) => {
      permissionEvents.push({ type: "permission.asked", sessionId, requestId, toolName: "Bash", toolInput: {} } as AtelierEvent)
    })

    await engine.sendMessage(session.id, { content: "run ls" })

    // Simulate SDK calling canUseTool
    if (canUseToolFn) {
      const resultPromise = canUseToolFn("Bash", { command: "ls" }, {
        toolUseID: "tool1",
        signal: new AbortController().signal,
        suggestions: ["allow"],
        decisionReason: "file listing",
      })

      // Resolve the permission — engine should inject original input into updatedInput
      engine.resolvePermission(session.id, "tool1", { behavior: "allow", updatedInput: {} })
      const result = await resultPromise
      // Engine fills in the original tool input when updatedInput is empty
      expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } })
    }
  })

  it("autonomous mode returns valid SDK PermissionResult (behavior + updatedInput)", async () => {
    let canUseToolFn: ((toolName: string, input: unknown, options: unknown) => Promise<unknown>) | undefined

    mockQueryFn.mockImplementation((opts: { options?: { canUseTool?: typeof canUseToolFn } }) => {
      canUseToolFn = opts.options?.canUseTool
      return createMockQuery([
        { type: "system", subtype: "init" },
        { type: "result", subtype: "success", result: "done", usage: { input_tokens: 10, output_tokens: 5 } },
      ])
    })

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    await engine.sendMessage(session.id, { content: "run ls" })

    if (canUseToolFn) {
      const result = await canUseToolFn("Bash", { command: "ls" }, {
        toolUseID: "tool-auto-1",
        signal: new AbortController().signal,
      })
      // Autonomous mode passes original input through as updatedInput
      expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } })
    } else {
      throw new Error("canUseTool was not set")
    }
  })

  it("abort signal resolves pending permission with deny and cleans up maps", async () => {
    let canUseToolFn: ((toolName: string, input: unknown, options: unknown) => Promise<unknown>) | undefined

    mockQueryFn.mockImplementation((opts: { options?: { canUseTool?: typeof canUseToolFn } }) => {
      canUseToolFn = opts.options?.canUseTool
      return createMockQuery([
        { type: "system", subtype: "init" },
        { type: "result", subtype: "success", result: "done", usage: { input_tokens: 10, output_tokens: 5 } },
      ])
    })

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "ask" }],
    })

    await engine.sendMessage(session.id, { content: "run ls" })

    if (canUseToolFn) {
      const abortController = new AbortController()
      const resultPromise = canUseToolFn("Bash", { command: "ls" }, {
        toolUseID: "tool-abort-1",
        signal: abortController.signal,
      })

      // Abort while permission is pending
      abortController.abort()
      const result = await resultPromise
      expect(result).toEqual({ behavior: "deny", message: "Aborted" })

      // Verify maps are cleaned up
      const liveSession = (engine as any).sessions.get(session.id)
      expect(liveSession.pendingPermissions.has("tool-abort-1")).toBe(false)
    }
  })

  it("concurrent waitForIdle calls both resolve", async () => {
    mockQueryFn.mockReturnValue(createMockQuery([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", result: "done", usage: { input_tokens: 1, output_tokens: 1 } },
    ]))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engine.sendMessage(session.id, { content: "hi" })

    const p1 = engine.waitForIdle(session.id)
    const p2 = engine.waitForIdle(session.id)
    await Promise.all([p1, p2]) // Both should resolve, not just the second
  })

  it("waitForIdle rejects after timeout", async () => {
    // Create a query that never yields a result
    const neverEndQuery = (async function* () {
      yield { type: "system", subtype: "init" }
      await new Promise(() => {}) // hang forever
    })()
    mockQueryFn.mockReturnValue(Object.assign(neverEndQuery, {
      interrupt: vi.fn(),
      close: vi.fn(),
    }))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engine.sendMessage(session.id, { content: "hi" })

    await expect(engine.waitForIdle(session.id, 50)).rejects.toThrow("timed out")
  })

  it("sendMessage succeeds after interruptSession (session stays resumable)", async () => {
    // Generator that handles two turns via channel
    let yieldSecondTurn: ((msg: unknown) => void) | undefined
    const generator = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-resume-1" }
      yield { type: "result", subtype: "success", result: "done", usage: { input_tokens: 1, output_tokens: 1 } }
      // Wait for second turn
      const msg: unknown = await new Promise((r) => { yieldSecondTurn = r })
      yield msg
      yield { type: "result", subtype: "success", result: "resumed", usage: { input_tokens: 1, output_tokens: 1 } }
    })()
    mockQueryFn.mockReturnValue(Object.assign(generator, {
      interrupt: vi.fn().mockImplementation(async () => {}),
      close: vi.fn(),
    }))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engine.sendMessage(session.id, { content: "hi" })
    await engine.waitForIdle(session.id)

    // Interrupt while idle — no-op since not mid-turn, process stays alive
    await engine.interruptSession(session.id)

    // Send follow-up through the same live channel
    await engine.sendMessage(session.id, { content: "more" })
    yieldSecondTurn?.({ type: "assistant", message: { id: "a2", role: "assistant", content: [{ type: "text", text: "resumed" }] } })
    await engine.waitForIdle(session.id)

    const output = await engine.getSessionOutput(session.id)
    expect(output.text).toBe("resumed")
  })

  it("interruptSession with queued message — process stays alive, channel delivers it", async () => {
    // Generator: handles init, blocks (busy), then after interrupt yields result,
    // then picks up the queued message from the channel
    let resolveBlock: () => void
    const blockPromise = new Promise<void>((r) => { resolveBlock = r })
    const generator = (async function* ({ prompt }: { prompt: AsyncIterable<unknown> }) {
      const iter = prompt[Symbol.asyncIterator]()
      await iter.next() // consume first message
      yield { type: "system", subtype: "init", session_id: "sdk-q-1" }
      await blockPromise // busy
      yield { type: "result", subtype: "success", result: "interrupted", usage: { input_tokens: 1, output_tokens: 1 } }
      // Pick up queued message from channel
      await iter.next()
      yield { type: "result", subtype: "success", result: "from queued", usage: { input_tokens: 1, output_tokens: 1 } }
    })

    let genInstance: ReturnType<typeof generator>
    mockQueryFn.mockImplementation((opts: { prompt: AsyncIterable<unknown> }) => {
      genInstance = generator(opts)
      return Object.assign(genInstance, {
        interrupt: vi.fn().mockImplementation(async () => { resolveBlock!() }),
        close: vi.fn(),
      })
    })

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engine.sendMessage(session.id, { content: "first message" })
    await new Promise((r) => setTimeout(r, 10))

    // Queue a second message while agent is busy
    await engine.sendMessage(session.id, { content: "queued message" })

    // Interrupt — process stays alive, channel still has queued message
    await engine.interruptSession(session.id)

    // The same query picks up the queued message — no respawn
    await engine.waitForIdle(session.id)
    expect(mockQueryFn).toHaveBeenCalledTimes(1)
  })

  it("interruptSession mid-turn keeps process alive — no respawn needed", async () => {
    // SDK finished first turn, between turns, second message starts.
    // Interrupt mid-second-turn — process stays alive via interrupt(), no respawn.
    let resolveSecondTurn: () => void
    const secondTurnBlock = new Promise<void>((r) => { resolveSecondTurn = r })

    mockQueryFn.mockImplementationOnce(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const iter = prompt[Symbol.asyncIterator]()
      const generator = (async function* () {
        await iter.next()
        yield { type: "system", subtype: "init", session_id: "sdk-1" }
        yield { type: "result", subtype: "success", result: "turn1", usage: { input_tokens: 1, output_tokens: 1 } }
        // Between turns — waiting for next channel message
        await iter.next()
        // Second turn starts
        yield { type: "assistant", message: { id: "a2", role: "assistant", content: [] } }
        await secondTurnBlock
        // After interrupt, yield result
        yield { type: "result", subtype: "success", result: "interrupted", usage: { input_tokens: 1, output_tokens: 1 } }
      })()
      return Object.assign(generator, {
        interrupt: vi.fn().mockImplementation(async () => { resolveSecondTurn() }),
        close: vi.fn(),
      })
    })

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engine.sendMessage(session.id, { content: "first" })
    await engine.waitForIdle(session.id)

    // Second message
    await engine.sendMessage(session.id, { content: "second" })
    await new Promise((r) => setTimeout(r, 10))

    // Register waiter before interrupt so we don't miss the idle event
    // (interrupt + Promise.race may yield result before the next await)
    const idlePromise = engine.waitForIdle(session.id)

    // Interrupt mid-processing — process stays alive
    await engine.interruptSession(session.id)

    // Wait for the result from interrupt
    await idlePromise

    // Only one query — no respawn
    expect(mockQueryFn).toHaveBeenCalledTimes(1)
  })

  it("interruptSession force-closes handle when interrupt() hangs", async () => {
    // Generator that blocks forever — simulates a hung SDK process.
    // close() causes the blocking promise to reject, ending the generator
    // (mirroring real SDK behavior where close() kills the subprocess).
    let rejectBlock: (err: Error) => void
    const generator = (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-hang-1" }
      await new Promise<void>((_, reject) => { rejectBlock = reject })
    })()
    const closeFn = vi.fn().mockImplementation(() => {
      rejectBlock(new Error("closed"))
    })
    mockQueryFn.mockReturnValue(Object.assign(generator, {
      // interrupt() never resolves — simulates a hung SDK
      interrupt: vi.fn().mockReturnValue(new Promise(() => {})),
      close: closeFn,
    }))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engine.sendMessage(session.id, { content: "do something" })
    await new Promise((r) => setTimeout(r, 10))

    // interruptSession should not hang forever — it should timeout and force-close
    await engine.interruptSession(session.id)

    // close() should have been called as a force-close fallback
    expect(closeFn).toHaveBeenCalled()

    // Session should emit idle after close (via event loop finally block)
    await new Promise((r) => setTimeout(r, 50))
    const idleEvents = events.filter((e) => e.type === "session.idle")
    expect(idleEvents.length).toBeGreaterThanOrEqual(1)

    // _interrupting flag should be reset so subsequent stops work
    // (Verify by calling interrupt again — should not throw or hang)
    await engine.interruptSession(session.id)
  }, 10000)

  it("follow-up message emits session.busy for generating animation", async () => {
    // First call: SDK yields result, event loop stays alive waiting for more channel messages
    let yieldControl: ((msg: unknown) => void) | undefined
    let resolveEnd: (() => void) | undefined
    const endPromise = new Promise<void>((r) => { resolveEnd = r })
    const generator = (async function* () {
      yield { type: "system", subtype: "init" }
      yield { type: "result", subtype: "success", result: "first", usage: { input_tokens: 10, output_tokens: 5 } }
      // Wait for follow-up — simulate SDK blocking until new user message triggers more output
      const msg: unknown = await new Promise((r) => { yieldControl = r })
      yield msg
      yield { type: "result", subtype: "success", result: "second", usage: { input_tokens: 20, output_tokens: 10 } }
      resolveEnd!()
    })()
    mockQueryFn.mockReturnValue(Object.assign(generator, {
      interrupt: vi.fn().mockImplementation(async () => {}),
      close: vi.fn(),
    }))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    await engine.sendMessage(session.id, { content: "first message" })
    await engine.waitForIdle(session.id)

    // Clear events from first turn
    events.length = 0

    // Send follow-up message — should emit session.busy
    await engine.sendMessage(session.id, { content: "follow-up" })

    const busyEvent = events.find((e) => e.type === "session.busy")
    expect(busyEvent).toBeTruthy()
    expect(busyEvent!.sessionId).toBe(session.id)

    // Let the generator finish
    yieldControl?.({ type: "assistant", message: { id: "msg2", role: "assistant", content: [{ type: "text", text: "reply" }] } })
    await endPromise
  })

  it("drains a message queued mid-turn after the turn result", async () => {
    let finishFirstTurn: () => void
    const firstTurnFinished = new Promise<void>((resolve) => { finishFirstTurn = resolve })
    let secondMessageConsumed = false

    mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const iter = prompt[Symbol.asyncIterator]()
      const generator = (async function* () {
        await iter.next()
        yield { type: "system", subtype: "init", session_id: "sdk-queued-1" }
        await firstTurnFinished
        yield { type: "result", subtype: "success", result: "first", usage: { input_tokens: 1, output_tokens: 1 } }

        const next = await iter.next()
        secondMessageConsumed = (next.value as any)?.message?.content === "second"
        yield { type: "result", subtype: "success", result: "second", usage: { input_tokens: 1, output_tokens: 1 } }
      })()
      return Object.assign(generator, {
        interrupt: vi.fn().mockImplementation(async () => {}),
        close: vi.fn(),
      })
    })

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    await engine.sendMessage(session.id, { content: "first" })
    await new Promise((r) => setTimeout(r, 10))

    await engine.sendMessage(session.id, { content: "second" })
    expect(secondMessageConsumed).toBe(false)

    finishFirstTurn!()
    const deadline = Date.now() + 1000
    while (!secondMessageConsumed && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
    }

    expect(secondMessageConsumed).toBe(true)
    expect(mockQueryFn).toHaveBeenCalledTimes(1)
    expect(events.filter((e) => e.type === "session.idle")).toHaveLength(1)
    expect(await engine.getSessionOutput(session.id)).toEqual({ text: "second", tokens: { input: 1, output: 1 } })
  })

  it("resumes session when handle is null (disk-resumed session)", async () => {
    mockQueryFn.mockReturnValue(createMockQuery([
      { type: "system", subtype: "init", session_id: "sdk-disk-1" },
      { type: "result", subtype: "success", result: "resumed", usage: { input_tokens: 5, output_tokens: 3 } },
    ]))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    // Simulate: session was activated then handle died (process death/VS Code restart)
    const liveSession = (engine as any).sessions.get(session.id)
    liveSession.status = "active"
    liveSession.queryHandle = null
    liveSession.sdkSessionId = "sdk-disk-1"

    await engine.sendMessage(session.id, { content: "continue" })
    await engine.waitForIdle(session.id)

    // Verify factory was called with resume option using SDK session ID
    expect(mockQueryFn).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ resume: "sdk-disk-1" }),
      })
    )
  })

  it("resume path canUseTool returns valid SDK PermissionResult (behavior + updatedInput)", async () => {
    let capturedOpts: Record<string, unknown> | undefined
    const eng = new ClaudeCodeEngine({
      queryFactory: (opts: unknown) => {
        capturedOpts = opts as Record<string, unknown>
        return createMockQuery([
          { type: "system", subtype: "init", session_id: "sdk-perm-1" },
          { type: "result", subtype: "success", result: "resumed", usage: { input_tokens: 1, output_tokens: 1 } },
        ])
      },
    })

    const session = await eng.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    // Simulate disk-resumed session (process died)
    const liveSession = (eng as any).sessions.get(session.id)
    liveSession.status = "active"
    liveSession.queryHandle = null
    liveSession.sdkSessionId = "sdk-perm-1"

    await eng.sendMessage(session.id, { content: "continue" })
    await eng.waitForIdle(session.id)

    const options = (capturedOpts as any).options
    expect(options.canUseTool).toBeDefined()
    const result = await options.canUseTool("Bash", { command: "ls" }, { toolUseID: "t1", signal: new AbortController().signal })
    // SDK Zod schema requires behavior:"allow" + updatedInput with original tool input
    expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } })
  })

  it("maps variant to maxThinkingTokens", async () => {
    const variants: Array<{ variant: string; expected: number | undefined }> = [
      { variant: "low", expected: 1024 },
      { variant: "medium", expected: 8192 },
      { variant: "high", expected: 32768 },
      { variant: "max", expected: undefined },
    ]

    for (const { variant, expected } of variants) {
      let capturedOpts: Record<string, unknown> | undefined
      const eng = new ClaudeCodeEngine({
        queryFactory: (opts: unknown) => {
          capturedOpts = opts as Record<string, unknown>
          return createMockQuery([
            { type: "system", subtype: "init" },
            { type: "result", subtype: "success", result: "done", usage: { input_tokens: 1, output_tokens: 1 } },
          ])
        },
      })

      const session = await eng.createSession({
        directory: "/workspace",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
        variant,
      })
      await eng.sendMessage(session.id, { content: "hi" })

      const options = (capturedOpts as any).options
      expect(options.maxThinkingTokens).toBe(expected)
      expect(options.effort).toBeUndefined()
      expect(options.settingSources).toEqual(["user", "project", "local"])
      expect(options.includePartialMessages).toBe(true)
    }
  })

  it("passes mcpServers with signal tool when stateDir and port are configured", async () => {
    let capturedOpts: Record<string, unknown> | undefined

    const engineWithMcp = new ClaudeCodeEngine({
      queryFactory: (opts: unknown) => {
        capturedOpts = opts as Record<string, unknown>
        return createMockQuery([
          { type: "system", subtype: "init" },
          { type: "result", subtype: "success", result: "done", usage: { input_tokens: 1, output_tokens: 1 } },
        ])
      },
      stateDir: "/tmp/atelier-state",
      port: 4321,
    })

    const session = await engineWithMcp.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    await engineWithMcp.sendMessage(session.id, { content: "hello" })

    expect(capturedOpts).toBeTruthy()
    const options = capturedOpts!.options as Record<string, unknown>
    const mcpServers = options.mcpServers as Record<string, unknown>
    expect(mcpServers).toBeTruthy()
    const signal = mcpServers["atelier-signal"] as Record<string, unknown>
    expect(signal.command).toBe(process.execPath)
    expect((signal.args as string[])[1]).toContain("atelier_signal_mcp.ts")
    const env = signal.env as Record<string, string>
    expect(env.ATELIER_PORT).toBe("4321")
    expect(env.ATELIER_SESSION_ID).toBe(session.id)
  })
})

describe("ClaudeCodeEngine metadata store integration", () => {
  let tmpDir: string
  let metaStore: SessionMetadataStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-meta-"))
    metaStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))
  })

  it("writes to metadata store on create/busy/idle", async () => {
    const mockQueryFn = vi.fn().mockReturnValue(createMockQuery([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", result: "done", usage: { input_tokens: 10, output_tokens: 5 } },
    ]))

    const engine = new ClaudeCodeEngine({ queryFactory: mockQueryFn, metadataStore: metaStore })

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    // Verify create
    const meta = metaStore.get(session.id)
    expect(meta).toBeTruthy()
    expect(meta!.backend).toBe("claude-code")
    expect(meta!.status).toBe("idle")

    // Send message → busy → idle
    await engine.sendMessage(session.id, { content: "hi" })
    await engine.waitForIdle(session.id)

    expect(metaStore.get(session.id)!.status).toBe("idle")
  })

  it("deletes from metadata store on deleteSession", async () => {
    const mockQueryFn = vi.fn()
    const engine = new ClaudeCodeEngine({ queryFactory: mockQueryFn, metadataStore: metaStore })

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    expect(metaStore.get(session.id)).toBeTruthy()
    await engine.deleteSession(session.id)
    expect(metaStore.get(session.id)).toBeNull()
  })

  it("deleteSession calls killSdkSubprocess with the session ID", async () => {
    // Mock listProcesses to apply the filter argument, simulating real behavior
    const allProcs = [
      { pid: 42, ppid: 1, command: 'node /path/to/claude-agent-sdk/cli.js --mcp-config {"ATELIER_SESSION_ID":"PLACEHOLDER"}' },
      { pid: 99, ppid: 1, command: "node /path/to/other-process.js" },
    ]
    const listSpy = vi.spyOn(processPlatform, "listProcesses").mockImplementation((filter) => {
      return filter ? allProcs.filter(filter) : allProcs
    })
    const terminateSpy = vi.spyOn(processPlatform, "terminateProcessTree").mockResolvedValue(undefined)

    const mockQueryFn = vi.fn()
    const engine = new ClaudeCodeEngine({ queryFactory: mockQueryFn, metadataStore: metaStore })

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })
    const sessionId = session.id

    // Update mock data with the real session ID so the filter matches PID 42
    allProcs[0]!.command = `node /path/to/claude-agent-sdk/cli.js --mcp-config {"ATELIER_SESSION_ID":"${sessionId}"}`

    await engine.deleteSession(sessionId)

    expect(listSpy).toHaveBeenCalled()
    // Only PID 42 matches the filter (claude-agent-sdk + session ID)
    expect(terminateSpy).toHaveBeenCalledWith(42)
    // PID 99 should NOT be killed (doesn't match filter)
    expect(terminateSpy).not.toHaveBeenCalledWith(99)

    listSpy.mockRestore()
    terminateSpy.mockRestore()
  })

  it("updates title in metadata store", async () => {
    const mockQueryFn = vi.fn()
    const engine = new ClaudeCodeEngine({ queryFactory: mockQueryFn, metadataStore: metaStore })

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    await engine.updateSessionTitle(session.id, "My Session")
    expect(metaStore.get(session.id)!.title).toBe("My Session")
  })
})

describe("forkSession", () => {
  let forkEngine: ClaudeCodeEngine
  let metadataStore: SessionMetadataStore
  let mockForkFn: ReturnType<typeof vi.fn>
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fork-test-"))
    metadataStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))
    mockForkFn = vi.fn().mockResolvedValue({ sessionId: "sdk-forked-123" })
    forkEngine = new ClaudeCodeEngine({
      queryFactory: vi.fn(),
      forkSessionFactory: mockForkFn,
      metadataStore,
      transcriptDir: tmpDir,
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("calls SDK forkSession with sdkSessionId and returns new Atelier session", async () => {
    metadataStore.create({
      id: "atelier-src",
      title: "Original",
      backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/workspace",
      createdAt: 1000,
      lastActiveAt: 2000,
      parentId: null,
      status: "idle",
      sdkSessionId: "sdk-original-456",
    })
    // Simulate SDK creating the forked JSONL
    fs.writeFileSync(path.join(tmpDir, "sdk-forked-123.jsonl"), '{"type":"system"}\n')

    const result = await forkEngine.forkSession("atelier-src", { title: "My fork" })

    expect(result.id).toBeTruthy()
    expect(result.id).not.toBe("atelier-src")

    expect(mockForkFn).toHaveBeenCalledWith("sdk-original-456", {
      dir: "/workspace",
      title: "My fork",
    })

    const meta = metadataStore.get(result.id)
    expect(meta).not.toBeNull()
    expect(meta!.forkedFrom).toBe("atelier-src")
    expect(meta!.parentId).toBeNull()
    expect(meta!.backend).toBe("claude-code")
    expect(meta!.model.modelID).toBe("claude-sonnet-4-6")
    expect(meta!.sdkSessionId).toBe("sdk-forked-123")
    expect(meta!.title).toBe("My fork")
    expect(meta!.status).toBe("idle")

    // Verify link: {newAtelierId}.jsonl points to (or copies) sdk-forked-123.jsonl.
    // On Unix this is a symlink; on Windows it may be a hardlink or copy (linkOrCopy fallback).
    // Cross-platform: verify the file exists and its content matches the source.
    const linkPath = path.join(tmpDir, `${result.id}.jsonl`)
    expect(fs.existsSync(linkPath)).toBe(true)
    const sourceContent = fs.readFileSync(path.join(tmpDir, "sdk-forked-123.jsonl"), "utf-8")
    expect(fs.readFileSync(linkPath, "utf-8")).toBe(sourceContent)
  })

  it("throws when source session not found in metadata", async () => {
    await expect(forkEngine.forkSession("nonexistent")).rejects.toThrow(/not found/)
  })

  it("throws when source session has no sdkSessionId", async () => {
    metadataStore.create({
      id: "no-sdk-id",
      title: "No SDK ID",
      backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/workspace",
      createdAt: 1000,
      lastActiveAt: 1000,
      parentId: null,
      status: "idle",
    })

    await expect(forkEngine.forkSession("no-sdk-id")).rejects.toThrow(/SDK session ID/)
  })

  it("propagates SDK fork errors", async () => {
    metadataStore.create({
      id: "src-err",
      title: "Source",
      backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/workspace",
      createdAt: 1000,
      lastActiveAt: 1000,
      parentId: null,
      status: "idle",
      sdkSessionId: "sdk-err",
    })
    mockForkFn.mockRejectedValue(new Error("Disk full"))

    await expect(forkEngine.forkSession("src-err")).rejects.toThrow("Disk full")
  })

  it("copies model and variant from source session", async () => {
    metadataStore.create({
      id: "src-variant",
      title: "Source",
      backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      variant: "high",
      workspacePath: "/workspace",
      createdAt: 1000,
      lastActiveAt: 1000,
      parentId: null,
      status: "busy",
      sdkSessionId: "sdk-variant",
    })
    fs.writeFileSync(path.join(tmpDir, "sdk-forked-123.jsonl"), '{"type":"system"}\n')

    const result = await forkEngine.forkSession("src-variant")
    const meta = metadataStore.get(result.id)
    expect(meta!.model.modelID).toBe("claude-opus-4-6")
    expect(meta!.variant).toBe("high")
  })

  it("defaults title to source title + ' (fork)' when not provided", async () => {
    metadataStore.create({
      id: "src-title",
      title: "Implementing auth",
      backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/workspace",
      createdAt: 1000,
      lastActiveAt: 1000,
      parentId: null,
      status: "idle",
      sdkSessionId: "sdk-title",
    })
    fs.writeFileSync(path.join(tmpDir, "sdk-forked-123.jsonl"), '{"type":"system"}\n')

    const result = await forkEngine.forkSession("src-title")
    const meta = metadataStore.get(result.id)
    expect(meta!.title).toBe("Implementing auth (fork)")
  })
})

describe("idle detector integration", () => {
  it("input_json_delta stream events emit tool_running to the idle detector during active tool block", async () => {
    const normalizedEvents: DetectorNormalizedEvent[] = []
    const mockQueryFn = vi.fn()

    // Simulate a Write tool call: content_block_start (tool_use) → many input_json_delta → content_block_stop → result
    mockQueryFn.mockReturnValue(createMockQuery([
      { type: "system", subtype: "init" },
      // message_start
      { type: "stream_event", event: { type: "message_start", message: { id: "msg-1", role: "assistant" } } },
      // content_block_start for tool_use (Write)
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "tu-1", name: "Write" } } },
      // input_json_delta — streaming the file content as tool arguments
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"file_path": "/workspace/plan.md", "content": "# Plan\\n\\n' } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "Step 1: ..." } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "Step 2: ..." } } },
      // content_block_stop — closes the tool block
      { type: "stream_event", event: { type: "content_block_stop" } },
      // Result
      { type: "result", subtype: "success", result: "Done", usage: { input_tokens: 100, output_tokens: 500 } },
    ]))

    const engine = new ClaudeCodeEngine({ queryFactory: mockQueryFn })
    engine.setRawEventCallback(() => {})
    engine.setNormalizedEventCallback((event) => normalizedEvents.push(event))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    await engine.sendMessage(session.id, { content: "write the plan" })
    await engine.waitForIdle(session.id)

    // input_json_delta events during a tool block should be classified as tool_running (not part_progress)
    // so the idle detector gives them a generous 300s lease instead of 30s.
    // content_block_stop also gets tool_running because _activeToolBlockId clearing is deferred
    // until AFTER the heartbeat — this prevents the dangerous lease downgrade from 300s to 30s.
    const toolRunningEvents = normalizedEvents.filter(
      (e) => e.kind === "progress_event" && "subtype" in e && e.subtype === "tool_running",
    )
    expect(toolRunningEvents.length).toBe(4) // 3 input_json_delta + 1 content_block_stop

    // Verify the tool_start also fired
    const toolStartEvents = normalizedEvents.filter(
      (e) => e.kind === "progress_event" && "subtype" in e && e.subtype === "tool_start",
    )
    expect(toolStartEvents.length).toBe(1)
  })

  it("text_delta and thinking_delta do NOT double-emit via the fallback path", async () => {
    const normalizedEvents: DetectorNormalizedEvent[] = []
    const mockQueryFn = vi.fn()

    mockQueryFn.mockReturnValue(createMockQuery([
      { type: "system", subtype: "init" },
      { type: "stream_event", event: { type: "message_start", message: { id: "msg-2", role: "assistant" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } },
      { type: "result", subtype: "success", result: "Hello", usage: { input_tokens: 10, output_tokens: 5 } },
    ]))

    const engine = new ClaudeCodeEngine({ queryFactory: mockQueryFn })
    engine.setRawEventCallback(() => {})
    engine.setNormalizedEventCallback((event) => normalizedEvents.push(event))

    const session = await engine.createSession({
      directory: "/workspace",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    })

    await engine.sendMessage(session.id, { content: "hi" })
    await engine.waitForIdle(session.id)

    // text_delta and thinking_delta produce AtelierEvents (message.delta) which are classified
    // as part_progress. The heartbeat should NOT fire for these because emittedProgress is true.
    // The system.init yield also emits a heartbeat (part_progress) since it produces no AtelierEvents.
    const progressEvents = normalizedEvents.filter(
      (e) => e.kind === "progress_event" && "subtype" in e && e.subtype === "part_progress",
    )
    // 3: system.init heartbeat + text_delta + thinking_delta (no duplicates from heartbeat)
    expect(progressEvents.length).toBe(3)
  })
})
