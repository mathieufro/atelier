import { describe, it, expect } from "vitest"
import { render } from "@solidjs/testing-library"
import { SubtaskPartView } from "./SubtaskPart.jsx"
import { FilePartView } from "./FilePart.jsx"
// Now imported from separate files
import { RetryPartView } from "./RetryPart.jsx"
import { AgentPartView } from "./AgentPart.jsx"
import { CompactionPartView } from "./CompactionPart.jsx"

describe("SubtaskPartView", () => {
  it("renders agent name and description", () => {
    const { container } = render(() =>
      <SubtaskPartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "subtask", prompt: "Fix bug", description: "Debug task", agent: "coder" }} />,
    )
    expect(container.textContent).toContain("coder")
    expect(container.textContent).toContain("Debug task")
  })
})

describe("FilePartView", () => {
  it("renders image for image mime", () => {
    const { container } = render(() =>
      <FilePartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "file", mime: "image/png", url: "data:image/png;base64,abc" }} />,
    )
    expect(container.querySelector("img")).not.toBeNull()
  })
  it("renders file link for non-image", () => {
    const { container } = render(() =>
      <FilePartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "file", mime: "text/plain", filename: "readme.txt", url: "file:///readme.txt" }} />,
    )
    expect(container.textContent).toContain("readme.txt")
  })
})

// I8: RetryPartView error extraction
describe("RetryPartView", () => {
  it("renders string error", () => {
    const { container } = render(() =>
      <RetryPartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "retry", error: "rate limit" } as any} />,
    )
    expect(container.textContent).toContain("rate limit")
    expect(container.textContent).toContain("Retrying")
  })

  it("renders ApiError with data.message", () => {
    const { container } = render(() =>
      <RetryPartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "retry", error: { name: "ApiError", data: { message: "too many requests" } } } as any} />,
    )
    expect(container.textContent).toContain("too many requests")
  })

  it("renders error with direct message field", () => {
    const { container } = render(() =>
      <RetryPartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "retry", error: { message: "network error" } } as any} />,
    )
    expect(container.textContent).toContain("network error")
  })

  it("renders unknown error when error is null", () => {
    const { container } = render(() =>
      <RetryPartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "retry", error: null } as any} />,
    )
    expect(container.textContent).toContain("unknown error")
  })
})

describe("AgentPartView", () => {
  it("renders agent name", () => {
    const { container } = render(() =>
      <AgentPartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "agent", name: "coder" } as any} />,
    )
    expect(container.textContent).toContain("Agent")
    expect(container.textContent).toContain("coder")
  })
})

describe("CompactionPartView", () => {
  it("renders compaction message", () => {
    const { container } = render(() =>
      <CompactionPartView part={{ id: "p1", sessionID: "s1", messageID: "m1", type: "compaction" } as any} />,
    )
    expect(container.textContent).toContain("Context compacted")
  })
})
