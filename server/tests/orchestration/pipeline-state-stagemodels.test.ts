import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { createPipelineState, type PipelineState } from "../../src/orchestration/pipeline-state.js"

describe("PipelineState stageModels", () => {
  let workDir: string
  let state: PipelineState

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-stagemodels-test-"))
    fs.mkdirSync(path.join(workDir, ".atelier", "pipelines"), { recursive: true })
    state = createPipelineState(workDir)
  })

  afterEach(async () => {
    await state.flush()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it("defaults stageModels to empty object", () => {
    const id = state.createPipeline({
      prompt: "Test",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-test",
    })
    const pipeline = state.getPipeline(id)
    expect(pipeline!.stageModels).toEqual({})
  })

  it("setStageModel adds entry to stageModels map", () => {
    const id = state.createPipeline({
      prompt: "Test",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-test",
    })
    state.setStageModel(id, "brainstorm", { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "thinking" })
    const pipeline = state.getPipeline(id)
    expect(pipeline!.stageModels["brainstorm"]).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet-4",
      variant: "thinking",
    })
  })

  it("getStageModel returns configured model or falls back to pipeline.model", () => {
    const id = state.createPipeline({
      prompt: "Test",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-test",
      model: { providerID: "openai", modelID: "gpt-4" },
      variant: "default",
    })
    state.setStageModel(id, "brainstorm", { providerID: "anthropic", modelID: "claude-sonnet-4" })
    
    const brainstormModel = state.getStageModel(id, "brainstorm")
    expect(brainstormModel).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
    
    const implementModel = state.getStageModel(id, "implement")
    expect(implementModel).toEqual({ providerID: "openai", modelID: "gpt-4", variant: "default" })
  })

  it("getStageModel returns undefined when no model configured", () => {
    const id = state.createPipeline({
      prompt: "Test",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-test",
    })
    const model = state.getStageModel(id, "brainstorm")
    expect(model).toBeUndefined()
  })

  it("stageModels persists across save/load cycle", async () => {
    const id = state.createPipeline({
      prompt: "Test",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-test",
    })
    state.setStageModel(id, "brainstorm", { providerID: "anthropic", modelID: "claude-sonnet-4" })
    state.setStageModel(id, "implement", { providerID: "openai", modelID: "gpt-4" })
    
    await state.flush()
    
    const reloaded = createPipelineState(workDir)
    const pipeline = reloaded.getPipeline(id)
    expect(pipeline!.stageModels["brainstorm"]).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4" })
    expect(pipeline!.stageModels["implement"]).toEqual({ providerID: "openai", modelID: "gpt-4" })
  })

  it("setStageModelConfirmed marks pipeline as confirmed", () => {
    const id = state.createPipeline({
      prompt: "Test",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-test",
    })
    expect(state.isStageModelsConfirmed(id)).toBe(false)
    
    state.setStageModelConfirmed(id, true)
    expect(state.isStageModelsConfirmed(id)).toBe(true)
  })

  it("confirmed flag persists across restart", async () => {
    const id = state.createPipeline({
      prompt: "Test",
      workspacePath: workDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-test",
    })
    state.setStageModelConfirmed(id, true)
    
    await state.flush()
    
    const reloaded = createPipelineState(workDir)
    expect(reloaded.isStageModelsConfirmed(id)).toBe(true)
  })
})
