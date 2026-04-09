import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { StoreProvider } from "../stores/context.jsx"
import { ChatView } from "./ChatView.jsx"

describe("ChatView", () => {
  const defaults = {
    onSend: async () => true,
    onAbort: () => {},
    isBusy: false,
    onPermissionReply: () => {},
    onQuestionReply: () => {},
    onQuestionReject: () => {},
    onFileClick: () => {},
    connection: "connected" as const,
    messagesLoading: false,
    hasOlder: false,
    hasNewer: false,
    loadingOlder: false,
    loadingNewer: false,
    onLoadOlder: () => {},
    onLoadNewer: () => {},
    mode: "build" as const,
    onModeChange: () => {},
    models: [],
    onSelectModel: () => {},
    variants: [],
    selectedVariant: undefined,
    onVariantChange: () => {},
  }

  it("renders message list and input bar", () => {
    const { container } = render(() =>
      <StoreProvider><ChatView {...defaults} /></StoreProvider>,
    )
    expect(container.querySelector("textarea")).not.toBeNull()
    expect(container.textContent).toContain("Start a conversation")
  })

  it("renders mode pill", () => {
    const { container } = render(() =>
      <StoreProvider><ChatView {...defaults} mode="plan" /></StoreProvider>,
    )
    expect(container.textContent).toContain("Plan")
  })

  it("passes favorites props into InputBar", async () => {
    const onSelectFavorite = vi.fn()
    const model = { id: "sonnet", name: "Sonnet", providerID: "anthropic", limit: { context: 100000 } }
    const { getByText, container } = render(() =>
      <StoreProvider>
        <ChatView
          {...defaults}
          models={[model] as any}
          selectedModel="anthropic:sonnet"
          favorites={[{ favoriteKey: "anthropic::sonnet::__none__", providerID: "anthropic", modelID: "sonnet" }] as any}
          onSelectFavorite={onSelectFavorite}
        />
      </StoreProvider>,
    )
    await fireEvent.click(getByText("Sonnet"))
    const favoriteButton = container.querySelector("[data-testid='favorite-row'] button.flex-1") as HTMLButtonElement
    await fireEvent.click(favoriteButton)
    expect(onSelectFavorite).toHaveBeenCalled()
  })
})
