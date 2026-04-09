import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { FileAttachments } from "./FileAttachments.jsx"

describe("FileAttachments", () => {
  it("renders attached files", () => {
    const files = [{ name: "test.png", mime: "image/png", url: "data:image/png;base64,abc" }]
    const { container } = render(() => <FileAttachments files={files} onRemove={() => {}} />)
    expect(container.textContent).toContain("test.png")
  })

  it("calls onRemove when remove clicked", async () => {
    const onRemove = vi.fn()
    const files = [{ name: "test.png", mime: "image/png", url: "data:..." }]
    const { getByText } = render(() => <FileAttachments files={files} onRemove={onRemove} />)
    await fireEvent.click(getByText("×"))
    expect(onRemove).toHaveBeenCalledWith(0)
  })

  it("uses VS Code variable classes", () => {
    const files = [{ name: "test.ts", mime: "text/plain", url: "/test.ts" }]
    const { container } = render(() => <FileAttachments files={files} onRemove={() => {}} />)
    expect(container.innerHTML).toContain("vsc-input-bg")
  })
})
