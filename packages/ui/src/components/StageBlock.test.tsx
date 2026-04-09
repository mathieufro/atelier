import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { StageBlock } from "./StageBlock.jsx"
import { StoreProvider } from "../stores/context.jsx"
import { PostMessageProvider } from "../stores/post-message.jsx"

describe("StageBlock", () => {
  const noop = () => {}

  it("renders stage header with icon and name", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <StageBlock
            stage="brainstorm"
            status="running"
            sessionId="sess1"

          />
        </StoreProvider>
      </PostMessageProvider>
    )
    expect(container.textContent).toContain("Brainstorm")
  })

  it("shows checkmark when completed", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <StageBlock
            stage="compile_brainstorm"
            status="completed"
            sessionId="sess1"

          />
        </StoreProvider>
      </PostMessageProvider>
    )
    expect(container.querySelector("[data-stage-status='completed']")).toBeTruthy()
  })

  it("shows idle indicator for idle stage", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <StageBlock
            stage="implement"
            status="idle"
            sessionId="sess1"

          />
        </StoreProvider>
      </PostMessageProvider>
    )
    expect(container.querySelector("[data-stage-status='idle']")).toBeTruthy()
  })

  it("collapses completed compiler stages by default", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <StageBlock
            stage="compile_brainstorm"
            status="completed"
            sessionId="sess1"

            defaultCollapsed={true}
          />
        </StoreProvider>
      </PostMessageProvider>
    )
    const content = container.querySelector("[data-stage-content]")
    expect(content?.getAttribute("data-collapsed")).toBe("true")
  })

  it("shows pause icon for interrupted stage", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <StageBlock
            stage="implement"
            status="running"
            interrupted={true}
            sessionId="sess1"

          />
        </StoreProvider>
      </PostMessageProvider>
    )
    const statusEl = container.querySelector("[data-stage-status='interrupted']")
    expect(statusEl).toBeTruthy()
    expect(statusEl?.textContent).toContain("⏸")
  })

  it("shows stuck indicator for stuck stage", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <StageBlock
            stage="review_spec"
            status="stuck"
            sessionId="sess1"

          />
        </StoreProvider>
      </PostMessageProvider>
    )
    expect(container.querySelector("[data-stage-status='stuck']")).toBeTruthy()
  })

  it("shows skip indicator for skipped stage", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <StageBlock
            stage="compile_brainstorm"
            status="skipped"
            sessionId="sess1"

          />
        </StoreProvider>
      </PostMessageProvider>
    )
    expect(container.querySelector("[data-stage-status='skipped']")).toBeTruthy()
  })

  it("renders fork button when sessionId is provided", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <StageBlock stage="implement" status="completed" sessionId="sess-1" />
        </StoreProvider>
      </PostMessageProvider>
    )
    const forkBtn = container.querySelector("[data-fork-button]")
    expect(forkBtn).not.toBeNull()
  })

  it("does not render fork button when sessionId is absent", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <StageBlock stage="implement" status="skipped" />
        </StoreProvider>
      </PostMessageProvider>
    )
    const forkBtn = container.querySelector("[data-fork-button]")
    expect(forkBtn).toBeNull()
  })

  it("sends forkStageSession message on fork button click", () => {
    const mockPost = vi.fn()
    const { container } = render(() =>
      <PostMessageProvider value={mockPost}>
        <StoreProvider>
          <StageBlock stage="implement" status="completed" sessionId="sess-42" />
        </StoreProvider>
      </PostMessageProvider>
    )
    const forkBtn = container.querySelector("[data-fork-button]") as HTMLButtonElement
    fireEvent.click(forkBtn)
    expect(mockPost).toHaveBeenCalledWith({
      type: "forkStageSession",
      sessionId: "sess-42",
    })
  })

  it("fork button click does not toggle collapse", () => {
    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <StageBlock stage="implement" status="running" sessionId="sess-1">
            <div>Content</div>
          </StageBlock>
        </StoreProvider>
      </PostMessageProvider>
    )
    const content = container.querySelector("[data-stage-content]")
    expect(content?.getAttribute("data-collapsed")).toBe("false")

    const forkBtn = container.querySelector("[data-fork-button]") as HTMLButtonElement
    fireEvent.click(forkBtn)

    expect(content?.getAttribute("data-collapsed")).toBe("false")
  })
})
