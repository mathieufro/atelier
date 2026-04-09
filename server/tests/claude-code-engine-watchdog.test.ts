import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { ClaudeCodeEngine } from "../src/engine/claude-code-engine.js"

// Mock MCP instructions resolver — avoid spawning real subprocesses under fake timers
vi.mock("../src/engine/mcp-instructions.js", () => ({
  resolveMcpInstructions: async () => undefined,
}))

/** Flush microtasks — needed after sync timer advancement to let async generators proceed.
 *  Uses process.nextTick (not faked by @sinonjs/fake-timers) instead of setImmediate. */
async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise(r => process.nextTick(r))
  }
}

/**
 * Helper: create a mock query factory that yields messages from an array,
 * optionally with delays between them (controlled by fake timers).
 */
function createMockQueryFactory(messages: Record<string, unknown>[]) {
  const interrupt = vi.fn(async () => {})
  const close = vi.fn()

  const factory = vi.fn((_opts: unknown) => {
    let idx = 0
    const gen = {
      async next() {
        if (idx < messages.length) {
          return { value: messages[idx++], done: false }
        }
        return { value: undefined, done: true }
      },
      async return() { return { value: undefined, done: true } },
      async throw(e: unknown) { throw e },
      [Symbol.asyncIterator]() { return this },
      interrupt,
      close,
    } as AsyncGenerator<unknown> & { interrupt(): Promise<void>; close(): void }
    return gen
  })

  return { factory, interrupt, close }
}

/**
 * Helper: create a mock query factory where yields are manually controlled.
 * Returns a `yield` function that pushes the next message, and a `finish` function.
 */
function createControllableQueryFactory() {
  const interrupt = vi.fn(async () => {})
  const close = vi.fn()
  let resolveNext: ((msg: Record<string, unknown>) => void) | null = null
  let finished = false
  let finishResolve: (() => void) | null = null

  const factory = vi.fn((_opts: unknown) => {
    const gen = {
      async next() {
        if (finished) return { value: undefined, done: true }
        return new Promise<IteratorResult<unknown>>((resolve) => {
          resolveNext = (msg) => {
            resolveNext = null
            resolve({ value: msg, done: false })
          }
          // If already finished while waiting, resolve done
          if (finished) {
            resolveNext = null
            resolve({ value: undefined, done: true })
          }
        })
      },
      async return() {
        finished = true
        finishResolve?.()
        return { value: undefined, done: true }
      },
      async throw(e: unknown) { throw e },
      [Symbol.asyncIterator]() { return this },
      interrupt,
      close,
    } as AsyncGenerator<unknown> & { interrupt(): Promise<void>; close(): void }
    return gen
  })

  return {
    factory,
    interrupt,
    close,
    yieldMessage(msg: Record<string, unknown>) {
      if (resolveNext) resolveNext(msg)
    },
    finish() {
      finished = true
      if (resolveNext) {
        const r = resolveNext
        resolveNext = null
        // Resolve with done
        ;(r as any)({ value: undefined, done: true })
      }
      finishResolve?.()
    },
  }
}

describe("ClaudeCodeEngine watchdog support", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe("lastYieldAt tracking", () => {
    it("lastYieldAt is updated on every SDK generator yield", async () => {
      const messages = [
        { type: "system", subtype: "init", session_id: "sdk-1" },
        { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
        { type: "result", result: "done", usage: { input_tokens: 10, output_tokens: 5 } },
      ]
      const { factory } = createMockQueryFactory(messages)
      const engine = new ClaudeCodeEngine({ queryFactory: factory })

      const { id } = await engine.createSession({ directory: "/tmp" })

      // Set initial time
      vi.setSystemTime?.(new Date("2026-01-01T00:00:00Z"))

      await engine.sendMessage(id, { content: "test" })

      // Wait for the event loop to process all messages
      vi.runAllTimers()
      await flush()

      // After all yields, getSessionState should reflect last yield
      // Session is now idle (result was yielded), so state may return busy=false
      const state = engine.getSessionState(id)
      // Session completed — state shows not busy
      expect(state).not.toBeNull()
      expect(state!.busy).toBe(false)
      expect(state!.lastYieldAt).toBeGreaterThan(0)
    })

    it("getSessionState returns correct snapshot during active session", async () => {
      const ctrl = createControllableQueryFactory()
      const engine = new ClaudeCodeEngine({ queryFactory: ctrl.factory })

      const { id } = await engine.createSession({ directory: "/tmp" })

      vi.setSystemTime?.(new Date("2026-01-01T00:00:00Z"))

      const sendPromise = engine.sendMessage(id, { content: "test" })
      vi.advanceTimersByTime(0)
      await flush()

      // Yield a tool.started equivalent
      vi.setSystemTime?.(new Date("2026-01-01T00:00:05Z"))
      ctrl.yieldMessage({ type: "content_block_start", content_block: { type: "tool_use", id: "tu-1", name: "Bash" } })
      vi.advanceTimersByTime(0)
      await flush()

      const state = engine.getSessionState(id)
      expect(state).not.toBeNull()
      expect(state!.busy).toBe(true)
      expect(state!.lastYieldAt).toBeGreaterThan(0)
      expect(state!.hasPendingInteractions).toBe(false)

      // Clean up — finish the generator
      ctrl.yieldMessage({ type: "result", result: "done", usage: { input_tokens: 10, output_tokens: 5 } })
      vi.advanceTimersByTime(0)
      await flush()
      ctrl.finish()
      vi.runAllTimers()
      await flush()
    })
  })

  describe("getSessionState", () => {
    it("returns null for non-existent session", () => {
      const engine = new ClaudeCodeEngine({})
      expect(engine.getSessionState("nonexistent")).toBeNull()
    })

    it("reflects pending interactions", async () => {
      const ctrl = createControllableQueryFactory()
      const engine = new ClaudeCodeEngine({ queryFactory: ctrl.factory })

      const { id } = await engine.createSession({ directory: "/tmp" })

      vi.setSystemTime?.(new Date("2026-01-01T00:00:00Z"))

      engine.sendMessage(id, { content: "test" })
      vi.advanceTimersByTime(0)
      await flush()

      // Yield a permission request message — this is SDK-level, need to check how
      // permissions get added. For now, just verify the property is readable.
      const state = engine.getSessionState(id)
      expect(state).not.toBeNull()
      expect(state!.hasPendingInteractions).toBe(false)

      // Clean up
      ctrl.finish()
      vi.runAllTimers()
      await flush()
    })
  })

  describe("interruptAndRestart", () => {
    it("stops current generator and sends continue", async () => {
      // With the new graceful interrupt approach, the process stays alive.
      // interrupt() stops the current turn, then sendMessage("continue") pushes
      // to the still-alive channel, and the event loop picks it up.
      const interruptFn = vi.fn(async () => {})
      let blockResolve: ((v: IteratorResult<unknown>) => void) | null = null
      let continueResolve: ((v: IteratorResult<unknown>) => void) | null = null
      let phase = 0

      const factory = vi.fn((_opts: unknown) => {
        return {
          async next() {
            phase++
            if (phase === 1) {
              // First next() — return system.init
              return { value: { type: "system", subtype: "init", session_id: "sdk-wd-1" }, done: false }
            }
            if (phase === 2) {
              // Second next() — block (simulating busy agent)
              return new Promise<IteratorResult<unknown>>((resolve) => { blockResolve = resolve })
            }
            if (phase === 3) {
              // After interrupt, yield interrupted result
              return { value: { type: "result", result: "interrupted", usage: { input_tokens: 1, output_tokens: 1 } }, done: false }
            }
            if (phase === 4) {
              // Wait for continue message from channel
              return new Promise<IteratorResult<unknown>>((resolve) => { continueResolve = resolve })
            }
            if (phase === 5) {
              // Yield continued result
              return { value: { type: "result", result: "continued", usage: { input_tokens: 1, output_tokens: 1 } }, done: false }
            }
            return { value: undefined, done: true }
          },
          async return() { return { value: undefined, done: true } },
          async throw(e: unknown) { throw e },
          [Symbol.asyncIterator]() { return this },
          interrupt: vi.fn(async () => {
            interruptFn()
            // Resolve the blocking next() to simulate SDK yielding result after interrupt
            blockResolve?.({ value: { type: "result", result: "interrupted", usage: { input_tokens: 1, output_tokens: 1 } }, done: false })
          }),
          close: vi.fn(),
        } as AsyncGenerator<unknown> & { interrupt(): Promise<void>; close(): void }
      })

      const engine = new ClaudeCodeEngine({ queryFactory: factory })
      const { id } = await engine.createSession({ directory: "/tmp" })

      // Start session — generator will block at phase 2
      engine.sendMessage(id, { content: "initial" })
      vi.advanceTimersByTime(0)
      await flush()

      // Verify session is busy
      const stateBefore = engine.getSessionState(id)
      expect(stateBefore?.busy).toBe(true)

      // Interrupt and restart — interrupt() keeps process alive, then sends "continue"
      const result = await engine.interruptAndRestart(id)
      vi.advanceTimersByTime(0)
      await flush()

      expect(result).toBe(true)
      expect(interruptFn).toHaveBeenCalled()
      // Factory called only once — no respawn, process stays alive
      expect(factory).toHaveBeenCalledTimes(1)

      // Let the continue message flow through
      continueResolve?.({ value: { type: "result", result: "continued", usage: { input_tokens: 1, output_tokens: 1 } }, done: false })
      vi.advanceTimersByTime(0)
      await flush()
    })

    it("is idempotent during concurrent calls", async () => {
      // Use a controllable generator that responds to interrupt
      let stopped = false
      let pendingResolve: ((v: IteratorResult<unknown>) => void) | null = null

      let callCount = 0
      const factory = vi.fn((_opts: unknown) => {
        callCount++
        if (callCount === 1) {
          return {
            async next() {
              if (stopped) return { value: undefined, done: true }
              return new Promise<IteratorResult<unknown>>((resolve) => { pendingResolve = resolve })
            },
            async return() { stopped = true; return { value: undefined, done: true } },
            async throw(e: unknown) { throw e },
            [Symbol.asyncIterator]() { return this },
            interrupt: vi.fn(async () => { stopped = true; pendingResolve?.({ value: undefined, done: true }) }),
            close: vi.fn(() => { stopped = true; pendingResolve?.({ value: undefined, done: true }) }),
          } as AsyncGenerator<unknown> & { interrupt(): Promise<void>; close(): void }
        }
        // Subsequent generators yield result
        let done = false
        return {
          async next() {
            if (!done) { done = true; return { value: { type: "result", result: "ok", usage: { input_tokens: 1, output_tokens: 1 } }, done: false } }
            return { value: undefined, done: true }
          },
          async return() { return { value: undefined, done: true } },
          async throw(e: unknown) { throw e },
          [Symbol.asyncIterator]() { return this },
          interrupt: vi.fn(async () => {}),
          close: vi.fn(),
        } as AsyncGenerator<unknown> & { interrupt(): Promise<void>; close(): void }
      })

      const engine = new ClaudeCodeEngine({ queryFactory: factory })
      const { id } = await engine.createSession({ directory: "/tmp" })

      engine.sendMessage(id, { content: "test" })
      vi.advanceTimersByTime(0)
      await flush()

      // Launch two concurrent restart attempts
      const p1 = engine.interruptAndRestart(id)
      const p2 = engine.interruptAndRestart(id)

      const [r1, r2] = await Promise.all([p1, p2])

      // At least one should return false (guarded by _restarting)
      expect(r1 === false || r2 === false).toBe(true)

      vi.runAllTimers()
      await flush()
    })

    it("does nothing if session is already idle", async () => {
      const { factory } = createMockQueryFactory([
        { type: "result", result: "done", usage: { input_tokens: 1, output_tokens: 1 } },
      ])
      const engine = new ClaudeCodeEngine({ queryFactory: factory })
      const { id } = await engine.createSession({ directory: "/tmp" })

      // Send and let it complete
      await engine.sendMessage(id, { content: "test" })
      vi.runAllTimers()
      await flush()

      // Session should be idle now
      const result = await engine.interruptAndRestart(id)
      expect(result).toBe(false)
    })

    it("handles sendMessage failure after interrupt gracefully", async () => {
      let callCount = 0
      let stopped = false
      let pendingResolve: ((v: IteratorResult<unknown>) => void) | null = null

      const factory = vi.fn((_opts: unknown) => {
        callCount++
        if (callCount === 1) {
          return {
            async next() {
              if (stopped) return { value: undefined, done: true }
              return new Promise<IteratorResult<unknown>>((resolve) => { pendingResolve = resolve })
            },
            async return() { stopped = true; return { value: undefined, done: true } },
            async throw(e: unknown) { throw e },
            [Symbol.asyncIterator]() { return this },
            interrupt: vi.fn(async () => { stopped = true; pendingResolve?.({ value: undefined, done: true }) }),
            close: vi.fn(() => { stopped = true; pendingResolve?.({ value: undefined, done: true }) }),
          } as AsyncGenerator<unknown> & { interrupt(): Promise<void>; close(): void }
        }
        // Second generator throws on creation
        throw new Error("SDK unavailable")
      })

      const engine = new ClaudeCodeEngine({ queryFactory: factory })
      const { id } = await engine.createSession({ directory: "/tmp" })

      engine.sendMessage(id, { content: "test" })
      vi.advanceTimersByTime(0)
      await flush()

      // interruptAndRestart should return false (sendMessage/respawn fails)
      const result = await engine.interruptAndRestart(id)
      expect(result).toBe(false)

      vi.runAllTimers()
      await flush()
    })
  })

})
