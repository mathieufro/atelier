// tests/integration/test-agent-engine.test.ts
import { describe, it, expect } from "vitest"
import { TestAgentEngine, emit, pause, wait } from "./test-agent-engine.js"
import type { AtelierEvent } from "@atelier/core"

describe("TestAgentEngine", () => {
  describe("advance()", () => {
    it("emits events one step at a time", async () => {
      const engine = new TestAgentEngine([
        emit({ type: "session.busy", sessionId: "s1" }),
        emit({ type: "session.idle", sessionId: "s1", usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.001 }),
      ])
      const e1 = await engine.advance()
      expect(e1).toEqual({ type: "session.busy", sessionId: "s1" })
      expect(engine.emittedEvents).toHaveLength(1)

      const e2 = await engine.advance()
      expect(e2!.type).toBe("session.idle")
      expect(engine.emittedEvents).toHaveLength(2)
    })

    it("returns null when scenario is exhausted", async () => {
      const engine = new TestAgentEngine([
        emit({ type: "session.busy", sessionId: "s1" }),
      ])
      await engine.advance()
      const result = await engine.advance()
      expect(result).toBeNull()
    })
  })

  describe("advanceTo()", () => {
    it("advances until a named pause point", async () => {
      const engine = new TestAgentEngine([
        emit({ type: "session.busy", sessionId: "s1" }),
        emit({ type: "message.created", sessionId: "s1", messageId: "m1", role: "assistant" }),
        pause("mid-stream"),
        emit({ type: "session.idle", sessionId: "s1", usage: { inputTokens: 10, outputTokens: 5 } }),
      ])
      await engine.advanceTo("mid-stream")
      expect(engine.emittedEvents).toHaveLength(2)
      // Advancing further gets the idle event
      await engine.advance()
      expect(engine.emittedEvents).toHaveLength(3)
    })

    it("throws if label not found", async () => {
      const engine = new TestAgentEngine([
        emit({ type: "session.busy", sessionId: "s1" }),
      ])
      await expect(engine.advanceTo("nonexistent")).rejects.toThrow()
    })
  })

  describe("advanceAll()", () => {
    it("emits all remaining events", async () => {
      const engine = new TestAgentEngine([
        emit({ type: "session.busy", sessionId: "s1" }),
        pause("point-a"),
        emit({ type: "session.idle", sessionId: "s1", usage: { inputTokens: 0, outputTokens: 0 } }),
      ])
      await engine.advanceAll()
      expect(engine.emittedEvents).toHaveLength(2) // pauses are skipped
    })
  })

  describe("wait steps", () => {
    it("delays by the specified duration", async () => {
      const engine = new TestAgentEngine([
        emit({ type: "session.busy", sessionId: "s1" }),
        wait(50),
        emit({ type: "session.idle", sessionId: "s1", usage: { inputTokens: 0, outputTokens: 0 } }),
      ])
      const start = Date.now()
      await engine.advanceAll()
      expect(Date.now() - start).toBeGreaterThanOrEqual(40) // allow small timing variance
    })
  })

  describe("AgentEngine interface", () => {
    it("createSession returns a session ID", async () => {
      const engine = new TestAgentEngine([])
      const session = await engine.createSession({
        directory: "/tmp",
        permission: "default",
      })
      expect(session.id).toBeDefined()
      expect(typeof session.id).toBe("string")
    })

    it("sendMessage records received messages", async () => {
      const engine = new TestAgentEngine([])
      await engine.createSession({ directory: "/tmp", permission: "default" })
      await engine.sendMessage("s1", { content: "hello" })
      expect(engine.receivedMessages).toHaveLength(1)
      expect(engine.receivedMessages[0].message.content).toBe("hello")
    })

    it("interruptSession records interrupted session IDs", async () => {
      const engine = new TestAgentEngine([])
      await engine.interruptSession("s1")
      expect(engine.interruptedSessions).toContain("s1")
    })
  })

  describe("event listener", () => {
    it("notifies listener when events are emitted", async () => {
      const received: AtelierEvent[] = []
      const engine = new TestAgentEngine([
        emit({ type: "session.busy", sessionId: "s1" }),
        emit({ type: "session.idle", sessionId: "s1", usage: { inputTokens: 0, outputTokens: 0 } }),
      ])
      engine.onEvent((event) => received.push(event))
      await engine.advanceAll()
      expect(received).toHaveLength(2)
    })
  })
})
