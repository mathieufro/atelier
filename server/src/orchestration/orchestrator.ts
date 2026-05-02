import type { Attachment, Logger, BackendId, PipelineType } from "@atelier/core"
import { noopLogger } from "@atelier/core"
import type { AgentEngine } from "@atelier/core/agent-engine"
import type { PipelineState, StageData } from "./pipeline-state.js"
import type { createEventMerger } from "../engine/event-merger.js"
import type { BackendRegistry } from "../engine/backend-registry.js"
import type { BackendProxy } from "../engine/backend-proxy.js"

import {
  type ActivePipeline,
  type QuestionPermissionProxy,
  resolveStartStage,
  validateWithinWorkspace,
  findSignalableStage,
  extractTopicSlug,
  createInternalSession,
  STAGE_TITLES,
} from "./helpers.js"
import { getTopology, getNextStage, CODE_PRODUCING_STAGES, type StageDefinition } from "./topology.js"
import { SIGNAL_FOOTER } from "./skill-loader.js"
import * as gitOps from "./git-ops.js"
import { readSettings } from "@atelier/core/settings"
import { atelierStateDir } from "@atelier/core/state-dir"
import { SessionMonitor } from "../engine/session-monitor.js"
import type { DetectorNormalizedEvent } from "./idle-detector-events.js"
import type { IdleDetectorStagePolicyOverride } from "./idle-detector-config.js"
import { StageRunner } from "./stage-runner.js"
import { handleAutoPermission as autoPermission, type AutoInterventionDeps } from "./auto-intervention.js"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as path from "node:path"

interface OrchestratorConfig {
  engine: AgentEngine
  registry?: BackendRegistry
  pipelineState: PipelineState
  eventMerger: ReturnType<typeof createEventMerger>
  skillsDir: string
  workspacePath: string
  /** Called before each pipeline to ensure the signal tool is deployed in the workspace. */
  ensureToolDeployed?: (targetDir?: string) => Promise<void>
  /** Optional logger — when omitted, logging is silently disabled (no-op). */
  logger?: Logger
  /** Proxy for auto-replying to questions/permissions in autonomous pipeline stages. */
  proxy?: QuestionPermissionProxy
  detectorServerDefaults?: Partial<IdleDetectorStagePolicyOverride>
  /** Override sweep interval for the session monitor (default 5000ms). Useful for tests. */
  sweepIntervalMs?: number
}

export class Orchestrator {
  private config: OrchestratorConfig
  private logger: Logger
  private pipelines = new Map<string, ActivePipeline>()
  private sessionIndex = new Map<string, string>() // sessionId -> pipelineId
  private monitor: SessionMonitor
  private stageRunner: StageRunner
  private autoInterventionDeps: AutoInterventionDeps
  private pendingInteractionIds = new Map<string, Set<string>>()
  /** Maps standalone session IDs to backend IDs for engine resolution on stall. */
  private standaloneSessionBackend = new Map<string, string>()
  /** Sessions pending deferred cleanup — killed when they go idle instead of immediately. */
  private deferredSessionCleanups = new Map<string, { backendId: BackendId; pipelineId: string }>()
  private idleMetrics = {
    stateTransitions: new Map<string, number>(),
    doneUnsignaledDetected: new Map<string, number>(),
    detectionLatencySamples: new Map<string, number[]>(),
    infraUncertainDurationMs: 0,
  }
  private infraUncertainStartedAt = new Map<string, number>()

  /** Resolve the engine for a given backend. Falls back to config.engine if no registry. */
  private async resolveEngine(backendId: BackendId): Promise<AgentEngine> {
    if (this.config.registry) {
      return this.config.registry.getEngine(backendId)
    }
    return this.config.engine
  }

  /** Resolve the engine for a pipeline's session (looks up the pipeline's backendId). */
  private async resolveEngineForSession(sessionId: string): Promise<AgentEngine> {
    const pipeline = this.findPipelineBySession(sessionId)
    return this.resolveEngine(this.resolveBackendForPipelineSession(sessionId, pipeline))
  }

  private resolveBackendForPipelineSession(sessionId: string, active: ActivePipeline | null = this.findPipelineBySession(sessionId)): BackendId {
    const metadataBackend = this.config.registry?.resolveBackendForSession(sessionId)
    if (metadataBackend) return metadataBackend

    const stageId = active?.sessionMap.get(sessionId)
    const stageName = active && stageId
      ? this.ps.getPipeline(active.id)?.stages.find((stage) => stage.id === stageId)?.stage
      : undefined
    const stageModel = active && stageName ? this.ps.getStageModel(active.id, stageName) : undefined
    if (stageModel && this.config.registry) {
      return this.config.registry.resolveBackend({ providerID: stageModel.providerID, modelID: stageModel.modelID })
    }

    return active?.backendId ?? "opencode"
  }

  constructor(config: OrchestratorConfig) {
    this.config = config
    this.logger = config.logger?.child({ source: "orchestrator" }) ?? noopLogger
    this.monitor = new SessionMonitor({
      serverDefaults: config.detectorServerDefaults,
      sweepIntervalMs: config.sweepIntervalMs,
      artifactExists: (assignedOutputPath) => {
        try {
          return fsSync.existsSync(path.join(this.config.workspacePath, assignedOutputPath))
        } catch {
          return false
        }
      },
      onExhausted: (args) => {
        const stage = findSignalableStage(this.ps, args.pipelineId, args.stageId)
        if (!stage || stage.interrupted) return
        const snapshot = this.monitor.getSessionSnapshot(args.sessionId)
        this.logDetectorDecision("exhausted", args, snapshot)
        if (args.reason === "done_unsignaled_timeout") {
          const stageName = this.stageNameForMetric(args.pipelineId, args.stageId)
          this.idleMetrics.doneUnsignaledDetected.set(stageName, (this.idleMetrics.doneUnsignaledDetected.get(stageName) ?? 0) + 1)
        }
        if (snapshot) {
          this.recordLatencySample(args.reason, Math.max(0, performance.now() - snapshot.lastEventAtMs))
        }
        // Idle/done-unsignaled detected — escalate to stuck for user intervention.
        this.ps.setStageStuck(args.pipelineId, args.stageId)
        this.ps.setStageError(args.pipelineId, args.stageId, args.reason)
        this.em.emit({
          type: "stuck_escalation",
          pipelineId: args.pipelineId,
          stageId: args.stageId,
          stage: stage.stage,
          sessionId: args.sessionId,
          reason: args.reason,
        } as Record<string, unknown>)
      },
      onStateChanged: (args) => {
        const key = `${args.from}->${args.to}:${args.stage}`
        this.idleMetrics.stateTransitions.set(key, (this.idleMetrics.stateTransitions.get(key) ?? 0) + 1)
        if (args.to === "IDLE_DETECTED" || args.to === "DONE_UNSIGNALED") {
          const snapshot = this.monitor.getSessionSnapshot(args.sessionId)
          if (snapshot) {
            const category = args.to === "DONE_UNSIGNALED" ? "done_unsignaled" : "idle_candidate"
            this.recordLatencySample(category, Math.max(0, performance.now() - snapshot.lastEventAtMs))
          }
        }
        if (args.to === "INFRA_UNCERTAIN") {
          this.infraUncertainStartedAt.set(args.sessionId, performance.now())
        }
        if (args.from === "INFRA_UNCERTAIN" && args.to !== "INFRA_UNCERTAIN") {
          const started = this.infraUncertainStartedAt.get(args.sessionId)
          if (started !== undefined) {
            this.idleMetrics.infraUncertainDurationMs += Math.max(0, performance.now() - started)
            this.infraUncertainStartedAt.delete(args.sessionId)
          }
        }
      },
      logger: config.logger,
      getEngineSessionState: (sessionId) => {
        const pipeline = this.findPipelineBySession(sessionId)
        const backendId = pipeline
          ? this.resolveBackendForPipelineSession(sessionId, pipeline)
          : this.standaloneSessionBackend.get(sessionId)
        if (!backendId) return null
        const engine = this.config.registry?.getEngineIfReady(backendId as import("@atelier/core").BackendId)
        if (!engine || typeof (engine as any).getSessionState !== "function") return null
        return (engine as any).getSessionState(sessionId)
      },
      // Standalone sessions are never auto-interrupted — see SessionMonitor comment.
    })
    this.stageRunner = new StageRunner({
      engine: config.engine,
      getEngineForPipeline: async (pipelineId) => {
        const pipeline = this.getPipeline(pipelineId)
        // Derive backend from the current active model (which may be a per-stage override)
        // rather than the fixed backendId set at pipeline creation. This allows stages
        // to use models from different providers than the pipeline default.
        if (pipeline?.model && this.config.registry) {
          const backendId = this.config.registry.resolveBackend(pipeline.model)
          return this.resolveEngine(backendId)
        }
        return this.resolveEngine(pipeline?.backendId ?? "opencode")
      },
      pipelineState: config.pipelineState,
      eventMerger: config.eventMerger,
      skillsDir: config.skillsDir,
      workspacePath: config.workspacePath,
      logger: this.logger,
      getPipeline: (id) => this.getPipeline(id),
      resolveSourceTranscriptPath: async ({ pipelineId, sourceSessionId, workspacePath }) =>
        this.resolveSourceTranscriptPath(pipelineId, sourceSessionId, workspacePath),
      stuckStage: async (pid, sid, err) => this.stuckStage(pid, sid, err),
      stuckStageInfrastructure: (pid, err, sid) => this.stuckStageInfrastructure(pid, err, sid),
      onPipelineCompleted: (pid) => {
        this.ps.completePipeline(pid)
        this.logger.info("atelier", "pipeline", "pipeline_completed", { pipelineId: pid })

        // Compute git info for completion event
        const pipelineData = this.ps.getPipeline(pid)
        const commitCount = pipelineData?.stages.filter(s => s.commitSha).length ?? 0
        const gitBranch = pipelineData?.gitBranch ?? undefined

        this.em.emit({
          type: "pipeline_completed",
          pipelineId: pid,
          ...(gitBranch ? { gitBranch, commitCount } : {}),
        } as Record<string, unknown>)

        // Mark completed but keep the pipeline alive — the final stage session stays
        // open for continued user interaction. Cleanup happens on abort or server restart.
        const active = this.pipelines.get(pid)
        if (active) active.completed = true
      },
      onSessionRegistered: ({ sessionId, pipelineId, stageId, stage, assignedOutputPath }) => {
        this.sessionIndex.set(sessionId, pipelineId)
        const active = this.pipelines.get(pipelineId)
        const topology = active ? getTopology(active.pipelineType) : []
        const topologyDef = topology.find((item) => item.stage === stage)
        const stageMode = topologyDef?.mode ?? (stage === "fix_spec" || stage === "classify" ? "interactive" : "autonomous")
        this.monitor.registerPipelineSession({
          pipelineId,
          stageId,
          stage,
          stageMode,
          sessionId,
          assignedOutputPath,
          pipelineConfig: active?.detectorConfig,
          stageOverride: topologyDef?.detectorOverride,
        })
      },
    })
    this.autoInterventionDeps = {
      logger: this.logger,
      proxy: config.proxy,
      findPipelineBySession: (sid: string) => this.findPipelineBySession(sid),
      onInteractionReplied: (sessionId: string, requestId: string) => this.handleInteractionReplied(sessionId, requestId),
    }

  }

  private get ps(): PipelineState { return this.config.pipelineState }
  private get em(): ReturnType<typeof createEventMerger> { return this.config.eventMerger }

  /**
   * Resolve transcript path for source sessions that do not have Claude JSONL files.
   * For OpenCode sessions, export the transcript to a workspace-local JSONL snapshot.
   */
  private async resolveSourceTranscriptPath(
    pipelineId: string,
    sourceSessionId: string,
    workspacePath: string,
  ): Promise<string | null> {
    if (!this.config.registry) return null

    const backendId = this.config.registry.resolveBackendForSession(sourceSessionId)
    if (!backendId || backendId === "claude-code") return null

    const transcriptDir = path.join(workspacePath, ".atelier", "state", "transcripts")
    const transcriptPath = path.join(transcriptDir, `${sourceSessionId}.jsonl`)
    const existing = await fs.access(transcriptPath).then(() => true, () => false)
    if (existing) return transcriptPath

    try {
      const proxy = await this.config.registry.getProxy(backendId)
      const snapshot = await this.exportSessionTranscript(proxy, sourceSessionId)
      if (!snapshot) return null
      await fs.mkdir(transcriptDir, { recursive: true })
      await fs.writeFile(transcriptPath, snapshot, "utf-8")
      this.logger.debug("atelier", "pipeline", "source_transcript_snapshot_created", {
        pipelineId,
        data: { sourceSessionId, backendId, transcriptPath },
      })
      return transcriptPath
    } catch (err) {
      this.logger.warn("atelier", "pipeline", "source_transcript_snapshot_failed", {
        pipelineId,
        error: String(err),
        data: { sourceSessionId, backendId },
      })
      return null
    }
  }

  private async exportSessionTranscript(proxy: BackendProxy, sessionId: string): Promise<string | null> {
    const lines: string[] = []
    const limit = 200
    let cursor = -1
    for (;;) {
      const page = await proxy.getMessages(sessionId, { after: cursor, limit })
      for (const entry of page.messages) {
        lines.push(JSON.stringify({ message: entry.message, parts: entry.parts }))
      }
      if (page.end >= page.total || page.messages.length === 0) break
      cursor = page.end - 1
    }
    return lines.length > 0 ? `${lines.join("\n")}\n` : null
  }

  // ---------------------------------------------------------------------------
  // Pipeline lookup helpers
  // ---------------------------------------------------------------------------

  /** Look up a pipeline by ID. Returns null if not active in memory. */
  getPipeline(pipelineId: string): ActivePipeline | null {
    return this.pipelines.get(pipelineId) ?? null
  }

  /** Find the active pipeline that owns a session. */
  private findPipelineBySession(sessionId: string): ActivePipeline | null {
    const pipelineId = this.sessionIndex.get(sessionId)
    if (!pipelineId) return null
    return this.pipelines.get(pipelineId) ?? null
  }

  /** Returns true if a specific pipeline is active in memory. */
  hasPipeline(pipelineId: string): boolean {
    return this.pipelines.has(pipelineId)
  }

  // ---------------------------------------------------------------------------
  // Session activity tracking
  // ---------------------------------------------------------------------------

  /** Called by the engine on any SSE event for a session */
  handleSessionActivity(_sessionId: string): void {
    // No-op — retained for interface compatibility
  }

  /** Called when session.busy fires — agent is actively processing */
  handleSessionBusy(sessionId: string): void {
    this.handleNormalizedEvent({ kind: "busy_edge", sessionId })
  }

  handleNormalizedEvent(event: DetectorNormalizedEvent, backendId?: string): void {
    // Track backend for standalone sessions so we can resolve the engine on stall
    if (backendId && "sessionId" in event && !this.sessionIndex.has(event.sessionId)) {
      this.standaloneSessionBackend.set(event.sessionId, backendId)
    }
    // Clean up standalone backend tracking when session ends
    if ("sessionId" in event && (event.kind === "idle_edge" || event.kind === "session_error")) {
      this.standaloneSessionBackend.delete(event.sessionId)
    }
    this.monitor.recordNormalizedEvent(event)

    // Stage retry on session_error for pipeline-owned sessions
    if (event.kind === "session_error" && "sessionId" in event && this.sessionIndex.has(event.sessionId)) {
      this.handleStageSessionError(event.sessionId, event.error)
    }
  }

  handleInteractionAsked(sessionId: string, requestId: string): void {
    const existing = this.pendingInteractionIds.get(sessionId) ?? new Set<string>()
    existing.add(requestId)
    this.pendingInteractionIds.set(sessionId, existing)
    this.monitor.addPendingInteraction(sessionId, requestId)
    this.logger.debug("atelier", "session", "interaction_asked_tracked", { sessionId, data: { requestId, pendingCount: existing.size } })
  }

  handleInteractionReplied(sessionId: string, requestId: string): void {
    const existing = this.pendingInteractionIds.get(sessionId)
    if (!existing) return
    existing.delete(requestId)
    this.monitor.clearPendingInteraction(sessionId, requestId)
    this.logger.debug("atelier", "session", "interaction_replied_tracked", { sessionId, data: { requestId, remainingCount: existing.size } })
    if (existing.size === 0) {
      this.pendingInteractionIds.delete(sessionId)
      this.monitor.sweep()
    }
  }

  // ---------------------------------------------------------------------------
  // Pipeline lifecycle
  // ---------------------------------------------------------------------------

  /** Creates pipeline record synchronously and starts execution in background.
   *  Returns {pipelineId, completion} immediately -- use for HTTP routes. */
  startPipelineAsync(prompt: string, opts?: {
    fromPipelineId?: string
    fromStage?: string
    model?: { providerID: string; modelID: string }
    variant?: string
    type?: PipelineType
    autonomous?: boolean
    detectorConfig?: Partial<IdleDetectorStagePolicyOverride>
    sourceSessionId?: string
    /** When provided with worktreeChoice, skips the classify stage entirely. */
    pipelineType?: PipelineType
    worktreeChoice?: "in-tree" | "worktree"
  }): { pipelineId: string; completion: Promise<void> } {
    const pipelineType = opts?.type ?? "feature"

    const pipelineId = this.ps.createPipeline({
       prompt,
       workspacePath: this.config.workspacePath,
       fromPipelineId: opts?.fromPipelineId,
       fromStage: opts?.fromStage,
       model: opts?.model,
       variant: opts?.variant,
       type: pipelineType,
       sourceSessionId: opts?.sourceSessionId,
     })
    this.logger.debug("atelier", "pipeline", "pipeline_created_pre_classify", { pipelineId, data: { pipelineType } })

      const backendId: BackendId = (this.config.registry && opts?.model)
        ? this.config.registry.resolveBackend(opts.model)
        : "opencode"
      this.logger.debug("atelier", "pipeline", "pipeline_backend_resolved", { pipelineId, data: { backendId, modelID: opts?.model?.modelID } })

      const activePipeline: ActivePipeline = {
       id: pipelineId,
       backendId,
       sessionMap: new Map(),
       stageSessionMap: new Map(),
       model: opts?.model,
       variant: opts?.variant,
        topologyIndex: -1,  // pre-topology sentinel — set after classification
        pipelineType,
        autonomous: opts?.autonomous ?? false,
        detectorConfig: opts?.detectorConfig,
        workspacePath: this.config.workspacePath,
      }
     this.pipelines.set(pipelineId, activePipeline)
     this.logger.info("atelier", "pipeline", "pipeline_created", { pipelineId, data: { prompt } })

     if (opts?.fromPipelineId && opts?.fromStage) {
       this.inheritFromSourcePipeline(pipelineId, opts.fromPipelineId)
     }

    const completion = (async () => {
      if (this.config.ensureToolDeployed) {
        this.logger.debug("atelier", "pipeline", "tool_deployed")
        try { await this.config.ensureToolDeployed() } catch (err) {
          await this.failPipeline(pipelineId, `Tool deployment failed: ${(err as Error).message}`)
          return
        }
      }

       // Generate pipeline directory — skip LLM slug generation for pre-classified
       // pipelines (avoids LLM call that hangs in containerized environments).
       // Also skip if already inherited from a source pipeline (restart case).
       const existingPipelineDir = this.pipelines.get(pipelineId)?.pipelineDir
       if (!existingPipelineDir) {
         if (opts?.pipelineType && opts?.worktreeChoice) {
           // Pre-classified: use pure-string slug (no LLM call)
           const { generateTaskSlug, resolveUniquePipelineDir } = await import("../infra/task-slug.js")
           const slug = generateTaskSlug(prompt)
           const datePrefix = new Date().toISOString().slice(0, 10)
           const suffix = pipelineId.slice(0, 4)
           const baseDir = `.atelier/pipelines/${datePrefix}-${slug}-${suffix}`
           const pipelineDir = resolveUniquePipelineDir(this.config.workspacePath, baseDir)
           const p = this.pipelines.get(pipelineId)
           if (p) p.pipelineDir = pipelineDir
           this.ps.updatePipelineDir(pipelineId, pipelineDir)
           // Create the directory before writing progress file
           await fs.mkdir(path.join(this.config.workspacePath, pipelineDir), { recursive: true })
           await this.stageRunner.createBareProgressFile(pipelineDir)
         } else {
           // Normal: use LLM-derived slug
           try {
             const pipelineDir = await this.stageRunner.generatePipelineDir(pipelineId, prompt, opts?.model)
             const p = this.pipelines.get(pipelineId)
             if (p) p.pipelineDir = pipelineDir
             await this.stageRunner.createBareProgressFile(pipelineDir)
           } catch (err) {
             await this.failPipeline(pipelineId, `Slug generation failed: ${(err as Error).message}`)
             return
           }
         }
       }

       const p = this.pipelines.get(pipelineId)
       if (!p) return

       // --- Pipeline restart: skip classification, inherit from source pipeline ---
       if (opts?.fromPipelineId) {
         const sourcePipeline = this.ps.getPipeline(opts.fromPipelineId)
         if (sourcePipeline) {
           p.pipelineType = (sourcePipeline.type ?? "feature") as PipelineType
           p.worktreeChoice = sourcePipeline.worktreeChoice ?? "in-tree"
           if (sourcePipeline.worktreePath) {
             const exists = await fs.access(sourcePipeline.worktreePath).then(() => true, () => false)
             if (exists) {
               p.worktreePath = sourcePipeline.worktreePath
               p.workspacePath = sourcePipeline.worktreePath
             } else {
               const ok = await this.setupWorktree(pipelineId, p)
               if (!ok) return
             }
           }
           this.ps.setPipelineType(pipelineId, p.pipelineType)
           if (p.worktreePath && p.worktreeChoice) {
             this.ps.setWorktreeMetadata(pipelineId, {
               worktreePath: p.worktreePath,
               worktreeChoice: p.worktreeChoice,
             })
           }
         }

         // Git branch verification on resume
         const ok = await this.verifyGitBranch(pipelineId)
         if (!ok) {
           await this.failPipeline(pipelineId, "Cannot resume: working tree is dirty and on wrong branch")
           return
         }
         // Inherit git metadata from source pipeline — branch already exists
         if (sourcePipeline?.gitBranch) {
           this.ps.setGitMetadata(pipelineId, {
             gitBranch: sourcePipeline.gitBranch,
             gitBaseBranch: sourcePipeline.gitBaseBranch!,
             gitBaseCommit: sourcePipeline.gitBaseCommit!,
           })
         }

         // Select topology and start from the requested stage
         const startStage = resolveStartStage(opts.fromStage)
         const topology = getTopology(p.pipelineType)
         const startIdx = topology.findIndex(s => s.stage === startStage)
         p.topologyIndex = startIdx >= 0 ? startIdx : 0
         await this.stageRunner.runStage(pipelineId, topology[p.topologyIndex]!.stage, prompt)
         return
       }

       // --- Plan / Bugfix mode: skip classification, go directly to topology ---
       if (pipelineType === "plan" || pipelineType === "bugfix") {
         p.topologyIndex = 0
         const ok = await this.createFeatureBranchForPipeline(p.id, p)
         if (!ok) return
         const topology = getTopology(pipelineType)
         await this.stageRunner.runStage(p.id, topology[0]!.stage, prompt)
         return
       }

       // --- Pre-classified pipeline: skip classify when both pipelineType and worktreeChoice are provided ---
       if (opts?.pipelineType && opts?.worktreeChoice) {
         p.pipelineType = opts.pipelineType
         p.worktreeChoice = opts.worktreeChoice
         this.ps.setPipelineType(pipelineId, p.pipelineType)
         p.topologyIndex = 0

         if (opts.worktreeChoice === "worktree") {
           const ok = await this.setupWorktree(pipelineId, p)
           if (!ok) { console.error(`[pipeline ${pipelineId}] setupWorktree failed`); return }
         } else {
           const ok = await this.createFeatureBranchForPipeline(p.id, p)
           if (!ok) { console.error(`[pipeline ${pipelineId}] createFeatureBranch failed`); return }
         }
         const topology = getTopology(p.pipelineType)
         console.error(`[pipeline ${pipelineId}] classify_skipped, starting stage: ${topology[0]!.stage}`)
         this.logger.info("atelier", "pipeline", "classify_skipped", { pipelineId, data: { pipelineType: p.pipelineType, worktreeChoice: opts.worktreeChoice } })
         try {
           await this.stageRunner.runStage(p.id, topology[0]!.stage, prompt)
         } catch (err) {
           console.error(`[pipeline ${pipelineId}] runStage threw:`, err)
           throw err
         }
         return
       }

       // --- New pipeline: run classification ---
       await this.stageRunner.runClassifyStage(pipelineId, prompt)
    })()

    return { pipelineId, completion }
  }

  /** Awaitable version for tests -- waits for pipeline execution to complete. */
  async startPipeline(prompt: string, opts?: {
    fromPipelineId?: string
    fromStage?: string
    model?: { providerID: string; modelID: string }
    variant?: string
    type?: PipelineType
    autonomous?: boolean
    detectorConfig?: Partial<IdleDetectorStagePolicyOverride>
    sourceSessionId?: string
  }): Promise<string> {
    const { pipelineId, completion } = this.startPipelineAsync(prompt, opts)
    await completion
    return pipelineId
  }

  // ---------------------------------------------------------------------------
  // Signal handling (agent -> orchestrator)
  // ---------------------------------------------------------------------------

   async handleSignal(signal: { type: string; sessionId: string; outputPath?: string; verdict?: string; action?: string; outcome?: string; pipelineType?: string; worktreeChoice?: string }): Promise<void> {
     const active = this.findPipelineBySession(signal.sessionId)
     if (!active) {
       this.logger.error("atelier", "signal", "signal_rejected", { data: { signalType: signal.type, reason: "no active pipeline" } })
       return
     }

    if (signal.type !== "stage_complete") {
      throw new Error(`Unknown signal type: "${signal.type}"`)
    }

    const stageId = active.sessionMap.get(signal.sessionId)
    if (!stageId) {
      this.logger.error("atelier", "signal", "signal_rejected", { data: { signalType: signal.type, reason: "unknown session" } })
      return
    }

    if (signal.outputPath) {
      validateWithinWorkspace(signal.outputPath, active.workspacePath)
    }

    const stage = this.findSignalableStage(active.id, stageId)
    if (!stage) return

    // --- Mandatory artifact enforcement ---
    // Check BEFORE markSessionTerminal so the idle detector keeps monitoring
    // the agent if we reject the signal (agent needs to write the file and retry).
    const topology = getTopology(active.pipelineType)
    const signalStageDef = topology.find(d => d.stage === stage.stage)
    const requiresArtifact = signalStageDef?.requiresArtifact ||
      (stage.stage.startsWith("fix_") && stage.stage !== "fix_code" && stage.stage !== "fix_hooks")
    if (requiresArtifact) {
      if (!signal.outputPath) {
        this.logger.warn("atelier", "signal", "artifact_missing_output_path", {
          pipelineId: active.id, stageId, stageName: stage.stage,
        })
        throw new Error(
          `Stage "${stage.stage}" requires an output artifact. ` +
          `Call atelier_signal again with outputPath set to the path of your output file.`
        )
      }
      const absArtifactPath = path.isAbsolute(signal.outputPath)
        ? signal.outputPath
        : path.join(active.workspacePath, signal.outputPath)
      try {
        await fs.access(absArtifactPath)
      } catch {
        this.logger.warn("atelier", "signal", "artifact_file_not_found", {
          pipelineId: active.id, stageId, stageName: stage.stage,
          data: { outputPath: signal.outputPath, resolvedPath: absArtifactPath },
        })
        throw new Error(
          `Stage "${stage.stage}" requires an output artifact but the file does not exist: ${signal.outputPath}. ` +
          `Write the file first, then call atelier_signal again with the correct outputPath.`
        )
      }
    }

    // Agent genuinely completed — mark terminal for idle detector
    this.monitor.markSessionTerminal(signal.sessionId)

    this.logger.info("atelier", "signal", "signal_received", { pipelineId: active.id, stageId, data: { signalType: signal.type, stageName: stage.stage, outputPath: signal.outputPath, verdict: signal.verdict, action: signal.action } })

    // --- Classification stage: pre-topology special handling ---
    if (active.currentStage === "classify") {
      if (!signal.pipelineType || !signal.worktreeChoice) {
        throw new Error("Classification signal requires pipelineType and worktreeChoice")
      }

      this.ps.completeStage(active.id, stageId, { outputPath: signal.outputPath })
      this.emitStageCompleted(active.id, stageId, "classify")

      // Apply classification from signal
      active.pipelineType = signal.pipelineType as "task" | "feature" | "epic" | "bugfix"
      active.worktreeChoice = signal.worktreeChoice as "in-tree" | "worktree"
      this.ps.setPipelineType(active.id, active.pipelineType)

      const topology = getTopology(active.pipelineType)
      active.topologyIndex = 0

      // Handle worktree vs in-tree
      if (active.worktreeChoice === "worktree") {
        const ok = await this.setupWorktree(active.id, active)
        if (!ok) {
          this.cleanupStageSession(active.id, stageId)
          return
        }
      } else {
        // In-tree: create feature branch (existing flow)
        const ok = await this.createFeatureBranchForPipeline(active.id, active)
        if (!ok) {
          this.cleanupStageSession(active.id, stageId)
          return
        }
      }

      this.cleanupStageSession(active.id, stageId)

      // Emit pipeline.type_determined event so UI can fetch presets and show model picker
      this.em.emit({
        type: "pipeline.type_determined",
        pipelineId: active.id,
        pipelineType: active.pipelineType,
      } as Record<string, unknown>)

      // Pause pipeline - wait for stageModels.confirmed before starting first topology stage
      this.logger.info("atelier", "pipeline", "pipeline_awaiting_stage_models", { pipelineId: active.id })
      return
    }

    // --- Compile stages: verify output file before advancing ---
    if (stage.stage.startsWith("compile_")) {
      if (!stage.compiledPromptPath) {
        this.stuckStage(active.id, stageId, `Compile stage ${stage.stage} has no compiledPromptPath — registration bug`)
        return
      }
      const compiledPath = stage.compiledPromptPath
      const absCompilePath = path.join(active.workspacePath, compiledPath)
      try {
        await fs.access(absCompilePath)
      } catch {
        this.stuckStage(active.id, stageId, `Compile agent signaled complete but output file missing: ${compiledPath}`)
        return
      }
      if (stage.stage === "compile_brainstorm") {
        active.brainstormCompiledPromptPath = compiledPath
      } else if (stage.stage === "compile_plan") {
        active.planCompiledPromptPath = compiledPath
      } else if (stage.stage === "compile_e2e_plan") {
        active.e2ePlanCompiledPromptPath = compiledPath
      } else if (stage.stage === "compile_roadmap_brainstorm") {
        active.roadmapBrainstormCompiledPromptPath = compiledPath
      } else if (stage.stage === "compile_task_brainstorm") {
        active.taskBrainstormCompiledPromptPath = compiledPath
      }
      this.ps.completeStage(active.id, stageId, { compiledPromptPath: compiledPath })
      this.emitStageCompleted(active.id, stageId, stage.stage)
      await this.advanceOrComplete(active.id)
      this.cleanupStageSession(active.id, stageId)
      return
    }

    // --- Review stages: verdict-based branching ---
    if (signalStageDef?.reviewBehavior) {
      if (!signal.verdict) {
        this.logger.warn("atelier", "stage", "review_missing_verdict", { pipelineId: active.id, stageId, stageName: stage.stage })
      }
      const verdict = signal.verdict || "has_issues"

      if (verdict === "stuck") {
        this.ps.setStageStuck(active.id, stageId)
        this.logger.info("atelier", "stage", "stage_stuck", { pipelineId: active.id, stageId, stageName: stage.stage })
        const stuckEvent: Record<string, unknown> = {
          type: "stuck_escalation",
          pipelineId: active.id,
          stageId,
          stage: stage.stage,
          sessionId: signal.sessionId,
          reviewOutputPath: signal.outputPath,
        }
        this.em.emit(stuckEvent)
        return // pipeline pauses at stuck
      }

      if (verdict === "has_issues") {
        const reviewOutputPath = signal.outputPath || stage.assignedOutputPath || undefined
        this.ps.completeStage(active.id, stageId, { outputPath: reviewOutputPath, verdict: "has_issues" })
        this.emitStageCompleted(active.id, stageId, stage.stage)

        // Insert fixer stage — derive fixer stage name from review stage (review_X → fix_X)
        active.lastReviewOutputPath = reviewOutputPath
        try {
          await this.insertFixerStage(active.id, stageId, stage.stage)
        } catch (err) {
          this.logger.error("atelier", "pipeline", "fixer_start_failed", { pipelineId: active.id, error: String(err) })
          this.ps.failPipeline(active.id, `Failed to start fixer: ${(err as Error).message}`)
          await this.deactivate(active.id)
        }
        this.cleanupStageSession(active.id, stageId)
        return
      }

      // verdict === "done" (or any other value) → advance normally
      this.ps.completeStage(active.id, stageId, { outputPath: signal.outputPath || stage.assignedOutputPath || undefined, verdict: "done" })
      this.emitStageCompleted(active.id, stageId, stage.stage)
      await this.advanceOrComplete(active.id)
      this.cleanupStageSession(active.id, stageId)
      return
    }

    // --- E2E gate: verdict decides whether to proceed with E2E stages or skip them ---
    if (stage.stage === "e2e_gate") {
      const gateVerdict = signal.verdict || "proceed"
      this.ps.completeStage(active.id, stageId, { outputPath: signal.outputPath, verdict: "done" })
      this.emitStageCompleted(active.id, stageId, stage.stage)

      if (gateVerdict === "skip") {
        // Skip E2E stages only, then continue (validate may follow)
        this.logger.info("atelier", "stage", "e2e_skipped", { pipelineId: active.id, data: { reason: "gate verdict: skip" } })
        const e2eStages = new Set(["compile_e2e_plan", "write_e2e_plan", "review_e2e_plan", "e2e"])
        for (const def of topology) {
          if (e2eStages.has(def.stage)) {
            const skippedId = this.ps.createStage({ pipelineId: active.id, stage: def.stage })
            this.ps.setStageStatus(active.id, skippedId, "skipped")
          }
        }
        // Advance past E2E stages to the next non-E2E stage (validate)
        let nextIdx = active.topologyIndex + 1
        while (nextIdx < topology.length && e2eStages.has(topology[nextIdx]!.stage)) {
          nextIdx++
        }
        if (nextIdx >= topology.length) {
          this.ps.completePipeline(active.id)
          this.em.emit({ type: "pipeline_completed", pipelineId: active.id } as Record<string, unknown>)
          active.completed = true
        } else {
          active.topologyIndex = nextIdx
          const pipeline = this.ps.getPipeline(active.id)
          if (pipeline) {
            await this.stageRunner.runStage(active.id, topology[nextIdx]!.stage, pipeline.prompt)
          }
        }
      } else {
        // verdict === "proceed" → advance to compile_e2e_plan normally
        await this.advanceOrComplete(active.id)
      }
      if (!active.completed) {
        this.cleanupStageSession(active.id, stageId)
      }
      return
    }

    // --- Plan gate: dual-signal pattern ---
    if (stage.stage === "plan_gate") {
      if (signal.action === "implement" && !active.planGateImplementing) {
        // First signal: implement — keep session alive, switch to autonomous mode
        active.planGateImplementing = true
        this.logger.info("atelier", "stage", "plan_gate_implement", { pipelineId: active.id, stageId })
        // Switch idle detector to autonomous settings for implementation
        this.monitor.reconfigureSession(signal.sessionId, { stageMode: "autonomous" })
        return // Do NOT complete stage or advance
      }

      // Second signal (stage_complete after implement) or action: "done"
      this.ps.completeStage(active.id, stageId, { outputPath: signal.outputPath })
      this.emitStageCompleted(active.id, stageId, stage.stage)

      const outcome = active.planGateImplementing ? "implemented" : "plan_only"
      this.ps.setCompletionOutcome(active.id, outcome)

      // If implemented, commit code changes
      if (active.planGateImplementing) {
        const wsPath = active.workspacePath
        try {
          await gitOps.stageAll(wsPath)
          if (await gitOps.hasStagedChanges(wsPath)) {
            const topicSlug = active.pipelineDir ? extractTopicSlug(active.pipelineDir) : "unknown"
            const message = `atelier(plan-gate): ${topicSlug} — plan implementation`
            const result = await gitOps.commit(wsPath, message)
            if (result.ok) {
              this.ps.setStageCommit(active.id, stageId, result.sha)
            }
          }
        } catch (err) {
          this.logger.warn("atelier", "git", "plan_gate_commit_failed", { pipelineId: active.id, error: String(err) })
        }
      }

      // Pipeline complete — plan_gate is the last stage
      this.ps.completePipeline(active.id)
      this.logger.info("atelier", "pipeline", "pipeline_completed", { pipelineId: active.id, data: { outcome } })
      const pipelineData = this.ps.getPipeline(active.id)
      const commitCount = pipelineData?.stages.filter(s => s.commitSha).length ?? 0
      const gitBranch = pipelineData?.gitBranch ?? undefined
      this.em.emit({
        type: "pipeline_completed",
        pipelineId: active.id,
        completionOutcome: outcome,
        ...(gitBranch ? { gitBranch, commitCount } : {}),
      } as Record<string, unknown>)
      // Keep session alive for continued user interaction
      active.completed = true
      return
    }

    // --- fix_hooks stages: retry commit on parent stage ---
    if (stage.stage === "fix_hooks") {
      this.ps.completeStage(active.id, stageId, { outputPath: signal.outputPath })
      this.emitStageCompleted(active.id, stageId, stage.stage)

      // Retry commit for the parent code-producing stage
      const parentStageId = stage.parentReviewStageId
      if (!parentStageId) {
        this.stuckStage(active.id, stageId, "fix_hooks has no parentReviewStageId")
        return
      }
      const parentStage = this.ps.getPipeline(active.id)?.stages.find(s => s.id === parentStageId)
      if (!parentStage) {
        this.stuckStage(active.id, stageId, "fix_hooks parent stage not found")
        return
      }

      const result = await this.commitAfterStage(active.id, parentStageId, parentStage.stage)
      if (!result.hookFixInserted) {
        await this.advanceOrComplete(active.id)
      }
      this.cleanupStageSession(active.id, stageId)
      return
    }

    // --- Bugfix stage: set completion outcome ---
    if (stage.stage === "bugfix") {
      const bugfixOutcome = signal.outcome ?? "fixed"
      this.ps.setCompletionOutcome(active.id, bugfixOutcome)
    }

    // --- Regular stages ---
    if (signal.outputPath) {
      if (stage.stage === "brainstorm") active.specPath = signal.outputPath
      if (stage.stage === "write_plan") active.planPath = signal.outputPath
      if (stage.stage === "write_e2e_plan") active.e2ePlanPath = signal.outputPath
      if (stage.stage === "brainstorm_roadmap") active.roadmapPath = signal.outputPath
      if (stage.stage === "task_brainstorm") active.taskSpecPath = signal.outputPath
      if (stage.stage === "quick_plan") active.planPath = signal.outputPath
    }
    this.ps.completeStage(active.id, stageId, { outputPath: signal.outputPath })
    this.emitStageCompleted(active.id, stageId, stage.stage)

    // Commit after stage completion:
    // - Worktree pipelines: commit after EVERY stage (artifacts only exist in ephemeral worktree)
    // - In-tree pipelines: commit only after code-producing stages (artifacts survive on disk)
    if (active.worktreePath || CODE_PRODUCING_STAGES.has(stage.stage)) {
      const result = await this.commitAfterStage(active.id, stageId, stage.stage)
      if (result.hookFixInserted) {
        this.cleanupStageSession(active.id, stageId)
        return // fix_hooks will handle advancement
      }
    }

    // Fixer stages: topologyIndex was not changed when fixer was inserted,
    // so advanceToNextStage correctly advances from the parent review's position
    await this.advanceOrComplete(active.id)
    // Keep the final stage session alive when pipeline completed — user can keep chatting
    if (!active.completed) {
      this.cleanupStageSession(active.id, stageId)
    }
  }

  // ---------------------------------------------------------------------------
  // Pipeline query methods
  // ---------------------------------------------------------------------------

   /** Returns true if the orchestrator has a running (non-completed) pipeline in memory. */
   hasActivePipeline(): boolean {
     for (const p of this.pipelines.values()) {
       if (!p.completed) return true
     }
     return false
   }

   getActiveStageName(pipelineId: string): string | null {
     const active = this.getPipeline(pipelineId)
     return active?.currentStage ?? null
   }

   getActiveStageSessionId(pipelineId: string): string | null {
     const active = this.getPipeline(pipelineId)
     if (!active?.currentStage) return null
     const sid = active.stageSessionMap.get(active.currentStage)
     if (sid) return sid
     // Pipeline completed with a skipped terminal stage (e.g. validate skipped
     // for in-tree pipelines) — currentStage points to the skipped stage which
     // has no session. Fall back to the last session still in the map so the
     // user can keep chatting with the final agent.
     if (active.completed) {
       let lastSid: string | null = null
       for (const [, s] of active.stageSessionMap) lastSid = s
       return lastSid
     }
     // In-memory stageSessionMap is empty but disk state may have a session for
     // this stage (e.g. stage went stuck and cleanup removed the mapping, or a
     // transition crashed before stageSessionMap was populated). Recover from
     // disk so the user can resume interacting with the session.
     const diskPipeline = this.ps.getPipeline(pipelineId)
     if (diskPipeline) {
       const diskStage = diskPipeline.stages.findLast(
         (s: { stage: string }) => s.stage === active.currentStage,
       )
       if (diskStage?.sessionId) {
         active.stageSessionMap.set(active.currentStage, diskStage.sessionId)
         active.sessionMap.set(diskStage.sessionId, diskStage.id)
         active.currentStageId = diskStage.id
         this.sessionIndex.set(diskStage.sessionId, pipelineId)
         if (diskStage.interrupted) active.interrupted = true
         // If the stage/pipeline was stuck, transition back to running so the
         // user's message can flow through normally.
         if (diskStage.status === "stuck") {
           this.ps.setStageStatus(pipelineId, diskStage.id, "running")
           this.ps.setPipelineStatus(pipelineId, "running")
           active.interrupted = true  // treat as interrupted so clearInterruptAndRoute handles it
         }
         this.logger.info("atelier", "recovery", "stage_session_recovered_from_disk", { pipelineId, data: { stage: active.currentStage, sessionId: diskStage.sessionId, wasStuck: diskStage.status === "stuck" } })
         return diskStage.sessionId
       }
     }
     return null
   }

  isStageInterrupted(pipelineId: string): boolean {
    const active = this.getPipeline(pipelineId)
    return active?.interrupted ?? false
  }

  isStageInterruptedForSession(sessionId: string): boolean {
    const active = this.findPipelineBySession(sessionId)
    return active?.interrupted ?? false
  }

  isSessionOwnedByPipeline(sessionId: string): boolean {
    return this.sessionIndex.has(sessionId)
  }

  findPipelineIdBySession(sessionId: string): string | null {
    return this.sessionIndex.get(sessionId) ?? null
  }

  /** Expose the monitor for test access. */
  getMonitor(): SessionMonitor { return this.monitor }

  getActivePipelineIds(): string[] {
    return [...this.pipelines.keys()]
  }

  // ---------------------------------------------------------------------------
  // Pipeline rehydration (after server restart)
  // ---------------------------------------------------------------------------

  /** Re-register a disk-only pipeline into memory so signals and routing work.
   *  Called when a message targets a pipeline that exists on disk but not in memory. */
  async rehydrateFromDisk(pipelineId: string): Promise<boolean> {
    this.logger.debug("atelier", "recovery", "rehydration_started", { pipelineId })
    if (this.pipelines.has(pipelineId)) return true

    const diskPipeline = this.ps.getPipeline(pipelineId)
    if (!diskPipeline || !diskPipeline.currentStage) {
      this.logger.debug("atelier", "recovery", "rehydration_failed", { pipelineId, data: { reason: "no disk pipeline or no current stage" } })
      return false
    }

    // Use findLast to get the most recent stage record — a stage name can appear
    // multiple times if review→fix cycles re-ran it (e.g. two review_spec entries).
    const currentStageData = diskPipeline.stages.findLast(
      (s: { stage: string }) => s.stage === diskPipeline.currentStage,
    )
    if (!currentStageData?.sessionId) return false

    const pipelineType = (diskPipeline.type ?? "feature") as PipelineType
    const topology = getTopology(pipelineType)
    let topologyIdx = topology.findIndex(t => t.stage === diskPipeline.currentStage)

    // Dynamically inserted stages (fix_spec, fix_plan, fix_code, fix_hooks) are not in the
    // static topology. Resolve topologyIndex from the parent review stage so that
    // advanceToNextStage correctly advances from the review stage's position after the
    // fixer completes — without this, topologyIndex falls back to 0 and the pipeline restarts.
    if (topologyIdx < 0 && currentStageData.parentReviewStageId) {
      const parentStage = diskPipeline.stages.find(
        (s: { id: string }) => s.id === currentStageData.parentReviewStageId,
      )
      if (parentStage) {
        topologyIdx = topology.findIndex(t => t.stage === parentStage.stage)
        this.logger.debug("atelier", "recovery", "fixer_topology_resolved", { pipelineId, data: { fixerStage: diskPipeline.currentStage, parentStage: parentStage.stage, topologyIdx } })
      }
    }

    // If still not found, infer from completed stages: use the highest topology position reached
    if (topologyIdx < 0) {
      for (const stage of diskPipeline.stages) {
        const idx = topology.findIndex(t => t.stage === stage.stage)
        if (idx > topologyIdx) topologyIdx = idx
      }
      this.logger.debug("atelier", "recovery", "topology_inferred_from_history", { pipelineId, data: { resolvedIndex: topologyIdx } })
    }

    const backendId: BackendId = (this.config.registry && diskPipeline.model)
      ? this.config.registry.resolveBackend(diskPipeline.model)
      : "opencode"

    const active: ActivePipeline = {
      id: pipelineId,
      backendId,
      sessionMap: new Map([[currentStageData.sessionId, currentStageData.id]]),
      stageSessionMap: new Map([[currentStageData.stage, currentStageData.sessionId]]),
      model: diskPipeline.model ?? undefined,
      variant: diskPipeline.variant ?? undefined,
      pipelineDir: diskPipeline.pipelineDir ?? undefined,
      currentStage: diskPipeline.currentStage,
      currentStageId: currentStageData.id,
      topologyIndex: topologyIdx >= 0 ? topologyIdx : 0,
      pipelineType,
      workspacePath: this.config.workspacePath,
    }

    // Restore worktree fields
    if (diskPipeline.worktreePath) {
      const worktrees = await gitOps.listWorktrees(this.config.workspacePath)
      const exists = worktrees.some(w => w.path === diskPipeline.worktreePath)
      if (!exists) {
        this.ps.failPipeline(pipelineId, `Worktree missing: ${diskPipeline.worktreePath}`)
        this.logger.error("atelier", "recovery", "worktree_missing", { pipelineId, data: { worktreePath: diskPipeline.worktreePath } })
        return false
      }
      active.workspacePath = diskPipeline.worktreePath
      active.worktreePath = diskPipeline.worktreePath
      active.worktreeChoice = (diskPipeline.worktreeChoice as "in-tree" | "worktree" | undefined) ?? "worktree"
    }

    // Handle classify stage in topology resolution
    if (diskPipeline.currentStage === "classify") {
      active.topologyIndex = 0
    }

    // Populate artifact paths from completed stages
    for (const stage of diskPipeline.stages) {
      if (stage.status === "completed") this.populateArtifactPath(pipelineId, stage)
    }

    this.pipelines.set(pipelineId, active)
    this.sessionIndex.set(currentStageData.sessionId, pipelineId)

    // Transition back to running
    this.ps.setPipelineStatus(pipelineId, "running")
    this.ps.setStageStatus(pipelineId, currentStageData.id, "running")

    // If the rehydrated stage was stuck or interrupted, mark as interrupted so
    // the next user message flows through clearInterruptAndRoute.
    if (currentStageData.status === "stuck" || currentStageData.interrupted) {
      active.interrupted = true
    }

    // Register with idle detector
    const topologyDef = topology.find(t => t.stage === currentStageData.stage)
    const stageMode = topologyDef?.mode ?? "autonomous"
    this.monitor.registerPipelineSession({
      pipelineId,
      stageId: currentStageData.id,
      stage: currentStageData.stage,
      stageMode,
      sessionId: currentStageData.sessionId,
      assignedOutputPath: currentStageData.assignedOutputPath ?? undefined,
    })

    this.logger.info("atelier", "pipeline", "pipeline_rehydrated", { pipelineId })
    this.em.emit({
      type: "stage_started",
      pipelineId,
      stageId: currentStageData.id,
      stage: currentStageData.stage,
      sessionId: currentStageData.sessionId,
    } as Record<string, unknown>)
    return true
  }

  // ---------------------------------------------------------------------------
  // Abort / resume / intervention
  // ---------------------------------------------------------------------------

   /** Abort the active stage session -- sets interrupted flag, emits stage_interrupted */
   async abortStageSession(sessionId: string): Promise<void> {
     const active = this.findPipelineBySession(sessionId)
     if (!active) return
     const stageId = active.sessionMap.get(sessionId)
     if (!stageId) return

     this.clearRetryTimer(active)

     // Set interrupted BEFORE cancel so the idle handler (triggered by cancel)
     // sees the flag and skips escalation.
     this.setInterrupted(active.id, stageId, true)

     const engine = await this.resolveEngineForSession(sessionId)
     await engine.interruptSession(sessionId)
     // Also interrupt responder session if one exists
     if (active.responderSessionId) {
       const responderEngine = await this.resolveEngine(active.backendId)
       await responderEngine.interruptSession(active.responderSessionId).catch(() => {})
     }
     this.logger.info("atelier", "stage", "stage_interrupted", { pipelineId: active.id, stageId, sessionId })
     this.em.emit({ type: "stage_interrupted", pipelineId: active.id, stageId, sessionId })
   }

   /** Resume an interrupted stage session -- clears flag, emits stage_resumed */
   async resumeStageSession(sessionId: string): Promise<void> {
     const active = this.findPipelineBySession(sessionId)
     if (!active) return
     const stageId = active.sessionMap.get(sessionId)
     if (!stageId) return

      // Clear interrupted flag in both active object and persistent state
      this.setInterrupted(active.id, stageId, false)
      this.monitor.resetSession(sessionId)
      this.logger.info("atelier", "stage", "stage_resumed", { pipelineId: active.id, stageId, sessionId })
      this.em.emit({ type: "stage_resumed", pipelineId: active.id, stageId, sessionId })
   }

  /** Clear interrupt and route a message to the stage session.
   *  If model/variant are provided, update the pipeline's stored model so
   *  subsequent stages also use the new selection — but only when the new
   *  model resolves to the same backend as the current stage's session.
   *  Crossing backends mid-pipeline would orphan the live session and hand
   *  the next stages an incompatible default. */
  async clearInterruptAndRoute(sessionId: string, content: string, opts?: { model?: { providerID: string; modelID: string }; variant?: string }): Promise<void> {
    const active = this.findPipelineBySession(sessionId)
    if (!active) return
    const stageId = active.sessionMap.get(sessionId)
    if (!stageId) return

    // Apply model/variant override only when it stays within the active session's backend.
    if (opts?.model) {
      const sessionBackend = this.resolveBackendForPipelineSession(sessionId, active)
      const newBackend = this.config.registry?.resolveBackend({ providerID: opts.model.providerID, modelID: opts.model.modelID })
      if (!newBackend || newBackend === sessionBackend) {
        active.model = opts.model
        active.variant = opts.variant
        this.ps.updatePipelineModel(active.id, opts.model, opts.variant ?? null)
      } else {
        this.logger.warn("atelier", "pipeline", "resume_model_backend_mismatch_ignored", {
          pipelineId: active.id,
          sessionId,
          data: { sessionBackend, newBackend, modelId: opts.model.modelID },
        })
      }
    } else if (opts?.variant !== undefined) {
      active.variant = opts.variant
      this.ps.updatePipelineModel(active.id, active.model ?? null, opts.variant ?? null)
    }

    const routed = await this.sendStageMessageWithRepair(sessionId, content, {
      model: active.model,
      variant: active.variant,
    })

    // Clear interrupted flag only after OpenCode accepts the resume message.
    this.setInterrupted(active.id, stageId, false)
    this.monitor.resetSession(routed.sessionId)
    this.em.emit({ type: "stage_resumed", pipelineId: active.id, stageId, sessionId: routed.sessionId })
    this.logger.debug("atelier", "message", "message_routed", { pipelineId: active.id, stageId, sessionId: routed.sessionId, data: { contentLength: routed.content.length } })
  }

  async routeStageMessage(sessionId: string, content: string, opts?: { attachments?: Attachment[]; model?: { providerID: string; modelID: string }; variant?: string }): Promise<void> {
    await this.sendStageMessageWithRepair(sessionId, content, opts)
  }

  private async sendStageMessageWithRepair(
    sessionId: string,
    content: string,
    opts?: { attachments?: Attachment[]; model?: { providerID: string; modelID: string }; variant?: string },
  ): Promise<{ sessionId: string; content: string }> {
    const active = this.findPipelineBySession(sessionId)
    if (!active) throw new Error(`Session ${sessionId} is not owned by an active pipeline`)
    const stageId = active.sessionMap.get(sessionId)
    if (!stageId) throw new Error(`Session ${sessionId} has no active pipeline stage`)

    let targetSessionId = sessionId
    let messageContent = content
    let engine = await this.resolveEngineForSession(sessionId)
    // The per-stage model is the authoritative one — the user-provided opts.model
    // is just a UI-level hint and may belong to a different backend in mixed-
    // backend pipelines. Forwarding it blindly would either be ignored (active
    // sessions ignore the model field) or cross backends and break routing.
    const { model: stageMessageModel, variant: stageMessageVariant } = this.resolveStageMessageModel(active, stageId, opts)

    try {
      await engine.sendMessage(targetSessionId, {
        content: messageContent,
        attachments: opts?.attachments,
        model: stageMessageModel,
        variant: stageMessageVariant,
      })
    } catch (err) {
      const replacementId = await this.repairMissingOpenCodeStageRoute(active, stageId, sessionId, err)
      if (!replacementId) throw err

      const stage = this.ps.getPipeline(active.id)?.stages.find(s => s.id === stageId) ?? null
      targetSessionId = replacementId
      engine = await this.resolveEngineForSession(targetSessionId)
      messageContent = this.buildRecoveredStageMessage(active, stage, content)
      const repaired = this.resolveStageMessageModel(active, stageId, opts)
      await engine.sendMessage(targetSessionId, {
        content: messageContent,
        attachments: opts?.attachments,
        model: repaired.model,
        variant: repaired.variant,
      })
    }

    return { sessionId: targetSessionId, content: messageContent }
  }

  /** Resolve the (model, variant) tuple to send with a stage message. The
   *  per-stage configured model wins over the user-provided UI hint, falling
   *  back to the pipeline default. */
  private resolveStageMessageModel(
    active: ActivePipeline,
    stageId: string,
    opts: { model?: { providerID: string; modelID: string }; variant?: string } | undefined,
  ): { model?: { providerID: string; modelID: string }; variant?: string } {
    const pipeline = this.ps.getPipeline(active.id)
    const stage = pipeline?.stages.find((s) => s.id === stageId)
    const stageModel = stage ? this.ps.getStageModel(active.id, stage.stage) : undefined
    if (stageModel) {
      return {
        model: { providerID: stageModel.providerID, modelID: stageModel.modelID },
        variant: stageModel.variant ?? opts?.variant ?? active.variant,
      }
    }
    return {
      model: opts?.model ?? active.model,
      variant: opts?.variant ?? active.variant,
    }
  }

  private isSessionNotFoundError(err: unknown): boolean {
    const text = err instanceof Error ? `${err.name} ${err.message}` : String(err)
    const lower = text.toLowerCase()
    return lower.includes("session") && lower.includes("not found")
  }

  private async repairMissingOpenCodeStageRoute(
    active: ActivePipeline,
    stageId: string,
    oldSessionId: string,
    err: unknown,
  ): Promise<string | null> {
    if (this.resolveBackendForPipelineSession(oldSessionId, active) !== "opencode" || !this.isSessionNotFoundError(err)) return null

    const pipeline = this.ps.getPipeline(active.id)
    const stage = pipeline?.stages.find(s => s.id === stageId)
    if (!stage) return null
    const stageModel = this.ps.getStageModel(active.id, stage.stage)
    const model = stageModel
      ? { providerID: stageModel.providerID, modelID: stageModel.modelID }
      : active.model
    const variant = stageModel?.variant ?? active.variant

    const engine = await this.resolveEngine("opencode")
    const session = await createInternalSession(engine, active.workspacePath, this.em, {
      parentID: active.id,
      model,
      variant,
      title: STAGE_TITLES[stage.stage] ?? stage.stage,
    })

    active.sessionMap.delete(oldSessionId)
    active.sessionMap.set(session.id, stageId)
    active.stageSessionMap.set(stage.stage, session.id)
    this.sessionIndex.delete(oldSessionId)
    this.sessionIndex.set(session.id, active.id)
    this.ps.setStageSessionId(active.id, stageId, session.id)
    this.monitor.markSessionTerminal(oldSessionId)

    const topologyDef = getTopology(active.pipelineType).find(item => item.stage === stage.stage)
    this.monitor.registerPipelineSession({
      pipelineId: active.id,
      stageId,
      stage: stage.stage,
      stageMode: topologyDef?.mode ?? "autonomous",
      sessionId: session.id,
      assignedOutputPath: stage.assignedOutputPath ?? undefined,
      pipelineConfig: active.detectorConfig,
      stageOverride: topologyDef?.detectorOverride,
    })

    this.logger.warn("atelier", "session", "opencode_stage_session_route_repaired", {
      pipelineId: active.id,
      stageId,
      sessionId: oldSessionId,
      data: { newSessionId: session.id, stage: stage.stage },
    })
    this.em.emit({
      type: "stage_started",
      pipelineId: active.id,
      stageId,
      stage: stage.stage,
      sessionId: session.id,
      model: active.model,
      variant: active.variant,
    } as Record<string, unknown>)

    return session.id
  }

  private buildRecoveredStageMessage(active: ActivePipeline, stage: StageData | null, content: string): string {
    const pipeline = this.ps.getPipeline(active.id)
    const parts = [
      "Atelier repaired the message route for this pipeline stage because the previous OpenCode route no longer accepted messages.",
      "Continue the existing pipeline stage using the workspace files and pipeline artifacts as source of truth. Do not restart from scratch unless the user explicitly asks.",
      `Pipeline ID: ${active.id}`,
      `Stage: ${stage?.stage ?? active.currentStage ?? "unknown"}`,
    ]

    if (pipeline?.prompt) parts.push(`Original user prompt:\n${pipeline.prompt}`)
    if (active.pipelineDir) parts.push(`Pipeline directory: ${path.join(active.workspacePath, active.pipelineDir)}`)
    if (stage?.assignedOutputPath) parts.push(`Expected output artifact: ${path.join(active.workspacePath, stage.assignedOutputPath)}`)

    parts.push(SIGNAL_FOOTER)
    parts.push(`User message to handle now:\n${content}`)
    return parts.join("\n\n")
  }

  // ---------------------------------------------------------------------------
  // Infrastructure failure (called by app.ts on connection loss, etc.)
  // ---------------------------------------------------------------------------

   /** Fail all active pipelines (used when infrastructure crashes) */
   async failAllActivePipelines(error: string): Promise<void> {
     for (const pipelineId of this.pipelines.keys()) {
       await this.failPipeline(pipelineId, error)
     }
   }

  // ---------------------------------------------------------------------------
  // Stage retry on transient API errors
  // ---------------------------------------------------------------------------

  private static readonly MAX_STAGE_RETRIES = 5

  private static isTransientError(error: string): boolean {
    const lower = error.toLowerCase()
    return lower.includes("rate limit") || lower.includes("overloaded")
      || lower.includes("529") || lower.includes("502") || lower.includes("503")
      || lower.includes("500") || lower.includes("timeout")
  }

  /** Handle a session_error for a pipeline-owned session.
   *  Transient errors trigger stage retry with exponential backoff.
   *  Non-transient errors stuck-escalate immediately. */
  private handleStageSessionError(sessionId: string, error?: string): void {
    const active = this.findPipelineBySession(sessionId)
    if (!active) return
    const stageId = active.sessionMap.get(sessionId)
    if (!stageId) return

    // Don't retry if the stage was interrupted by the user
    if (active.interrupted) return

    const stage = this.ps.getPipeline(active.id)?.stages.find(s => s.id === stageId)
    if (!stage || stage.status !== "running") return

    if (!error || !Orchestrator.isTransientError(error)) {
      this.stuckStage(active.id, stageId, error ?? "Session error (non-transient)")
      return
    }

    const retries = active.stageRetryCount ?? new Map()
    active.stageRetryCount = retries
    const count = (retries.get(stage.stage) ?? 0) + 1
    retries.set(stage.stage, count)

    if (count > Orchestrator.MAX_STAGE_RETRIES) {
      this.stuckStage(active.id, stageId, `Transient error after ${Orchestrator.MAX_STAGE_RETRIES} retries: ${error}`)
      return
    }

    const delayMs = 1000 * Math.pow(2, count - 1) // 1s, 2s, 4s, 8s, 16s
    this.logger.warn("atelier", "stage", "stage_retry_scheduled", {
      pipelineId: active.id, stageId,
      data: { attempt: count, delayMs, error },
    })
    this.em.emit({
      type: "stage_retry",
      pipelineId: active.id,
      stageId,
      stage: stage.stage,
      attempt: count,
      error,
      nextRetryMs: delayMs,
    } as Record<string, unknown>)

    // Clean up the failed session before retrying
    this.cleanupStageSession(active.id, stageId)

    // Schedule retry with backoff — store timer handle for abort cancellation
    active.stageRetryTimer = setTimeout(async () => {
      active.stageRetryTimer = undefined
      if (active.interrupted) return // aborted during backoff
      const pipeline = this.ps.getPipeline(active.id)
      if (!pipeline) return
      try {
        await this.stageRunner.runStage(active.id, stage.stage, pipeline.prompt)
      } catch (err) {
        this.logger.error("atelier", "stage", "stage_retry_failed", { pipelineId: active.id, error: String(err) })
        await this.failPipeline(active.id, `Stage retry failed: ${(err as Error).message}`)
      }
    }, delayMs)
  }

  // ---------------------------------------------------------------------------
  // Idle detection
  // ---------------------------------------------------------------------------

  handleSessionIdle(sessionId: string): void {
    // If this session is pending deferred cleanup (signaled stage_complete,
    // now finished its turn), kill the subprocess and evict.
    const deferred = this.deferredSessionCleanups.get(sessionId)
    if (deferred) {
      this.deferredSessionCleanups.delete(sessionId)
      this.logger.debug("atelier", "stage", "deferred_cleanup_on_idle", { data: { sessionId } })
      this.resolveEngine(deferred.backendId)
        .then(async (e) => {
          await e.interruptSession(sessionId)
          e.evictSession?.(sessionId)
        })
        .catch(() => {})
    }
    this.handleNormalizedEvent({ kind: "idle_edge", sessionId })
  }

  // ---------------------------------------------------------------------------
  // Auto-intervention: questions and permissions in autonomous stages
  // ---------------------------------------------------------------------------

  async handleAutoPermission(sessionId: string, requestId: string): Promise<void> {
    await autoPermission(this.autoInterventionDeps, sessionId, requestId)
  }

  // ---------------------------------------------------------------------------
  // Pipeline session / status queries (used by poll endpoint)
  // ---------------------------------------------------------------------------

  /** Returns all session IDs owned by a pipeline (for event filtering in poll endpoint). */
  getSessionsForPipeline(pipelineId: string): Set<string> {
    const active = this.pipelines.get(pipelineId)
    if (!active) return new Set()
    return new Set(active.sessionMap.keys())
  }

  /** Returns the responder session ID for the current stage (if any). */
  getResponderSession(pipelineId: string): string | undefined {
    return this.pipelines.get(pipelineId)?.responderSessionId
  }

  /** Returns the current stage name and whether it's interactive. */
  getCurrentStageInfo(pipelineId: string): { stage: string | null; interactive: boolean } {
    const active = this.pipelines.get(pipelineId)
    if (!active?.currentStage) return { stage: null, interactive: false }
    const stage = active.currentStage
    if (stage === "classify") return { stage, interactive: true }
    const topology = getTopology(active.pipelineType)
    const def = topology.find(t => t.stage === stage)
    return { stage, interactive: def?.mode === "interactive" }
  }

  /** Returns the current status of a pipeline. */
  getPipelineStatus(pipelineId: string): "running" | "completed" | "failed" | "unknown" {
    const active = this.pipelines.get(pipelineId)
    if (active) return active.completed ? "completed" : "running"
    const disk = this.ps.getPipeline(pipelineId)
    if (!disk) return "unknown"
    return disk.status as "running" | "completed" | "failed" | "unknown"
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /** Clean up timers. Call on server shutdown or in test teardown. */
  destroy(): void {
    for (const active of this.pipelines.values()) {
      this.clearRetryTimer(active)
    }
    this.monitor.dispose()
  }

  /** Rescue-commit all active worktree pipelines. Call before server shutdown. */
  async rescueAllWorktrees(): Promise<void> {
    for (const [pipelineId, pipeline] of this.pipelines) {
      if (!pipeline.worktreePath) continue
      try {
        const topicSlug = pipeline.pipelineDir ? extractTopicSlug(pipeline.pipelineDir) : "unknown"
        const sha = await gitOps.rescueCommitWorktree(
          pipeline.workspacePath,
          `${topicSlug} — uncommitted work rescued on server shutdown`,
          this.logger,
        )
        if (sha) {
          this.logger.info("atelier", "git", "shutdown_rescue_commit", {
            pipelineId,
            data: { sha, worktreePath: pipeline.worktreePath },
          })
        }
      } catch (err) {
        this.logger.error("atelier", "git", "shutdown_rescue_failed", {
          pipelineId,
          data: { error: String(err), worktreePath: pipeline.worktreePath },
        })
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Stuck retry (called from stuck-retry endpoint)
  // ---------------------------------------------------------------------------

   /** Retry a stuck stage: insert a fixer or resume the stuck reviewer. */
   async handleStuckRetry(pipelineId: string, stageId: string, action: "fix" | "resume"): Promise<void> {
     const active = this.getPipeline(pipelineId)
     if (!active) throw new Error("Pipeline not active")

     const detail = this.ps.getPipeline(pipelineId)
     const stage = detail?.stages.find(s => s.id === stageId)
     if (!stage || stage.status !== "stuck") throw new Error("Stage is not stuck")

     if (action === "resume") {
       // Resume: transition back to running, clear interrupt, and wake the agent
       this.ps.setStageStatus(pipelineId, stageId, "running")
       this.ps.setPipelineStatus(pipelineId, "running")
        this.setInterrupted(pipelineId, stageId, false)
        if (stage.sessionId) {
          this.handleSessionActivity(stage.sessionId)
          // Send a message to wake the session (it may have been aborted/idle)
          const engine = await this.resolveEngineForSession(stage.sessionId)
          await engine.sendMessage(stage.sessionId, { content: "The stuck state has been cleared. Continue your review and call atelier_signal when done." })
        }
       this.logger.info("atelier", "stage", "stage_resumed_from_stuck", { pipelineId, stageId, stageName: stage.stage })
       this.em.emit({ type: "stage_resumed", pipelineId, stageId, sessionId: stage.sessionId })
       return
     }

     // action === "fix"
     this.ps.setPipelineStatus(pipelineId, "running")
     const topology = getTopology(active.pipelineType)
    const topologyDef = topology.find(d => d.stage === stage.stage)

    if (topologyDef?.reviewBehavior) {
      // Insert fixer stage — derive fixer stage name from review stage (review_X → fix_X)
      this.ps.completeStage(pipelineId, stageId, { verdict: "has_issues" })
      this.emitStageCompleted(pipelineId, stageId, stage.stage)
      await this.insertFixerStage(pipelineId, stageId, stage.stage)
      this.cleanupStageSession(pipelineId, stageId)
    } else {
      // Cannot insert a fixer for this stage — escalate to user rather than leaving pipeline wedged
      this.ps.setStageStuck(pipelineId, stageId)
      this.em.emit({
        type: "stuck_escalation",
        pipelineId,
        stageId,
        stage: stage.stage,
        sessionId: stage.sessionId ?? "",
        reason: "Cannot insert fixer for this stage type",
      })
    }
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  private static readonly MAX_FIX_ATTEMPTS = 3

  // ---------------------------------------------------------------------------
  // Git operations
  // ---------------------------------------------------------------------------

  /** Check if git operations are enabled for a pipeline.
   *  Worktree pipelines always have git enabled (worktrees are git constructs).
   *  In-tree pipelines respect the user's gitEnabled setting. */
  private isGitEnabled(pipelineId?: string): boolean {
    if (pipelineId) {
      const active = this.pipelines.get(pipelineId)
      if (active?.worktreePath) return true
    }
    return readSettings(atelierStateDir(this.config.workspacePath)).gitEnabled
  }


  /** Create a worktree for a pipeline. Returns false on failure.
   *  Git is implicitly required — worktrees are git constructs. */
  private async setupWorktree(pipelineId: string, active: ActivePipeline): Promise<boolean> {
    const wsPath = this.config.workspacePath
    try { await gitOps.ensureGitRepo(wsPath) } catch (err) {
      await this.failPipeline(pipelineId, `Git init failed: ${(err as Error).message}`)
      return false
    }
    const slug = extractTopicSlug(active.pipelineDir!)
    const worktreePath = path.join(wsPath, ".atelier", "worktrees", slug)
    let branchName = `atelier/${slug}`
    let suffix = 2
    while (await gitOps.branchExists(wsPath, branchName)) {
      branchName = `atelier/${slug}-${suffix}`
      suffix++
    }
    const result = await gitOps.addWorktree(wsPath, worktreePath, branchName)
    if (!result.ok) {
      await this.failPipeline(pipelineId, `Worktree creation failed: ${result.error}`)
      return false
    }
    const worktreePipelineDir = path.join(worktreePath, active.pipelineDir!)
    await fs.mkdir(worktreePipelineDir, { recursive: true })
    const mainProgressPath = path.join(wsPath, active.pipelineDir!, "progress.md")
    const wtProgressPath = path.join(worktreePipelineDir, "progress.md")
    try { await fs.copyFile(mainProgressPath, wtProgressPath) } catch {}
    // Deploy tools to the worktree's local state dir (~/.atelier/<hash>),
    // same as in-tree pipelines. Never deploy to the worktree root.
    if (this.config.ensureToolDeployed) {
      try { await this.config.ensureToolDeployed(atelierStateDir(worktreePath)) } catch (err) {
        this.logger.info("atelier", "pipeline", "tool_deploy_failed", { pipelineId, error: String(err) })
      }
    }
    active.workspacePath = worktreePath
    active.worktreePath = worktreePath
    const baseBranch = await gitOps.getCurrentBranch(wsPath)
    const baseCommit = await gitOps.getHeadSha(wsPath)
    this.ps.setGitMetadata(pipelineId, { gitBranch: branchName, gitBaseBranch: baseBranch, gitBaseCommit: baseCommit })
    this.ps.setWorktreeMetadata(pipelineId, { worktreePath, worktreeChoice: "worktree" })
    this.em.emit({ type: "git_branch_created", pipelineId, branch: branchName, baseBranch, baseCommit } as Record<string, unknown>)
    this.em.emit({ type: "worktree_created", pipelineId, worktreePath, branch: branchName } as Record<string, unknown>)
    this.logger.info("atelier", "pipeline", "worktree_created", { pipelineId, data: { worktreePath, branchName } })
    return true
  }

  /** Create a feature branch for a new pipeline. Returns false on failure (pipeline already failed). */
  private async createFeatureBranchForPipeline(pipelineId: string, p: ActivePipeline): Promise<boolean> {
    if (!this.isGitEnabled(pipelineId)) return true
    try {
      const wsPath = this.config.workspacePath
      await gitOps.ensureGitRepo(wsPath)

      if (await gitOps.isRebaseOrMergeInProgress(wsPath)) {
        this.logger.warn("atelier", "pipeline", "rebase_or_merge_in_progress", { pipelineId })
      }

      if (!(await gitOps.isWorkingTreeClean(wsPath))) {
        this.logger.warn("atelier", "pipeline", "dirty_working_tree", { pipelineId })
      }

      const baseBranch = await gitOps.getCurrentBranch(wsPath)
      const baseCommit = await gitOps.getHeadSha(wsPath)

      // Slug keeps the 4-char suffix for branch uniqueness (unlike extractTopicSlug used in commit messages)
      const taskSlug = path.basename(p.pipelineDir!).slice(11)
      let branchName = `atelier/${taskSlug}`

      // Handle branch name collision with incrementing suffix
      let suffix = 2
      while (await gitOps.branchExists(wsPath, branchName)) {
        branchName = `atelier/${taskSlug}-${suffix}`
        suffix++
      }
      await gitOps.createFeatureBranch(wsPath, branchName)

      this.ps.setGitMetadata(pipelineId, {
        gitBranch: branchName,
        gitBaseBranch: baseBranch,
        gitBaseCommit: baseCommit,
      })

      this.em.emit({
        type: "git_branch_created",
        pipelineId,
        branch: branchName,
        baseBranch,
        baseCommit,
      } as Record<string, unknown>)

      this.logger.info("atelier", "git", "git_branch_created", {
        pipelineId,
        data: { branch: branchName, baseBranch, baseCommit },
      })

      return true
    } catch (err) {
      await this.failPipeline(pipelineId, `Failed to create feature branch: ${(err as Error).message}`)
      return false
    }
  }

  /** Commit changes after a code-producing stage completes. */
  private async commitAfterStage(
    pipelineId: string,
    stageId: string,
    stageName: string,
  ): Promise<{ committed: boolean; hookFixInserted: boolean }> {
    if (!this.isGitEnabled(pipelineId)) return { committed: false, hookFixInserted: false }

    const active = this.getPipeline(pipelineId)
    const wsPath = active?.workspacePath ?? this.config.workspacePath

    try {
      await gitOps.stageAll(wsPath)
    } catch (err) {
      this.stuckStage(pipelineId, stageId, `git add failed: ${(err as Error).message}`)
      return { committed: false, hookFixInserted: false }
    }

    if (!(await gitOps.hasStagedChanges(wsPath))) {
      this.logger.info("atelier", "git", "nothing_to_commit", { pipelineId, stageId, data: { stage: stageName } })
      return { committed: false, hookFixInserted: false }
    }

    // Build commit message
    const topicSlug = active?.pipelineDir ? extractTopicSlug(active.pipelineDir) : "unknown"
    const desc = stageName === "fix_code" ? "applied code review fixes" : `${stageName} complete`
    const message = `atelier(${stageName}): ${topicSlug} — ${desc}`

    const result = await gitOps.commit(wsPath, message)

    if (result.ok) {
      this.ps.setStageCommit(pipelineId, stageId, result.sha)
      this.em.emit({
        type: "git_committed",
        pipelineId,
        stageId,
        stage: stageName,
        sha: result.sha,
        message,
      } as Record<string, unknown>)
      this.logger.info("atelier", "git", "git_committed", { pipelineId, stageId, data: { sha: result.sha } })
      return { committed: true, hookFixInserted: false }
    }

    if (result.hookFailed) {
      return this.handleHookFailure(pipelineId, stageId, stageName, result.error)
    }

    // Non-hook git error — escalate
    this.stuckStage(pipelineId, stageId, `git commit failed: ${result.error}`)
    return { committed: false, hookFixInserted: false }
  }

  /** Handle a pre-commit hook failure by inserting a fix_hooks stage. */
  private async handleHookFailure(
    pipelineId: string,
    stageId: string,
    stageName: string,
    hookError: string,
  ): Promise<{ committed: boolean; hookFixInserted: boolean }> {
    // Emit hook failure event
    this.em.emit({
      type: "git_hook_failed",
      pipelineId,
      stageId,
      stage: stageName,
      error: hookError,
    } as Record<string, unknown>)

    // Track attempts with namespaced key
    const attemptKey = `hook_fix:${stageId}`
    const attempts = this.ps.incrementFixAttempt(pipelineId, attemptKey)

    if (attempts > Orchestrator.MAX_FIX_ATTEMPTS) {
      this.logger.error("atelier", "git", "hook_fix_exhausted", { pipelineId, stageId, data: { attempts } })
      this.stuckStage(pipelineId, stageId, `Pre-commit hooks failed after ${Orchestrator.MAX_FIX_ATTEMPTS} fix attempts: ${hookError}`)
      return { committed: false, hookFixInserted: false }
    }

    // Build fix_hooks task instruction
    const taskInstruction = `Fix the following pre-commit hook violations. The hooks ran during a git commit after the ${stageName} stage and failed.\n\nHook error output:\n${hookError}\n\nFix all issues reported above. Do not bypass or disable hooks.`

    const pipeline = this.ps.getPipeline(pipelineId)
    if (pipeline) {
      await this.stageRunner.runStage(pipelineId, "fix_hooks", taskInstruction, {
        dynamicallyInserted: true,
        parentReviewStageId: stageId,
      })
    }

    return { committed: false, hookFixInserted: true }
  }

  /** Verify the git branch on pipeline resume. Returns true if ok, false if dirty on wrong branch. */
  private async verifyGitBranch(pipelineId: string): Promise<boolean> {
    if (!this.isGitEnabled(pipelineId)) return true

    const pipeline = this.ps.getPipeline(pipelineId)
    if (!pipeline?.gitBranch) return true // legacy pipeline, no git

    const wsPath = this.config.workspacePath
    const currentBranch = await gitOps.getCurrentBranch(wsPath)

    if (currentBranch === pipeline.gitBranch) return true

    // Wrong branch — try to checkout
    if (await gitOps.isWorkingTreeClean(wsPath)) {
      await gitOps.checkoutBranch(wsPath, pipeline.gitBranch)
      this.logger.info("atelier", "git", "branch_recovered", {
        pipelineId,
        data: { from: currentBranch, to: pipeline.gitBranch },
      })
      return true
    }

    // Dirty tree on wrong branch — cannot recover
    return false
  }

  /** Insert a fixer stage derived from a review stage (review_X -> fix_X). */
  private async insertFixerStage(pipelineId: string, stageId: string, reviewStageName: string): Promise<void> {
    const attempts = this.ps.incrementFixAttempt(pipelineId, stageId)
    if (attempts > Orchestrator.MAX_FIX_ATTEMPTS) {
      this.logger.warn("atelier", "pipeline", "fix_attempts_exhausted", { pipelineId, stageId, data: { attempts } })
      this.ps.setStageStuck(pipelineId, stageId)
      this.em.emit({
        type: "stuck_escalation",
        pipelineId,
        stageId,
        stage: reviewStageName,
        sessionId: "",
        reason: "Max fix attempts reached",
      })
      return
    }

    const fixerStageName = reviewStageName.replace("review_", "fix_")
    this.em.emit({
      type: "fix_stage_inserted",
      pipelineId,
      stageId,
      fixStage: fixerStageName,
      parentReviewStageId: stageId,
    })
    const pipeline = this.ps.getPipeline(pipelineId)
    if (pipeline) {
      await this.stageRunner.runStage(pipelineId, fixerStageName, pipeline.prompt, {
        dynamicallyInserted: true,
        parentReviewStageId: stageId,
      })
    }
  }

  private emitStageCompleted(pipelineId: string, stageId: string, stageName: string): void {
    this.logger.info("atelier", "stage", "stage_completed", { pipelineId, stageId, stageName })
    this.em.emit({ type: "stage_completed", pipelineId, stageId, stageName } as Record<string, unknown>)
    // Session index cleanup is deferred — callers call cleanupStageSession after advancing the pipeline
    // to avoid dropping SSE events that arrive while the engine session is still closing.
  }

  /** Remove stage session routing while keeping session history available. */
  private cleanupStageSession(pipelineId: string, stageId: string): void {
     const active = this.getPipeline(pipelineId)
     if (!active) return
      // Find the sessionId for this stage
      let sessionId: string | undefined
      for (const [sid, sId] of active.sessionMap) {
        if (sId === stageId) { sessionId = sid; break }
      }
      if (!sessionId) return
      // Capture backendId before clearing maps; mixed-backend pipelines may use a
      // different backend for this stage than the pipeline's initial backend.
      const backendId = this.resolveBackendForPipelineSession(sessionId, active)

      active.sessionMap.delete(sessionId)
      this.sessionIndex.delete(sessionId)
      // Clean stageSessionMap to prevent stale entries from being returned by
      // getActiveStageSessionId() after the pipeline advances to a new stage.
      for (const [stage, sid] of active.stageSessionMap) {
        if (sid === sessionId) {
          active.stageSessionMap.delete(stage)
          break
        }
      }
      this.logger.debug("atelier", "stage", "session_cleaned_up", { data: { stageId, sessionId } })

      // Clean up responder session if one exists for this stage.
      // Only clean up if the stage being cleaned is still the current stage —
      // if a new stage already started (via advanceOrComplete before cleanup),
      // it may have created a fresh responder that we must not touch.
      if (active.responderSessionId && active.currentStageId === stageId) {
        const responderId = active.responderSessionId
        active.responderSessionId = undefined
        this.resolveEngine(backendId).then(eng => {
          eng.interruptSession(responderId).catch(() => {})
          eng.evictSession?.(responderId)
        }).catch(() => {})
      }

      // Defer session termination: let the agent finish its current turn naturally
      // (e.g. write final output after atelier_signal tool returns) before killing
      // the subprocess. The idle callback fires when the turn completes.
      const sid = sessionId
      this.deferredSessionCleanups.set(sid, { backendId, pipelineId })
      // Safety timeout: kill after 60s even if idle never fires (e.g. agent loops)
      setTimeout(() => {
        if (this.deferredSessionCleanups.delete(sid)) {
          this.logger.debug("atelier", "stage", "deferred_cleanup_timeout", { data: { sessionId: sid } })
          this.resolveEngine(backendId)
            .then(async (e) => {
              await e.interruptSession(sid)
              e.evictSession?.(sid)
            })
            .catch(() => {})
        }
      }, 60_000)
  }

  /** Delete the OpenCode session for a completed/failed stage to free Go-side memory. */
   private async advanceOrComplete(pipelineId: string): Promise<void> {
    try {
      await this.stageRunner.advanceToNextStage(pipelineId)
     } catch (err) {
       this.logger.error("atelier", "pipeline", "advance_failed", { pipelineId, error: String(err) })
       this.ps.failPipeline(pipelineId, `Failed to start next stage: ${(err as Error).message}`)
       await this.deactivate(pipelineId)
     }
  }

  /** Populate artifact paths on this.active from a completed/skipped stage record. */
   private populateArtifactPath(pipelineId: string, stage: StageData): void {
     const active = this.getPipeline(pipelineId)
     if (!active) return
     if (stage.stage === "brainstorm" && stage.outputPath) active.specPath = stage.outputPath
     if (stage.stage === "compile_brainstorm" && stage.compiledPromptPath) active.brainstormCompiledPromptPath = stage.compiledPromptPath
     if (stage.stage === "compile_plan" && stage.compiledPromptPath) active.planCompiledPromptPath = stage.compiledPromptPath
     if (stage.stage === "write_plan" && stage.outputPath) active.planPath = stage.outputPath
     if (stage.stage === "compile_e2e_plan" && stage.compiledPromptPath) active.e2ePlanCompiledPromptPath = stage.compiledPromptPath
     if (stage.stage === "write_e2e_plan" && stage.outputPath) active.e2ePlanPath = stage.outputPath
     if (stage.stage === "brainstorm_roadmap" && stage.outputPath) active.roadmapPath = stage.outputPath
     if (stage.stage === "compile_roadmap_brainstorm" && stage.compiledPromptPath) active.roadmapBrainstormCompiledPromptPath = stage.compiledPromptPath
     if (stage.stage === "task_brainstorm" && stage.outputPath) active.taskSpecPath = stage.outputPath
     if (stage.stage === "compile_task_brainstorm" && stage.compiledPromptPath) active.taskBrainstormCompiledPromptPath = stage.compiledPromptPath
     if (stage.stage === "quick_plan" && stage.outputPath) active.planPath = stage.outputPath
   }

   /** Inherit pipeline directory and skipped-stage artifacts from a source pipeline. */
   private inheritFromSourcePipeline(pipelineId: string, fromPipelineId: string): void {
     const sourcePipeline = this.ps.getPipeline(fromPipelineId)
     const active = this.getPipeline(pipelineId)
     if (!active) return
     if (sourcePipeline?.pipelineDir) {
       active.pipelineDir = sourcePipeline.pipelineDir
       this.ps.updatePipelineDir(pipelineId, sourcePipeline.pipelineDir)
     }

    const detail = this.ps.getPipeline(pipelineId)
    if (!detail) return

     for (const s of detail.stages) {
       if (s.status === "skipped") {
         this.populateArtifactPath(pipelineId, s)
       }
     }
  }

  private findSignalableStage(pipelineId: string, stageId: string): StageData | null {
    return findSignalableStage(this.ps, pipelineId, stageId)
  }

  private clearRetryTimer(active: ActivePipeline): void {
    if (active.stageRetryTimer) {
      clearTimeout(active.stageRetryTimer)
      active.stageRetryTimer = undefined
    }
  }

  /** Set or clear the interrupted flag on the active pipeline and persist it. */
   private setInterrupted(pipelineId: string, stageId: string, interrupted: boolean): void {
     const active = this.getPipeline(pipelineId)
     if (!active) return
     active.interrupted = interrupted
     this.ps.setStageInterrupted(pipelineId, stageId, interrupted)
   }


  // ---------------------------------------------------------------------------
  // Stuck escalation
  // ---------------------------------------------------------------------------

  /** Escalate a stage to the user: stage goes stuck, pipeline pauses, user is notified.
   *  Used for both infrastructure failures and agentic dead-ends — never silently kills. */
  private stuckStage(pipelineId: string, stageId: string, error: string): void {
    // Cancel any pending retry timer to prevent stale timers from restarting the stage
    const active = this.pipelines.get(pipelineId)
    if (active) this.clearRetryTimer(active)

    // Look up stage details before session cleanup removes the mapping
    const detail = this.ps.getPipeline(pipelineId)
    const stageRecord = detail?.stages.find(s => s.id === stageId)
    this.cleanupStageSession(pipelineId, stageId)
    this.ps.setStageStuck(pipelineId, stageId)
    this.ps.setStageError(pipelineId, stageId, error)
    this.logger.error("atelier", "stage", "stage_stuck_escalated", { pipelineId, stageId, error })
    this.em.emit({
      type: "stuck_escalation",
      pipelineId,
      stageId,
      stage: stageRecord?.stage ?? "",
      sessionId: stageRecord?.sessionId ?? "",
      reason: error,
    } as Record<string, unknown>)
  }

  /** Infrastructure failure during stage setup: cancel session, escalate to user. */
  private stuckStageInfrastructure(pipelineId: string, error: string, stageId: string): void {
    this.cancelRunningSession(pipelineId, stageId)
    this.stuckStage(pipelineId, stageId, error)
  }

  // ---------------------------------------------------------------------------
  // Cleanup helpers
  // ---------------------------------------------------------------------------

  /** Delete a pipeline, cleaning up worktree if present. */
  async deletePipeline(pipelineId: string): Promise<void> {
    const active = this.pipelines.get(pipelineId)
    const pipelineData = this.ps.getPipeline(pipelineId)

    // Clean up worktree if present — rescue commit happens inside removeWorktree safety net
    const worktreePath = active?.worktreePath ?? pipelineData?.worktreePath
    if (worktreePath) {
      // Explicit rescue commit before deletion (Layer 3: deletePipeline)
      const topicSlug = active?.pipelineDir
        ? extractTopicSlug(active.pipelineDir)
        : (pipelineData?.pipelineDir ? extractTopicSlug(pipelineData.pipelineDir) : "unknown")
      await gitOps.rescueCommitWorktree(
        worktreePath,
        `${topicSlug} — uncommitted work rescued on pipeline delete`,
        this.logger,
      )
      const result = await gitOps.removeWorktree(this.config.workspacePath, worktreePath, { logger: this.logger })
      if (!result.ok) {
        this.logger.warn("atelier", "pipeline", "worktree_cleanup_failed", { pipelineId, data: { error: result.error } })
      }
      // Clear worktreePath so deactivate() doesn't redundantly retry removal
      if (active) active.worktreePath = undefined
    }

    // Deactivate from memory
    if (active) {
      await this.deactivate(pipelineId)
    }

    // Delete from persistent state
    const sessionIds = this.ps.deletePipeline(pipelineId)

    // Clean up sessions
    for (const sid of sessionIds) {
      this.sessionIndex.delete(sid)
    }
  }

  /** Resumes a pipeline after stage models have been confirmed by the user.
   *  Starts the first topology stage with the configured model. */
  async resumeAfterStageModelsConfirmed(pipelineId: string): Promise<void> {
    let active = this.pipelines.get(pipelineId)

    const pipeline = this.ps.getPipeline(pipelineId)
    if (!pipeline) return

    // After server restart the in-memory ActivePipeline map is empty.
    // Reconstruct a minimal ActivePipeline from disk so the first topology
    // stage can start — rehydrateFromDisk cannot help here because there is
    // no active session between classify completion and brainstorm start.
    if (!active) {
      const pipelineType = (pipeline.type ?? "feature") as PipelineType
      const backendId: BackendId = (this.config.registry && pipeline.model)
        ? this.config.registry.resolveBackend(pipeline.model)
        : "opencode"

      active = {
        id: pipelineId,
        backendId,
        sessionMap: new Map(),
        stageSessionMap: new Map(),
        model: pipeline.model ?? undefined,
        variant: pipeline.variant ?? undefined,
        pipelineDir: pipeline.pipelineDir ?? undefined,
        topologyIndex: 0,
        pipelineType,
        workspacePath: this.config.workspacePath,
      }

      // Restore worktree fields
      if (pipeline.worktreePath) {
        active.workspacePath = pipeline.worktreePath
        active.worktreePath = pipeline.worktreePath
        active.worktreeChoice = (pipeline.worktreeChoice as "in-tree" | "worktree" | undefined) ?? "worktree"
      }

      this.pipelines.set(pipelineId, active)

      // Restore artifact paths from completed stages (must be after pipelines.set
      // because populateArtifactPath reads from the in-memory map)
      for (const stage of pipeline.stages) {
        if (stage.status === "completed") this.populateArtifactPath(pipelineId, stage)
      }
      this.logger.info("atelier", "pipeline", "pipeline_reconstructed_for_resume", {
        pipelineId,
        data: { pipelineType, backendId },
      })
    }

    const topology = getTopology(active.pipelineType)
    const firstStage = topology[0]
    if (!firstStage) return

    // Ensure pipeline status is running (crash recovery may have set it to idle)
    this.ps.setPipelineStatus(pipelineId, "running")

    this.logger.info("atelier", "pipeline", "pipeline_resuming_after_confirmation", {
      pipelineId,
      data: { firstStage: firstStage.stage },
    })

    // runStage handles per-stage model overrides via pipelineState.getStageModel
    await this.stageRunner.runStage(pipelineId, firstStage.stage, pipeline.prompt)
  }

   /** Hard stop a pipeline (e.g. backend crash): escalates any running stage to user, deactivates. */
   async failPipeline(pipelineId: string, error: string): Promise<void> {
     const pipeline = this.pipelines.get(pipelineId)
     if (!pipeline) return

     // Escalate any running stage so the user is notified
     const detail = this.ps.getPipeline(pipelineId)
     const runningStage = detail?.stages.find((s) => s.status === "running")
     if (runningStage) {
       this.stuckStage(pipelineId, runningStage.id, error)
       await this.deactivate(pipelineId)
     } else {
       // No running stage — just mark the pipeline stuck at the pipeline level
       this.ps.failPipeline(pipelineId, error)
       this.logger.error("atelier", "pipeline", "pipeline_idle_error", { pipelineId, data: { error } })
       await this.deactivate(pipelineId)
     }
   }

   /** Cancel the OpenCode session for the given stageId (or the current stage if none specified).
    *  Fire-and-forget — best-effort session cancellation. */

   private cancelRunningSession(pipelineId: string, stageId?: string): void {
     const pipeline = this.pipelines.get(pipelineId)
     if (!pipeline) return
     let sessionId: string | undefined
     if (stageId) {
       for (const [sid, sId] of pipeline.sessionMap) {
         if (sId === stageId) { sessionId = sid; break }
       }
     } else if (pipeline.currentStage) {
       // Fall back to the current stage's session
       sessionId = pipeline.stageSessionMap.get(pipeline.currentStage)
     }
     if (!sessionId) return
     this.resolveEngineForSession(sessionId).then(engine => engine.interruptSession(sessionId)).catch(() => {})
   }

  private async deactivate(pipelineId: string): Promise<void> {
     const pipeline = this.pipelines.get(pipelineId)
     if (!pipeline) return
     // Remove from map immediately to prevent concurrent deactivation races
     this.pipelines.delete(pipelineId)

     this.clearRetryTimer(pipeline)
     const sessionIds = [...pipeline.sessionMap.keys()]
     const backendId = pipeline.backendId
     this.monitor.resetPipeline(sessionIds)
     // Clean sessionIndex for this pipeline's sessions
     for (const sid of sessionIds) {
       this.sessionIndex.delete(sid)
     }
     // Also collect sessions with deferred cleanup pending (already removed from sessionMap)
     for (const [sid, deferred] of this.deferredSessionCleanups) {
       if (deferred.pipelineId === pipelineId) {
         sessionIds.push(sid)
         this.deferredSessionCleanups.delete(sid)
       }
     }
     // Kill any remaining backend subprocesses for this pipeline's sessions
     for (const sid of sessionIds) {
       this.resolveEngine(backendId)
         .then(e => e.interruptSession(sid))
         .catch(() => {})
     }
     // Clean up worktree — rescue-commit any uncommitted work first
     if (pipeline.worktreePath) {
       const topicSlug = pipeline.pipelineDir ? extractTopicSlug(pipeline.pipelineDir) : "unknown"
       const sha = await gitOps.rescueCommitWorktree(
         pipeline.worktreePath,
         `${topicSlug} — uncommitted work rescued on deactivate`,
         this.logger,
       )
       if (sha) {
         this.logger.info("atelier", "git", "deactivate_rescue_commit", {
           pipelineId,
           data: { sha, worktreePath: pipeline.worktreePath },
         })
       }
       // removeWorktree has its own safety net — will refuse if rescue failed and changes remain
       const result = await gitOps.removeWorktree(this.config.workspacePath, pipeline.worktreePath, { logger: this.logger })
       if (!result.ok) {
         this.logger.error("atelier", "git", "deactivate_worktree_remove_failed", {
           pipelineId,
           data: { error: result.error, worktreePath: pipeline.worktreePath },
         })
       }
     }
    }

    private stageNameForMetric(pipelineId: string, stageId: string): string {
      const stage = findSignalableStage(this.ps, pipelineId, stageId)
      return stage?.stage ?? "unknown"
    }

    private recordLatencySample(category: string, sampleMs: number): void {
      const existing = this.idleMetrics.detectionLatencySamples.get(category) ?? []
      existing.push(sampleMs)
      if (existing.length > 100) existing.shift()
      this.idleMetrics.detectionLatencySamples.set(category, existing)
    }

    private logDetectorDecision(
      decision: "exhausted",
      args: { pipelineId: string; stageId: string; sessionId: string; reason: string },
      snapshot: ReturnType<SessionMonitor["getSessionSnapshot"]>,
    ): void {
      this.logger.info("atelier", "idle_detector", "decision_evidence", {
        pipelineId: args.pipelineId,
        stageId: args.stageId,
        sessionId: args.sessionId,
        data: {
          decision,
          reason: args.reason,
          lastProgressSubtype: snapshot?.lastProgressSubtype,
          leaseUntilMs: snapshot?.leaseUntilMs,
          artifactPresent: snapshot?.artifactPresent,
          assignedOutputPath: snapshot?.assignedOutputPath,
          infraState: snapshot?.infraState,
          state: snapshot?.state,
        },
      })
    }

    getIdleMetricsForTests(): {
      transitions: Record<string, number>
      doneUnsignaled: Record<string, number>
      detectionLatencyMs: Record<string, number[]>
      infraUncertainDurationMs: number
    } {
      return {
        transitions: Object.fromEntries(this.idleMetrics.stateTransitions.entries()),
        doneUnsignaled: Object.fromEntries(this.idleMetrics.doneUnsignaledDetected.entries()),
        detectionLatencyMs: Object.fromEntries(this.idleMetrics.detectionLatencySamples.entries()),
        infraUncertainDurationMs: this.idleMetrics.infraUncertainDurationMs,
      }
    }

}
