import { describe, it, expect } from "vitest"
import { createRoot } from "solid-js"
import { createRalphStore } from "./ralph-store.js"

describe("createRalphStore", () => {
  it("initializes with no loops", () => {
    createRoot((dispose) => {
      const store = createRalphStore()
      expect(store.getLoop("s1")).toBeNull()
      expect(store.isLoopActive("s1")).toBe(false)
      dispose()
    })
  })

  it("tracks ralph.started event", () => {
    createRoot((dispose) => {
      const store = createRalphStore()
      store.handleEvent({
        type: "ralph.started",
        sessionId: "s1",
        promptPath: "/path/to/prompt.md",
        maxIterations: 10,
        completionPromise: "DONE",
        iteration: 1,
      })

      const loop = store.getLoop("s1")
      expect(loop).toMatchObject({
        sessionId: "s1",
        promptPath: "/path/to/prompt.md",
        maxIterations: 10,
        iteration: 1,
        status: "running",
      })
      expect(store.isLoopActive("s1")).toBe(true)
      dispose()
    })
  })

  it("updates iteration on ralph.iteration event", () => {
    createRoot((dispose) => {
      const store = createRalphStore()
      store.handleEvent({
        type: "ralph.started",
        sessionId: "s1",
        promptPath: "/p.md",
        maxIterations: 10,
        completionPromise: null,
        iteration: 1,
      })
      store.handleEvent({
        type: "ralph.iteration",
        sessionId: "s1",
        iteration: 3,
        maxIterations: 10,
      })

      expect(store.getLoop("s1")?.iteration).toBe(3)
      dispose()
    })
  })

  it("updates status on ralph.complete event", () => {
    createRoot((dispose) => {
      const store = createRalphStore()
      store.handleEvent({
        type: "ralph.started",
        sessionId: "s1",
        promptPath: "/p.md",
        maxIterations: 10,
        completionPromise: "DONE",
        iteration: 1,
      })
      store.handleEvent({
        type: "ralph.complete",
        sessionId: "s1",
        iteration: 5,
        reason: "promise_fulfilled",
        detail: "DONE",
      })

      const loop = store.getLoop("s1")
      expect(loop?.status).toBe("completed")
      expect(loop?.reason).toBe("promise_fulfilled")
      expect(loop?.detail).toBe("DONE")
      expect(store.isLoopActive("s1")).toBe(false)
      dispose()
    })
  })

  it("tracks events per session for divider rendering", () => {
    createRoot((dispose) => {
      const store = createRalphStore()
      store.handleEvent({ type: "ralph.started", sessionId: "s1", promptPath: "/p.md", maxIterations: 3, completionPromise: null, iteration: 1 })
      store.handleEvent({ type: "ralph.iteration", sessionId: "s1", iteration: 1, maxIterations: 3 })
      store.handleEvent({ type: "ralph.iteration", sessionId: "s1", iteration: 2, maxIterations: 3 })
      store.handleEvent({ type: "ralph.complete", sessionId: "s1", iteration: 2, reason: "max_iterations" })

      const events = store.getEvents("s1")
      expect(events).toHaveLength(3) // 2 iterations + 1 complete (started is not a divider)
      expect(events![0]!.type).toBe("iteration")
      expect(events![1]!.type).toBe("iteration")
      expect(events![2]!.type).toBe("complete")
      dispose()
    })
  })

  it("ignores events for unknown types", () => {
    createRoot((dispose) => {
      const store = createRalphStore()
      store.handleEvent({ type: "session.busy", sessionId: "s1" } as any)
      expect(store.getLoop("s1")).toBeNull()
      dispose()
    })
  })
})
