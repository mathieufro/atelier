import { Show, For, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { ConnectionState, Mode, Model, PipelineStage, PromptParams, StageStatus, FavoritePair, FavoriteRecord, PipelineStatus, SkillInfo, ActiveFileContext, StageModelConfig, PresetRecord } from "@atelier/core"
import { useStores } from "../stores/context.jsx"
import { InputBar } from "./InputBar.jsx"
import { MessageList } from "./MessageList.jsx"
import { PermissionBanner } from "./PermissionBanner.jsx"
import { QuestionBanner } from "./QuestionBanner.jsx"
import { StageBlock } from "./StageBlock.jsx"
import { ModelConfirmationPanel } from "./ModelConfirmationPanel.jsx"
import { getTopologyForType } from "../utils/pipeline-stages.js"

interface PipelineStageInfo {
  id: string
  stage: PipelineStage
  sessionId?: string
  status: StageStatus
  interrupted?: boolean
}

interface ChatViewProps {
  onSend: (content: string, attachments?: PromptParams["attachments"]) => Promise<boolean>
  onAbort: () => void
  isBusy: boolean
  sending?: boolean
  sendError?: string | null
  onPermissionReply: (sessionId: string, id: string, reply: "once" | "always" | "reject") => void
  onQuestionReply: (sessionId: string, id: string, answers: string[][]) => void
  onQuestionReject: (sessionId: string, id: string) => void
  onFileClick: (path: string, line?: number) => void
  connection: ConnectionState
  messagesLoading: boolean
  hasOlder: boolean
  hasNewer: boolean
  loadingOlder: boolean
  loadingNewer: boolean
  onLoadOlder: () => void
  onLoadNewer: () => void
  mode: Mode
  onModeChange: (mode: Mode) => void
  models: Model[]
  selectedModel?: string
  onSelectModel: (id: string) => void
  favorites?: FavoriteRecord[]
  onUpsertFavorite?: (favorite: FavoritePair) => void
  onSelectFavorite?: (favorite: FavoriteRecord) => void
  onRemoveFavorite?: (favoriteKey: string) => void
  onReorderFavorites?: (favoriteKeys: string[]) => void
  inputTokens?: number
  fileResults?: Array<{ path: string; name: string }>
  onRequestFiles?: (query: string) => void
  activeFileInsert?: { path: string; startLine?: number; endLine?: number }
  activeFileContext?: ActiveFileContext
  fileContextEnabled?: boolean
  onToggleFileContext?: () => void
  modeLocked?: boolean
  variants: string[]
  selectedVariant: string | undefined
  onVariantChange: (variant: string | undefined) => void
  pipelineStages?: PipelineStageInfo[]
  pipelineStatus?: PipelineStatus | null
  onRestartStage?: (stageId: string) => void
  onRestartPipeline?: () => void
  skills?: SkillInfo[]
  onInvokeSkill?: (skillName: string, content: string, attachments?: PromptParams["attachments"]) => Promise<boolean> | boolean
  onNewChat?: () => void
  onClearError?: () => void
  onStartRalphLoop?: (args: { promptPath: string; maxIterations?: number; completionPromise?: string }) => void
  onCancelRalphLoop?: () => void
  onSendError?: (error: string) => void
  stageModels?: Record<string, StageModelConfig>
  stageModelsConfirmed?: boolean
  pipelineType?: string
  presets?: PresetRecord[]
  onConfirmStageModels?: (stageModels: Record<string, StageModelConfig>) => void
  onStageModelChange?: (stage: string, config: StageModelConfig) => void
  onSavePreset?: (name: string, stageModels: Record<string, StageModelConfig>) => Promise<void>
  onLoadPreset?: (preset: PresetRecord) => void
}

export function ChatView(props: ChatViewProps) {
  const { interactionStore, messageStore, sessionStore, ralphStore } = useStores()
  let scrollRef!: HTMLDivElement
  let inputRef!: HTMLDivElement
  let autoScroll = true
  const [showScrollBtn, setShowScrollBtn] = createSignal(false)

  /** Session IDs that belong to the current tab (chat session or pipeline stage sessions). */
  const tabSessionIds = createMemo((): Set<string> => {
    const ids = new Set<string>()
    const active = sessionStore.activeSessionId()
    if (active) ids.add(active)
    const stages = props.pipelineStages
    if (stages) {
      for (const s of stages) {
        if (s.sessionId) ids.add(s.sessionId)
      }
    }
    return ids
  })

  const currentPipelineStage = (): PipelineStage | null => {
    const stages = props.pipelineStages
    if (!stages?.length) return null
    const running = stages.find(s => s.status === "running")
    if (running) return running.stage
    // Terminal pipeline (all stages completed or idle) -- no active stage
    const lastStage = stages[stages.length - 1]!
    if (lastStage.status === "completed" || lastStage.status === "idle") return null
    return lastStage.stage
  }

  const classifyCompleted = (): boolean => {
    const stages = props.pipelineStages
    if (!stages?.length) return false
    const classifyStage = stages.find(s => s.stage === "classify")
    return classifyStage?.status === "completed"
  }

  const getTopologyStages = (): Array<{ stage: string; label: string }> =>
    getTopologyForType(props.pipelineType ?? "feature")

  // Sync scroll padding-bottom with input height so content can scroll past it
  onMount(() => {
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => {
      if (inputRef && scrollRef) {
        scrollRef.style.paddingBottom = `${inputRef.offsetHeight}px`
      }
    })
    ro.observe(inputRef)
    onCleanup(() => ro.disconnect())
  })

  function onScroll() {
    const { scrollTop, scrollHeight, clientHeight } = scrollRef
    autoScroll = scrollHeight - scrollTop - clientHeight < 100
    setShowScrollBtn(!autoScroll)
    if (scrollTop < 120 && props.hasOlder && !props.loadingOlder) {
      props.onLoadOlder()
    }
    if (scrollHeight - scrollTop - clientHeight < 140 && props.hasNewer && !props.loadingNewer) {
      props.onLoadNewer()
    }
  }

  const resolvedSessionId = () => sessionStore.activeSessionId() ?? ""

  // In pipeline mode, track the running stage's session for scroll triggers.
  // In chat mode, track the active session directly.
  const scrollSessionId = (): string => {
    const chatSid = resolvedSessionId()
    if (chatSid) return chatSid
    // Pipeline mode: find the running stage's session
    const stages = props.pipelineStages
    if (stages?.length) {
      const running = stages.find(s => s.status === "running")
      if (running?.sessionId) return running.sessionId
      // Fallback: last stage with a session (just completed)
      for (let i = stages.length - 1; i >= 0; i--) {
        if (stages[i]!.sessionId) return stages[i]!.sessionId!
      }
    }
    return ""
  }

  // Reset autoscroll when the user explicitly switches chat sessions.
  // Pipeline stage transitions also change scrollSessionId() but must NOT reset the
  // user's scroll position — otherwise any panel observing the same pipeline (including
  // a panel in another VS Code process on the same server) gets force-scrolled on every
  // stage_started broadcast.
  let prevChatSid = ""
  createEffect(() => {
    const sid = resolvedSessionId()
    if (sid !== prevChatSid) {
      autoScroll = true
      setShowScrollBtn(false)
      prevChatSid = sid
    }
  })

  // Re-enable autoscroll when an interaction (question/permission) is completed.
  // The user was at the bottom reading the banner; resume following new content.
  let prevCompletedCount = 0
  createEffect(() => {
    const count = interactionStore.completedQuestionsFor(tabSessionIds()).length
    if (count > prevCompletedCount) {
      autoScroll = true
      setShowScrollBtn(false)
    }
    prevCompletedCount = count
  })

  createEffect(() => {
    const sid = scrollSessionId()
    messageStore.messages(sid)
    messageStore.deltaVersion(sid)
    // Track busy state so the "Generating..." placeholder triggers scroll
    void props.isBusy
    if (autoScroll) {
      // Double-RAF: first frame lets SolidJS reconcile the DOM,
      // second frame measures the final scrollHeight after layout.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollRef.scrollTop = scrollRef.scrollHeight
        })
      })
    }
  })

  return (
    <div data-testid="chat-panel" class="flex-1 min-h-0 relative bg-vsc-sidebar-bg">
      {/* Scrollable message area */}
      <div
        ref={scrollRef}
        class="absolute inset-0 overflow-y-auto overflow-x-hidden"
        onScroll={onScroll}
      >
        <Show when={props.connection === "reconnecting"}>
          <div class="px-4 py-2 border-b border-vsc-panel-border text-xs text-vsc-warning flex items-center gap-2">
            <span class="animate-pulse">●</span> Connection lost — reconnecting...
          </div>
        </Show>
        <Show
          when={(props.mode === "feature" || props.mode === "plan" || props.mode === "bugfix") && props.pipelineStages?.length}
          fallback={<MessageList onFileClick={props.onFileClick} loading={props.messagesLoading} completedQuestions={interactionStore.completedQuestionsFor(tabSessionIds())} />}
        >
          <div class="py-2">
            <For each={props.pipelineStages}>
              {(stage, idx) => (
                <StageBlock
                  stage={stage.stage}
                  status={stage.status}
                  interrupted={stage.interrupted}
                  sessionId={stage.sessionId}
                  defaultCollapsed={stage.status === "completed" && stage.stage.startsWith("compile")}
                  isLast={idx() === (props.pipelineStages?.length ?? 0) - 1}
                >
                  <Show when={stage.sessionId}>
                    <MessageList sessionId={stage.sessionId} onFileClick={props.onFileClick} loading={false} hideEmptyPrompt completedQuestions={interactionStore.completedQuestionsFor(new Set([stage.sessionId!]))} />
                  </Show>
                </StageBlock>
              )}
            </For>

            <Show when={
              classifyCompleted() &&
              !props.stageModelsConfirmed &&
              props.pipelineStages?.some(s => s.stage === "classify")
            }>
              <ModelConfirmationPanel
                pipelineType={props.pipelineType ?? "feature"}
                stages={getTopologyStages()}
                stageModels={props.stageModels ?? {}}
                models={props.models}
                favorites={props.favorites ?? []}
                presets={props.presets ?? []}
                defaultModel={{
                  providerID: props.selectedModel?.split(":")[0] ?? "anthropic",
                  modelID: props.selectedModel?.split(":")[1] ?? "claude-sonnet-4",
                }}
                completedStages={new Set(
                  props.pipelineStages
                    ?.filter(s => s.status === "completed")
                    .map(s => s.stage) ?? []
                )}
                onConfirm={() => {
                  props.onConfirmStageModels?.(props.stageModels ?? {})
                }}
                onStageModelChange={props.onStageModelChange ?? (() => {})}
                onSavePreset={props.onSavePreset ?? (async () => {})}
                onLoadPreset={props.onLoadPreset ?? (() => {})}
              />
            </Show>

          </div>
        </Show>
        <Show when={props.loadingOlder || props.loadingNewer}>
          <div class="px-4 py-2 text-xs text-vsc-description-fg">Loading messages...</div>
        </Show>
        <Show when={interactionStore.pendingPermissionFor(tabSessionIds())}>
          {(req) => <PermissionBanner request={req()} onReply={props.onPermissionReply} />}
        </Show>
        <Show when={interactionStore.pendingQuestionFor(tabSessionIds())}>
          {(req) => <QuestionBanner request={req()} onReply={props.onQuestionReply} onReject={props.onQuestionReject} />}
        </Show>
      </div>
      {/* Gradient at very bottom of window */}
      <div class="absolute bottom-0 left-0 right-0 h-32 pointer-events-none z-[5] bg-gradient-to-t from-vsc-sidebar-bg to-transparent" />
      {/* Input — transparent, floats above gradient */}
      <div ref={inputRef} class="absolute bottom-0 left-0 right-0 z-10 pointer-events-auto">
        <InputBar
          onSend={props.onSend}
          onAbort={props.onAbort}
          isBusy={props.isBusy}
          sending={props.sending}
          sendError={props.sendError}
          modeLocked={props.modeLocked}
          mode={props.mode}
          onModeChange={props.onModeChange}
          models={props.models}
          selectedModel={props.selectedModel}
          onSelectModel={props.onSelectModel}
          favorites={props.favorites ?? []}
          onUpsertFavorite={props.onUpsertFavorite}
          onSelectFavorite={props.onSelectFavorite}
          onRemoveFavorite={props.onRemoveFavorite}
          onReorderFavorites={props.onReorderFavorites}
          inputTokens={props.inputTokens}
          fileResults={props.fileResults}
          onRequestFiles={props.onRequestFiles}
          activeFileInsert={props.activeFileInsert}
          activeFileContext={props.activeFileContext}
          fileContextEnabled={props.fileContextEnabled}
          onToggleFileContext={props.onToggleFileContext}
          variants={props.variants}
          selectedVariant={props.selectedVariant}
          onVariantChange={props.onVariantChange}
          pipelineStage={currentPipelineStage()}
          skills={props.skills}
          onInvokeSkill={props.onInvokeSkill}
          onNewChat={props.onNewChat}
          onClearError={props.onClearError}
          isLoopActive={ralphStore.isLoopActive(sessionStore.activeSessionId() ?? "")}
          onStartRalphLoop={props.onStartRalphLoop}
          onCancelRalphLoop={props.onCancelRalphLoop}
          onSendError={props.onSendError}
        />
      </div>
      <Show when={showScrollBtn()}>
        <button
          class="absolute bottom-20 right-4 bg-vsc-sidebar-bg text-vsc-editor-fg rounded-full w-8 h-8 flex items-center justify-center shadow-lg hover:opacity-80 text-sm z-20 border border-vsc-panel-border"
          onClick={() => { scrollRef.scrollTop = scrollRef.scrollHeight }}
        >
          ↓
        </button>
      </Show>
    </div>
  )
}
