import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { ModelPill } from "./ModelPill.jsx"

const models = [
  { id: "sonnet", name: "Sonnet", providerID: "anthropic", variants: { thinking: {}, max: {} }, limit: { context: 200000 } },
  { id: "opus", name: "Opus", providerID: "anthropic", limit: { context: 200000 } },
  { id: "gpt-4.1", name: "gpt-4.1", providerID: "openai", limit: { context: 200000 } },
]

describe("ModelPill", () => {
  it("renders favorites section above model list in canonical order", async () => {
    const favorites = [
      { favoriteKey: "openai::gpt-4.1::__none__", providerID: "openai", modelID: "gpt-4.1" },
      { favoriteKey: "anthropic::sonnet::thinking", providerID: "anthropic", modelID: "sonnet", variant: "thinking" },
    ]
    const { getByText, container } = render(() => (
      <ModelPill
        models={models as any}
        selected="anthropic:sonnet"
        selectedVariant="thinking"
        favorites={favorites as any}
        onSelect={() => {}}
        onUpsertFavorite={() => {}}
        onSelectFavorite={() => {}}
        onRemoveFavorite={() => {}}
        onReorderFavorites={() => {}}
      />
    ))
    await fireEvent.click(getByText("Sonnet"))
    const rows = container.querySelectorAll("[data-testid='favorite-row']")
    expect(rows[0]!.textContent).toContain("gpt-4.1")
  })

  it("clicking favorite selects model and variant as pair", async () => {
    const onSelectFavorite = vi.fn()
    const favorites = [{ favoriteKey: "anthropic::sonnet::thinking", providerID: "anthropic", modelID: "sonnet", variant: "thinking" }]
    const { getByText, queryByText, container } = render(() => (
      <ModelPill
        models={models as any}
        selected="anthropic:sonnet"
        selectedVariant="thinking"
        favorites={favorites as any}
        onSelect={() => {}}
        onUpsertFavorite={() => {}}
        onSelectFavorite={onSelectFavorite}
        onRemoveFavorite={() => {}}
        onReorderFavorites={() => {}}
      />
    ))
    await fireEvent.click(getByText("Sonnet"))
    const firstFavoriteButton = container.querySelector("[data-testid='favorite-row'] button[disabled='false'], [data-testid='favorite-row'] button.flex-1") as HTMLButtonElement
    await fireEvent.click(firstFavoriteButton)
    expect(onSelectFavorite).toHaveBeenCalledWith({ favoriteKey: "anthropic::sonnet::thinking", providerID: "anthropic", modelID: "sonnet", variant: "thinking" })
    expect(queryByText("Favorites")).toBeNull()
  })

  it("stale favorite row shows Unavailable and does not invoke selection", async () => {
    const onSelectFavorite = vi.fn()
    const favorites = [{ favoriteKey: "x::missing::__none__", providerID: "x", modelID: "missing" }]
    const { getByText, container } = render(() => (
      <ModelPill
        models={models as any}
        selected="anthropic:sonnet"
        favorites={favorites as any}
        onSelect={() => {}}
        onUpsertFavorite={() => {}}
        onSelectFavorite={onSelectFavorite}
        onRemoveFavorite={() => {}}
        onReorderFavorites={() => {}}
      />
    ))
    await fireEvent.click(getByText("Sonnet"))
    expect(container.textContent).toContain("Unavailable")
    const favoriteButton = container.querySelector("[data-testid='favorite-row'] button.flex-1") as HTMLButtonElement
    await fireEvent.click(favoriteButton)
    expect(onSelectFavorite).not.toHaveBeenCalled()
  })

  it("clicking non-favorite row star upserts favorite pair in-UI", async () => {
    const onUpsertFavorite = vi.fn()
    const { getByText, container } = render(() => (
      <ModelPill
        models={models as any}
        selected="anthropic:sonnet"
        selectedVariant="thinking"
        favorites={[] as any}
        onSelect={() => {}}
        onUpsertFavorite={onUpsertFavorite}
        onSelectFavorite={() => {}}
        onRemoveFavorite={() => {}}
        onReorderFavorites={() => {}}
      />
    ))
    await fireEvent.click(getByText("Sonnet"))
    const stars = container.querySelectorAll("button[aria-label='Favorite model/variant']")
    await fireEvent.click(stars[0]!)
    expect(onUpsertFavorite).toHaveBeenCalledWith({ providerID: "anthropic", modelID: "sonnet", variant: "thinking" })
  })

  it("dragging favorite row emits reordered keys", async () => {
    const onReorderFavorites = vi.fn()
    const favorites = [
      { favoriteKey: "anthropic::sonnet::thinking", providerID: "anthropic", modelID: "sonnet", variant: "thinking" },
      { favoriteKey: "anthropic::opus::__none__", providerID: "anthropic", modelID: "opus" },
    ]
    const { getByText, container } = render(() => (
      <ModelPill
        models={models as any}
        selected="anthropic:sonnet"
        favorites={favorites as any}
        onSelect={() => {}}
        onUpsertFavorite={() => {}}
        onSelectFavorite={() => {}}
        onRemoveFavorite={() => {}}
        onReorderFavorites={onReorderFavorites}
      />
    ))
    await fireEvent.click(getByText("Sonnet"))
    const names = container.querySelectorAll("[data-testid='favorite-model-name']")
    await fireEvent.dragStart(names[0]!)
    await fireEvent.dragOver(names[1]!)
    await fireEvent.drop(names[1]!)
    expect(onReorderFavorites).toHaveBeenCalledWith([
      "anthropic::opus::__none__",
      "anthropic::sonnet::thinking",
    ])
  })

  it("selecting model without variant support resets variant", async () => {
    const onVariantChange = vi.fn()
    const { getByText } = render(() => (
      <ModelPill
        models={models as any}
        selected="anthropic:sonnet"
        selectedVariant="thinking"
        favorites={[] as any}
        onSelect={() => {}}
        onVariantChange={onVariantChange}
        onUpsertFavorite={() => {}}
        onSelectFavorite={() => {}}
        onRemoveFavorite={() => {}}
        onReorderFavorites={() => {}}
      />
    ))
    await fireEvent.click(getByText("Sonnet"))
    // opus does not have variants, so selecting it should reset variant
    await fireEvent.click(getByText("Opus"))
    expect(onVariantChange).toHaveBeenCalledWith(undefined)
  })
})
