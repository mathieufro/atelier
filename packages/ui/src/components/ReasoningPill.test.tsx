import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { ReasoningPill } from "./ReasoningPill.jsx"

const VARIANTS = ["low", "medium", "high", "max"]

describe("ReasoningPill", () => {
  it("displays brain icon and current variant label", () => {
    const { container } = render(() =>
      <ReasoningPill variants={VARIANTS} current="medium" onChange={() => {}} />,
    )
    expect(container.textContent).toContain("medium")
  })

  it("displays think:off when current is undefined", () => {
    const { container } = render(() =>
      <ReasoningPill variants={VARIANTS} current={undefined} onChange={() => {}} />,
    )
    expect(container.textContent).toContain("think:off")
  })

  it("cycles: undefined → first variant", async () => {
    const onChange = vi.fn()
    const { getByRole } = render(() =>
      <ReasoningPill variants={VARIANTS} current={undefined} onChange={onChange} />,
    )
    await fireEvent.click(getByRole("button"))
    expect(onChange).toHaveBeenCalledWith("low")
  })

  it("cycles: first → second variant", async () => {
    const onChange = vi.fn()
    const { getByRole } = render(() =>
      <ReasoningPill variants={VARIANTS} current="low" onChange={onChange} />,
    )
    await fireEvent.click(getByRole("button"))
    expect(onChange).toHaveBeenCalledWith("medium")
  })

  it("cycles: middle → next variant", async () => {
    const onChange = vi.fn()
    const { getByRole } = render(() =>
      <ReasoningPill variants={VARIANTS} current="medium" onChange={onChange} />,
    )
    await fireEvent.click(getByRole("button"))
    expect(onChange).toHaveBeenCalledWith("high")
  })

  it("cycles: last variant → undefined (off)", async () => {
    const onChange = vi.fn()
    const { getByRole } = render(() =>
      <ReasoningPill variants={VARIANTS} current="max" onChange={onChange} />,
    )
    await fireEvent.click(getByRole("button"))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it("cycles: unknown current → undefined (off)", async () => {
    const onChange = vi.fn()
    const { getByRole } = render(() =>
      <ReasoningPill variants={VARIANTS} current="nonexistent" onChange={onChange} />,
    )
    await fireEvent.click(getByRole("button"))
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it("does nothing when variants is empty", async () => {
    const onChange = vi.fn()
    const { getByRole } = render(() =>
      <ReasoningPill variants={[]} current={undefined} onChange={onChange} />,
    )
    await fireEvent.click(getByRole("button"))
    expect(onChange).not.toHaveBeenCalled()
  })

  it("renders nothing when hidden", () => {
    const { container } = render(() =>
      <ReasoningPill variants={VARIANTS} current="medium" onChange={() => {}} hidden />,
    )
    expect(container.textContent).toBe("")
  })

  it("sets data-variant attribute to current or off", () => {
    const { container } = render(() =>
      <ReasoningPill variants={VARIANTS} current="high" onChange={() => {}} />,
    )
    expect(container.querySelector("[data-variant='high']")).not.toBeNull()
  })
})
