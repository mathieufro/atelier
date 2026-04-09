// T17: These are type regression guards — they verify that the TypeScript type definitions
// compile and accept the expected shapes. They have no runtime assertions beyond type checking.
import { describe, it, expect } from "vitest"
import type {
  PipelineStage,
  PipelineStatus,
  StageStatus,
  PipelineEvent,
  ConnectionEvent,
  UnifiedEvent,
  PipelineSummary,
  PipelineDetail,
  StageDetail,
} from "../src/types.js"

describe("Pipeline types", () => {
  it("PipelineStage accepts all valid stage names", () => {
    const stages: PipelineStage[] = [
      "compile_brainstorm",
      "brainstorm",
      "compile_plan",
      "write_plan",
      "implement",
    ]
    expect(stages).toHaveLength(5)
  })

  it("PipelineStatus accepts valid statuses including stuck", () => {
    const statuses: PipelineStatus[] = ["running", "completed", "idle", "stuck"]
    expect(statuses).toHaveLength(4)
  })

  it("StageStatus accepts all 5 values including stuck and idle", () => {
    const statuses: StageStatus[] = ["running", "completed", "skipped", "stuck", "idle"]
    expect(statuses).toHaveLength(5)
  })

  it("PipelineEvent discriminated union covers all event types", () => {
    const events: PipelineEvent[] = [
      { type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm", sessionId: "sess1" },
      { type: "stage_completed", pipelineId: "p1", stageId: "s1", outputPath: "/out.md" },
      { type: "stage_interrupted", pipelineId: "p1", stageId: "s1", sessionId: "sess1" },
      { type: "stage_resumed", pipelineId: "p1", stageId: "s1", sessionId: "sess1" },
      { type: "pipeline_completed", pipelineId: "p1" },
    ]
    expect(events).toHaveLength(5)
  })

  it("ConnectionEvent covers all connection event types", () => {
    const events: ConnectionEvent[] = [
      { type: "connection_lost" },
      { type: "connection_restored" },
      { type: "full_refresh_required" },
    ]
    expect(events).toHaveLength(3)
  })

  it("PipelineSummary has required fields", () => {
    const summary: PipelineSummary = {
      id: "p1",
      prompt: "build a todo app",
      status: "running",
      currentStage: "brainstorm",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    expect(summary.id).toBe("p1")
  })

  it("PipelineDetail includes stages array and new fields", () => {
    const detail: PipelineDetail = {
      id: "p1",
      prompt: "build a todo app",
      status: "running",
      currentStage: "brainstorm",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      type: "feature",
      stages: [{
        id: "s1",
        stage: "brainstorm",
        sessionId: "sess1",
        status: "running",
        interrupted: false,
        startedAt: Date.now(),
      }],
    }
    expect(detail.stages).toHaveLength(1)
  })

  it("HostMessage includes unified event variant", () => {
    const msg: import("../src/types.js").HostMessage = {
      type: "event",
      event: { type: "pipeline_completed", pipelineId: "p1", seq: 1 },
    }
    expect(msg.type).toBe("event")
  })

  it("UnifiedEvent accepts pipeline events with seq", () => {
    const event: UnifiedEvent = {
      type: "stage_started",
      pipelineId: "p1",
      stageId: "s1",
      stage: "brainstorm",
      seq: 1,
    }
    expect(event.seq).toBe(1)
  })

  it("UnifiedEvent accepts forwarded OpenCode events", () => {
    const event: UnifiedEvent = {
      type: "message.updated",
      seq: 5,
      sessionID: "s1",
      properties: {},
    }
    expect(event.type).toBe("message.updated")
  })
})

describe("Phase 3a shared types", () => {
  it("PipelineStage includes all topology stages", () => {
    const stages: PipelineStage[] = [
      "compile_brainstorm", "brainstorm", "review_spec", "fix_spec",
      "establish_conventions", "compile_plan", "write_plan", "review_plan",
      "fix_plan", "implement", "review_code", "fix_code", "simplify",
    ]
    // Type assertion — if any string above is not in PipelineStage union, this won't compile
    expect(stages).toHaveLength(13)
  })

  it("StageStatus includes stuck and idle", () => {
    const statuses: StageStatus[] = ["running", "completed", "skipped", "stuck", "idle"]
    expect(statuses).toHaveLength(5)
  })

  it("PipelineEvent includes new event types", () => {
    const stuckEvent: PipelineEvent = {
      type: "stuck_escalation",
      pipelineId: "p1",
      stageId: "s1",
      stage: "review_spec",
      sessionId: "sess1",
      reviewOutputPath: "review.md",
    }
    const fixEvent: PipelineEvent = {
      type: "fix_stage_inserted",
      pipelineId: "p1",
      stageId: "s1",
      fixStage: "fix_spec",
      parentReviewStageId: "r1",
    }
    expect(stuckEvent.type).toBe("stuck_escalation")
    expect(fixEvent.type).toBe("fix_stage_inserted")
  })
})
