import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createApp } from "../src/app.js"
import { Hono } from "hono"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { PresetStore } from "../src/engine/preset-store.js"
import { createPipelineState } from "../src/orchestration/pipeline-state.js"
import { createEventMerger } from "../src/engine/event-merger.js"

describe("Preset routes", () => {
  let tmpDir: string
  let presetsDir: string
  let app: Hono
  let presetStore: PresetStore
  let pipelineState: ReturnType<typeof createPipelineState>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-presets-"))
    presetsDir = path.join(tmpDir, ".atelier", "presets")
    fs.mkdirSync(presetsDir, { recursive: true })
    fs.mkdirSync(path.join(tmpDir, ".atelier", "pipelines"), { recursive: true })
    
    presetStore = new PresetStore(presetsDir)
    pipelineState = createPipelineState(tmpDir)
    
    const eventMerger = createEventMerger()
    app = createApp({
      registry: {} as any,
      metadataStore: {} as any,
      workspacePath: tmpDir,
      eventMerger,
      getOrchestrator: () => null,
      getStatus: () => "ready",
      getPipelineState: () => pipelineState,
      presetStore,
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("GET /presets/:pipelineType returns empty array initially", async () => {
    const res = await app.request("/presets/feature")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([])
  })

  it("POST /presets/:pipelineType saves a preset", async () => {
    const res = await app.request("/presets/feature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Fast Build",
        stageModels: { brainstorm: { providerID: "anthropic", modelID: "claude-sonnet-4" } },
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe("Fast Build")
    expect(body.pipelineType).toBe("feature")
  })

  it("DELETE /presets/:presetId deletes a preset", async () => {
    const saveRes = await app.request("/presets/feature", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test", stageModels: {} }),
    })
    const preset = await saveRes.json()
    
    const delRes = await app.request(`/presets/${preset.id}`, { method: "DELETE" })
    expect(delRes.status).toBe(200)
    
    const listRes = await app.request("/presets/feature")
    const list = await listRes.json()
    expect(list).toEqual([])
  })

  it("POST /pipelines/:id/stage-models updates stage models", async () => {
    const pipelineId = pipelineState.createPipeline({
      prompt: "Test",
      workspacePath: tmpDir,
      pipelineDir: ".atelier/pipelines/2026-03-01-test",
    })
    
    const res = await app.request(`/pipelines/${pipelineId}/stage-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stageModels: {
          brainstorm: { providerID: "anthropic", modelID: "claude-sonnet-4" },
        },
        confirmed: true,
      }),
    })
    expect(res.status).toBe(200)
    
    const pipeline = pipelineState.getPipeline(pipelineId)
    expect(pipeline!.stageModels["brainstorm"].modelID).toBe("claude-sonnet-4")
    expect(pipeline!.stageModelsConfirmed).toBe(true)
  })

  it("POST /pipelines/:id/stage-models returns 404 for unknown pipeline", async () => {
    const res = await app.request("/pipelines/unknown-id/stage-models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageModels: {}, confirmed: true }),
    })
    expect(res.status).toBe(404)
  })
})
