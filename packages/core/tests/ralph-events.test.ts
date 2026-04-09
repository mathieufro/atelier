import { describe, it, expect } from "vitest"
import type { AtelierEvent } from "../src/atelier-events.js"

describe("Ralph AtelierEvent types", () => {
  it("ralph.started is assignable to AtelierEvent", () => {
    const event: AtelierEvent = {
      type: "ralph.started",
      sessionId: "s1",
      promptPath: "/path/to/prompt.md",
      maxIterations: 20,
      completionPromise: "DONE",
      iteration: 1,
    }
    expect(event.type).toBe("ralph.started")
  })

  it("ralph.iteration is assignable to AtelierEvent", () => {
    const event: AtelierEvent = {
      type: "ralph.iteration",
      sessionId: "s1",
      iteration: 3,
      maxIterations: 20,
    }
    expect(event.type).toBe("ralph.iteration")
  })

  it("ralph.complete is assignable to AtelierEvent", () => {
    const event: AtelierEvent = {
      type: "ralph.complete",
      sessionId: "s1",
      iteration: 12,
      reason: "promise_fulfilled",
      detail: "DONE",
    }
    expect(event.type).toBe("ralph.complete")
  })

  it("ralph.complete accepts all four reason values", () => {
    const reasons = ["promise_fulfilled", "max_iterations", "cancelled", "error"] as const
    for (const reason of reasons) {
      const event: AtelierEvent = { type: "ralph.complete", sessionId: "s1", iteration: 1, reason }
      expect(event.reason).toBe(reason)
    }
  })

  it("ralph.complete detail is optional", () => {
    const withDetail: AtelierEvent = { type: "ralph.complete", sessionId: "s1", iteration: 1, reason: "error", detail: "file not found" }
    const withoutDetail: AtelierEvent = { type: "ralph.complete", sessionId: "s1", iteration: 1, reason: "cancelled" }
    expect(withDetail.detail).toBe("file not found")
    expect("detail" in withoutDetail).toBe(false)
  })
})
