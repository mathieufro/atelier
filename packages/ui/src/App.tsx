import { createSignal, createMemo, Show, onMount, onCleanup, batch } from "solid-js"
import { StoreProvider, useStores } from "./stores/context.jsx"
import { PostMessageProvider } from "./stores/post-message.jsx"
import { ChatView } from "./components/ChatView.jsx"
import { OnboardingCard } from "./components/OnboardingCard.jsx"
import { SessionDropdown } from "./components/SessionDropdown.jsx"
import { StageModelPicker } from "./components/StageModelPicker.jsx"
import type { ConnectionState, WebviewMessage, HostMessage, Model, Mode, PromptParams, MessageWithParts, UnifiedEvent, PipelineEvent, OpenCodeForwardedEvent, PipelineSummary, FavoritePair, FavoriteRecord, SkillInfo, ActiveFileContext, StageModelConfig, PresetRecord } from "@atelier/core"
import { permissionRulesetToMode } from "@atelier/core"
import { setWorkspacePath } from "./stores/workspace.js"
import { modelKey } from "./components/ModelPill.jsx"
import { createRpc } from "./rpc.js"
import { debug } from "./debug.js"
import { STAGE_LABELS, getTopologyForType } from "./utils/pipeline-stages.js"
import { createClickOutside } from "./utils/click-outside.js"

interface AppProps {
  postMessage?: (msg: WebviewMessage) => void
  setState?: (state: unknown) => void
  initialActiveSessionId?: string
  initialActivePipelineId?: string
  initialFileContextEnabled?: boolean
}

function isPipelineEvent(event: UnifiedEvent): event is PipelineEvent & { seq: number } {
  return event.type.startsWith("stage_") || event.type.startsWith("pipeline_")
}

function isPipelineMode(m: Mode): boolean {
  return m === "feature" || m === "plan" || m === "bugfix"
}

// STAGE_LABELS imported from ./utils/pipeline-stages.js

function AppInner(props: AppProps) {
  const MESSAGE_PAGE_SIZE = 80
  const post = (msg: WebviewMessage) => props.postMessage?.(msg)
  const { sessionStore, messageStore, interactionStore, pipelineStore, ralphStore } = useStores()
  const [connection, setConnection] = createSignal<ConnectionState>("reconnecting")
  const [ready, setReady] = createSignal(false)
  const [configLoaded, setConfigLoaded] = createSignal(false)
  const [models, setModels] = createSignal<Model[]>([])
  const [selectedModel, setSelectedModel] = createSignal<string | undefined>()
  const [selectedVariant, setSelectedVariant] = createSignal<string | undefined>()
  const [favorites, setFavorites] = createSignal<FavoriteRecord[]>([])
  const [committedModel, setCommittedModel] = createSignal<string | undefined>()
  const [mode, setMode] = createSignal<Mode>("build")
  const [messagesLoading, setMessagesLoading] = createSignal(false)
  const [loadingSessionId, setLoadingSessionId] = createSignal<string | null>(null)
  const [fileResults, setFileResults] = createSignal<Array<{ path: string; name: string }>>([])
  const [activeFileInsert, setActiveFileInsert] = createSignal<{ path: string; startLine?: number; endLine?: number } | undefined>()
  const [activeFileContext, setActiveFileContext] = createSignal<ActiveFileContext>(null)
  const [fileContextEnabled, setFileContextEnabled] = createSignal<boolean>(
    props.initialFileContextEnabled ?? true
  )
  const [skills, setSkills] = createSignal<SkillInfo[]>([])
  const [sendError, setSendError] = createSignal<string | null>(null)
  const [sending, setSending] = createSignal(false)
  const [restoredInitialView, setRestoredInitialView] = createSignal(false)
  // Tracks when the user explicitly triggered "+ New Chat" but the session hasn't been
  // confirmed yet — prevents stage_started auto-select from hijacking the empty chat.
  const [newChatPending, setNewChatPending] = createSignal(false)
  const [stageModels, setStageModels] = createSignal<Record<string, StageModelConfig>>({})
  const [stageModelsConfirmed, setStageModelsConfirmed] = createSignal(false)
  const [presets, setPresets] = createSignal<PresetRecord[]>([])
  const [pipelineTypeDetermined, setPipelineTypeDetermined] = createSignal<string | null>(null)
  const [showStageDropdown, setShowStageDropdown] = createSignal(false)
  let stageDropdownContainerRef: HTMLDivElement | undefined
  const stageDropdownClickOutside = createClickOutside(
    () => stageDropdownContainerRef,
    () => setShowStageDropdown(false),
  )
  const rpc = createRpc(post as (msg: Record<string, unknown>) => void)

  const persistState = (partial: { activeSessionId?: string | null; activePipelineId?: string | null; fileContextEnabled?: boolean }) =>
    props.setState?.({
      activeSessionId: sessionStore.activeSessionId() ?? undefined,
      activePipelineId: pipelineStore.activePipelineId() ?? undefined,
      fileContextEnabled: fileContextEnabled(),
      ...partial,
    })

  let messagesLoadingTimer: ReturnType<typeof setTimeout> | undefined

  function beginMessagesLoad(sessionId: string) {
    setMessagesLoading(true)
    setLoadingSessionId(sessionId)
    clearTimeout(messagesLoadingTimer)
    messagesLoadingTimer = setTimeout(() => {
      if (!messagesLoading()) return
      debug("messages_load_timeout", { sessionId })
      setMessagesLoading(false)
      setLoadingSessionId(null)
      setSendError("Loading this conversation timed out. Try selecting it again.")
    }, 20_000)
  }

  function endMessagesLoad(sessionId?: string) {
    const pending = loadingSessionId()
    if (sessionId && pending && sessionId !== pending) return
    setMessagesLoading(false)
    setLoadingSessionId(null)
    clearTimeout(messagesLoadingTimer)
  }

  let eventBuffer: UnifiedEvent[] = []
  let frameRequested = false

  function flushEvents() {
    const events = eventBuffer
    eventBuffer = []
    frameRequested = false
    debug("flush_events", { count: events.length })
    batch(() => {
      for (const event of events) {
        if (isPipelineEvent(event)) {
          // Capture before handleEvent adds the pipeline to summaries
          const isNewPipeline = event.type === "stage_started" && !pipelineStore.summaries().some(s => s.id === event.pipelineId)
          pipelineStore.handleEvent(event)
          if (event.type === "stage_started") {
            // Remove stage session from chatlist — session.created may have added it before we knew it was a pipeline session
            if (event.sessionId) sessionStore.removeSession(event.sessionId)
            // Auto-select only brand-new pipelines — not stage transitions of existing ones
            // (prevents an empty tab from hijacking a pipeline already open in another tab)
            if (isNewPipeline && !sessionStore.activeSessionId() && !pipelineStore.activePipelineId() && !newChatPending()) {
              handleSelectPipeline(event.pipelineId)
            }
          }
          if (event.type === "stage_interrupted") {
            sessionStore.handleEvent({ type: "session.idle", properties: { sessionID: event.sessionId } })
          }
        } else if (event.type === "connection_lost") {
          setConnection("reconnecting")
        } else if (event.type === "connection_restored") {
          setConnection("connected")
        } else if (event.type === "full_refresh_required") {
          // Trigger full REST refresh
          post({ type: "ready" })
        } else if (event.type === "send_error") {
          setSendError(event.error ?? "Message delivery failed")
        } else if (event.type === "skill.used") {
          messageStore.setPendingSkill(event.sessionId, event.skillName)
        } else {
          // OpenCode events (dotted names like message.updated, session.created, etc.)
          const ocEvent = event as OpenCodeForwardedEvent & { seq: number }
          sessionStore.handleEvent(ocEvent)
          messageStore.handleEvent(ocEvent)
          interactionStore.handleEvent(ocEvent)
          ralphStore.handleEvent(ocEvent)

          // Sync mode/model from the latest message for the active session
          if (ocEvent.type === "message.updated") {
            // Runtime messages carry extra fields (finish, variant, model) not fully
            // captured by the SDK Message type — use a loose record for those fields.
            const info = ocEvent.properties.info as Record<string, unknown>
            const evtSessionId = info.sessionID as string | undefined
            const isPipelineSession = evtSessionId ? pipelineStore.getPipelineIdForSession(evtSessionId) !== undefined : false
            const isActiveChat = evtSessionId === sessionStore.activeSessionId()
            const tabPipelineId = activePipelineId()
            const isActivePipelineSession = isPipelineSession && tabPipelineId !== null
              && pipelineStore.getPipelineIdForSession(evtSessionId!) === tabPipelineId
            const isActiveSession = evtSessionId && (isActiveChat || isActivePipelineSession)
            if (isActiveSession && info.finish) {
              if (!isPipelineSession && info.mode) {
                const m = info.mode as Mode
                if (m === "build" || m === "plan") setMode(m)
              }
              const parent = info.parentID ? messageStore.getMessage(evtSessionId, info.parentID as string) : undefined
              if (info.role === "assistant" && parent?.role === "assistant") continue
              const model = info.model as { providerID?: string; modelID?: string } | undefined
              const providerID = (info.providerID ?? model?.providerID) as string | undefined
              const modelID = (info.modelID ?? model?.modelID) as string | undefined
              const key = findModelKey(providerID, modelID)
              if (key) {
                setSelectedModel(key)
                setCommittedModel(key)
              }
              if ("variant" in info) setSelectedVariant(info.variant as string | undefined)
            }
          }
        }
      }
    })
  }

  // Derive mode from active session's permission field
  function updateModeFromSession(sessionId: string | null) {
    if (!sessionId) return
    // Pipeline sessions: derive mode from pipeline type
    const pipelineId = pipelineStore.getPipelineIdForSession(sessionId)
    if (pipelineId) {
      const summary = pipelineStore.summaries().find(s => s.id === pipelineId)
      setMode(summary?.type === "plan" ? "plan" : summary?.type === "bugfix" ? "bugfix" : "feature")
      return
    }
    const session = sessionStore.sessions().find((s) => s.id === sessionId)
    setMode(session?.permission ? permissionRulesetToMode(session.permission) : "build")
  }

  /** Build composite key from message model info, matching against known models */
  function findModelKey(providerID: string | undefined, modelID: string | undefined): string | undefined {
    if (!modelID) return undefined
    if (providerID) {
      const key = `${providerID}:${modelID}`
      if (models().some((m) => modelKey(m) === key)) return key
    }
    const match = models().find((m) => m.id === modelID)
    return match ? modelKey(match) : undefined
  }

  function isSubagentAssistant(message: MessageWithParts["message"], lookup: Map<string, MessageWithParts["message"]>): boolean {
    if (message.role !== "assistant") return false
    const parent = lookup.get(message.parentID)
    return parent?.role === "assistant"
  }

  function restoreModelAndVariant(messages: MessageWithParts[]): void {
    const lookup = new Map(messages.map((entry) => [entry.message.id, entry.message]))
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!.message
      if (m.role !== "user" && m.role !== "assistant") continue
      if (isSubagentAssistant(m, lookup)) continue
      const providerID = m.role === "user" ? m.model?.providerID : m.providerID
      const modelID = m.role === "user" ? m.model?.modelID : m.modelID
      const key = findModelKey(providerID, modelID)
      if (key) {
        setSelectedModel(key)
        setCommittedModel(key)
      }
      setSelectedVariant(m.variant)
      return
    }
  }

  const selectedModelObj = (): Model | undefined => {
    const key = selectedModel()
    return key ? models().find((m) => modelKey(m) === key) : undefined
  }

  const availableVariants = createMemo((): string[] => {
    const model = selectedModelObj()
    if (!model?.variants) return []
    return Object.keys(model.variants)
  })

  function resolveTopValidFavorite(rows: FavoriteRecord[]): FavoriteRecord | undefined {
    return rows.find((favorite) => {
      const model = models().find((m) => m.providerID === favorite.providerID && m.id === favorite.modelID)
      if (!model) return false
      if (!favorite.variant) return true
      return Object.keys(model.variants ?? {}).includes(favorite.variant)
    })
  }

  onMount(() => {
    function handleHostMessage(e: MessageEvent<HostMessage>) {
      const msg = e.data
      if (rpc.handleResponse(msg)) return
      switch (msg.type) {
        case "sessions": {
          sessionStore.loadSessions(msg.sessions)
          setConnection("connected")
          // Auto-select on delete: if active session was removed, pick the next one
          const active = sessionStore.activeSessionId()
          if (active && !msg.sessions.some((s) => s.id === active)) {
            const next = msg.sessions[0]
            if (next) handleSelectSession(next.id)
            else sessionStore.setActiveSession(null)
          }
          if (!restoredInitialView() && props.initialActiveSessionId && msg.sessions.some((s) => s.id === props.initialActiveSessionId)) {
            handleSelectSession(props.initialActiveSessionId!)
            setRestoredInitialView(true)
          }
          setReady(true)
          break
        }
        case "messages": {
          const sid = msg.sessionId ?? sessionStore.activeSessionId()
          if (sid) {
            const isActiveChat = sid === sessionStore.activeSessionId()
            const direction = msg.direction ?? "replace"
            try {
              messageStore.applyMessagePage(sid, msg.messages, {
                start: msg.start,
                end: msg.end,
                total: msg.total,
                direction: msg.direction,
              })
              // Restore model/variant from messages — works for both standalone
              // sessions and pipeline stages, but only when this tab is actively
              // viewing the specific pipeline that owns this session.
              const tabPid = activePipelineId()
              const isActivePipelineView = tabPid !== null && pipelineStore.getPipelineIdForSession(sid) === tabPid
              if ((isActiveChat || isActivePipelineView) && direction === "replace") {
                restoreModelAndVariant(msg.messages)
              }
            } catch (err) {
              console.error("[Atelier] Failed to apply message page:", err)
            }
            if (direction === "replace" && (isActiveChat || sid === loadingSessionId())) {
              endMessagesLoad(sid)
            }
          }
          break
        }
        case "config": {
          debug("config_loaded", { modelCount: msg.models.length })
          setModels(msg.models)
          setConfigLoaded(true)
          setFavorites(msg.favorites ?? [])
          setWorkspacePath(msg.workspacePath)
          if (msg.variant) setSelectedVariant(msg.variant)
          // Re-restore model/variant from current messages now that models are available
          // (messages may have arrived before config, so the initial restore found no matches)
          const activeSid = sessionStore.activeSessionId()
          if (activeSid && msg.models.length > 0) {
            const msgs = messageStore.messages(activeSid)
            if (msgs.length > 0) {
              restoreModelAndVariant(msgs.map((e) => ({ message: e.message, parts: e.parts })))
            }
          }
          if (!selectedModel() && msg.models.length > 0) {
            const fav = resolveTopValidFavorite(msg.favorites ?? [])
            if (fav) {
              const key = findModelKey(fav.providerID, fav.modelID)
              if (key) setSelectedModel(key)
              setSelectedVariant(fav.variant)
            }
            if (!selectedModel()) setSelectedModel(modelKey(msg.models[0]!))
          }
          break
        }
        case "skills":
          setSkills(msg.skills)
          break
        case "favorites.state":
          setFavorites(msg.favorites ?? [])
          break
        case "presets.state":
          setPresets(msg.presets ?? [])
          break
        case "favorites.command.upsertCurrent": {
          const selected = selectedModelObj()
          if (!selected) {
            setSendError("No model is currently selectable; configure a model before favoriting.")
            break
          }
          post({
            type: "favorites.upsert",
            favorite: {
              providerID: selected.providerID,
              modelID: selected.id,
              variant: selectedVariant(),
            },
          })
          break
        }
        case "activeSession":
          // Skip if already active to prevent switchSession → activeSession → switchSession loop
          if (sessionStore.activeSessionId() === msg.sessionId) break
          setNewChatPending(false)
          sessionStore.setActiveSession(msg.sessionId)
          beginMessagesLoad(msg.sessionId)
          post({ type: "switchSession", sessionId: msg.sessionId })
          updateModeFromSession(msg.sessionId)
          setCommittedModel(undefined)
          persistState({ activeSessionId: msg.sessionId, activePipelineId: null })
          break
        case "modeChanged":
          setMode(msg.mode)
          break
        case "fileResults":
          setFileResults(msg.files)
          break
        case "activeFileInserted": {
          setActiveFileInsert({ path: msg.path, startLine: msg.startLine, endLine: msg.endLine })
          requestAnimationFrame(() => setActiveFileInsert(undefined))
          break
        }
        case "activeFileContext":
          setActiveFileContext(msg.path === null ? null : { path: msg.path, relativePath: msg.relativePath, startLine: msg.startLine, endLine: msg.endLine })
          break
        case "pipelines":
          pipelineStore.loadSummaries(msg.pipelines ?? [])
          if (
            !restoredInitialView()
            && !props.initialActiveSessionId
            && props.initialActivePipelineId
            && msg.pipelines?.some((p: PipelineSummary) => p.id === props.initialActivePipelineId)
          ) {
            handleSelectPipeline(props.initialActivePipelineId)
            setRestoredInitialView(true)
          }
          break
        case "pipeline":
          pipelineStore.loadPipeline(msg.pipeline)
          // Restore model/variant from pipeline config
          if (msg.pipeline.model) {
            const key = `${msg.pipeline.model.providerID}:${msg.pipeline.model.modelID}`
            setSelectedModel(key)
            setCommittedModel(key)
          }
          if (msg.pipeline.variant) setSelectedVariant(msg.pipeline.variant)
          if (msg.pipeline.type) {
            setPipelineTypeDetermined(msg.pipeline.type)
            // Fetch presets for this pipeline type (they may not have been loaded yet)
            post({ type: "presets.list", pipelineType: msg.pipeline.type })
          }
          if (msg.pipeline.stageModels) setStageModels(msg.pipeline.stageModels)
          if (msg.pipeline.stageModelsConfirmed) setStageModelsConfirmed(true)
          break
        case "event": {
          const event = msg.event
          if (event.type === "favorites.updated") {
            setFavorites(event.favorites ?? [])
            break
          }
          if (event.type === "config.updated") {
            // Backend became ready — re-fetch config to get full model list
            post({ type: "refreshConfig" })
            break
          }
          // Process skill.used immediately (not buffered) so the pending skill
          // is set BEFORE any REST messages response triggers applyMessagePage.
          if (event.type === "skill.used") {
            messageStore.setPendingSkill(event.sessionId, event.skillName)
          }
          if (event.type === "stageModels.confirmed") {
            setStageModels(event.stageModels)
            setStageModelsConfirmed(true)
            break
          }
          if (event.type === "stageModels.updated") {
            setStageModels(event.stageModels)
            break
          }
          if (event.type === "pipeline.type_determined") {
            setPipelineTypeDetermined(event.pipelineType)
            post({ type: "presets.list", pipelineType: event.pipelineType })
            break
          }
          if (event.type === "presets.state") {
            setPresets(event.presets)
            break
          }
          eventBuffer.push(event)
          if (!frameRequested) {
            frameRequested = true
            requestAnimationFrame(flushEvents)
          }
          break
        }
        case "connectionState":
          setConnection(msg.state)
          break
        case "error":
          console.error(`[Atelier] ${msg.code}: ${msg.message}`)
          if (msg.code === "CONNECTION_LOST") setConnection("disconnected")
          // Always clear loading state on errors — prevents stuck loading skeletons
          endMessagesLoad()
          break
      }
    }

    window.addEventListener("message", handleHostMessage)
    onCleanup(() => {
      window.removeEventListener("message", handleHostMessage)
      clearTimeout(messagesLoadingTimer)
      rpc.dispose()
    })
    post({ type: "ready" })
    post({ type: "requestSkills" })
  })

  const handleSend = async (
    content: string,
    attachments?: PromptParams["attachments"],
    fileContext?: string,
  ): Promise<boolean> => {
    const sid = pipelineActiveSessionId() ?? sessionStore.activeSessionId()
    const currentPipelineId = activePipelineId()
    const modelObj = selectedModelObj()

    // Append file context for the backend (agents need it in the prompt text)
    // Placed at the end so the session title/slug is derived from the actual prompt, not the context tag
    const backendContent = fileContext ? `${content}\n[context: ${fileContext}]` : content

    setSendError(null)
    setSending(true)

    // Show the user message immediately in the UI (optimistic) — clean text, context rendered separately
    if (sid) {
      messageStore.addOptimisticUserMessage(
        sid,
        content,
        modelObj ? { providerID: modelObj.providerID, modelID: modelObj.id } : undefined,
        undefined,
        fileContext,
      )
    }

    try {
      const sendMsg: WebviewMessage = {
        type: "sendMessage",
        content: backendContent,
        mode: mode(),
        sessionId: sid ?? undefined,
        pipelineId: isPipelineMode(mode()) ? (currentPipelineId ?? undefined) : undefined,
        attachments,
        model: modelObj ? { providerID: modelObj.providerID, modelID: modelObj.id } : undefined,
        variant: selectedVariant(),
        sourceSessionId: isPipelineMode(mode()) && !currentPipelineId && sessionStore.activeSessionId()
          ? sessionStore.activeSessionId()!
          : undefined,
      }
      debug("send_message", { sessionId: sid, mode: mode(), contentLength: content.length })
      const result = await rpc.request(sendMsg) as { pipelineId?: string; sessionId?: string }
      // When a new pipeline is created, switch the UI to view it
      if (result.pipelineId && !currentPipelineId) {
        // Clear optimistic message from the build session — it now lives in the pipeline
        if (sid) messageStore.clearOptimisticUserMessage(sid)
        handleSelectPipeline(result.pipelineId)
      }
      // New session created — move optimistic message to the correct session.
      // The bridge already sent activeSession before the RPC response, so the UI
      // may have triggered a switchSession → empty page load.  applyMessagePage
      // preserves optimistic entries, so the message survives regardless of timing.
      if (result.sessionId) {
        if (sid) messageStore.clearOptimisticUserMessage(sid)
        messageStore.addOptimisticUserMessage(
          result.sessionId,
          content,
          modelObj ? { providerID: modelObj.providerID, modelID: modelObj.id } : undefined,
          undefined,
          fileContext,
        )
      }
      return true
    } catch (err) {
      setSendError((err as Error).message)
      if (sid) messageStore.clearOptimisticUserMessage(sid)
      return false
    } finally {
      setSending(false)
    }
  }

  const handleInvokeSkill = async (
    skillName: string,
    content: string,
    attachments?: PromptParams["attachments"],
  ): Promise<boolean> => {
    const sid = pipelineActiveSessionId() ?? sessionStore.activeSessionId()
    const modelObj = selectedModelObj()
    setSendError(null)
    setSending(true)

    // Show the user message immediately (optimistic) with skill metadata
    // Display includes /skillname prefix so user sees what they typed
    const displayContent = content ? `/${skillName} ${content}` : `/${skillName}`
    if (sid) {
      messageStore.addOptimisticUserMessage(
        sid,
        displayContent,
        modelObj ? { providerID: modelObj.providerID, modelID: modelObj.id } : undefined,
        skillName,
      )
    }

    try {
      const invokeMsg: WebviewMessage = {
        type: "invokeSkill",
        skillName,
        content,
        sessionId: sid ?? undefined,
        attachments,
        model: modelObj ? { providerID: modelObj.providerID, modelID: modelObj.id } : undefined,
        variant: selectedVariant(),
      }
      const result = await rpc.request(invokeMsg) as { sessionId?: string }
      // Ensure pending skill is set before switchSession triggers message fetch.
      // The SSE skill.used event may arrive after the REST message page, so set it eagerly here.
      const targetSid = result.sessionId ?? sid
      if (targetSid) messageStore.setPendingSkill(targetSid, skillName)
      // New session created — add optimistic now (same rationale as handleSend)
      if (result.sessionId && !sid) {
        messageStore.addOptimisticUserMessage(
          result.sessionId,
          displayContent,
          modelObj ? { providerID: modelObj.providerID, modelID: modelObj.id } : undefined,
          skillName,
        )
      }
      return true
    } catch (err) {
      setSendError((err as Error).message)
      if (sid) messageStore.clearOptimisticUserMessage(sid)
      return false
    } finally {
      setSending(false)
    }
  }

  // In pipeline mode, find the running stage's session for busy/abort
  const pipelineActiveSessionId = () => {
    if (!isPipelineMode(mode())) return null
    const stages = pipelineStore.stages()
    const active = stages.find(s => s!.status === "running")
        ?? stages.findLast(s => s!.status === "idle" || s!.status === "stuck")
    if (active?.sessionId) return active.sessionId
    // After pipeline completion, use the last stage's session for continued interaction
    if (pipelineStore.pipelineStatus() === "completed") {
      const last = stages.findLast(s => s!.sessionId)
      return last?.sessionId ?? null
    }
    return null
  }

  const handleAbort = () => {
    const sid = pipelineActiveSessionId() ?? sessionStore.activeSessionId()
    if (!sid) return
    post({ type: "abortSession", sessionId: sid })
  }

  const handleConfirmStageModels = (models: Record<string, StageModelConfig>) => {
    const pid = activePipelineId()
    if (!pid) return
    setStageModelsConfirmed(true)
    post({
      type: "stageModels.confirm",
      pipelineId: pid,
      stageModels: models,
    })
  }

  const handleStageModelChange = (stage: string, config: StageModelConfig) => {
    const pid = activePipelineId()
    if (!pid) return
    setStageModels(prev => ({ ...prev, [stage]: config }))
    post({
      type: "stageModels.update",
      pipelineId: pid,
      stage,
      config,
    })
  }

  const handleSavePreset = async (name: string, models: Record<string, StageModelConfig>) => {
    const pType = pipelineTypeDetermined()
    if (!pType) return
    post({
      type: "presets.save",
      pipelineType: pType,
      name,
      stageModels: models,
    })
  }

  const handleLoadPreset = (preset: PresetRecord) => {
    setStageModels(preset.stageModels)
  }

  const isBusy = () => {
    if (sending()) return true
    // In pipeline mode, check stage status directly — the session store may not
    // have the "busy" status yet (SSE race), but the pipeline stage is authoritative.
    if (isPipelineMode(mode())) {
      const stages = pipelineStore.stages()
      if (stages.some(s => s!.status === "running")) return true
      // After pipeline completion, check session-level busy status so the stop
      // button works for follow-up messages sent to the final stage's session.
      if (pipelineStore.pipelineStatus() === "completed") {
        const lastSid = pipelineActiveSessionId()
        return lastSid ? sessionStore.getStatus(lastSid).type === "busy" : false
      }
      return false
    }
    const sid = sessionStore.activeSessionId()
    return sid ? sessionStore.getStatus(sid).type === "busy" : false
  }

  const handleNewSession = () => {
    pipelineStore.deactivate()
    setSendError(null)
    setNewChatPending(true)
    setMode("build")
    const favorite = resolveTopValidFavorite(favorites())
    if (favorite) {
      const key = findModelKey(favorite.providerID, favorite.modelID)
      if (key) {
        setSelectedModel(key)
        setCommittedModel(key)
      }
      setSelectedVariant(favorite.variant)
    }
    // Don't eagerly create a server-side session — the first sendMessage will create
    // one on the correct backend (based on the selected model).  Eager creation
    // caused a double-session bug: POST /session always used the default backend,
    // but POST /message routed to a different backend when the model didn't match,
    // creating a second session and losing the first message.
    sessionStore.setActiveSession(null)
    endMessagesLoad()
    persistState({ activeSessionId: null, activePipelineId: null })
  }

  const handleSelectFavorite = (favorite: FavoriteRecord) => {
    const key = findModelKey(favorite.providerID, favorite.modelID)
    if (!key) return
    setSelectedModel(key)
    setCommittedModel(key)
    setSelectedVariant(favorite.variant)
  }

  const handleSelectSession = (id: string) => {
    debug("select_session", { sessionId: id })
    pipelineStore.deactivate()
    setSendError(null)
    sessionStore.setActiveSession(id)
    beginMessagesLoad(id)
    post({ type: "switchSession", sessionId: id })
    updateModeFromSession(id)
    setCommittedModel(undefined)
    persistState({ activeSessionId: id, activePipelineId: null })
  }
  const handleSelectPipeline = (id: string) => {
    debug("select_pipeline", { pipelineId: id })
    setSendError(null)
    sessionStore.setActiveSession(null)
    // Reset pipeline-specific state so stale values from previous pipeline don't persist
    setStageModels({})
    setStageModelsConfirmed(false)
    setPresets([])
    setPipelineTypeDetermined(null)
    // Derive mode from pipeline type
    const summary = pipelineStore.summaries().find(s => s.id === id)
    setMode(summary?.type === "plan" ? "plan" : summary?.type === "bugfix" ? "bugfix" : "feature")
    post({ type: "loadPipeline", pipelineId: id })
    persistState({ activeSessionId: null, activePipelineId: id })
  }
  const handleDeleteSession = (id: string) => post({ type: "deleteSession", sessionId: id })

  const handleLoadOlder = () => {
    const sid = sessionStore.activeSessionId()
    if (!sid) return
    const info = messageStore.windowInfo(sid)
    if (!info.hasOlder || info.loadingOlder) return
    messageStore.setLoadingOlder(sid, true)
    post({ type: "loadOlderMessages", sessionId: sid, before: info.start, limit: MESSAGE_PAGE_SIZE })
  }

  const handleLoadNewer = () => {
    const sid = sessionStore.activeSessionId()
    if (!sid) return
    const info = messageStore.windowInfo(sid)
    if (!info.hasNewer || info.loadingNewer) return
    messageStore.setLoadingNewer(sid, true)
    post({ type: "loadNewerMessages", sessionId: sid, after: info.end - 1, limit: MESSAGE_PAGE_SIZE })
  }

  const handlePermissionReply = (sessionId: string, id: string, reply: "once" | "always" | "reject") => {
    post({ type: "permissionReply", sessionId, requestId: id, reply })
  }
  const handleQuestionReply = (sessionId: string, id: string, answers: string[][]) => {
    interactionStore.completeQuestion(sessionId, answers, false)
    post({ type: "questionReply", sessionId, requestId: id, answers })
  }
  const handleQuestionReject = (sessionId: string, id: string) => {
    interactionStore.completeQuestion(sessionId, undefined, true)
    post({ type: "questionReject", sessionId, requestId: id })
  }
  const handleFileClick = (path: string, line?: number) => post({ type: "openFile", path, line })

  const handleRequestFiles = (query: string) => {
    post({ type: "requestFiles", query })
  }

  const toggleFileContext = () => {
    const next = !fileContextEnabled()
    setFileContextEnabled(next)
    persistState({ fileContextEnabled: next })
  }

  const tokenInfo = () => {
    const sid = sessionStore.activeSessionId()
    return sid ? messageStore.tokenUsage(sid) : undefined
  }

  const modeLocked = () => {
    // Lock mode only when a pipeline is active — build sessions with messages
    // should still allow switching to pipeline modes (triggers auto-fork)
    return !!pipelineStore.activePipelineId()
  }

  const activeWindow = () => {
    const sid = sessionStore.activeSessionId()
    return sid ? messageStore.windowInfo(sid) : undefined
  }

  const activePipelineId = () =>
    isPipelineMode(mode()) ? pipelineStore.activePipelineId() : null

  const currentRunningStage = () => {
    const stages = pipelineStore.stages()
    return stages.find((s) => s!.status === "running") ?? null
  }

  const currentStageLabel = () => {
    if (!isPipelineMode(mode())) return null
    if (!activePipelineId()) return null
    const running = currentRunningStage()
    if (running) return STAGE_LABELS[running.stage] ?? running.stage
    // Pipeline is active but between stages — still show the button
    if (pipelineTypeDetermined()) return "Models"
    return null
  }

  const getTopologyStages = (): Array<{ stage: string; label: string }> => {
    const type = pipelineTypeDetermined() ?? "feature"
    return getTopologyForType(type)
  }

  return (
    <Show when={ready()} fallback={
      <div class="flex items-center justify-center h-full bg-vsc-sidebar-bg text-vsc-description-fg">
        <div class="flex items-center gap-2">Connecting...</div>
      </div>
    }>
      <Show when={configLoaded()} fallback={
        <div class="flex items-center justify-center h-full bg-vsc-sidebar-bg text-vsc-description-fg">
          <div class="flex items-center gap-2">Connecting to backends...</div>
        </div>
      }>
        <Show when={models().length > 0} fallback={
          <OnboardingCard onCheckAgain={() => post({ type: "refreshConfig" })} />
        }>
          <div
            class="flex flex-col h-full bg-vsc-sidebar-bg text-vsc-editor-fg"
            style={{
              "font-family": "var(--vscode-font-family)",
              "font-size": "var(--vscode-font-size)",
              "font-weight": "var(--vscode-font-weight, 400)",
            }}
          >
            {/* Header bar */}
            <div
              data-testid="header-bar"
              class="flex items-center h-8 px-3 border-b border-vsc-panel-border shrink-0"
              style={{ background: "color-mix(in srgb, var(--vscode-sideBar-background) 84%, var(--vscode-editor-background) 16%)" }}
            >
              <SessionDropdown
                sessions={sessionStore.sessions()}
                activeSessionId={sessionStore.activeSessionId()}
                onNewSession={handleNewSession}
                onSelectSession={handleSelectSession}
                onDeleteSession={handleDeleteSession}
                pipelines={pipelineStore.summaries()}
                activePipelineId={activePipelineId()}
                onSelectPipeline={handleSelectPipeline}
                isLoopActive={(id) => ralphStore.isLoopActive(id)}
              />
              <button
                class="text-xs px-2 py-1 text-vsc-description-fg hover:text-vsc-editor-fg"
                onClick={handleNewSession}
              >
                + New Chat
              </button>
              <div class="ml-auto flex items-center gap-3 text-xs text-vsc-description-fg">
                <Show when={currentStageLabel()}>
                  <div class="relative" ref={stageDropdownContainerRef}>
                    <button
                      data-testid="header-stage-button"
                      class="px-2 py-0.5 rounded text-[11px] hover:bg-vsc-list-hover/30 flex items-center gap-1 transition-colors"
                      classList={{ "bg-vsc-list-hover/20": showStageDropdown() }}
                      onClick={() => {
                        const next = !showStageDropdown()
                        setShowStageDropdown(next)
                        if (next) stageDropdownClickOutside.startListening()
                        else stageDropdownClickOutside.stopListening()
                      }}
                    >
                      {currentStageLabel()}
                      <svg class="w-3 h-3 opacity-50" viewBox="0 0 16 16" fill="none">
                        <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    <Show when={showStageDropdown() && activePipelineId()}>
                      <div class="absolute top-full right-0 mt-1 z-50 rounded-lg border border-vsc-panel-border bg-vsc-editor-bg shadow-lg overflow-hidden">
                        <StageModelPicker
                          pipelineType={pipelineTypeDetermined() ?? "feature"}
                          stages={getTopologyStages()}
                          stageModels={stageModels()}
                          models={models()}
                          favorites={favorites()}
                          presets={presets()}
                          defaultModel={{
                            providerID: selectedModel()?.split(":")[0] ?? "anthropic",
                            modelID: selectedModel()?.split(":")[1] ?? "claude-sonnet-4",
                          }}
                          completedStages={new Set(
                            pipelineStore.stages()
                              .filter(s => s?.status === "completed")
                              .map(s => s!.stage)
                          )}
                          currentStage={currentRunningStage()?.stage}
                          onConfirm={() => {
                            setShowStageDropdown(false)
                            stageDropdownClickOutside.stopListening()
                          }}
                          onStageModelChange={handleStageModelChange}
                          onSavePreset={handleSavePreset}
                          onLoadPreset={handleLoadPreset}
                        />
                      </div>
                    </Show>
                  </div>
                </Show>
                <Show when={tokenInfo()}>
                  <span class="tabular-nums">
                    {tokenInfo()!.input}↓ {tokenInfo()!.output}↑
                    {tokenInfo()!.cache > 0 ? ` ${tokenInfo()!.cache}⚡` : ""}
                  </span>
                </Show>
                <div data-testid="connection-indicator" class="flex items-center gap-1">
                  <span class="inline-block w-1.5 h-1.5 rounded-full" classList={{
                    "bg-vsc-success": connection() === "connected",
                    "bg-vsc-warning animate-pulse": connection() === "reconnecting",
                    "bg-vsc-error": connection() === "disconnected",
                  }} />
                </div>
              </div>
            </div>
            {/* Chat area */}
            <ChatView
              onSend={handleSend}
              onAbort={handleAbort}
              isBusy={isBusy()}
              sending={sending()}
              sendError={sendError()}
              onPermissionReply={handlePermissionReply}
              onQuestionReply={handleQuestionReply}
              onQuestionReject={handleQuestionReject}
              onFileClick={handleFileClick}
              connection={connection()}
              messagesLoading={messagesLoading()}
              hasOlder={activeWindow()?.hasOlder ?? false}
              hasNewer={activeWindow()?.hasNewer ?? false}
              loadingOlder={activeWindow()?.loadingOlder ?? false}
              loadingNewer={activeWindow()?.loadingNewer ?? false}
              onLoadOlder={handleLoadOlder}
              onLoadNewer={handleLoadNewer}
              mode={mode()}
              onModeChange={setMode}
              models={models()}
              selectedModel={selectedModel()}
              onSelectModel={setSelectedModel}
              favorites={favorites()}
              onUpsertFavorite={(favorite: FavoritePair) => post({ type: "favorites.upsert", favorite })}
              onSelectFavorite={handleSelectFavorite}
              onRemoveFavorite={(favoriteKey: string) => post({ type: "favorites.remove", favoriteKey })}
              onReorderFavorites={(favoriteKeys: string[]) => post({ type: "favorites.reorder", favoriteKeys })}
              inputTokens={tokenInfo()?.total}
              fileResults={fileResults()}
              onRequestFiles={handleRequestFiles}
              activeFileInsert={activeFileInsert()}
              activeFileContext={activeFileContext()}
              fileContextEnabled={fileContextEnabled()}
              onToggleFileContext={toggleFileContext}
              modeLocked={modeLocked()}
              variants={availableVariants()}
              selectedVariant={selectedVariant()}
              onVariantChange={setSelectedVariant}
              pipelineStages={pipelineStore.stages()}
              pipelineStatus={pipelineStore.pipelineStatus()}
              onRestartStage={(stageId) => {
                const stage = pipelineStore.stages().find(s => s.id === stageId)
                if (stage) post({ type: "restartPipeline", fromPipeline: pipelineStore.activePipelineId()!, fromStage: stage.stage })
              }}
              onRestartPipeline={() => post({ type: "restartPipeline", fromPipeline: pipelineStore.activePipelineId()!, fromStage: "brainstorm" })}
              skills={skills()}
              onInvokeSkill={handleInvokeSkill}
              onNewChat={handleNewSession}
              onClearError={() => setSendError(null)}
              onStartRalphLoop={(args) => post({ type: "startRalphLoop", ...args })}
              onCancelRalphLoop={() => post({ type: "cancelRalphLoop", sessionId: sessionStore.activeSessionId()! })}
              onSendError={(err) => setSendError(err)}
              stageModels={stageModels()}
              stageModelsConfirmed={stageModelsConfirmed()}
              pipelineType={pipelineTypeDetermined() ?? "feature"}
              presets={presets()}
              onConfirmStageModels={handleConfirmStageModels}
              onStageModelChange={handleStageModelChange}
              onSavePreset={handleSavePreset}
              onLoadPreset={handleLoadPreset}
            />
          </div>
        </Show>
      </Show>
    </Show>
  )
}

export function App(props: AppProps) {
  const post = (msg: WebviewMessage) => props.postMessage?.(msg)
  return (
    <PostMessageProvider value={post}>
      <StoreProvider>
        <AppInner
          postMessage={props.postMessage}
          setState={props.setState}
          initialActiveSessionId={props.initialActiveSessionId}
          initialActivePipelineId={props.initialActivePipelineId}
          initialFileContextEnabled={props.initialFileContextEnabled}
        />
      </StoreProvider>
    </PostMessageProvider>
  )
}
