import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import crypto from "node:crypto"
import type { PipelineStage, StageStatus, Logger, StageModelConfig } from "@atelier/core"
import { validateWithinWorkspace } from "./helpers.js"
import { getTopology } from "./topology.js"

export interface PipelineStateData {
  id: string
  prompt: string
  workspacePath: string
  status: "running" | "completed" | "idle" | "stuck"
  currentStage: string | null
  type: string
  fromPipelineId: string | null
  fromStage: string | null
  model: { providerID: string; modelID: string } | null
  variant: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
  error: string | null
  pipelineDir: string
  title: string | null
  completionOutcome?: string
  stepCounter: number
  stages: StageData[]
  /** fix attempt counts per review stageId — prevents unbounded fix/review loops */
  fixAttempts?: Record<string, number>
  /** Feature branch name, e.g. "atelier/weather-dashboard-3266" */
  gitBranch: string | null
  /** Branch we forked from, e.g. "main" */
  gitBaseBranch: string | null
  /** SHA of the commit we branched from (for Phase 6 rollback) */
  gitBaseCommit: string | null
  worktreePath: string | null
  worktreeChoice: "in-tree" | "worktree" | null
  /** Session ID of the build session this pipeline was forked from, if any */
  sourceSessionId: string | null
  stageModels: Record<string, StageModelConfig>
  stageModelsConfirmed: boolean
}

export interface StageData {
  id: string
  stage: string
  sessionId: string | null
  status: StageStatus
  compiledPromptPath: string | null
  assignedOutputPath: string | null
  outputPath: string | null
  interrupted: boolean
  error: string | null
  startedAt: number
  completedAt: number | null
  verdict?: "done" | "has_issues" | "stuck" | "partial"
  parentReviewStageId?: string
  dynamicallyInserted?: boolean
  /** True for stages re-entered via verdict: "partial" — auditable iteration marker. */
  restartedFromPartial?: boolean
  /** SHA of the commit made after this stage (code-producing stages only) */
  commitSha?: string | null
}

export interface PipelineState {
  createPipeline(opts: {
    prompt: string
    workspacePath: string
    pipelineDir?: string
    fromPipelineId?: string
    fromStage?: string
    model?: { providerID: string; modelID: string }
    variant?: string
    type?: string
    sourceSessionId?: string
  }): string

  getPipeline(id: string): PipelineStateData | null
  listPipelines(): Array<{ id: string; prompt: string; title?: string; status: string; currentStage: string | null; createdAt: number; updatedAt: number; type?: string; completionOutcome?: string }>
  getRunningPipelines(): PipelineStateData[]
  getAllPipelineSessionIds(): string[]
  /** Get the last stage's session ID from the most recently completed pipeline. */
  getLastCompletedSessionId(): string | null

  createStage(opts: { pipelineId: string; stage: string; sessionId?: string; compiledPromptPath?: string; assignedOutputPath?: string; dynamicallyInserted?: boolean; parentReviewStageId?: string; restartedFromPartial?: boolean }): string
  completeStage(pipelineId: string, stageId: string, opts?: { outputPath?: string; compiledPromptPath?: string; verdict?: "done" | "has_issues" | "stuck" | "partial" }): void
  /** Increment the fix attempt count for a review stage and return the new count. */
  incrementFixAttempt(pipelineId: string, reviewStageId: string): number
  setStageError(pipelineId: string, stageId: string, error: string): void
  setStageStuck(pipelineId: string, stageId: string): void
  setStageStatus(pipelineId: string, stageId: string, status: StageStatus): void
  setStageInterrupted(pipelineId: string, stageId: string, interrupted: boolean): void
  setStageSessionId(pipelineId: string, stageId: string, sessionId: string): void
  setPipelineStatus(pipelineId: string, status: PipelineStateData["status"]): void
  incrementStepCounter(pipelineId: string): number

  updatePipelineStage(id: string, stage: string): void
  updatePipelineModel(id: string, model: { providerID: string; modelID: string } | null, variant: string | null): void
  updatePipelineDir(id: string, pipelineDir: string): void
  completePipeline(id: string): void
  failPipeline(id: string, error: string): void
  deletePipeline(id: string): string[]
  markCrashedPipelinesAsIdle(): number

  /** Set git metadata after branch creation. Called once per pipeline. */
  setGitMetadata(pipelineId: string, meta: {
    gitBranch: string
    gitBaseBranch: string
    gitBaseCommit: string
  }): void

  /** Record a commit SHA on a stage after successful commit. */
  setStageCommit(pipelineId: string, stageId: string, sha: string): void

  /** Wait for all pending async disk writes to complete (for testing). */
  setWorktreeMetadata(pipelineId: string, meta: { worktreePath: string; worktreeChoice: "in-tree" | "worktree" }): void
  setPipelineType(pipelineId: string, type: string): void
  setCompletionOutcome(pipelineId: string, outcome: string): void
  setStageModel(pipelineId: string, stage: string, config: StageModelConfig): void
  getStageModel(pipelineId: string, stage: string): StageModelConfig | undefined
  setStageModelConfirmed(pipelineId: string, confirmed: boolean): void
  isStageModelsConfirmed(pipelineId: string): boolean
  flush(): Promise<void>
}

const STATE_FILE = "pipeline-state.json"
const STATE_TMP = "pipeline-state.json.tmp"


export function createPipelineState(workspacePath: string, logger?: Logger): PipelineState {
  const pipelinesDir = path.join(workspacePath, ".atelier", "pipelines")
  const stateIndexDir = path.join(workspacePath, ".atelier", "state")
  const log = logger?.child({ source: "pipeline-state" })

  const cache = new Map<string, PipelineStateData>()

  // Async write queue -- serializes disk writes to prevent races.
  // Cache is updated synchronously (reads never block); disk writes happen async.
  let writeChain = Promise.resolve()

  function queueWrite(fn: () => Promise<void>) {
    writeChain = writeChain.then(fn).catch((err) => {
      log?.error("atelier", "pipeline", "async_write_error", { error: String(err) })
    })
  }

  initialize()

  function initialize() {
    if (fs.existsSync(pipelinesDir)) {
      for (const entry of fs.readdirSync(pipelinesDir)) {
        const dir = path.join(pipelinesDir, entry)
        if (!fs.statSync(dir).isDirectory()) continue

        const tmpFile = path.join(dir, STATE_TMP)
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)

        const stateFile = path.join(dir, STATE_FILE)
        if (fs.existsSync(stateFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(stateFile, "utf-8")) as PipelineStateData
            // Migrate legacy pipelineDir (was .atelier/<slug>, now .atelier/pipelines/<slug>)
            const expectedDir = `.atelier/pipelines/${entry}`
            if (data.pipelineDir && data.pipelineDir !== expectedDir) {
              data.pipelineDir = expectedDir
              // Also fix compiledPromptPath references in stages
              for (const stage of data.stages) {
                if (stage.compiledPromptPath && !stage.compiledPromptPath.startsWith(".atelier/pipelines/")) {
                  stage.compiledPromptPath = stage.compiledPromptPath.replace(/^\.atelier\//, ".atelier/pipelines/")
                }
              }
              save(data)
            }
            cache.set(data.id, data)
          } catch {
            // Corrupt JSON -- skip
          }
        }
      }
    }

    if (fs.existsSync(stateIndexDir)) {
      for (const entry of fs.readdirSync(stateIndexDir)) {
        if (!entry.endsWith(".json")) continue
        const filePath = path.join(stateIndexDir, entry)
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as PipelineStateData
          cache.set(data.id, data)
        } catch {
          // Corrupt -- skip
        }
      }
    }
  }

  function requirePipeline(id: string): PipelineStateData {
    const data = cache.get(id)
    if (!data) throw new Error(`Pipeline not found: ${id}`)
    return data
  }

  function requireStage(data: PipelineStateData, stageId: string): StageData {
    const stage = data.stages.find(s => s.id === stageId)
    if (!stage) throw new Error(`Stage not found: ${stageId}`)
    return stage
  }

  async function atomicWriteAsync(filePath: string, data: PipelineStateData) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true })
    const tmpPath = filePath + ".tmp"
    await fsp.writeFile(tmpPath, JSON.stringify(data, null, 2))
    await fsp.rename(tmpPath, filePath)
  }

  function stateFilePath(data: PipelineStateData): string {
    if (data.pipelineDir) {
      return path.join(workspacePath, data.pipelineDir, STATE_FILE)
    }
    return path.join(stateIndexDir, `${data.id}.json`)
  }

  function save(data: PipelineStateData) {
    data.updatedAt = Date.now()
    cache.set(data.id, data)
    const snapshot = structuredClone(data)
    queueWrite(() => atomicWriteAsync(stateFilePath(snapshot), snapshot))
  }

  function createPipeline(opts: {
    prompt: string
    workspacePath: string
    pipelineDir?: string
    fromPipelineId?: string
    fromStage?: string
    model?: { providerID: string; modelID: string }
    variant?: string
    type?: string
    sourceSessionId?: string
  }): string {

    const id = crypto.randomUUID()
    const now = Date.now()

    const data: PipelineStateData = {
      id,
      prompt: opts.prompt,
      workspacePath: opts.workspacePath,
      status: "running",
      currentStage: null,
      type: opts.type ?? "feature",
      fromPipelineId: opts.fromPipelineId ?? null,
      fromStage: opts.fromStage ?? null,
      model: opts.model ?? null,
      variant: opts.variant ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
      pipelineDir: opts.pipelineDir ?? "",
      title: null,
      stepCounter: 0,
      stages: [],
      gitBranch: null,
      gitBaseBranch: null,
      gitBaseCommit: null,
      worktreePath: null,
      worktreeChoice: null,
      sourceSessionId: opts.sourceSessionId ?? null,
      stageModels: {},
      stageModelsConfirmed: false,
    }

    if (opts.fromPipelineId && opts.fromStage) {
      const source = cache.get(opts.fromPipelineId)
      if (source) {
        const topology = getTopology((data.type as "feature" | "plan" | "epic") ?? "feature")
        const topologyStages = topology.map(d => d.stage)
        const fromIdx = topologyStages.indexOf(opts.fromStage as PipelineStage)
        if (fromIdx > 0) {
          const precedingStages = new Set(topologyStages.slice(0, fromIdx))
          for (const stage of source.stages) {
            // Skip dynamically inserted stages (fixers) — they are reactive detours
            if (stage.dynamicallyInserted) continue
            if (precedingStages.has(stage.stage as PipelineStage)) {
              data.stages.push({ ...stage, status: "skipped" })
            }
          }
        }
      }
    }

    if (opts.pipelineDir) {
      validateWithinWorkspace(opts.pipelineDir, workspacePath, "Pipeline directory")
      queueWrite(async () => {
        await fsp.mkdir(path.join(workspacePath, opts.pipelineDir!), { recursive: true })
      })
    }

    save(data)
    log?.debug("atelier", "pipeline", "pipeline_record_created", { pipelineId: id, data: { type: opts.type, fromPipelineId: opts.fromPipelineId } })
    return id
  }

  function getPipeline(id: string): PipelineStateData | null {
    return cache.get(id) ?? null
  }

  function listPipelines(): Array<{ id: string; prompt: string; title?: string; status: string; currentStage: string | null; createdAt: number; updatedAt: number; type?: string; completionOutcome?: string }> {
    return Array.from(cache.values(), (data) => ({
      id: data.id,
      prompt: data.prompt,
      ...(data.title ? { title: data.title } : {}),
      status: data.status,
      currentStage: data.currentStage,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      ...(data.type ? { type: data.type } : {}),
      ...(data.completionOutcome ? { completionOutcome: data.completionOutcome } : {}),
    }))
  }

  function getRunningPipelines(): PipelineStateData[] {
    return Array.from(cache.values()).filter(d => d.status === "running")
  }

  function getAllPipelineSessionIds(): string[] {
    return Array.from(cache.values()).flatMap(d => d.stages.flatMap(s => s.sessionId ? [s.sessionId] : []))
  }

  function getLastCompletedSessionId(): string | null {
    let latest: { completedAt: number; sessionId: string } | null = null
    for (const data of cache.values()) {
      if (data.status !== "completed") continue
      for (let i = data.stages.length - 1; i >= 0; i--) {
        const stage = data.stages[i]!
        if (stage.sessionId && stage.completedAt) {
          if (!latest || stage.completedAt > latest.completedAt) {
            latest = { completedAt: stage.completedAt, sessionId: stage.sessionId! }
          }
          break // only need the last stage per pipeline
        }
      }
    }
    return latest?.sessionId ?? null
  }

  function createStage(opts: { pipelineId: string; stage: string; sessionId?: string; compiledPromptPath?: string; assignedOutputPath?: string; dynamicallyInserted?: boolean; parentReviewStageId?: string; restartedFromPartial?: boolean }): string {
    const data = requirePipeline(opts.pipelineId)
    const stageId = crypto.randomUUID()
    const stageData: StageData = {
      id: stageId,
      stage: opts.stage,
      sessionId: opts.sessionId ?? null,
      status: "running",
      compiledPromptPath: opts.compiledPromptPath ?? null,
      assignedOutputPath: opts.assignedOutputPath ?? null,
      outputPath: null,
      interrupted: false,
      error: null,
      startedAt: Date.now(),
      completedAt: null,
    }
    if (opts.dynamicallyInserted) stageData.dynamicallyInserted = true
    if (opts.parentReviewStageId) stageData.parentReviewStageId = opts.parentReviewStageId
    if (opts.restartedFromPartial) stageData.restartedFromPartial = true
    data.stages.push(stageData)
    data.currentStage = opts.stage
    save(data)
    log?.debug("atelier", "stage", "stage_record_created", { pipelineId: opts.pipelineId, stageId, stageName: opts.stage })
    return stageId
  }

  function completeStage(pipelineId: string, stageId: string, opts?: { outputPath?: string; compiledPromptPath?: string; verdict?: "done" | "has_issues" | "stuck" | "partial" }) {
    const data = requirePipeline(pipelineId)
    const stage = requireStage(data, stageId)
    stage.status = "completed"
    stage.completedAt = Date.now()
    if (opts?.outputPath) stage.outputPath = opts.outputPath
    if (opts?.compiledPromptPath) stage.compiledPromptPath = opts.compiledPromptPath
    if (opts?.verdict) stage.verdict = opts.verdict
    save(data)
    log?.debug("atelier", "stage", "stage_record_completed", { pipelineId, stageId, data: { verdict: opts?.verdict, outputPath: opts?.outputPath } })
  }

  function incrementFixAttempt(pipelineId: string, reviewStageId: string): number {
    const data = requirePipeline(pipelineId)
    const current = data.fixAttempts?.[reviewStageId] ?? 0
    const next = current + 1
    data.fixAttempts = { ...data.fixAttempts, [reviewStageId]: next }
    save(data)
    log?.debug("atelier", "pipeline", "fix_attempt_incremented", { pipelineId, data: { count: next } })
    return next
  }

  function setStageStuck(pipelineId: string, stageId: string) {
    const data = requirePipeline(pipelineId)
    const stage = requireStage(data, stageId)
    stage.status = "stuck"
    data.status = "stuck"
    save(data)
    log?.debug("atelier", "stage", "stage_status_stuck", { pipelineId, stageId })
  }

  function setStageError(pipelineId: string, stageId: string, error: string) {
    const data = requirePipeline(pipelineId)
    const stage = requireStage(data, stageId)
    stage.error = error
    save(data)
  }

  function setStageStatus(pipelineId: string, stageId: string, status: StageStatus) {
    const data = requirePipeline(pipelineId)
    const stage = requireStage(data, stageId)
    stage.status = status
    save(data)
    log?.debug("atelier", "stage", "stage_status_transition", { pipelineId, stageId, data: { status } })
  }

  function setStageInterrupted(pipelineId: string, stageId: string, interrupted: boolean) {
    const data = requirePipeline(pipelineId)
    const stage = requireStage(data, stageId)
    stage.interrupted = interrupted
    save(data)
  }

  function setStageSessionId(pipelineId: string, stageId: string, sessionId: string) {
    const data = requirePipeline(pipelineId)
    const stage = requireStage(data, stageId)
    stage.sessionId = sessionId
    save(data)
  }

  function setPipelineStatus(pipelineId: string, status: PipelineStateData["status"]) {
    const data = requirePipeline(pipelineId)
    data.status = status
    save(data)
    log?.debug("atelier", "pipeline", "pipeline_status_transition", { pipelineId, data: { status } })
  }

  function incrementStepCounter(pipelineId: string): number {
    const data = requirePipeline(pipelineId)
    data.stepCounter = data.stepCounter + 1
    save(data)
    return data.stepCounter
  }

  function updatePipelineStage(id: string, stage: string) {
    const data = requirePipeline(id)
    data.currentStage = stage
    save(data)
  }

  function updatePipelineModel(id: string, model: { providerID: string; modelID: string } | null, variant: string | null) {
    const data = requirePipeline(id)
    data.model = model
    data.variant = variant
    save(data)
  }

  function updatePipelineDir(id: string, pipelineDir: string) {
    const data = requirePipeline(id)

    const oldPath = stateFilePath(data)
    queueWrite(async () => {
      try { await fsp.unlink(oldPath) } catch { /* may not exist */ }
    })

    validateWithinWorkspace(pipelineDir, workspacePath, "Pipeline directory")
    data.pipelineDir = pipelineDir

    // Extract a human-readable title from the slug embedded in the dir name
    // Format: .atelier/pipelines/YYYY-MM-DD-<slug>-<suffix>
    const dirName = path.basename(pipelineDir)
    const withoutDate = dirName.slice(11) // strip "YYYY-MM-DD-"
    const withoutSuffix = withoutDate.replace(/-[a-z0-9]{4}$/, "")
    if (withoutSuffix) {
      data.title = withoutSuffix.replace(/-/g, " ")
    }

    queueWrite(async () => {
      await fsp.mkdir(path.join(workspacePath, pipelineDir), { recursive: true })
    })

    save(data)
  }

  function completePipeline(id: string) {
    const data = requirePipeline(id)
    data.status = "completed"
    data.completedAt = Date.now()
    save(data)
    log?.debug("atelier", "pipeline", "pipeline_record_completed", { pipelineId: id })
  }

  function failPipeline(id: string, error: string) {
    const data = requirePipeline(id)
    data.status = "stuck"
    data.error = error
    save(data)
    log?.debug("atelier", "pipeline", "pipeline_record_failed", { pipelineId: id, error })
  }

  function deletePipeline(id: string): string[] {
    const data = cache.get(id)
    if (!data) return []

    const sessionIds = data.stages
      .filter(s => s.sessionId)
      .map(s => s.sessionId!)

    if (data.pipelineDir) {
      validateWithinWorkspace(data.pipelineDir, workspacePath, "Pipeline directory")
      const absDir = path.join(workspacePath, data.pipelineDir)
      queueWrite(async () => {
        try { await fsp.rm(absDir, { recursive: true, force: true }) } catch { /* may not exist */ }
      })
    } else {
      const indexFile = path.join(stateIndexDir, `${id}.json`)
      queueWrite(async () => {
        try { await fsp.unlink(indexFile) } catch { /* may not exist */ }
      })
    }

    cache.delete(id)
    return sessionIds
  }

  function setGitMetadata(pipelineId: string, meta: { gitBranch: string; gitBaseBranch: string; gitBaseCommit: string }) {
    const data = requirePipeline(pipelineId)
    data.gitBranch = meta.gitBranch
    data.gitBaseBranch = meta.gitBaseBranch
    data.gitBaseCommit = meta.gitBaseCommit
    save(data)
    log?.debug("atelier", "pipeline", "git_metadata_set", { pipelineId, data: { gitBranch: meta.gitBranch } })
  }

  function setStageCommit(pipelineId: string, stageId: string, sha: string) {
    const data = requirePipeline(pipelineId)
    const stage = requireStage(data, stageId)
    stage.commitSha = sha
    save(data)
    log?.debug("atelier", "stage", "stage_commit_recorded", { pipelineId, stageId, data: { sha } })
  }

  function setWorktreeMetadata(pipelineId: string, meta: { worktreePath: string; worktreeChoice: "in-tree" | "worktree" }) {
    const data = requirePipeline(pipelineId)
    data.worktreePath = meta.worktreePath
    data.worktreeChoice = meta.worktreeChoice
    save(data)
  }

  function setPipelineType(pipelineId: string, type: string) {
    const data = requirePipeline(pipelineId)
    data.type = type
    save(data)
  }

  function setCompletionOutcome(pipelineId: string, outcome: string) {
    const data = requirePipeline(pipelineId)
    data.completionOutcome = outcome
    save(data)
  }

  function markCrashedPipelinesAsIdle(): number {
    let count = 0
    for (const data of cache.values()) {
      if (data.status === "running" || data.status === "stuck") {
        data.status = "idle"
        for (const stage of data.stages) {
          if (stage.status === "running" || stage.status === "stuck") {
            stage.status = "idle"
          }
        }
        save(data)
        log?.debug("atelier", "pipeline", "crashed_pipeline_marked_idle", { pipelineId: data.id })
        count++
      }
    }
    return count
  }

  function setStageModel(pipelineId: string, stage: string, config: StageModelConfig) {
    const data = requirePipeline(pipelineId)
    data.stageModels[stage] = config
    save(data)
  }

  function getStageModel(pipelineId: string, stage: string): StageModelConfig | undefined {
    const data = requirePipeline(pipelineId)
    const stageModel = data.stageModels[stage]
    if (stageModel) return stageModel
    // compile_* stages fall back to the shared "compile" model key
    if (stage.startsWith("compile_")) {
      const compileModel = data.stageModels["compile"]
      if (compileModel) return compileModel
    }
    if (data.model) {
      return { providerID: data.model.providerID, modelID: data.model.modelID, variant: data.variant ?? undefined }
    }
    return undefined
  }

  function setStageModelConfirmed(pipelineId: string, confirmed: boolean) {
    const data = requirePipeline(pipelineId)
    data.stageModelsConfirmed = confirmed
    save(data)
  }

  function isStageModelsConfirmed(pipelineId: string): boolean {
    const data = cache.get(pipelineId)
    return data?.stageModelsConfirmed ?? false
  }

  return {
    createPipeline,
    getPipeline,
    listPipelines,
    getRunningPipelines,
    getAllPipelineSessionIds,
    getLastCompletedSessionId,
    createStage,
    completeStage,
    setStageError,
    setStageStuck,
    setStageStatus,
    setStageInterrupted,
    setStageSessionId,
    setPipelineStatus,
    incrementStepCounter,
    updatePipelineStage,
    updatePipelineModel,
    updatePipelineDir,
    completePipeline,
    failPipeline,
    deletePipeline,
    markCrashedPipelinesAsIdle,
    flush: () => writeChain,
    incrementFixAttempt,
    setGitMetadata,
    setStageCommit,
    setWorktreeMetadata,
    setPipelineType,
    setCompletionOutcome,
    setStageModel,
    getStageModel,
    setStageModelConfirmed,
    isStageModelsConfirmed,
  }
}
