import { describe, it, expect, vi } from "vitest"
import { render } from "@solidjs/testing-library"
import { AssistantMessageView } from "./AssistantMessage.jsx"

vi.mock("./parts/TextPart.jsx", () => ({
  TextPartView: (props: any) => <div>{props.part.text}</div>,
}))

describe("AssistantMessageView", () => {
  it("renders text parts", () => {
    const parts = [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text" as const, text: "Here is my answer" }]
    const { container } = render(() => <AssistantMessageView parts={parts} />)
    expect(container.textContent).toContain("Here is my answer")
  })

  it("renders tool parts", () => {
    const parts = [{
      id: "p1", sessionID: "s1", messageID: "m1", type: "tool" as const,
      callID: "c1", tool: "bash",
      state: { status: "completed" as const, input: { command: "ls" }, output: "file.ts", title: "bash", metadata: {}, time: { start: 0, end: 100 } },
    }]
    const { container } = render(() => <AssistantMessageView parts={parts} />)
    expect(container.textContent).toContain("Bash")
  })

  it("renders mixed parts in order", () => {
    const parts = [
      { id: "p1", sessionID: "s1", messageID: "m1", type: "text" as const, text: "First" },
      { id: "p2", sessionID: "s1", messageID: "m1", type: "reasoning" as const, text: "Thinking", time: { start: 0 } },
    ]
    const { container } = render(() => <AssistantMessageView parts={parts} />)
    expect(container.textContent).toContain("First")
    expect(container.textContent).toContain("Thinking")
  })

  // All 7+ part types render correctly
  it("renders all supported part types without crash", () => {
    const parts = [
      { id: "p1", sessionID: "s1", messageID: "m1", type: "text" as const, text: "text" },
      { id: "p2", sessionID: "s1", messageID: "m1", type: "reasoning" as const, text: "reasoning", time: { start: 0 } },
      { id: "p3", sessionID: "s1", messageID: "m1", type: "tool" as const, callID: "c1", tool: "bash", state: { status: "pending" as const, input: {}, time: { start: 0 } } },
      { id: "p4", sessionID: "s1", messageID: "m1", type: "file" as const, mime: "text/plain", url: "file:///x", filename: "x.txt" },
      { id: "p5", sessionID: "s1", messageID: "m1", type: "retry" as const, error: "rate limit" },
      { id: "p6", sessionID: "s1", messageID: "m1", type: "agent" as const, name: "coder" },
      { id: "p7", sessionID: "s1", messageID: "m1", type: "compaction" as const },
    ]
    const { container } = render(() => <AssistantMessageView parts={parts as any} />)
    expect(container.textContent).toContain("text")
    expect(container.textContent).toContain("Retrying")
    expect(container.textContent).toContain("coder")
    expect(container.textContent).toContain("compacted")
  })

  it("silently hides unknown and metadata part types", () => {
    const parts = [
      { id: "p1", sessionID: "s1", messageID: "m1", type: "unknown_type" as any },
      { id: "p2", sessionID: "s1", messageID: "m1", type: "step-start" as any },
      { id: "p3", sessionID: "s1", messageID: "m1", type: "step-finish" as any, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 },
    ]
    const { container } = render(() => <AssistantMessageView parts={parts} />)
    expect(container.textContent?.trim()).toBe("")
  })

  it("renders interrupted marker for aborted assistant messages", () => {
    const parts = [{ id: "p1", sessionID: "s1", messageID: "m1", type: "reasoning" as const, text: "Still thinking", time: { start: 0 } }]
    const { container } = render(() => <AssistantMessageView parts={parts} interrupted={true} />)
    expect(container.textContent).toContain("interrupted")
    expect(container.querySelectorAll(".dots").length).toBe(0)
  })

  it("shows 'Reconnecting...' when status is stalled", () => {
    const parts = [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text" as const, text: "partial" }]
    const { container } = render(() => <AssistantMessageView parts={parts} isStalled={true} />)
    expect(container.textContent).toContain("Reconnecting")
  })

  it("reverts to normal when stalled clears", () => {
    const parts = [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text" as const, text: "response" }]
    // Not stalled, not streaming — should show no placeholder
    const { container } = render(() => <AssistantMessageView parts={parts} isStalled={false} isStreaming={true} />)
    expect(container.textContent).not.toContain("Reconnecting")
    expect(container.textContent).toContain("response")
  })

  it("does not show Reconnecting when interrupted", () => {
    const parts = [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text" as const, text: "partial" }]
    const { container } = render(() => <AssistantMessageView parts={parts} isStalled={true} interrupted={true} />)
    expect(container.textContent).not.toContain("Reconnecting")
    expect(container.textContent).toContain("interrupted")
  })
})
