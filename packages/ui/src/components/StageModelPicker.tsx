import { createSignal, For, Show, onCleanup } from "solid-js"
import type { Model, FavoriteRecord, PresetRecord, StageModelConfig } from "@atelier/core"
import { modelKey } from "./ModelPill.jsx"
import { createClickOutside } from "../utils/click-outside.js"

interface StageInfo {
  stage: string
  label: string
}

export interface StageModelPickerProps {
  pipelineType: string
  stages: StageInfo[]
  stageModels: Record<string, StageModelConfig>
  models: Model[]
  favorites: FavoriteRecord[]
  presets: PresetRecord[]
  defaultModel: StageModelConfig
  completedStages: Set<string>
  currentStage?: string
  onConfirm: () => void
  onStageModelChange: (stage: string, config: StageModelConfig) => void
  onSavePreset: (name: string, stageModels: Record<string, StageModelConfig>) => void
  onLoadPreset: (preset: PresetRecord) => void
}

function shortModelName(model: Model): string {
  if (model.name) return model.name
  const slash = model.id.indexOf("/")
  return slash !== -1 ? model.id.slice(slash + 1) : model.id
}

function getVariants(model: Model | undefined): string[] {
  if (!model?.variants) return []
  return Object.keys(model.variants)
}

export function StageModelPicker(props: StageModelPickerProps) {
  const [openDropdown, setOpenDropdown] = createSignal<string | null>(null)
  const [presetOpen, setPresetOpen] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [presetName, setPresetName] = createSignal("")

  let containerRef!: HTMLDivElement
  const { startListening, stopListening } = createClickOutside(
    () => containerRef,
    () => {
      setOpenDropdown(null)
      setPresetOpen(false)
    },
  )

  // Start listening immediately so clicks outside the picker close dropdowns
  startListening()
  onCleanup(stopListening)

  const getStageModel = (stage: string): StageModelConfig =>
    props.stageModels[stage] ?? props.defaultModel

  const getModelByConfig = (config: StageModelConfig): Model | undefined =>
    props.models.find(m => m.providerID === config.providerID && m.id === config.modelID)

  const handleModelSelect = (stage: string, model: Model) => {
    const current = getStageModel(stage)
    // Reset variant if the new model doesn't support the current one
    const variants = getVariants(model)
    const variant = current.variant && variants.includes(current.variant) ? current.variant : undefined
    props.onStageModelChange(stage, { providerID: model.providerID, modelID: model.id, variant })
    setOpenDropdown(null)
  }

  const handleVariantCycle = (stage: string) => {
    const config = getStageModel(stage)
    const model = getModelByConfig(config)
    const variants = getVariants(model)
    if (variants.length === 0) return

    let next: string | undefined
    if (!config.variant) {
      next = variants[0]
    } else {
      const idx = variants.indexOf(config.variant)
      next = idx === -1 || idx === variants.length - 1 ? undefined : variants[idx + 1]
    }
    props.onStageModelChange(stage, { ...config, variant: next })
  }

  const handleSavePreset = () => {
    const name = presetName().trim()
    if (!name) return
    props.onSavePreset(name, props.stageModels)
    setSaving(false)
    setPresetName("")
  }

  const ChevronDown = () => (
    <svg class="w-3 h-3 opacity-50" viewBox="0 0 16 16" fill="none">
      <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )

  return (
    <div ref={containerRef} class="p-3 min-w-[340px]">
      {/* Stage list */}
      <div class="max-h-[320px] overflow-y-auto -mx-1 px-1">
        <For each={props.stages}>
          {(stageInfo) => {
            const config = () => getStageModel(stageInfo.stage)
            const model = () => getModelByConfig(config())
            const variants = () => getVariants(model())
            const isCompleted = () => props.completedStages.has(stageInfo.stage)
            const isCurrent = () => props.currentStage === stageInfo.stage
            const isLocked = () => isCompleted() || isCurrent()
            const isOpen = () => openDropdown() === stageInfo.stage
            const displayName = () => {
              const m = model()
              return m ? shortModelName(m) : config().modelID
            }
            const variantLabel = () => config().variant
            const isLastVariant = () => {
              const v = variants()
              return v.length > 0 && config().variant === v[v.length - 1]
            }

            return (
              <div
                class="flex items-center gap-2 px-2 py-[5px] rounded text-xs"
                classList={{ "bg-vsc-list-hover/15": isCurrent() }}
                data-stage={stageInfo.stage}
              >
                {/* Status dot */}
                <span
                  class="w-[5px] h-[5px] rounded-full shrink-0"
                  classList={{
                    "bg-[#3fb950]": isCompleted(),
                    "bg-vsc-link animate-pulse": isCurrent() && !isCompleted(),
                    "bg-vsc-description-fg/25": !isCompleted() && !isCurrent(),
                  }}
                />
                {/* Stage label */}
                <span
                  class="w-[100px] shrink-0 truncate"
                  classList={{
                    "text-vsc-disabled-fg": isCompleted(),
                    "text-vsc-editor-fg": isCurrent() && !isCompleted(),
                    "text-vsc-description-fg": !isCompleted() && !isCurrent(),
                  }}
                >
                  {stageInfo.label}
                </span>
                {/* Model selector */}
                <div class="relative flex-1 min-w-0">
                  <Show when={!isLocked()} fallback={
                    <span class="text-vsc-disabled-fg/60 text-[11px] truncate block">
                      {displayName()}
                      <Show when={variantLabel()}>
                        <span class="ml-1 opacity-60">· {variantLabel()}</span>
                      </Show>
                    </span>
                  }>
                    <button
                      class="flex items-center gap-1 w-full h-[22px] px-1.5 rounded text-[11px] text-left truncate border border-transparent hover:border-vsc-panel-border hover:bg-vsc-list-hover/20 transition-colors"
                      classList={{ "border-vsc-panel-border bg-vsc-input-bg": isOpen() }}
                      onClick={(e) => {
                        e.stopPropagation()
                        setOpenDropdown(isOpen() ? null : stageInfo.stage)
                        setPresetOpen(false)
                      }}
                    >
                      <span class="flex-1 truncate text-vsc-editor-fg">{displayName()}</span>
                      <ChevronDown />
                    </button>
                    <Show when={isOpen()}>
                      <div class="absolute top-full left-0 right-0 mt-0.5 z-50 rounded-md border border-vsc-panel-border bg-vsc-editor-bg shadow-lg overflow-hidden max-h-[180px] overflow-y-auto">
                        <For each={props.models}>
                          {(m) => {
                            const key = modelKey(m)
                            const selected = () => key === `${config().providerID}:${config().modelID}`
                            return (
                              <button
                                class="flex items-center w-full text-left px-2.5 py-1.5 text-[11px] hover:bg-vsc-list-hover/30 transition-colors"
                                classList={{
                                  "text-vsc-link": selected(),
                                  "text-vsc-editor-fg": !selected(),
                                }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleModelSelect(stageInfo.stage, m)
                                }}
                              >
                                <span class="flex-1 truncate">{shortModelName(m)}</span>
                                <Show when={selected()}>
                                  <svg class="w-3 h-3 shrink-0 ml-1" viewBox="0 0 16 16" fill="currentColor">
                                    <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                                  </svg>
                                </Show>
                              </button>
                            )
                          }}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </div>
                {/* Variant cycle button */}
                <Show when={variants().length > 0 && !isLocked()}>
                  <button
                    class="shrink-0 h-[22px] px-1.5 rounded text-[10px] leading-none transition-colors"
                    classList={{
                      "text-vsc-description-fg/40": !variantLabel(),
                      "text-vsc-link": !!variantLabel() && !isLastVariant(),
                      "text-vsc-warning": isLastVariant(),
                    }}
                    onClick={(e) => { e.stopPropagation(); handleVariantCycle(stageInfo.stage) }}
                    title={`Reasoning: ${variantLabel() ?? "off"}`}
                  >
                    {variantLabel() ?? "off"}
                  </button>
                </Show>
                <Show when={variants().length > 0 && isLocked() && variantLabel()}>
                  <span
                    class="shrink-0 text-[10px] leading-none text-vsc-disabled-fg/40"
                    title={`Reasoning: ${variantLabel()}`}
                  >
                    {variantLabel()}
                  </span>
                </Show>
              </div>
            )
          }}
        </For>
      </div>

      {/* Footer */}
      <div class="mt-2 pt-2 border-t border-vsc-panel-border/40 flex items-center gap-1.5">
        <button
          class="h-[26px] px-3 rounded text-[11px] bg-vsc-button-bg text-vsc-button-fg hover:bg-vsc-button-hover transition-colors"
          onClick={props.onConfirm}
        >
          Confirm
        </button>

        <Show when={!saving()} fallback={
          <div class="flex items-center gap-1 flex-1">
            <input
              type="text"
              placeholder="Preset name…"
              value={presetName()}
              onInput={(e) => setPresetName(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSavePreset(); if (e.key === "Escape") setSaving(false) }}
              class="flex-1 h-[22px] px-1.5 text-[11px] bg-transparent border border-vsc-panel-border rounded text-vsc-editor-fg placeholder:text-vsc-disabled-fg outline-none focus:border-vsc-link"
              autofocus
            />
            <button
              class="h-[22px] px-2 rounded text-[11px] text-vsc-description-fg hover:text-vsc-editor-fg"
              onClick={handleSavePreset}
            >
              Save
            </button>
            <button
              class="h-[22px] px-1 rounded text-[11px] text-vsc-description-fg hover:text-vsc-editor-fg"
              onClick={() => setSaving(false)}
            >
              ✕
            </button>
          </div>
        }>
          <button
            class="h-[26px] px-2 rounded text-[11px] text-vsc-description-fg hover:text-vsc-editor-fg transition-colors"
            onClick={() => { setSaving(true); setPresetOpen(false); setOpenDropdown(null) }}
          >
            Save preset
          </button>

          <div class="relative ml-auto">
            <button
              class="h-[26px] px-2 rounded text-[11px] text-vsc-description-fg hover:text-vsc-editor-fg transition-colors"
              onClick={(e) => { e.stopPropagation(); setPresetOpen(!presetOpen()); setOpenDropdown(null) }}
            >
              Load preset
              <svg class="w-3 h-3 inline-block ml-0.5 opacity-50" viewBox="0 0 16 16" fill="none">
                <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <Show when={presetOpen()}>
              <div class="absolute bottom-full right-0 mb-1 min-w-[160px] z-50 rounded-md border border-vsc-panel-border bg-vsc-editor-bg shadow-lg overflow-hidden">
                <Show when={props.presets.length > 0} fallback={
                  <div class="px-2.5 py-2 text-[11px] text-vsc-disabled-fg">No presets saved yet</div>
                }>
                  <For each={props.presets}>
                    {(preset) => (
                      <button
                        class="block w-full text-left px-2.5 py-1.5 text-[11px] text-vsc-editor-fg hover:bg-vsc-list-hover/30 transition-colors"
                        onClick={() => { props.onLoadPreset(preset); setPresetOpen(false) }}
                      >
                        {preset.name}
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}
