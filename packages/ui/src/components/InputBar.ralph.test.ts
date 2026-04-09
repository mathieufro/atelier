import { describe, it, expect } from "vitest"
import { parseRalphLoopArgs } from "./InputBar.jsx"

describe("parseRalphLoopArgs", () => {
  it("parses prompt path only", () => {
    const result = parseRalphLoopArgs("./prompt.md")
    expect(result).toEqual({ promptPath: "./prompt.md", maxIterations: undefined, completionPromise: undefined })
  })

  it("parses all arguments", () => {
    const result = parseRalphLoopArgs('./ralph.md --max-iterations 20 --completion-promise "ALL TESTS PASSING"')
    expect(result).toEqual({
      promptPath: "./ralph.md",
      maxIterations: 20,
      completionPromise: "ALL TESTS PASSING",
    })
  })

  it("handles single-word completion promise without quotes", () => {
    const result = parseRalphLoopArgs("task.md --completion-promise DONE")
    expect(result).toEqual({ promptPath: "task.md", maxIterations: undefined, completionPromise: "DONE" })
  })

  it("handles max-iterations without completion promise", () => {
    const result = parseRalphLoopArgs("task.md --max-iterations 5")
    expect(result).toEqual({ promptPath: "task.md", maxIterations: 5, completionPromise: undefined })
  })

  it("returns error for empty input", () => {
    const result = parseRalphLoopArgs("")
    expect(result).toEqual({ error: 'Usage: /ralph-loop <prompt-path> [--max-iterations N] [--completion-promise "TEXT"]' })
  })

  it("returns error for missing prompt path (only flags)", () => {
    const result = parseRalphLoopArgs("--max-iterations 5")
    expect(result).toEqual({ error: 'Usage: /ralph-loop <prompt-path> [--max-iterations N] [--completion-promise "TEXT"]' })
  })

  it("handles double-quoted prompt with spaces", () => {
    const result = parseRalphLoopArgs('"my prompt.md" --max-iterations 3')
    expect("promptPath" in result && result.promptPath).toBe("my prompt.md")
  })
})
