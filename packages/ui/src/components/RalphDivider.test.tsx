import { describe, it, expect } from "vitest"
import { render } from "solid-js/web"
import { RalphDivider } from "./RalphDivider.jsx"
import { findPrecedingDividers, findTrailingDividers } from "./MessageList.jsx"
import type { RalphDividerEvent } from "../stores/ralph-store.js"

function renderToText(event: RalphDividerEvent): string {
  const container = document.createElement("div")
  render(() => <RalphDivider event={event} />, container)
  return container.textContent ?? ""
}

describe("RalphDivider", () => {
  it("renders iteration divider with max", () => {
    const text = renderToText({ type: "iteration", sessionId: "s1", iteration: 3, maxIterations: 20, timestamp: 0 })
    expect(text).toContain("Iteration 3/20")
  })

  it("renders iteration divider without max", () => {
    const text = renderToText({ type: "iteration", sessionId: "s1", iteration: 7, maxIterations: 0, timestamp: 0 })
    expect(text).toContain("Iteration 7")
    expect(text).not.toContain("/")
  })

  it("renders complete divider for promise fulfilled", () => {
    const text = renderToText({ type: "complete", sessionId: "s1", iteration: 12, reason: "promise_fulfilled", detail: "DONE", timestamp: 0 })
    expect(text).toContain("Loop complete")
    expect(text).toContain("promise fulfilled")
    expect(text).toContain("12")
  })

  it("renders complete divider for max iterations", () => {
    const text = renderToText({ type: "complete", sessionId: "s1", iteration: 20, reason: "max_iterations", timestamp: 0 })
    expect(text).toContain("max iterations")
    expect(text).toContain("20")
  })

  it("renders complete divider for cancelled", () => {
    const text = renderToText({ type: "complete", sessionId: "s1", iteration: 5, reason: "cancelled", timestamp: 0 })
    expect(text).toContain("cancelled")
    expect(text).toContain("5")
  })

  it("renders complete divider for error", () => {
    const text = renderToText({ type: "complete", sessionId: "s1", iteration: 3, reason: "error", detail: "file not found", timestamp: 0 })
    expect(text).toContain("error")
    expect(text).toContain("file not found")
  })
})

describe("Divider interleaving", () => {
  const dividers: RalphDividerEvent[] = [
    { type: "iteration", sessionId: "s1", iteration: 1, maxIterations: 3, timestamp: 100 },
    { type: "iteration", sessionId: "s1", iteration: 2, maxIterations: 3, timestamp: 300 },
    { type: "complete", sessionId: "s1", iteration: 2, reason: "max_iterations", timestamp: 500 },
  ]
  const messages = [
    { time: { created: 50 } },
    { time: { created: 200 } },
    { time: { created: 400 } },
  ]

  it("finds dividers between messages", () => {
    expect(findPrecedingDividers(dividers, messages, 0)).toHaveLength(0) // 50 < all dividers
    expect(findPrecedingDividers(dividers, messages, 1)).toHaveLength(1) // iteration@100 between 50-200
    expect(findPrecedingDividers(dividers, messages, 2)).toHaveLength(1) // iteration@300 between 200-400
  })

  it("finds trailing dividers after last message", () => {
    expect(findTrailingDividers(dividers, messages)).toHaveLength(1) // complete@500 > 400
  })

  it("returns empty when no dividers", () => {
    expect(findPrecedingDividers([], messages, 1)).toHaveLength(0)
    expect(findTrailingDividers([], messages)).toHaveLength(0)
  })

  it("all dividers are trailing when no messages", () => {
    expect(findTrailingDividers(dividers, [])).toHaveLength(3)
  })
})
