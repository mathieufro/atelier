import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { FilePicker } from "./FilePicker.jsx"

describe("FilePicker", () => {
  it("renders popover when visible", () => {
    const files = [{ path: "/src/foo.ts", name: "foo.ts" }]
    const { container } = render(() =>
      <FilePicker visible={true} files={files} onSelect={() => {}} query="" />,
    )
    expect(container.textContent).toContain("foo.ts")
  })

  it("renders nothing when not visible", () => {
    const { container } = render(() =>
      <FilePicker visible={false} files={[]} onSelect={() => {}} query="" />,
    )
    expect(container.children.length === 0 || container.textContent === "").toBe(true)
  })

  it("calls onSelect when file is clicked", async () => {
    const onSelect = vi.fn()
    const files = [{ path: "/src/bar.ts", name: "bar.ts" }]
    const { getByText } = render(() =>
      <FilePicker visible={true} files={files} onSelect={onSelect} query="" />,
    )
    await fireEvent.click(getByText("bar.ts"))
    expect(onSelect).toHaveBeenCalledWith({ path: "/src/bar.ts", name: "bar.ts" })
  })

  it("shows 'No matching files' when empty and not loading", () => {
    const { container } = render(() =>
      <FilePicker visible={true} files={[]} onSelect={() => {}} query="xyz" loading={false} />,
    )
    expect(container.textContent).toContain("No matching files")
  })

  it("shows 'Searching...' when loading", () => {
    const { container } = render(() =>
      <FilePicker visible={true} files={[]} onSelect={() => {}} query="foo" loading={true} />,
    )
    expect(container.textContent).toContain("Searching...")
    expect(container.textContent).not.toContain("No matching files")
  })

  it("highlights matching portion of filename from query", () => {
    const files = [{ path: "/src/utils.ts", name: "utils.ts" }]
    const { container } = render(() =>
      <FilePicker visible={true} files={files} onSelect={() => {}} query="util" />,
    )
    expect(container.querySelector("mark")).not.toBeNull()
  })
})
