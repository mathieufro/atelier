import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { OnboardingCard } from "./OnboardingCard.jsx"

describe("OnboardingCard", () => {
  it("renders the Atelier logo SVG", () => {
    const { container } = render(() => <OnboardingCard onCheckAgain={() => {}} />)
    const svg = container.querySelector("svg")
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24")
    // Three paths: tabletop + two legs
    const paths = svg!.querySelectorAll("path")
    expect(paths.length).toBe(3)
  })

  it("renders heading and explanatory text", () => {
    const { container } = render(() => <OnboardingCard onCheckAgain={() => {}} />)
    expect(container.textContent).toContain("No backend detected")
    expect(container.textContent).toContain("Atelier needs a backend")
  })

  it("renders Claude Code and OpenCode cards with setup steps", () => {
    const { container } = render(() => <OnboardingCard onCheckAgain={() => {}} />)
    expect(container.textContent).toContain("Claude Code")
    expect(container.textContent).toContain("claude login")
    expect(container.textContent).toContain("OpenCode")
    expect(container.textContent).toContain("opencode login")
  })

  it("renders Check again button that calls onCheckAgain", () => {
    const onCheckAgain = vi.fn()
    const { container } = render(() => <OnboardingCard onCheckAgain={onCheckAgain} />)
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Check again"
    )
    expect(button).toBeDefined()
    fireEvent.click(button!)
    expect(onCheckAgain).toHaveBeenCalledOnce()
  })
})
