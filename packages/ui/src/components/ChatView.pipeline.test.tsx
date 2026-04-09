import { describe, it, expect } from "vitest"
import { render } from "@solidjs/testing-library"
import { StoreProvider } from "../stores/context.jsx"
import { PostMessageProvider } from "../stores/post-message.jsx"
import { ChatView } from "./ChatView.jsx"
import type { Model } from "@atelier/core"

const mockModels = [
  { id: "claude-sonnet-4", name: "Claude Sonnet 4", providerID: "anthropic", limit: { context: 200000, output: 8192 } },
] as Model[]

describe("ChatView - Pipeline rendering", () => {
  const noop = () => {}

  it("renders stage blocks when pipeline stages are provided", () => {
    const stages = [
      { id: "s1", stage: "compile_brainstorm" as const, sessionId: "sess1", status: "completed" as const },
      { id: "s2", stage: "brainstorm" as const, sessionId: "sess2", status: "running" as const },
    ]

    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <ChatView
            onSend={async () => true}
            onAbort={noop}
            isBusy={false}
            onPermissionReply={noop}
            onQuestionReply={noop}
            onQuestionReject={noop}
            onFileClick={noop}
            connection="connected"
            messagesLoading={false}
            hasOlder={false}
            hasNewer={false}
            loadingOlder={false}
            loadingNewer={false}
            onLoadOlder={noop}
            onLoadNewer={noop}
            mode="feature"
            onModeChange={noop}
            models={[]}
            onSelectModel={noop}
            fileResults={[]}
            onRequestFiles={noop}
            variants={[]}
            selectedVariant={undefined}
            onVariantChange={noop}
            pipelineStages={stages}
          />
        </StoreProvider>
      </PostMessageProvider>
    )
    expect(container.querySelector("[data-stage='compile_brainstorm']")).toBeTruthy()
    expect(container.querySelector("[data-stage='brainstorm']")).toBeTruthy()
  })

  it("passes interrupted flag to StageBlock", () => {
    const stages = [
      { id: "s1", stage: "implement" as const, sessionId: "sess1", status: "running" as const, interrupted: true },
    ]

    const { container } = render(() =>
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <ChatView
            onSend={async () => true}
            onAbort={noop}
            isBusy={false}
            onPermissionReply={noop}
            onQuestionReply={noop}
            onQuestionReject={noop}
            onFileClick={noop}
            connection="connected"
            messagesLoading={false}
            hasOlder={false}
            hasNewer={false}
            loadingOlder={false}
            loadingNewer={false}
            onLoadOlder={noop}
            onLoadNewer={noop}
            mode="feature"
            onModeChange={noop}
            models={[]}
            onSelectModel={noop}
            fileResults={[]}
            onRequestFiles={noop}
            variants={[]}
            selectedVariant={undefined}
            onVariantChange={noop}
            pipelineStages={stages}
          />
        </StoreProvider>
      </PostMessageProvider>
    )

    const statusEl = container.querySelector("[data-stage-status]")
    expect(statusEl?.getAttribute("data-stage-status")).toBe("interrupted")
  })

  it("shows ModelConfirmationPanel after classify completes when not confirmed", () => {
    const stages = [
      { id: "s1", stage: "classify" as const, sessionId: "sess1", status: "completed" as const },
      { id: "s2", stage: "brainstorm" as const, status: "idle" as const },
    ]
    const { container } = render(() => (
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <ChatView
            mode="feature"
            pipelineStages={stages}
            pipelineStatus="running"
            models={mockModels}
            selectedModel="anthropic:claude-sonnet-4"
            favorites={[]}
            onSend={async () => true}
            onAbort={noop}
            isBusy={false}
            onPermissionReply={noop}
            onQuestionReply={noop}
            onQuestionReject={noop}
            onFileClick={noop}
            connection="connected"
            messagesLoading={false}
            hasOlder={false}
            hasNewer={false}
            loadingOlder={false}
            loadingNewer={false}
            onLoadOlder={noop}
            onLoadNewer={noop}
            onModeChange={noop}
            onSelectModel={noop}
            variants={[]}
            selectedVariant={undefined}
            onVariantChange={noop}
            stageModels={{}}
            stageModelsConfirmed={false}
            presets={[]}
            onConfirmStageModels={() => {}}
            onStageModelChange={() => {}}
            onSavePreset={async () => {}}
            onLoadPreset={() => {}}
          />
        </StoreProvider>
      </PostMessageProvider>
    ))
    expect(container.querySelector(".model-confirmation-panel")).toBeTruthy()
  })

  it("hides ModelConfirmationPanel after stage models confirmed", () => {
    const stages = [
      { id: "s1", stage: "classify" as const, sessionId: "sess1", status: "completed" as const },
      { id: "s2", stage: "brainstorm" as const, status: "idle" as const },
    ]
    const { container } = render(() => (
      <PostMessageProvider value={noop}>
        <StoreProvider>
          <ChatView
            mode="feature"
            pipelineStages={stages}
            pipelineStatus="running"
            models={mockModels}
            selectedModel="anthropic:claude-sonnet-4"
            favorites={[]}
            onSend={async () => true}
            onAbort={noop}
            isBusy={false}
            onPermissionReply={noop}
            onQuestionReply={noop}
            onQuestionReject={noop}
            onFileClick={noop}
            connection="connected"
            messagesLoading={false}
            hasOlder={false}
            hasNewer={false}
            loadingOlder={false}
            loadingNewer={false}
            onLoadOlder={noop}
            onLoadNewer={noop}
            onModeChange={noop}
            onSelectModel={noop}
            variants={[]}
            selectedVariant={undefined}
            onVariantChange={noop}
            stageModels={{}}
            stageModelsConfirmed={true}
            presets={[]}
            onConfirmStageModels={() => {}}
            onStageModelChange={() => {}}
            onSavePreset={async () => {}}
            onLoadPreset={() => {}}
          />
        </StoreProvider>
      </PostMessageProvider>
    ))
    expect(container.querySelector(".model-confirmation-panel")).toBeNull()
  })
})
