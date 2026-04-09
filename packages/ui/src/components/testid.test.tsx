import { describe, it, expect } from "vitest"
import { render } from "@solidjs/testing-library"
import { StoreProvider } from "../stores/context.jsx"
import { ChatView } from "./ChatView.jsx"
import { InputBar } from "./InputBar.jsx"
import { MessageList } from "./MessageList.jsx"
import { SessionDropdown } from "./SessionDropdown.jsx"
import { ModePill } from "./ModePill.jsx"
import { ModelPill } from "./ModelPill.jsx"

// ChatView wraps the header bar, connection indicator, message list, and input bar.
// Rendering App directly requires mock host messages to pass the ready() gate.
// Instead, test each component via ChatView (which is always rendered) or in isolation.

const chatViewDefaults = {
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

describe("data-testid attributes", () => {
  it("ChatView renders chat-panel testid", () => {
    const { container } = render(() =>
      <StoreProvider><ChatView {...chatViewDefaults} /></StoreProvider>,
    )
    expect(container.querySelector('[data-testid="chat-panel"]')).toBeTruthy()
  })

  it("ChatView renders input-bar and message-list testids", () => {
    const { container } = render(() =>
      <StoreProvider><ChatView {...chatViewDefaults} /></StoreProvider>,
    )
    expect(container.querySelector('[data-testid="input-bar"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="message-list"]')).toBeTruthy()
  })

  it("ModePill has data-testid", () => {
    const { container } = render(() => (
      <ModePill mode="build" onModeChange={() => {}} />
    ))
    expect(container.querySelector('[data-testid="mode-pill"]')).toBeTruthy()
  })

  it("ModelPill has data-testid", () => {
    const { container } = render(() => (
      <ModelPill models={[]} onSelect={() => {}} favorites={[]} onUpsertFavorite={() => {}} onSelectFavorite={() => {}} onRemoveFavorite={() => {}} onReorderFavorites={() => {}} />
    ))
    expect(container.querySelector('[data-testid="model-pill"]')).toBeTruthy()
  })

  it("SessionDropdown has data-testid", () => {
    const { container } = render(() => (
      <SessionDropdown sessions={[]} onNewSession={() => {}} onSelectSession={() => {}} onDeleteSession={() => {}} />
    ))
    expect(container.querySelector('[data-testid="session-dropdown"]')).toBeTruthy()
  })
})
