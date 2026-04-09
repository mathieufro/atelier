import { describe, it, expect } from "vitest"

// Spec test: verifies the sourceSessionId detection logic independently.
// This mirrors the condition in App.tsx but does not import it — it documents
// the intended behavior as a contract. If the App.tsx condition changes,
// this test must be updated manually to match.

describe("sourceSessionId detection", () => {
  function computeSourceSessionId(opts: {
    isPipelineMode: boolean
    currentPipelineId: string | null
    activeSessionId: string | null
  }): string | undefined {
    // Mirror the logic from App.tsx sendMessage construction
    if (opts.isPipelineMode && !opts.currentPipelineId && opts.activeSessionId) {
      return opts.activeSessionId
    }
    return undefined
  }

  it("sets sourceSessionId when switching from build to pipeline mode with active session", () => {
    expect(computeSourceSessionId({
      isPipelineMode: true,
      currentPipelineId: null,
      activeSessionId: "build-sess-abc",
    })).toBe("build-sess-abc")
  })

  it("omits sourceSessionId when no active session exists", () => {
    expect(computeSourceSessionId({
      isPipelineMode: true,
      currentPipelineId: null,
      activeSessionId: null,
    })).toBeUndefined()
  })

  it("omits sourceSessionId when already in a pipeline (has pipelineId)", () => {
    expect(computeSourceSessionId({
      isPipelineMode: true,
      currentPipelineId: "pipeline-xyz",
      activeSessionId: "build-sess-abc",
    })).toBeUndefined()
  })

  it("omits sourceSessionId in build mode", () => {
    expect(computeSourceSessionId({
      isPipelineMode: false,
      currentPipelineId: null,
      activeSessionId: "build-sess-abc",
    })).toBeUndefined()
  })
})
