import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { createPipelineState, type PipelineState } from "../../src/orchestration/pipeline-state.js"

describe("PipelineState", () => {
  let workDir: string
  let pipelinesDir: string
  let state: PipelineState

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-state-test-"))
    pipelinesDir = path.join(workDir, ".atelier", "pipelines")
    fs.mkdirSync(pipelinesDir, { recursive: true })
    state = createPipelineState(workDir)
  })

  afterEach(async () => {
    await state.flush()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it("creates a pipeline with state file", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    expect(id).toBeTruthy()
    const pipeline = state.getPipeline(id)
    expect(pipeline).not.toBeNull()
    expect(pipeline!.prompt).toBe("Build auth")
    expect(pipeline!.status).toBe("running")
  })

  it("persists sourceSessionId when provided", async () => {
    const id = state.createPipeline({
      prompt: "Fork test",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-fork",
      sourceSessionId: "sess-abc-123",
    })
    const pipeline = state.getPipeline(id)
    expect(pipeline!.sourceSessionId).toBe("sess-abc-123")

    // Verify persistence survives flush + reload
    await state.flush()
    const reloaded = createPipelineState(workDir)
    const rehydrated = reloaded.getPipeline(id)
    expect(rehydrated!.sourceSessionId).toBe("sess-abc-123")
  })

  it("defaults sourceSessionId to null when omitted", () => {
    const id = state.createPipeline({
      prompt: "No fork",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-nofork",
    })
    const pipeline = state.getPipeline(id)
    expect(pipeline!.sourceSessionId).toBeNull()
  })

  it("lists pipelines by scanning directories", () => {
    const id1 = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    state.completePipeline(id1)
    state.createPipeline({
      prompt: "Build cache",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-cache",
    })
    const list = state.listPipelines()
    expect(list).toHaveLength(2)
  })

  it("adds a stage and completes it", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const stageId = state.createStage({ pipelineId: id, stage: "brainstorm", sessionId: "sess1" })
    state.completeStage(id, stageId, { outputPath: "spec.md" })
    const detail = state.getPipeline(id)
    const stage = detail!.stages.find(s => s.id === stageId)
    expect(stage!.status).toBe("completed")
    expect(stage!.outputPath).toBe("spec.md")
  })

  it("failPipeline sets status to stuck (not failed)", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const stageId = state.createStage({ pipelineId: id, stage: "brainstorm" })
    state.setStageStuck(id, stageId)
    state.setStageError(id, stageId, "Agent crashed")
    state.failPipeline(id, "Agent crashed")
    const pipeline = state.getPipeline(id)
    expect(pipeline!.status).toBe("stuck")
    expect(pipeline!.error).toBe("Agent crashed")
    expect(pipeline!.completedAt).toBeNull()
    const stage = pipeline!.stages.find(s => s.id === stageId)
    expect(stage!.status).toBe("stuck")
  })

  it("sets and clears interrupted flag on stage", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const stageId = state.createStage({ pipelineId: id, stage: "brainstorm", sessionId: "sess1" })
    state.setStageInterrupted(id, stageId, true)
    let detail = state.getPipeline(id)
    expect(detail!.stages[0].interrupted).toBe(true)

    state.setStageInterrupted(id, stageId, false)
    detail = state.getPipeline(id)
    expect(detail!.stages[0].interrupted).toBe(false)
  })

  it("deletes pipeline directory and returns session IDs", async () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    state.createStage({ pipelineId: id, stage: "compile_brainstorm", sessionId: "s1" })
    state.createStage({ pipelineId: id, stage: "brainstorm", sessionId: "s2" })
    state.completePipeline(id)
    const sessionIds = state.deletePipeline(id)
    expect(sessionIds).toEqual(["s1", "s2"])
    expect(state.getPipeline(id)).toBeNull()
    // Flush async writes before checking disk
    await state.flush()
    expect(fs.existsSync(path.join(workDir, ".atelier/pipelines/2026-03-01-auth"))).toBe(false)
  })

  it("allows creating a second pipeline while one is running", () => {
    const id1 = state.createPipeline({
      prompt: "First",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-first",
    })
    const id2 = state.createPipeline({
      prompt: "Second",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-second",
    })
    expect(id1).not.toBe(id2)
    const p1 = state.getPipeline(id1)
    const p2 = state.getPipeline(id2)
    expect(p1?.status).toBe("running")
    expect(p2?.status).toBe("running")
  })

  it("getRunningPipelines returns all running pipelines", () => {
    const id1 = state.createPipeline({
      prompt: "First",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-first",
    })
    const id2 = state.createPipeline({
      prompt: "Second",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-second",
    })
    const running = (state as any).getRunningPipelines()
    expect(running).toHaveLength(2)
    expect(running.map((p: any) => p.id)).toContain(id1)
    expect(running.map((p: any) => p.id)).toContain(id2)
  })

  it("getRunningPipelines excludes completed pipelines", () => {
    const id1 = state.createPipeline({
      prompt: "First",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-first",
    })
    const id2 = state.createPipeline({
      prompt: "Second",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-second",
    })
    state.completePipeline(id1)
    const running = (state as any).getRunningPipelines()
    expect(running).toHaveLength(1)
    expect(running[0].id).toBe(id2)
  })

  it("markCrashedPipelinesAsIdle marks running as idle", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    state.markCrashedPipelinesAsIdle()
    const pipeline = state.getPipeline(id)
    expect(pipeline!.status).toBe("idle")
  })

  it("markCrashedPipelinesAsIdle also fails running stages", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const stageId = state.createStage({ pipelineId: id, stage: "brainstorm", sessionId: "sess1" })
    state.markCrashedPipelinesAsIdle()

    const pipeline = state.getPipeline(id)
    expect(pipeline!.status).toBe("idle")
    const stage = pipeline!.stages.find(s => s.id === stageId)
    expect(stage!.status).toBe("idle")
    expect(stage!.error).toBeNull()
  })

  it("getAllPipelineSessionIds collects session IDs from all stages", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    state.createStage({ pipelineId: id, stage: "compile_brainstorm", sessionId: "s1" })
    state.createStage({ pipelineId: id, stage: "brainstorm", sessionId: "s2" })
    const ids = state.getAllPipelineSessionIds()
    expect(ids).toContain("s1")
    expect(ids).toContain("s2")
  })

  it("survives crash mid-write (atomic rename)", async () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    // Flush async writes before checking disk
    await state.flush()
    // Verify .tmp file is not present after write
    const dir = path.join(workDir, ".atelier/pipelines/2026-03-01-auth")
    expect(fs.existsSync(path.join(dir, "pipeline-state.json"))).toBe(true)
    expect(fs.existsSync(path.join(dir, "pipeline-state.json.tmp"))).toBe(false)
  })

  it("recovers from crash that left only .tmp file (no .json)", () => {
    // Simulate crash: create .tmp without corresponding .json
    const dir = path.join(workDir, ".atelier/pipelines/2026-03-01-orphan")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "pipeline-state.json.tmp"), JSON.stringify({
      id: "orphan-id", prompt: "Orphan", status: "running", stages: [],
    }))
    // Re-create state to trigger recovery scan
    const freshState = createPipelineState(workDir)
    // .tmp should be cleaned up or adopted
    const list = freshState.listPipelines()
    // Orphan should not appear in listing (incomplete write = discard)
    expect(list.find(p => p.id === "orphan-id")).toBeUndefined()
    expect(fs.existsSync(path.join(dir, "pipeline-state.json.tmp"))).toBe(false)
  })

  it("handles corrupt JSON in state file gracefully", () => {
    // Create a pipeline directory with invalid JSON
    const dir = path.join(workDir, ".atelier/pipelines/2026-03-01-corrupt")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "pipeline-state.json"), "{ invalid json {{")
    const freshState = createPipelineState(workDir)
    // Should not throw — corrupt pipelines are skipped in listing
    const list = freshState.listPipelines()
    expect(list.find(p => p.prompt === "corrupt")).toBeUndefined()
  })

  it("handles empty pipeline directory (no state file)", () => {
    const dir = path.join(workDir, ".atelier/pipelines/2026-03-01-empty")
    fs.mkdirSync(dir, { recursive: true })
    const freshState = createPipelineState(workDir)
    const list = freshState.listPipelines()
    // Empty directory is silently skipped
    expect(list).toHaveLength(0)
  })

  it("creates pipeline without pipelineDir (bootstrap case)", async () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      // No pipelineDir — slug unknown until compile_brainstorm completes
    })
    expect(id).toBeTruthy()
    const pipeline = state.getPipeline(id)
    expect(pipeline).not.toBeNull()
    // State stored in central index until pipelineDir is set
    expect(pipeline!.pipelineDir).toBe("")

    // After compile generates slug, set pipelineDir
    state.updatePipelineDir(id, ".atelier/pipelines/2026-03-01-auth")
    const updated = state.getPipeline(id)
    expect(updated!.pipelineDir).toBe(".atelier/pipelines/2026-03-01-auth")
    // Flush async writes before checking disk
    await state.flush()
    expect(fs.existsSync(path.join(workDir, ".atelier/pipelines/2026-03-01-auth/pipeline-state.json"))).toBe(true)
  })

  it("pipeline data survives process restart (re-loaded from disk)", async () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const stageId = state.createStage({ pipelineId: id, stage: "brainstorm", sessionId: "sess1" })
    state.completeStage(id, stageId, { outputPath: "spec.md" })

    // Flush async writes before reading from disk with fresh instance
    await state.flush()

    // Create a fresh instance reading from disk
    const freshState = createPipelineState(workDir)
    const pipeline = freshState.getPipeline(id)
    expect(pipeline).not.toBeNull()
    expect(pipeline!.prompt).toBe("Build auth")
    expect(pipeline!.stages).toHaveLength(1)
    expect(pipeline!.stages[0].outputPath).toBe("spec.md")
  })

  it("rejects path traversal in pipelineDir", () => {
    expect(() => state.createPipeline({
      prompt: "Test",
      workspacePath: workDir,
      pipelineDir: "../../etc/evil",
    })).toThrow("Pipeline directory must be within workspace")
  })

  it("stage supports stuck status", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const stageId = state.createStage({ pipelineId: id, stage: "review_spec", sessionId: "s1" })
    state.setStageStuck(id, stageId)
    const detail = state.getPipeline(id)
    const stage = detail!.stages.find(s => s.id === stageId)!
    expect(stage.status).toBe("stuck")
  })

  it("stage stores verdict", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const stageId = state.createStage({ pipelineId: id, stage: "review_spec", sessionId: "s1" })
    state.completeStage(id, stageId, { outputPath: "review.md", verdict: "has_issues" })
    const detail = state.getPipeline(id)
    expect(detail!.stages[0].verdict).toBe("has_issues")
  })

  it("stage stores dynamicallyInserted and parentReviewStageId", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const reviewStageId = state.createStage({ pipelineId: id, stage: "review_spec", sessionId: "s1" })
    state.completeStage(id, reviewStageId, { verdict: "has_issues" })
    const fixStageId = state.createStage({
      pipelineId: id,
      stage: "fix_spec",
      sessionId: "s2",
      dynamicallyInserted: true,
      parentReviewStageId: reviewStageId,
    })
    const detail = state.getPipeline(id)
    const fixStage = detail!.stages.find(s => s.id === fixStageId)!
    expect(fixStage.dynamicallyInserted).toBe(true)
    expect(fixStage.parentReviewStageId).toBe(reviewStageId)
  })

  it("pipeline stores stepCounter", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const pipeline = state.getPipeline(id)!
    expect(pipeline.stepCounter).toBe(0)
    state.incrementStepCounter(id)
    expect(state.getPipeline(id)!.stepCounter).toBe(1)
    state.incrementStepCounter(id)
    expect(state.getPipeline(id)!.stepCounter).toBe(2)
  })

  it("incrementStepCounter returns the new counter value", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    expect(state.incrementStepCounter(id)).toBe(1)
    expect(state.incrementStepCounter(id)).toBe(2)
    expect(state.incrementStepCounter(id)).toBe(3)
  })

  it("setStageStatus transitions stage status", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const stageId = state.createStage({ pipelineId: id, stage: "review_spec", sessionId: "s1" })
    state.setStageStuck(id, stageId)
    expect(state.getPipeline(id)!.stages[0].status).toBe("stuck")

    state.setStageStatus(id, stageId, "running")
    expect(state.getPipeline(id)!.stages[0].status).toBe("running")
  })

  it("restart from review_spec copies preceding stages as skipped", () => {
    const id1 = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
      type: "feature",
    })
    const s1 = state.createStage({ pipelineId: id1, stage: "compile_brainstorm", sessionId: "s1" })
    state.completeStage(id1, s1)
    const s2 = state.createStage({ pipelineId: id1, stage: "brainstorm", sessionId: "s2" })
    state.completeStage(id1, s2)
    const s3 = state.createStage({ pipelineId: id1, stage: "review_spec", sessionId: "s3" })
    state.completeStage(id1, s3)
    state.completePipeline(id1)

    const id2 = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth-2",
      fromPipelineId: id1,
      fromStage: "review_spec",
      type: "feature",
    })
    const detail = state.getPipeline(id2)!
    const skipped = detail.stages.filter(s => s.status === "skipped")
    expect(skipped.map(s => s.stage)).toContain("compile_brainstorm")
    expect(skipped.map(s => s.stage)).toContain("brainstorm")
    expect(skipped.map(s => s.stage)).not.toContain("review_spec")
  })

  it("restart skips dynamically inserted fixer stages from source pipeline", () => {
    const id1 = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
      type: "feature",
    })
    const s1 = state.createStage({ pipelineId: id1, stage: "compile_brainstorm", sessionId: "s1" })
    state.completeStage(id1, s1)
    const s2 = state.createStage({ pipelineId: id1, stage: "brainstorm", sessionId: "s2" })
    state.completeStage(id1, s2)
    const s3 = state.createStage({ pipelineId: id1, stage: "review_spec", sessionId: "s3" })
    state.completeStage(id1, s3, { verdict: "has_issues" })
    const fixId = state.createStage({
      pipelineId: id1, stage: "fix_spec", sessionId: "s4",
      dynamicallyInserted: true, parentReviewStageId: s3,
    })
    state.completeStage(id1, fixId)
    const s5 = state.createStage({ pipelineId: id1, stage: "compile_plan", sessionId: "s5" })
    state.completeStage(id1, s5)
    state.completePipeline(id1)

    const id2 = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth-3",
      fromPipelineId: id1,
      fromStage: "compile_plan",
      type: "feature",
    })
    const detail = state.getPipeline(id2)!
    const stageNames = detail.stages.map(s => s.stage)
    // Preceding topology stages should be skipped
    expect(stageNames).toContain("compile_brainstorm")
    expect(stageNames).toContain("brainstorm")
    expect(stageNames).toContain("review_spec")
    // Dynamically inserted fix_spec should NOT be copied
    expect(stageNames).not.toContain("fix_spec")
    // compile_plan is the restart point — should NOT be in skipped
    expect(stageNames).not.toContain("compile_plan")
  })

  it("handles restart with fromPipelineId and fromStage", () => {
    const id1 = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const s1 = state.createStage({ pipelineId: id1, stage: "compile_brainstorm", sessionId: "s1" })
    state.completeStage(id1, s1, { compiledPromptPath: "compiled.md" })
    const s2 = state.createStage({ pipelineId: id1, stage: "brainstorm", sessionId: "s2" })
    state.completeStage(id1, s2, { outputPath: "spec.md" })
    state.completePipeline(id1)

    const id2 = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth-2",
      fromPipelineId: id1,
      fromStage: "brainstorm",
    })
    const detail = state.getPipeline(id2)
    // compile_brainstorm should be copied as skipped
    const skipped = detail!.stages.find(s => s.stage === "compile_brainstorm")
    expect(skipped!.status).toBe("skipped")
  })

  it("full suspend/restart cycle: interrupt -> crash -> restore -> restart", () => {
    const id = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
    })
    const stage1 = state.createStage({ pipelineId: id, stage: "compile_brainstorm", sessionId: "s1" })
    state.completeStage(id, stage1, { compiledPromptPath: "compiled.md" })
    const stage2 = state.createStage({ pipelineId: id, stage: "brainstorm", sessionId: "s2" })
    state.completeStage(id, stage2, { outputPath: "spec.md" })
    state.createStage({ pipelineId: id, stage: "implement", sessionId: "s3" })

    state.markCrashedPipelinesAsIdle()

    const pipeline = state.getPipeline(id)
    expect(pipeline!.status).toBe("idle")
    expect(pipeline!.stages[0].status).toBe("completed")
    expect(pipeline!.stages[1].status).toBe("completed")
    expect(pipeline!.stages[2].status).toBe("idle")
    expect(pipeline!.stages[2].error).toBeNull()
    expect(pipeline!.stages[0].sessionId).toBe("s1")
    expect(pipeline!.stages[1].sessionId).toBe("s2")
    expect(pipeline!.stages[2].sessionId).toBe("s3")

    const id2 = state.createPipeline({
      prompt: "Build auth",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-auth",
      fromPipelineId: id,
      fromStage: "implement",
    })
    const pipeline2 = state.getPipeline(id2)
    expect(pipeline2!.status).toBe("running")
    const skipped = pipeline2!.stages.filter(s => s.status === "skipped")
    expect(skipped.length).toBeGreaterThanOrEqual(2)
    expect(state.getPipeline(id)!.status).toBe("idle")
  })

  describe("git metadata", () => {
    it("new pipelines have null git fields", () => {
      const id = state.createPipeline({
        prompt: "Build auth",
        workspacePath: workDir,
        pipelineDir: ".atelier/pipelines/2026-03-01-auth-1234",
      })
      const p = state.getPipeline(id)!
      expect(p.gitBranch).toBeNull()
      expect(p.gitBaseBranch).toBeNull()
      expect(p.gitBaseCommit).toBeNull()
    })

    it("setGitMetadata stores branch info and persists", async () => {
      const id = state.createPipeline({
        prompt: "Build auth",
        workspacePath: workDir,
        pipelineDir: ".atelier/pipelines/2026-03-01-auth-1234",
      })
      state.setGitMetadata(id, {
        gitBranch: "atelier/auth-api-1234",
        gitBaseBranch: "main",
        gitBaseCommit: "abc123def456",
      })
      const p = state.getPipeline(id)!
      expect(p.gitBranch).toBe("atelier/auth-api-1234")
      expect(p.gitBaseBranch).toBe("main")
      expect(p.gitBaseCommit).toBe("abc123def456")

      // Verify persistence
      await state.flush()
      const reloaded = createPipelineState(workDir)
      const p2 = reloaded.getPipeline(id)!
      expect(p2.gitBranch).toBe("atelier/auth-api-1234")
    })

    it("setStageCommit stores SHA on a stage", () => {
      const id = state.createPipeline({
        prompt: "Build auth",
        workspacePath: workDir,
        pipelineDir: ".atelier/pipelines/2026-03-01-auth-1234",
      })
      const stageId = state.createStage({ pipelineId: id, stage: "implement" })
      state.setStageCommit(id, stageId, "deadbeef1234567890")
      const p = state.getPipeline(id)!
      const stage = p.stages.find(s => s.id === stageId)!
      expect(stage.commitSha).toBe("deadbeef1234567890")
    })

    it("backwards compatibility: loading state without git fields defaults to null", async () => {
      const id = state.createPipeline({
        prompt: "Legacy pipeline",
        workspacePath: workDir,
        pipelineDir: ".atelier/pipelines/2026-03-01-legacy-aaaa",
      })
      await state.flush()

      const stateFile = path.join(workDir, ".atelier/pipelines/2026-03-01-legacy-aaaa/pipeline-state.json")
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf-8"))
      delete raw.gitBranch
      delete raw.gitBaseBranch
      delete raw.gitBaseCommit
      fs.writeFileSync(stateFile, JSON.stringify(raw, null, 2))

      const reloaded = createPipelineState(workDir)
      const p = reloaded.getPipeline(id)!
      // Should not crash, fields should be null/undefined
      expect(p.gitBranch ?? null).toBeNull()
    })
  })

  describe("assignedOutputPath persistence", () => {
    it("persists assignedOutputPath distinct from signaled outputPath", async () => {
      const id = state.createPipeline({
        prompt: "Build auth",
        workspacePath: workDir,
        pipelineDir: ".atelier/pipelines/2026-03-01-auth",
      })
      const stageId = state.createStage({
        pipelineId: id,
        stage: "write_plan",
        sessionId: "sess1",
        assignedOutputPath: ".atelier/pipelines/2026-03-01-auth/07-auth-plan.md",
      })
      state.completeStage(id, stageId, { outputPath: ".atelier/plans/plan.md" })
      await state.flush()

      const reloaded = createPipelineState(workDir)
      const detail = reloaded.getPipeline(id)
      const stage = detail!.stages.find((s) => s.id === stageId)!
      expect(stage.assignedOutputPath).toBe(".atelier/pipelines/2026-03-01-auth/07-auth-plan.md")
      expect(stage.outputPath).toBe(".atelier/plans/plan.md")
    })

    it("loads legacy state files without assignedOutputPath", async () => {
      const legacyDir = path.join(workDir, ".atelier/pipelines/2026-03-01-legacy")
      fs.mkdirSync(legacyDir, { recursive: true })
      fs.writeFileSync(path.join(legacyDir, "pipeline-state.json"), JSON.stringify({
        id: "legacy-id",
        prompt: "Legacy",
        workspacePath: workDir,
        status: "running",
        currentStage: "write_plan",
        type: "feature",
        fromPipelineId: null,
        fromStage: null,
        model: null,
        variant: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        completedAt: null,
        error: null,
        pipelineDir: ".atelier/pipelines/2026-03-01-legacy",
        stepCounter: 1,
        stages: [{
          id: "stage-legacy",
          stage: "write_plan",
          sessionId: "sess-legacy",
          status: "running",
          compiledPromptPath: null,
          outputPath: null,
          interrupted: false,
          error: null,
          startedAt: Date.now(),
          completedAt: null,
        }],
      }, null, 2))

      const reloaded = createPipelineState(workDir)
      const detail = reloaded.getPipeline("legacy-id")
      expect(detail).toBeTruthy()
      expect(detail!.stages[0].assignedOutputPath ?? null).toBeNull()
    })
  })
})
