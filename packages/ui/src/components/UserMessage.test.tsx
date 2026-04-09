import { describe, it, expect } from "vitest"
import { render } from "@solidjs/testing-library"
import { UserMessageView } from "./UserMessage.jsx"

describe("UserMessage", () => {
  it("renders text content without 'You' label", () => {
    const parts = [{ type: "text", text: "Hello" }]
    const { container } = render(() => <UserMessageView parts={parts as any} />)
    expect(container.textContent).not.toContain("You")
    expect(container.textContent).toContain("Hello")
  })

  it("uses VS Code input background for user messages", () => {
    const parts = [{ type: "text", text: "Hi" }]
    const { container } = render(() => <UserMessageView parts={parts as any} />)
    expect(container.innerHTML).toContain("vsc-input-bg")
  })

  it("renders compaction notice instead of an empty bubble", () => {
    const parts = [{ type: "compaction", auto: true }]
    const { container } = render(() => <UserMessageView parts={parts as any} />)
    expect(container.textContent).toContain("Context compacted automatically")
  })

  it("does not render a bubble when no visible part types exist", () => {
    const parts = [{ type: "step-start" }]
    const { container } = render(() => <UserMessageView parts={parts as any} />)
    expect(container.innerHTML).toBe("")
  })

  it("renders skill badge when skillName is provided", () => {
    const parts = [{ type: "text", text: "Build an API" }]
    const { container } = render(() => <UserMessageView parts={parts as any} skillName="brainstorming" />)
    expect(container.textContent).toContain("/brainstorming")
  })

  it("does not render skill badge when skillName is absent", () => {
    const parts = [{ type: "text", text: "Hello" }]
    const { container } = render(() => <UserMessageView parts={parts as any} />)
    expect(container.textContent).not.toContain("/")
  })
})
