import { describe, it, expect, vi } from "vitest"
import { render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { TextPartView } from "./TextPart.jsx"
import { ReasoningPartView } from "./ReasoningPart.jsx"

vi.mock("../../markdown/renderer.js", () => ({
  createStreamingRenderer: (container: HTMLElement) => ({
    write: (text: string) => { container.textContent = (container.textContent || "") + text },
    end: () => {},
    cleanup: () => {},
  })
}))

describe("TextPartView", () => {
  it("renders text content", () => {
    const { container } = render(() =>
      <TextPartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "Hello world" }} />,
    )
    expect(container.textContent).toContain("Hello world")
  })
  it("renders empty text without crashing", () => {
    const { container } = render(() =>
      <TextPartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "" }} />,
    )
    expect(container).toBeDefined()
  })
})

describe("ReasoningPartView", () => {
  it("renders thinking header", () => {
    const { container } = render(() =>
      <ReasoningPartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "reasoning", text: "Let me think...", time: { start: 1000 } }} />,
    )
    expect(container.textContent).toContain("Thinking")
  })
  it("shows duration when complete", () => {
    const { container } = render(() =>
      <ReasoningPartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "reasoning", text: "Done", time: { start: 1000, end: 3500 } }} />,
    )
    expect(container.textContent).toContain("2.5s")
  })
})
