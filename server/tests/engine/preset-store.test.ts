import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { PresetStore } from "../../src/engine/preset-store.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

describe("PresetStore", () => {
  let tmpDir: string
  let presetsDir: string
  let store: PresetStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "presets-"))
    presetsDir = path.join(tmpDir, ".atelier", "presets")
    fs.mkdirSync(presetsDir, { recursive: true })
    store = new PresetStore(presetsDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("lists empty presets initially", async () => {
    const list = await store.listPresets("feature")
    expect(list).toEqual([])
  })

  it("saves a preset and lists it", async () => {
    const preset = await store.savePreset("feature", "Fast Build", {
      brainstorm: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    })
    expect(preset.name).toBe("Fast Build")
    expect(preset.pipelineType).toBe("feature")
    
    const list = await store.listPresets("feature")
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe("Fast Build")
  })

  it("saves preset to correct subdirectory by pipeline type", async () => {
    await store.savePreset("feature", "Feature Preset", {})
    await store.savePreset("task", "Task Preset", {})
    
    expect(fs.existsSync(path.join(presetsDir, "feature"))).toBe(true)
    expect(fs.existsSync(path.join(presetsDir, "task"))).toBe(true)
    
    const featureList = await store.listPresets("feature")
    const taskList = await store.listPresets("task")
    expect(featureList).toHaveLength(1)
    expect(taskList).toHaveLength(1)
  })

  it("overwrites preset with same name", async () => {
    await store.savePreset("feature", "Fast Build", {
      brainstorm: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    })
    await store.savePreset("feature", "Fast Build", {
      brainstorm: { providerID: "openai", modelID: "gpt-4" },
    })
    
    const list = await store.listPresets("feature")
    expect(list).toHaveLength(1)
    expect(list[0].stageModels["brainstorm"].modelID).toBe("gpt-4")
  })

  it("deletes a preset", async () => {
    const preset = await store.savePreset("feature", "Fast Build", {})
    await store.deletePreset(preset.id)
    
    const list = await store.listPresets("feature")
    expect(list).toEqual([])
  })

  it("handles missing preset file on delete gracefully", async () => {
    await expect(store.deletePreset("nonexistent-id")).resolves.not.toThrow()
  })

  it("ignores corrupt preset files", async () => {
    const featureDir = path.join(presetsDir, "feature")
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, "corrupt.json"), "{ invalid json")
    
    const list = await store.listPresets("feature")
    expect(list).toEqual([])
  })

  it("generates unique IDs for presets", async () => {
    const p1 = await store.savePreset("feature", "Preset 1", {})
    const p2 = await store.savePreset("feature", "Preset 2", {})
    expect(p1.id).not.toBe(p2.id)
  })

  it("persists preset to disk", async () => {
    await store.savePreset("feature", "Fast Build", {
      brainstorm: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    })
    
    const store2 = new PresetStore(presetsDir)
    const list = await store2.listPresets("feature")
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe("Fast Build")
  })
})
