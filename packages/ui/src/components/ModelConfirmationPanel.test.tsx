import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { ModelConfirmationPanel } from "./ModelConfirmationPanel.jsx"
import type { Model, PresetRecord, StageModelConfig } from "@atelier/core"

const mockModels = [
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", providerID: "anthropic", limit: { context: 200000, output: 8192 } },
] as Model[]

const mockStages = [
  { stage: "brainstorm", label: "Brainstorm" },
  { stage: "implement", label: "Implement" },
]

describe("ModelConfirmationPanel", () => {
  it("renders header with pipeline type", () => {
    const { container } = render(() => (
      <ModelConfirmationPanel
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
        onSavePreset={async () => {}}
        onLoadPreset={() => {}}
      />
    ))
    expect(container.textContent).toContain("Configure Models for Feature Pipeline")
  })

  it("renders description text", () => {
    const { container } = render(() => (
      <ModelConfirmationPanel
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
        onSavePreset={async () => {}}
        onLoadPreset={() => {}}
      />
    ))
    expect(container.textContent).toContain("Select models for each stage")
  })

  it("renders StageModelPicker internally", () => {
    const { getByText } = render(() => (
      <ModelConfirmationPanel
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
        onSavePreset={async () => {}}
        onLoadPreset={() => {}}
      />
    ))
    expect(getByText("Brainstorm")).toBeTruthy()
    expect(getByText("Implement")).toBeTruthy()
  })

  it("calls onConfirm when confirm button clicked", async () => {
    const onConfirm = vi.fn()
    const { getByText } = render(() => (
      <ModelConfirmationPanel
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
        onSavePreset={async () => {}}
        onLoadPreset={() => {}}
      />
    ))
    await fireEvent.click(getByText("Confirm"))
    expect(onConfirm).toHaveBeenCalled()
  })
})
