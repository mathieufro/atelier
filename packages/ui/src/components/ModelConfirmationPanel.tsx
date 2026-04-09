import { Show } from "solid-js"
import type { Model, FavoriteRecord, PresetRecord, StageModelConfig } from "@atelier/core"
import { StageModelPicker } from "./StageModelPicker.jsx"

interface StageInfo {
  stage: string
  label: string
}

interface ModelConfirmationPanelProps {
  pipelineType: string
  stages: StageInfo[]
  stageModels: Record<string, StageModelConfig>
  models: Model[]
  favorites: FavoriteRecord[]
  presets: PresetRecord[]
  defaultModel: StageModelConfig
  completedStages: Set<string>
  onConfirm: () => void
  onStageModelChange: (stage: string, config: StageModelConfig) => void
  onSavePreset: (name: string, stageModels: Record<string, StageModelConfig>) => Promise<void>
  onLoadPreset: (preset: PresetRecord) => void
}

const PIPELINE_TYPE_LABELS: Record<string, string> = {
  feature: "Feature Pipeline",
  task: "Task Pipeline",
  epic: "Epic Pipeline",
  bugfix: "Bugfix Pipeline",
  plan: "Plan Pipeline",
}

export function ModelConfirmationPanel(props: ModelConfirmationPanelProps) {
  const pipelineLabel = () => PIPELINE_TYPE_LABELS[props.pipelineType] ?? props.pipelineType

  return (
    <div class="model-confirmation-panel p-4 rounded-lg border border-vsc-panel-border bg-vsc-editor-bg my-4">
      <div class="mb-3">
        <h3 class="text-sm font-medium text-vsc-editor-fg">
          Configure Models for {pipelineLabel()}
        </h3>
        <p class="text-xs text-vsc-description-fg mt-1">
          Select models for each stage or load a preset. Pipeline will continue after confirmation.
        </p>
      </div>
      <StageModelPicker
        pipelineType={props.pipelineType}
        stages={props.stages}
        stageModels={props.stageModels}
        models={props.models}
        favorites={props.favorites}
        presets={props.presets}
        defaultModel={props.defaultModel}
        completedStages={props.completedStages}
        onConfirm={props.onConfirm}
        onStageModelChange={props.onStageModelChange}
        onSavePreset={props.onSavePreset}
        onLoadPreset={props.onLoadPreset}
      />
    </div>
  )
}
