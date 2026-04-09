import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { StageModelPicker } from "./StageModelPicker.jsx"
import type { Model, FavoriteRecord, PresetRecord, StageModelConfig } from "@atelier/core"

const mockModels = [
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", providerID: "anthropic", limit: { context: 200000, output: 8192 } },
  { id: "gpt-4", name: "GPT-4", providerID: "openai", limit: { context: 128000, output: 4096 } },
] as Model[]

const mockStages = [
  { stage: "brainstorm", label: "Brainstorm" },
  { stage: "review_spec", label: "Review Spec" },
  { stage: "implement", label: "Implement" },
]

describe("StageModelPicker", () => {
  it("renders all stages from topology", () => {
    const { container } = render(() => (
      <StageModelPicker
        pipelineType="feature"
        stages={mockStages}
        stageModels={{}}
        models={mockModels}
        favorites={[]}
        presets={[]}
        defaultModel={{ providerID: "anthropic", modelID: "claude-sonnet-4" }}
        completedStages={new Set()}
        onConfirm={() => {}}
        onStageModelChange={() => {}}
        onSavePreset={() => {}}
        onLoadPreset={() => {}}
      />
    ))
    expect(container.textContent).toContain("Brainstorm")
    expect(container.textContent).toContain("Review Spec")
    expect(container.textContent).toContain("Implement")
  })

  it("shows default model in all stage selectors initially", () => {
    const { getAllByText } = render(() => (
      <StageModelPicker
        pipelineType="feature"
        stages={mockStages}
        stageModels={{}}
        models={mockModels}
        favorites={[]}
        presets={[]}
        defaultModel={{ providerID: "anthropic", modelID: "claude-sonnet-4" }}
        completedStages={new Set()}
        onConfirm={() => {}}
        onStageModelChange={() => {}}
        onSavePreset={() => {}}
        onLoadPreset={() => {}}
      />
    ))
    const sonnetLabels = getAllByText("Claude Sonnet 4")
    expect(sonnetLabels.length).toBeGreaterThanOrEqual(3)
  })

  it("calls onStageModelChange when model selected for a stage", async () => {
    const onStageModelChange = vi.fn()
    const { getByText, getAllByText } = render(() => (
      <StageModelPicker
        pipelineType="feature"
        stages={mockStages}
        stageModels={{}}
        models={mockModels}
        favorites={[]}
        presets={[]}
        defaultModel={{ providerID: "anthropic", modelID: "claude-sonnet-4" }}
        completedStages={new Set()}
        onConfirm={() => {}}
        onStageModelChange={onStageModelChange}
        onSavePreset={() => {}}
        onLoadPreset={() => {}}
      />
    ))
    // Click first model selector to open dropdown
    const modelButtons = getAllByText("Claude Sonnet 4")
    await fireEvent.click(modelButtons[0]!)
    // Select GPT-4
    await fireEvent.click(getByText("GPT-4"))
    expect(onStageModelChange).toHaveBeenCalledWith("brainstorm", { providerID: "openai", modelID: "gpt-4" })
  })

  it("disables selector for completed stages", () => {
    const { container } = render(() => (
      <StageModelPicker
        pipelineType="feature"
        stages={mockStages}
        stageModels={{}}
        models={mockModels}
        favorites={[]}
        presets={[]}
        defaultModel={{ providerID: "anthropic", modelID: "claude-sonnet-4" }}
        completedStages={new Set(["brainstorm"])}
        onConfirm={() => {}}
        onStageModelChange={() => {}}
        onSavePreset={() => {}}
        onLoadPreset={() => {}}
      />
    ))
    const brainstormRow = container.querySelector("[data-stage='brainstorm']")
    expect(brainstormRow?.querySelector("span.text-vsc-disabled-fg")).toBeTruthy()
  })

  it("shows preset dropdown and calls onLoadPreset", async () => {
    const onLoadPreset = vi.fn()
    const presets: PresetRecord[] = [
      { id: "p1", name: "Fast Build", pipelineType: "feature", stageModels: {}, createdAt: Date.now() },
    ]
    const { getByText } = render(() => (
      <StageModelPicker
        pipelineType="feature"
        stages={mockStages}
        stageModels={{}}
        models={mockModels}
        favorites={[]}
        presets={presets}
        defaultModel={{ providerID: "anthropic", modelID: "claude-sonnet-4" }}
        completedStages={new Set()}
        onConfirm={() => {}}
        onStageModelChange={() => {}}
        onSavePreset={() => {}}
        onLoadPreset={onLoadPreset}
      />
    ))
    await fireEvent.click(getByText("Load preset"))
    await fireEvent.click(getByText("Fast Build"))
    expect(onLoadPreset).toHaveBeenCalledWith(presets[0])
  })

  it("calls onSavePreset with current stage models", async () => {
    const onSavePreset = vi.fn()
    const stageModels: Record<string, StageModelConfig> = {
      brainstorm: { providerID: "openai", modelID: "gpt-4" },
    }
    const { getByPlaceholderText, getByText } = render(() => (
      <StageModelPicker
        pipelineType="feature"
        stages={mockStages}
        stageModels={stageModels}
        models={mockModels}
        favorites={[]}
        presets={[]}
        defaultModel={{ providerID: "anthropic", modelID: "claude-sonnet-4" }}
        completedStages={new Set()}
        onConfirm={() => {}}
        onStageModelChange={() => {}}
        onSavePreset={onSavePreset}
        onLoadPreset={() => {}}
      />
    ))
    await fireEvent.click(getByText("Save preset"))
    const input = getByPlaceholderText("Preset name…")
    await fireEvent.input(input, { target: { value: "My Preset" } })
    await fireEvent.click(getByText("Save"))
    expect(onSavePreset).toHaveBeenCalledWith("My Preset", stageModels)
  })

  it("calls onConfirm when confirm button clicked", async () => {
    const onConfirm = vi.fn()
    const { getByText } = render(() => (
      <StageModelPicker
        pipelineType="feature"
        stages={mockStages}
        stageModels={{}}
        models={mockModels}
        favorites={[]}
        presets={[]}
        defaultModel={{ providerID: "anthropic", modelID: "claude-sonnet-4" }}
        completedStages={new Set()}
        onConfirm={onConfirm}
        onStageModelChange={() => {}}
        onSavePreset={() => {}}
        onLoadPreset={() => {}}
      />
    ))
    await fireEvent.click(getByText("Confirm"))
    expect(onConfirm).toHaveBeenCalled()
  })
})
