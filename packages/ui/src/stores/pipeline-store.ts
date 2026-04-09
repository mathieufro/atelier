import { createSignal, createMemo } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { PipelineEvent, PipelineDetail, PipelineStage, PipelineStatus, PipelineSummary, StageStatus } from "@atelier/core"
import { debug } from "../debug.js"

interface StageInfo {
  id: string
  stage: PipelineStage
  sessionId?: string
  status: StageStatus
  interrupted?: boolean
  error?: string
  outputPath?: string
}

interface PipelineStoreState {
  stages: Record<string, StageInfo>
  stageOrder: string[]
  sessionToStageId: Record<string, string>
  /** Maps every session ID to its owning pipeline ID — survives pipeline switches */
  sessionToPipelineId: Record<string, string>
}

export function createPipelineStore() {
  const [activePipelineId, setActivePipelineId] = createSignal<string | null>(null)
  const [currentStage, setCurrentStage] = createSignal<PipelineStage | null>(null)
  const [pipelineStatus, setPipelineStatus] = createSignal<PipelineStatus | null>(null)
  const [summaries, setSummaries] = createSignal<PipelineSummary[]>([])
  const [state, setState] = createStore<PipelineStoreState>({
    stages: {},
    stageOrder: [],
    sessionToStageId: {},
    sessionToPipelineId: {},
  })

  const stages = createMemo(() =>
    state.stageOrder.map(id => state.stages[id]).filter((s): s is StageInfo => Boolean(s))
  )

  function sessionToStage(sessionId: string): string | undefined {
    return state.sessionToStageId[sessionId]
  }

  /** Returns the pipeline ID that owns a given session, across all pipelines (not just the active one). */
  function getPipelineIdForSession(sessionId: string): string | undefined {
    return state.sessionToPipelineId[sessionId]
  }

  function loadSummaries(list: PipelineSummary[]): void {
    setSummaries(list)
  }

  function handleEvent(event: PipelineEvent): void {
    const pipelineId = "pipelineId" in event ? event.pipelineId : null
    const isActivePipeline = pipelineId !== null && activePipelineId() === pipelineId

    switch (event.type) {
      case "stage_started":
        debug("stage_started", { pipelineId: event.pipelineId, stage: event.stage })
        // Keep cross-pipeline ownership mapping fresh for all stage sessions.
        if (event.sessionId) {
          setState("sessionToPipelineId", event.sessionId, event.pipelineId)
        }
        // Ensure the pipeline exists in summaries (may arrive via SSE before loadSummaries)
        if (!summaries().some(s => s.id === event.pipelineId)) {
          setSummaries(prev => [...prev, {
            id: event.pipelineId,
            prompt: "",
            status: "running" as const,
            currentStage: event.stage,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }])
        }
        if (!isActivePipeline) {
          setSummaries(prev => prev.map(s =>
            s.id === event.pipelineId ? { ...s, currentStage: event.stage, status: "running" as const, updatedAt: Date.now() } : s
          ))
          break
        }

        setCurrentStage(event.stage)
        setPipelineStatus("running")
        setState(produce(s => {
          s.stages[event.stageId] = {
            id: event.stageId,
            stage: event.stage,
            sessionId: event.sessionId,
            status: "running",
          }
          if (!s.stageOrder.includes(event.stageId)) {
            s.stageOrder.push(event.stageId)
          }
          if (event.sessionId) {
            s.sessionToStageId[event.sessionId] = event.stageId
            s.sessionToPipelineId[event.sessionId] = event.pipelineId
          }
        }))
        setSummaries(prev => prev.map(s =>
          s.id === event.pipelineId ? { ...s, currentStage: event.stage, status: "running" as const, updatedAt: Date.now() } : s
        ))
        break

      case "stage_completed":
        debug("stage_completed", { pipelineId: event.pipelineId, stage: event.stageName })
        if (!isActivePipeline) break
        setState("stages", event.stageId, produce(s => {
          if (s) {
            s.status = "completed"
            if (event.outputPath) s.outputPath = event.outputPath
          }
        }))
        break

      case "stage_interrupted":
        if (!isActivePipeline) break
        setState("stages", event.stageId, produce(s => {
          if (s) s.interrupted = true
        }))
        break

      case "stage_resumed":
        if (!isActivePipeline) break
        setState("stages", event.stageId, produce(s => {
          if (s) s.interrupted = false
        }))
        break

      case "stuck_escalation":
        debug("stuck_escalation", { pipelineId: event.pipelineId, stage: event.stage })
        if (!isActivePipeline) break
        setState("stages", event.stageId, produce(s => {
          if (s) s.status = "stuck"
        }))
        break

      case "fix_stage_inserted":
        // Informational — actual stage creation happens via stage_started
        break

      case "pipeline_title_updated":
        if (summaries().some(s => s.id === event.pipelineId)) {
          setSummaries(prev => prev.map(s =>
            s.id === event.pipelineId ? { ...s, title: event.title, updatedAt: Date.now() } : s
          ))
        } else {
          // Title event may arrive before stage_started — create a placeholder summary
          setSummaries(prev => [...prev, {
            id: event.pipelineId,
            prompt: "",
            title: event.title,
            status: "running" as const,
            currentStage: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }])
        }
        break

      case "pipeline_completed":
        debug("pipeline_completed", { pipelineId: event.pipelineId })
        if (isActivePipeline) {
          setPipelineStatus("completed")
          setCurrentStage(null)
        }
        setSummaries(prev => prev.map(s =>
          s.id === event.pipelineId ? { ...s, status: "completed" as const, currentStage: null, updatedAt: Date.now() } : s
        ))
        break

      // Note: pipeline_failed removed — failures set pipeline to idle via state, not events
    }
  }

  function loadPipeline(detail: PipelineDetail): void {
    setActivePipelineId(detail.id)
    setCurrentStage(detail.currentStage)
    setPipelineStatus(detail.status)
    const stages: Record<string, StageInfo> = {}
    const stageOrder: string[] = []
    const sessionToStageId: Record<string, string> = {}
    // Merge into existing sessionToPipelineId (don't replace — preserve other pipelines' mappings)
    const sessionToPipelineId = { ...state.sessionToPipelineId }
    for (const s of detail.stages) {
      stages[s.id] = {
        id: s.id,
        stage: s.stage,
        sessionId: s.sessionId,
        status: s.status,
        interrupted: s.interrupted,
        error: s.error,
        outputPath: s.outputPath,
      }
      stageOrder.push(s.id)
      if (s.sessionId) {
        sessionToStageId[s.sessionId] = s.id
        sessionToPipelineId[s.sessionId] = detail.id
      }
    }
    setState({ stages, stageOrder, sessionToStageId, sessionToPipelineId })
  }

  function reset(): void {
    const pid = activePipelineId()
    setActivePipelineId(null)
    setCurrentStage(null)
    setPipelineStatus(null)
    setState({ stages: {}, stageOrder: [], sessionToStageId: {}, sessionToPipelineId: state.sessionToPipelineId })
    if (pid) setSummaries(prev => prev.filter(s => s.id !== pid))
  }

  /** Clear the active pipeline view without removing the pipeline from summaries. */
  function deactivate(): void {
    setActivePipelineId(null)
    setCurrentStage(null)
    setPipelineStatus(null)
    setState({ stages: {}, stageOrder: [], sessionToStageId: {}, sessionToPipelineId: state.sessionToPipelineId })
  }

  return {
    activePipelineId,
    currentStage,
    pipelineStatus,
    summaries,
    stages,
    sessionToStage,
    getPipelineIdForSession,
    loadSummaries,
    loadPipeline,
    handleEvent,
    reset,
    deactivate,
  }
}

export type PipelineStore = ReturnType<typeof createPipelineStore>
