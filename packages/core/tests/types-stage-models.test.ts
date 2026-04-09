import { describe, it, expect } from "vitest"
import type { StageModelConfig, PresetRecord, WebviewMessage, HostMessage } from "../src/types.js"

describe("StageModelConfig type", () => {
  it("accepts valid config with all fields", () => {
    const config: StageModelConfig = { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "thinking" }
    expect(config.providerID).toBe("anthropic")
    expect(config.modelID).toBe("claude-sonnet-4")
    expect(config.variant).toBe("thinking")
  })

  it("accepts config without variant", () => {
    const config: StageModelConfig = { providerID: "anthropic", modelID: "claude-sonnet-4" }
    expect(config.variant).toBeUndefined()
  })
})

describe("PresetRecord type", () => {
  it("accepts valid preset with all fields", () => {
    const preset: PresetRecord = {
      id: "preset-123",
      name: "Fast Build",
      pipelineType: "feature",
      stageModels: { brainstorm: { providerID: "anthropic", modelID: "claude-sonnet-4" } },
      createdAt: Date.now(),
    }
    expect(preset.id).toBe("preset-123")
    expect(preset.name).toBe("Fast Build")
    expect(preset.pipelineType).toBe("feature")
  })
})

describe("WebviewMessage stageModels types", () => {
  it("accepts stageModels.confirm message", () => {
    const msg: WebviewMessage = {
      type: "stageModels.confirm",
      pipelineId: "pipe-1",
      stageModels: { brainstorm: { providerID: "anthropic", modelID: "claude-sonnet-4" } },
    }
    expect(msg.type).toBe("stageModels.confirm")
  })

  it("accepts stageModels.update message", () => {
    const msg: WebviewMessage = {
      type: "stageModels.update",
      pipelineId: "pipe-1",
      stage: "brainstorm",
      config: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    }
    expect(msg.type).toBe("stageModels.update")
  })

  it("accepts presets.save message", () => {
    const msg: WebviewMessage = {
      type: "presets.save",
      pipelineType: "feature",
      name: "Fast Build",
      stageModels: { brainstorm: { providerID: "anthropic", modelID: "claude-sonnet-4" } },
    }
    expect(msg.type).toBe("presets.save")
  })
})

describe("HostMessage stageModels types", () => {
  it("accepts stageModels.confirmed message", () => {
    const msg: HostMessage = {
      type: "stageModels.confirmed",
      pipelineId: "pipe-1",
      stageModels: { brainstorm: { providerID: "anthropic", modelID: "claude-sonnet-4" } },
    }
    expect(msg.type).toBe("stageModels.confirmed")
  })

  it("accepts pipeline.type_determined message", () => {
    const msg: HostMessage = {
      type: "pipeline.type_determined",
      pipelineId: "pipe-1",
      pipelineType: "feature",
    }
    expect(msg.type).toBe("pipeline.type_determined")
  })

  it("accepts presets.state message", () => {
    const msg: HostMessage = {
      type: "presets.state",
      pipelineType: "feature",
      presets: [],
    }
    expect(msg.type).toBe("presets.state")
  })
})
