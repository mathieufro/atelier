import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { ModePill } from "./ModePill.jsx"

describe("ModePill", () => {
  it("displays Build for build mode", () => {
    const { container } = render(() => <ModePill mode="build" onModeChange={() => {}} />)
    expect(container.textContent).toContain("Build")
  })

  it("displays Plan mode with data attribute", () => {
    const { container } = render(() => <ModePill mode="plan" onModeChange={() => {}} />)
    const pill = container.querySelector("[data-mode]")
    expect(pill?.getAttribute("data-mode")).toBe("plan")
    expect(container.textContent).toContain("Plan")
  })

  it("displays Feature mode", () => {
    const { container } = render(() => <ModePill mode="feature" onModeChange={() => {}} />)
    expect(container.textContent).toContain("Feature")
  })

  it("cycles to next mode on click", async () => {
    const onModeChange = vi.fn()
    const { getByText } = render(() => <ModePill mode="build" onModeChange={onModeChange} />)
    await fireEvent.click(getByText("Build"))
    expect(onModeChange).toHaveBeenCalledWith("plan")
  })

  it("cycles build→plan on Shift+Tab", async () => {
    const onModeChange = vi.fn()
    render(() => <ModePill mode="build" onModeChange={onModeChange} />)
    await fireEvent.keyDown(document, { key: "Tab", shiftKey: true })
    expect(onModeChange).toHaveBeenCalledWith("plan")
  })

  it("cycles plan→feature on Shift+Tab", async () => {
    const onModeChange = vi.fn()
    render(() => <ModePill mode="plan" onModeChange={onModeChange} />)
    await fireEvent.keyDown(document, { key: "Tab", shiftKey: true })
    expect(onModeChange).toHaveBeenCalledWith("feature")
  })

  it("cycles feature→bugfix on Shift+Tab", async () => {
    const onModeChange = vi.fn()
    render(() => <ModePill mode="feature" onModeChange={onModeChange} />)
    await fireEvent.keyDown(document, { key: "Tab", shiftKey: true })
    expect(onModeChange).toHaveBeenCalledWith("bugfix")
  })

  it("cycles bugfix→build on Shift+Tab", async () => {
    const onModeChange = vi.fn()
    render(() => <ModePill mode="bugfix" onModeChange={onModeChange} />)
    await fireEvent.keyDown(document, { key: "Tab", shiftKey: true })
    expect(onModeChange).toHaveBeenCalledWith("build")
  })

  it("displays Bugfix mode", () => {
    const { container } = render(() => <ModePill mode="bugfix" onModeChange={() => {}} />)
    expect(container.textContent).toContain("Bugfix")
  })
})
