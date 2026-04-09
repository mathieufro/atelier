import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { SkillPicker } from "./SkillPicker.jsx"
import type { SkillInfo } from "@atelier/core"

const testSkills: SkillInfo[] = [
  { name: "brainstorming", description: "Guides brainstorm sessions", stage: "brainstorm" },
  { name: "bugfixing", description: "Bug investigation and fixing", stage: "bugfix" },
  { name: "implementing-plans", description: "Autonomous code implementation", stage: "implement" },
]

describe("SkillPicker", () => {
  it("renders all skills when visible with empty query", () => {
    const { container } = render(() =>
      <SkillPicker visible={true} skills={testSkills} query="" selectedIndex={0} onSelect={() => {}} onClose={() => {}} />,
    )
    expect(container.textContent).toContain("/brainstorming")
    expect(container.textContent).toContain("/bugfixing")
    expect(container.textContent).toContain("/implementing-plans")
  })

  it("renders nothing when not visible", () => {
    const { container } = render(() =>
      <SkillPicker visible={false} skills={testSkills} query="" selectedIndex={0} onSelect={() => {}} onClose={() => {}} />,
    )
    expect(container.textContent).not.toContain("/brainstorming")
  })

  it("filters skills by name query", () => {
    const { container } = render(() =>
      <SkillPicker visible={true} skills={testSkills} query="bug" selectedIndex={0} onSelect={() => {}} onClose={() => {}} />,
    )
    expect(container.textContent).toContain("/bugfixing")
    expect(container.textContent).not.toContain("/brainstorming")
    expect(container.textContent).not.toContain("/implementing-plans")
  })

  it("filters skills by description", () => {
    const { container } = render(() =>
      <SkillPicker visible={true} skills={testSkills} query="autonomous" selectedIndex={0} onSelect={() => {}} onClose={() => {}} />,
    )
    expect(container.textContent).toContain("/implementing-plans")
    expect(container.textContent).not.toContain("/brainstorming")
  })

  it("shows descriptions", () => {
    const { container } = render(() =>
      <SkillPicker visible={true} skills={testSkills} query="" selectedIndex={0} onSelect={() => {}} onClose={() => {}} />,
    )
    expect(container.textContent).toContain("Guides brainstorm sessions")
    expect(container.textContent).toContain("Bug investigation and fixing")
  })

  it("calls onSelect when skill button is clicked", async () => {
    const onSelect = vi.fn()
    const { getByText } = render(() =>
      <SkillPicker visible={true} skills={testSkills} query="" selectedIndex={0} onSelect={onSelect} onClose={() => {}} />,
    )
    await fireEvent.click(getByText("Bug investigation and fixing"))
    expect(onSelect).toHaveBeenCalledWith(testSkills[1])
  })

  it("shows 'No matching commands' when query matches nothing", () => {
    const { container } = render(() =>
      <SkillPicker visible={true} skills={testSkills} query="zzzznonexistent" selectedIndex={0} onSelect={() => {}} onClose={() => {}} />,
    )
    expect(container.textContent).toContain("No matching commands")
  })

  it("handles empty skills array", () => {
    const { container } = render(() =>
      <SkillPicker visible={true} skills={[]} query="" selectedIndex={0} onSelect={() => {}} onClose={() => {}} />,
    )
    expect(container.textContent).toContain("No matching commands")
  })

  it("highlights the selected row with bg-vsc-list-hover", () => {
    const { container } = render(() =>
      <SkillPicker visible={true} skills={testSkills} query="" selectedIndex={1} onSelect={() => {}} onClose={() => {}} />,
    )
    const buttons = container.querySelectorAll("button")
    expect(buttons[1]!.classList.contains("bg-vsc-list-hover")).toBe(true)
    expect(buttons[0]!.classList.contains("bg-vsc-list-hover")).toBe(false)
    expect(buttons[2]!.classList.contains("bg-vsc-list-hover")).toBe(false)
  })
})
