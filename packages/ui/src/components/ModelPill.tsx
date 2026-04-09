import { createSignal, createMemo, For, Show, onCleanup } from "solid-js"
import { favoriteKeyOf, type FavoritePair, type FavoriteRecord, type Model } from "@atelier/core"
import { createClickOutside } from "../utils/click-outside.js"

export function modelKey(model: Model): string {
  return `${model.providerID}:${model.id}`
}

interface ModelPillProps {
  models: Model[]
  selected?: string
  selectedVariant?: string
  favorites: FavoriteRecord[]
  onSelect: (key: string) => void
  onVariantChange?: (variant: string | undefined) => void
  onUpsertFavorite: (favorite: FavoritePair) => void
  onSelectFavorite: (favorite: FavoriteRecord) => void
  onRemoveFavorite: (favoriteKey: string) => void
  onReorderFavorites: (favoriteKeys: string[]) => void
}

function shortModelName(model: Model): string {
  if (model.name) return model.name
  const slash = model.id.indexOf("/")
  return slash !== -1 ? model.id.slice(slash + 1) : model.id
}

export function ModelPill(props: ModelPillProps) {
  const [open, setOpen] = createSignal(false)
  const [dragIndex, setDragIndex] = createSignal<number | null>(null)
  const [draggingFavorites, setDraggingFavorites] = createSignal(false)
  let containerRef!: HTMLDivElement
  const { startListening, stopListening } = createClickOutside(
    () => containerRef,
    () => setOpen(false),
  )

  const selectedModel = () => props.models.find((m) => modelKey(m) === props.selected)

  const favoriteRows = () => props.favorites.map((favorite) => {
    const model = props.models.find((m) => m.providerID === favorite.providerID && m.id === favorite.modelID)
    const stale = !model || (!!favorite.variant && !Object.keys(model.variants ?? {}).includes(favorite.variant))
    return { favorite, model, stale }
  })

  const BACKEND_LABELS: Record<string, string> = { "claude-code": "Claude Code", opencode: "OpenCode" }
  const modelGroups = createMemo(() => {
    const groups = new Map<string, Model[]>()
    for (const model of props.models) {
      const backend = (model as unknown as Record<string, unknown>).backend as string | undefined ?? "other"
      if (!groups.has(backend)) groups.set(backend, [])
      groups.get(backend)!.push(model)
    }
    return [...groups.entries()].map(([backend, models]) => ({
      label: BACKEND_LABELS[backend] ?? backend,
      models,
    }))
  })

  onCleanup(stopListening)

  function toggle() {
    const next = !open()
    setOpen(next)
    if (next) startListening()
    else stopListening()
  }

  function selectModel(model: Model) {
    props.onSelect(modelKey(model))
    // Reset variant if not supported by the new model
    const variantIsValid = !props.selectedVariant || Object.keys(model.variants ?? {}).includes(props.selectedVariant)
    if (!variantIsValid) {
      props.onVariantChange?.(undefined)
    }
    setOpen(false)
    stopListening()
  }

  function selectFavorite(favorite: FavoriteRecord) {
    props.onSelectFavorite(favorite)
    setOpen(false)
    stopListening()
  }

  function commitReorder(dropIndex: number) {
    const from = dragIndex()
    setDragIndex(null)
    if (from === null || from === dropIndex || props.favorites.length < 2) return
    const next = [...props.favorites]
    const [moved] = next.splice(from, 1)
    next.splice(dropIndex, 0, moved!)
    props.onReorderFavorites(next.map((favorite) => favorite.favoriteKey))
  }

  const FavoriteStarIcon = () => (
    <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 1.9 9.86 5.67l4.17.6-3.01 2.94.71 4.15L8 11.4l-3.73 1.96.71-4.15-3.01-2.94 4.17-.6L8 1.9z"
        class="fill-transparent stroke-current stroke-[1.1] transition-colors group-hover:fill-current"
      />
    </svg>
  )

  const RemoveIcon = () => (
    <svg class="h-3.5 w-3.5" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" class="fill-none stroke-current stroke-[1.2]" />
    </svg>
  )

  return (
    <div data-testid="model-pill" ref={containerRef} class="relative">
      <button
        class="h-6 px-1.5 rounded text-xs text-vsc-description-fg hover:text-vsc-editor-fg"
        classList={{ "text-vsc-disabled-fg cursor-default": props.models.length === 0 }}
        onClick={() => props.models.length > 0 && toggle()}
        disabled={props.models.length === 0}
      >
        {props.models.length === 0 ? "No models" : shortModelName(selectedModel() ?? props.models[0]!)}
      </button>
      <Show when={open()}>
        <div class="absolute bottom-full left-0 mb-1 min-w-[240px] z-50 rounded-xl border border-vsc-panel-border bg-vsc-editor-bg shadow-lg overflow-hidden">
          <div class="model-pill-scroll max-h-[280px] overflow-y-auto py-1">
            <div class="px-3 py-1 text-[10px] uppercase tracking-wider text-vsc-disabled-fg">Favorites</div>
            <Show when={favoriteRows().length > 0} fallback={<div class="px-3 py-1.5 text-xs text-vsc-disabled-fg">No favorites yet</div>}>
              <For each={favoriteRows()}>
                {(row, i) => (
                  <div data-testid="favorite-row" class="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-vsc-list-hover/30">
                    <button
                      data-testid="favorite-model-name"
                      class="flex-1 text-left select-none"
                      classList={{
                        "text-vsc-disabled-fg": row.stale,
                        "text-vsc-link": !row.stale,
                        "cursor-grab active:cursor-grabbing": !row.stale && props.favorites.length > 1,
                      }}
                      disabled={row.stale}
                      draggable={!row.stale && props.favorites.length > 1}
                      onDragStart={() => {
                        setDragIndex(i())
                        setDraggingFavorites(true)
                      }}
                      onDragEnd={() => {
                        setDragIndex(null)
                        // Defer clearing the dragging flag so the onClick handler
                        // that fires immediately after drop/dragEnd still sees
                        // draggingFavorites() === true and can skip navigation.
                        queueMicrotask(() => setDraggingFavorites(false))
                      }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        commitReorder(i())
                        queueMicrotask(() => setDraggingFavorites(false))
                      }}
                      onClick={() => {
                        if (!row.stale && !draggingFavorites()) selectFavorite(row.favorite)
                      }}
                    >
                      {row.model ? shortModelName(row.model) : row.favorite.modelID}
                    </button>
                    <Show when={row.favorite.variant}>
                      <span class="text-[10px] text-vsc-description-fg">{row.favorite.variant}</span>
                    </Show>
                    <Show when={row.stale}>
                      <span class="text-[10px] text-vsc-warning">Unavailable</span>
                    </Show>
                    <button
                      aria-label="Remove favorite"
                      class="inline-flex h-4 w-4 items-center justify-center rounded text-vsc-disabled-fg/70 hover:text-vsc-editor-fg"
                      onClick={() => props.onRemoveFavorite(row.favorite.favoriteKey)}
                    >
                      <RemoveIcon />
                    </button>
                  </div>
                )}
              </For>
            </Show>
            <div class="my-1 border-t border-vsc-panel-border/40" />
            <For each={modelGroups()}>
              {(group) => (
                <>
                  <div class="px-3 py-1 text-[10px] uppercase tracking-wider text-vsc-disabled-fg mt-1">{group.label}</div>
                  <For each={group.models}>
                    {(model) => {
                      const key = modelKey(model)
                      const currentVariant = key === props.selected ? props.selectedVariant : undefined
                      const candidate: FavoritePair = { providerID: model.providerID, modelID: model.id, variant: currentVariant }
                      const favored = props.favorites.some((favorite) => favorite.favoriteKey === favoriteKeyOf(candidate))
                      return (
                        <div class="flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-vsc-list-hover/30">
                          <button
                            class="flex-1 text-left"
                            classList={{
                              "text-vsc-editor-fg": key !== props.selected,
                              "text-vsc-link": key === props.selected,
                            }}
                            onClick={() => selectModel(model)}
                          >
                            {shortModelName(model)}
                          </button>
                          <Show
                            when={!favored}
                            fallback={<span class="h-4 w-4 shrink-0" aria-hidden="true" />}
                          >
                            <button
                              aria-label="Favorite model/variant"
                              class="group inline-flex h-4 w-4 items-center justify-center rounded text-vsc-disabled-fg/35 hover:text-vsc-disabled-fg/70"
                              onClick={() => props.onUpsertFavorite(candidate)}
                            >
                              <FavoriteStarIcon />
                            </button>
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  )
}
