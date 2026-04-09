import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { QuestionBanner } from "./QuestionBanner.jsx"

const mockQuestion = { id: "q1", sessionID: "s1", questions: [{ question: "Which?", header: "Choice", options: [{ label: "A", description: "Option A" }] }] }

describe("QuestionBanner", () => {
  it("renders question text", () => {
    const req = { id: "q1", sessionID: "s1", questions: [{ question: "Pick one?", header: "Choice", options: [{ label: "A", description: "Option A" }] }] }
    const { container } = render(() => <QuestionBanner request={req} onReply={() => {}} onReject={() => {}} />)
    expect(container.textContent).toContain("Pick one?")
  })

  it("calls onReply with sessionID, requestId, and selected answers on Submit", async () => {
    const onReply = vi.fn()
    const { getByText } = render(() => <QuestionBanner request={mockQuestion} onReply={onReply} onReject={() => {}} />)
    await fireEvent.click(getByText("A"))
    await fireEvent.click(getByText("Submit"))
    expect(onReply).toHaveBeenCalledWith("s1", "q1", [["A"]])
  })

  it("calls onReject with sessionID and requestId on Dismiss", async () => {
    const onReject = vi.fn()
    const { getByText } = render(() => <QuestionBanner request={mockQuestion} onReply={() => {}} onReject={onReject} />)
    await fireEvent.click(getByText("Dismiss"))
    expect(onReject).toHaveBeenCalledWith("s1", "q1")
  })
})
