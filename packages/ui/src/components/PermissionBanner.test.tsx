import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { PermissionBanner } from "./PermissionBanner.jsx"

const mockPermission = { id: "perm1", sessionID: "s1", permission: "bash", patterns: [], metadata: {}, always: [] }

describe("PermissionBanner", () => {
  it("renders permission info", () => {
    const req = { id: "p1", sessionID: "s1", permission: "bash", patterns: ["*"], metadata: {}, always: [] }
    const { container } = render(() => <PermissionBanner request={req} onReply={() => {}} />)
    expect(container.textContent).toContain("bash")
  })

  it("calls onReply with sessionID, id, and 'once' when Allow clicked", async () => {
    const onReply = vi.fn()
    const req = { id: "p1", sessionID: "s1", permission: "bash", patterns: [], metadata: {}, always: [] }
    const { getByText } = render(() => <PermissionBanner request={req} onReply={onReply} />)
    fireEvent.click(getByText("Allow"))
    expect(onReply).toHaveBeenCalledWith("s1", "p1", "once")
  })

  it("calls onReply with sessionID, id, and 'reject' when Deny clicked", async () => {
    const onReply = vi.fn()
    const { getByText } = render(() => <PermissionBanner request={mockPermission} onReply={onReply} />)
    await fireEvent.click(getByText("Deny"))
    expect(onReply).toHaveBeenCalledWith("s1", "perm1", "reject")
  })

  it("calls onReply with sessionID, id, and 'always' when Always clicked", async () => {
    const onReply = vi.fn()
    const { getByText } = render(() => <PermissionBanner request={mockPermission} onReply={onReply} />)
    await fireEvent.click(getByText("Always"))
    expect(onReply).toHaveBeenCalledWith("s1", "perm1", "always")
  })
})
