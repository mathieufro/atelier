import { describe, it, expect } from "vitest"
import { createRoot } from "solid-js"
import { createPipelineStore } from "./pipeline-store.js"

function activatePipeline(store: ReturnType<typeof createPipelineStore>, id = "p1") {
  store.loadPipeline({
    id,
    prompt: `Pipeline ${id}`,
    status: "running",
    currentStage: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    stages: [],
  } as any)
}

describe("createPipelineStore", () => {
  it("starts with no active pipeline", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      expect(store.activePipelineId()).toBeNull()
      expect(store.currentStage()).toBeNull()
      expect(store.stages()).toEqual([])
      dispose()
    })
  })

  it("tracks stage_started event", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store)
      store.handleEvent({
        type: "stage_started",
        pipelineId: "p1",
        stageId: "s1",
        stage: "brainstorm",
        sessionId: "sess1",
      })
      expect(store.activePipelineId()).toBe("p1")
      expect(store.currentStage()).toBe("brainstorm")
      expect(store.sessionToStage("sess1")).toBe("s1")
      expect(store.stages()).toHaveLength(1)
      expect(store.stages()[0]!.stage).toBe("brainstorm")
      expect(store.stages()[0]!.status).toBe("running")
      dispose()
    })
  })

  it("updates stage on stage_completed", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store)
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm", sessionId: "sess1" })
      store.handleEvent({ type: "stage_completed", pipelineId: "p1", stageId: "s1", outputPath: "/spec.md" })
      expect(store.stages()[0]!.status).toBe("completed")
      dispose()
    })
  })

  it("marks pipeline complete on pipeline_completed", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store)
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm", sessionId: "sess1" })
      store.handleEvent({ type: "pipeline_completed", pipelineId: "p1" })
      expect(store.pipelineStatus()).toBe("completed")
      dispose()
    })
  })

  it("clears currentStage to null on pipeline_completed", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store)
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm", sessionId: "sess1" })
      expect(store.currentStage()).toBe("brainstorm")
      store.handleEvent({ type: "pipeline_completed", pipelineId: "p1" })
      expect(store.currentStage()).toBeNull()
      dispose()
    })
  })

  it("tracks multi-stage transitions: both stages recorded in order", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store)
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "compile_brainstorm", sessionId: "sess-compiler" })
      expect(store.currentStage()).toBe("compile_brainstorm")

      store.handleEvent({ type: "stage_completed", pipelineId: "p1", stageId: "s1", outputPath: "/compiled.md" })
      expect(store.stages()[0]!.status).toBe("completed")

      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s2", stage: "brainstorm", sessionId: "sess-brainstorm" })
      expect(store.currentStage()).toBe("brainstorm")

      expect(store.stages()).toHaveLength(2)
      expect(store.stages()[0]!.stage).toBe("compile_brainstorm")
      expect(store.stages()[0]!.status).toBe("completed")
      expect(store.stages()[1]!.stage).toBe("brainstorm")
      expect(store.stages()[1]!.status).toBe("running")
      dispose()
    })
  })

  it("maps session IDs to stage IDs for message grouping", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store)
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "compile_brainstorm", sessionId: "sess-compiler" })
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s2", stage: "brainstorm", sessionId: "sess-brainstorm" })
      expect(store.sessionToStage("sess-compiler")).toBe("s1")
      expect(store.sessionToStage("sess-brainstorm")).toBe("s2")
      expect(store.sessionToStage("unknown")).toBeUndefined()
      dispose()
    })
  })

  it("handles stage_interrupted event", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store)
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm", sessionId: "sess1" })
      store.handleEvent({ type: "stage_interrupted", pipelineId: "p1", stageId: "s1", sessionId: "sess1" })
      const stage = store.stages().find(s => s.id === "s1")
      expect(stage!.interrupted).toBe(true)
      dispose()
    })
  })

  it("handles stage_resumed event", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store)
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm", sessionId: "sess1" })
      store.handleEvent({ type: "stage_interrupted", pipelineId: "p1", stageId: "s1", sessionId: "sess1" })
      store.handleEvent({ type: "stage_resumed", pipelineId: "p1", stageId: "s1", sessionId: "sess1" })
      const stage = store.stages().find(s => s.id === "s1")
      expect(stage!.interrupted).toBe(false)
      dispose()
    })
  })

  it("handles stuck_escalation — sets stage status to stuck", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store)
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "review_spec", sessionId: "sess1" })
      store.handleEvent({ type: "stuck_escalation", pipelineId: "p1", stageId: "s1", stage: "review_spec", sessionId: "sess1" })
      expect(store.stages()[0]!.status).toBe("stuck")
      dispose()
    })
  })

  it("handles fix_stage_inserted — does not throw", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store)
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "review_spec", sessionId: "sess1" })
      expect(() => {
        store.handleEvent({ type: "fix_stage_inserted", pipelineId: "p1", stageId: "s-fix", fixStage: "fix_spec", parentReviewStageId: "s1" })
      }).not.toThrow()
      // Stage is still running — fix_stage_inserted is informational
      expect(store.stages()[0]!.status).toBe("running")
      dispose()
    })
  })

  it("unknown event types are silently ignored", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store)
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm", sessionId: "sess1" })
      // Unknown pipeline event type — should not throw
      expect(() => {
        store.handleEvent({ type: "unknown_event", pipelineId: "p1" } as any)
      }).not.toThrow()
      expect(store.pipelineStatus()).toBe("running")
      dispose()
    })
  })

  it("loads and returns pipeline summaries", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      const summaries = [
        { id: "p1", prompt: "Build a todo app", status: "running" as const, currentStage: "brainstorm" as const, createdAt: 1000, updatedAt: 2000 },
        { id: "p2", prompt: "Refactor auth", status: "completed" as const, currentStage: null, createdAt: 500, updatedAt: 1500 },
      ]
      store.loadSummaries(summaries)
      expect(store.summaries()).toHaveLength(2)
      expect(store.summaries()[0]!.id).toBe("p1")
      dispose()
    })
  })

  it("updates summary status on pipeline_completed", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      store.loadSummaries([
        { id: "p1", prompt: "Build app", status: "running" as const, currentStage: "brainstorm" as const, createdAt: 1000, updatedAt: 2000 },
      ])
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm", sessionId: "sess1" })
      store.handleEvent({ type: "pipeline_completed", pipelineId: "p1" })
      expect(store.summaries()[0]!.status).toBe("completed")
      expect(store.summaries()[0]!.currentStage).toBeNull()
      dispose()
    })
  })

  it("updates summary stage on stage_started", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      store.loadSummaries([
        { id: "p1", prompt: "Build app", status: "running" as const, currentStage: "compile_brainstorm" as const, createdAt: 1000, updatedAt: 2000 },
      ])
      store.handleEvent({ type: "stage_started", pipelineId: "p1", stageId: "s2", stage: "brainstorm", sessionId: "sess2" })
      expect(store.summaries()[0]!.currentStage).toBe("brainstorm")
      dispose()
    })
  })

  it("does not switch active pipeline on events from another pipeline", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store, "p1")

      store.handleEvent({ type: "stage_started", pipelineId: "p2", stageId: "s2", stage: "brainstorm", sessionId: "sess2" })

      expect(store.activePipelineId()).toBe("p1")
      expect(store.stages()).toHaveLength(0)
      dispose()
    })
  })

  it("keeps session-to-pipeline mapping for non-active pipeline events", () => {
    createRoot((dispose) => {
      const store = createPipelineStore()
      activatePipeline(store, "p1")

      store.handleEvent({ type: "stage_started", pipelineId: "p2", stageId: "s2", stage: "brainstorm", sessionId: "sess2" })

      expect(store.getPipelineIdForSession("sess2")).toBe("p2")
      dispose()
    })
  })
})
