import { describe, it, expect } from "vitest"
import { render } from "@solidjs/testing-library"
import { ContextIndicator } from "./ContextIndicator.jsx"

describe("ContextIndicator", () => {
  it("shows percentage when model is matched", () => {
    const { container } = render(() =>
      <ContextIndicator inputTokens={20000} contextLimit={200000} />,
    )
    expect(container.textContent).toContain("10%")
  })

  it("rounds to nearest integer", () => {
    const { container } = render(() =>
      <ContextIndicator inputTokens={33333} contextLimit={200000} />,
    )
    expect(container.textContent).toContain("17%")
  })

  it("hides when usage is below 5%", () => {
    const { container } = render(() =>
      <ContextIndicator inputTokens={0} contextLimit={200000} />,
    )
    expect(container.textContent).toBe("")
  })

  it("renders progress bar element", () => {
    const { container } = render(() =>
      <ContextIndicator inputTokens={50000} contextLimit={200000} />,
    )
    // Progress bar should exist as a rounded-full div
    const bar = container.querySelector(".rounded-full")
    expect(bar).not.toBeNull()
  })

  it("renders nothing when no context limit", () => {
    const { container } = render(() =>
      <ContextIndicator inputTokens={8900} contextLimit={undefined} />,
    )
    expect(container.textContent).toBe("")
  })

  it("renders nothing when no tokens", () => {
    const { container } = render(() =>
      <ContextIndicator inputTokens={undefined} contextLimit={200000} />,
    )
    expect(container.textContent).toBe("")
  })
})
