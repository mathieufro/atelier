import type { Logger } from "@atelier/core"
import type {
  DetectorNormalizedEvent,
  DetectorProgressSubtype,
  DetectorInfraState,
} from "../orchestration/idle-detector-events.js"
import {
  resolveIdleDetectorConfig,
  type IdleDetectorConfig,
  type IdleDetectorStagePolicyOverride,
} from "../orchestration/idle-detector-config.js"
import type { EngineSessionState } from "./claude-code-engine.js"

// ---------------------------------------------------------------------------
// Grace window after reconnect stabilisation: if no new events arrive within
// this period, treat the session as idle rather than waiting forever.
// ---------------------------------------------------------------------------
const INFRA_IDLE_GRACE_MS = 30_000

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DetectorState =
  | "WORKING"
  | "QUIET_PENDING"
  | "IDLE_DETECTED"
  | "DONE_UNSIGNALED"
  | "INFRA_UNCERTAIN"
  | "TERMINAL"

export interface PipelineSessionRegistration {
  pipelineId: string
  stageId: string
  stage: string
  stageMode: "autonomous" | "interactive" | "compile"
  sessionId: string
  assignedOutputPath?: string
  pipelineConfig?: Partial<IdleDetectorStagePolicyOverride>
  stageOverride?: Partial<IdleDetectorStagePolicyOverride>
}

export interface SessionMonitorSnapshot {
  pipelineId?: string
  stageId?: string
  stage?: string
  state?: DetectorState
  sessionId: string
  lastEventAtMs: number
  lastProgressSubtype?: DetectorProgressSubtype
  lastEventKind: DetectorNormalizedEvent["kind"]
  leaseUntilMs?: number
  assignedOutputPath?: string
  artifactPresent?: boolean
  pendingInteractions?: number
  pendingToolCount?: number
  infraState?: DetectorInfraState
}

export interface SessionMonitorDeps {
  now?: () => number
  logger?: Logger
  serverDefaults?: Partial<IdleDetectorStagePolicyOverride>
  artifactExists?: (assignedOutputPath: string) => boolean
  /** Override sweep interval (default 5000ms). Useful for tests with short idle windows. */
  sweepIntervalMs?: number

  // Pipeline callbacks
  onExhausted: (args: {
    pipelineId: string
    stageId: string
    sessionId: string
    reason: string
  }) => void
  onStateChanged?: (args: {
    pipelineId: string
    stageId: string
    stage: string
    sessionId: string
    from: DetectorState
    to: DetectorState
    reason: string
  }) => void

  // Standalone session callbacks
  onStandaloneStalled?: (sessionId: string, reason: string, restartCount: number) => void

  // Engine state provider — used to clean up standalone tracking when sessions end
  getEngineSessionState?: (sessionId: string) => EngineSessionState | null
}

// ---------------------------------------------------------------------------
// Internal ledgers (discriminated union via `mode`)
// ---------------------------------------------------------------------------

interface PipelineLedger {
  mode: "pipeline"
  pipelineId: string
  stageId: string
  stage: string
  stageMode: "autonomous" | "interactive" | "compile"
  sessionId: string
  state: DetectorState
  stateEnteredAtMs: number
  lastEventAtMs: number
  lastEventKind: DetectorNormalizedEvent["kind"]
  lastProgressSubtype: DetectorProgressSubtype
  leaseUntilMs: number
  busy: boolean
  busySinceMs?: number
  infraState: DetectorInfraState
  infraUncertainSinceMs?: number
  reconnectStableSinceMs?: number
  pendingInteractionIds: Set<string>
  pendingToolCount: number
  assignedOutputPath?: string
  doneUnsignaledSinceMs?: number
  escalated: boolean
  rateLimitedUntilMs?: number
  config: IdleDetectorConfig
}

interface StandaloneLedger {
  mode: "standalone"
  sessionId: string
  lastYieldAtMs: number
  lastSubtype: DetectorProgressSubtype
  pendingToolCount: number
  restartCount: number
  stalled: boolean
  permanentlyStalled: boolean
}

type MonitoredSession = PipelineLedger | StandaloneLedger

// ---------------------------------------------------------------------------
// SessionMonitor — unified stall detection for pipeline and standalone sessions
// ---------------------------------------------------------------------------

export class SessionMonitor {
  private static readonly MAX_PIPELINE_SNAPSHOTS = 50

  private readonly now: () => number
  private readonly deps: SessionMonitorDeps
  private readonly sessions = new Map<string, MonitoredSession>()
  private readonly pipelineSnapshots = new Map<string, SessionMonitorSnapshot>()
  private infraState: DetectorInfraState = "connected"
  private readonly log?: Logger
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(deps: SessionMonitorDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => performance.now())
    this.log = deps.logger?.child({ source: "session-monitor" })
  }

  // =========================================================================
  // Pipeline session API (preserves IdleDetector interface)
  // =========================================================================

  registerPipelineSession(input: PipelineSessionRegistration): void {
    const now = this.now()
    const config = resolveIdleDetectorConfig({
      stage: input.stage,
      stageMode: input.stageMode,
      serverDefaults: this.deps.serverDefaults,
      pipelineConfig: input.pipelineConfig,
      stageOverride: input.stageOverride,
    })
    this.sessions.set(input.sessionId, {
      mode: "pipeline",
      pipelineId: input.pipelineId,
      stageId: input.stageId,
      stage: input.stage,
      stageMode: input.stageMode,
      sessionId: input.sessionId,
      state: "WORKING",
      stateEnteredAtMs: now,
      lastEventAtMs: now,
      lastEventKind: "progress_event",
      lastProgressSubtype: "unknown",
      leaseUntilMs: now,
      busy: false,
      infraState: this.infraState,
      pendingInteractionIds: new Set<string>(),
      pendingToolCount: 0,
      assignedOutputPath: input.assignedOutputPath,
      escalated: false,
      config,
    })
    this.log?.debug("atelier", "watchdog", "session_registered", {
      pipelineId: input.pipelineId,
      stageId: input.stageId,
      sessionId: input.sessionId,
      data: { stageMode: input.stageMode, stage: input.stage },
    })
    this.ensureSweepRunning()
  }

  markSessionTerminal(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.mode !== "pipeline") return
    this.log?.debug("atelier", "watchdog", "session_marked_terminal", { sessionId })
    this.transitionPipeline(entry, "TERMINAL", "stage_terminal")
  }

  resetSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.mode !== "pipeline") return
    this.log?.debug("atelier", "watchdog", "session_reset", { sessionId })
    const now = this.now()
    entry.escalated = false
    entry.doneUnsignaledSinceMs = undefined
    entry.lastEventAtMs = now
    entry.lastEventKind = "busy_edge"
    entry.busy = true
    entry.busySinceMs = now
    this.transitionPipeline(entry, "WORKING", "session_resumed")
  }

  /**
   * Re-resolve idle detector config for a live session (e.g., plan_gate switching
   * from interactive to autonomous after the user chooses [Execute Plan]).
   */
  reconfigureSession(sessionId: string, opts: { stageMode: "autonomous" | "interactive" }): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.mode !== "pipeline") return
    entry.stageMode = opts.stageMode
    entry.config = resolveIdleDetectorConfig({
      stage: entry.stage,
      stageMode: opts.stageMode,
      serverDefaults: this.deps.serverDefaults,
    })
    entry.escalated = false
    this.log?.debug("atelier", "watchdog", "session_reconfigured", {
      sessionId,
      data: { stageMode: opts.stageMode },
    })
  }

  addPendingInteraction(sessionId: string, requestId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.mode !== "pipeline") return
    entry.pendingInteractionIds.add(requestId)
  }

  clearPendingInteraction(sessionId: string, requestId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.mode !== "pipeline") return
    entry.pendingInteractionIds.delete(requestId)
    if (entry.pendingInteractionIds.size === 0) {
      this.evaluatePipelineSession(entry, this.now())
    }
  }

  resetPipeline(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      this.sessions.delete(sessionId)
      this.pipelineSnapshots.delete(sessionId)
    }
    if (this.sessions.size === 0) this.stopSweep()
  }

  getSessionSnapshot(sessionId: string): SessionMonitorSnapshot | null {
    const entry = this.sessions.get(sessionId)
    if (entry && entry.mode === "pipeline") {
      return {
        pipelineId: entry.pipelineId,
        stageId: entry.stageId,
        stage: entry.stage,
        state: entry.state,
        sessionId,
        lastEventAtMs: entry.lastEventAtMs,
        lastProgressSubtype: entry.lastProgressSubtype,
        lastEventKind: entry.lastEventKind,
        leaseUntilMs: entry.leaseUntilMs,
        assignedOutputPath: entry.assignedOutputPath,
        artifactPresent: this.hasAssignedArtifact(entry),
        pendingInteractions: entry.pendingInteractionIds.size,
        pendingToolCount: entry.pendingToolCount,
        infraState: entry.infraState,
      }
    }
    return this.pipelineSnapshots.get(sessionId) ?? null
  }

  // =========================================================================
  // Standalone session API
  // =========================================================================

  /** Check if a standalone session is being tracked (for testing). */
  isTracked(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId)
    return entry !== undefined && entry.mode === "standalone"
  }

  // =========================================================================
  // Unified event ingestion
  // =========================================================================

  recordNormalizedEvent(event: DetectorNormalizedEvent): void {
    const atMs = event.atMs ?? this.now()

    // Infra state changes apply to all pipeline sessions
    if (event.kind === "infra_state_changed") {
      this.infraState = event.state
      for (const entry of this.sessions.values()) {
        if (entry.mode !== "pipeline") continue
        entry.infraState = event.state
        if (event.state !== "connected") {
          entry.reconnectStableSinceMs = undefined
          entry.infraUncertainSinceMs = atMs
          this.transitionPipeline(entry, "INFRA_UNCERTAIN", "infra_unhealthy")
        } else {
          entry.reconnectStableSinceMs = atMs
        }
      }
      this.log?.debug("atelier", "watchdog", "infra_state_changed", {
        data: { state: event.state, sessionCount: this.sessions.size },
      })
      return
    }

    if ("sessionId" in event) {
      const entry = this.sessions.get(event.sessionId)

      if (entry) {
        if (entry.mode === "pipeline") {
          this.recordPipelineEvent(entry, event, atMs)
        } else {
          this.recordStandaloneEvent(entry, event)
        }
      } else {
        // Auto-register standalone sessions on busy_edge or progress for unknown sessions
        if (event.kind === "busy_edge" || event.kind === "progress_event") {
          this.registerStandaloneFromBusy(event.sessionId)
        }
      }

      // Update pipeline snapshot cache for known pipeline sessions
      if (entry && entry.mode === "pipeline") {
        this.pipelineSnapshots.set(event.sessionId, {
          pipelineId: entry.pipelineId,
          stageId: entry.stageId,
          stage: entry.stage,
          state: entry.state,
          sessionId: event.sessionId,
          lastEventAtMs: atMs,
          lastProgressSubtype: entry.lastProgressSubtype,
          lastEventKind: event.kind,
          leaseUntilMs: entry.leaseUntilMs,
          assignedOutputPath: entry.assignedOutputPath,
          artifactPresent: this.hasAssignedArtifact(entry),
          pendingInteractions: entry.pendingInteractionIds.size,
          pendingToolCount: entry.pendingToolCount,
          infraState: entry.infraState,
        })
        // FIFO eviction — Map insertion order is chronological
        if (this.pipelineSnapshots.size > SessionMonitor.MAX_PIPELINE_SNAPSHOTS) {
          const firstKey = this.pipelineSnapshots.keys().next().value
          if (firstKey) this.pipelineSnapshots.delete(firstKey)
        }
      }
    }
  }

  // =========================================================================
  // Sweep — dispatches to mode-specific evaluators
  // =========================================================================

  sweep(): void {
    const now = this.now()
    for (const entry of this.sessions.values()) {
      if (entry.mode === "pipeline") {
        this.evaluatePipelineSession(entry, now)
      } else {
        this.evaluateStandaloneSession(entry, now)
      }
    }
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  dispose(): void {
    this.stopSweep()
    this.sessions.clear()
    this.pipelineSnapshots.clear()
  }

  // =========================================================================
  // Private: standalone session helpers
  // =========================================================================

  private registerStandaloneFromBusy(sessionId: string): void {
    if (this.sessions.has(sessionId)) return
    this.sessions.set(sessionId, {
      mode: "standalone",
      sessionId,
      lastYieldAtMs: this.now(),
      lastSubtype: "unknown",
      pendingToolCount: 0,
      restartCount: 0,
      stalled: false,
      permanentlyStalled: false,
    })
    this.ensureSweepRunning()
  }

  private recordStandaloneEvent(
    entry: StandaloneLedger,
    event: DetectorNormalizedEvent & { sessionId: string },
  ): void {
    if (event.kind === "idle_edge" || event.kind === "session_error") {
      this.sessions.delete(entry.sessionId)
      if (this.sessions.size === 0) this.stopSweep()
      return
    }
    if (event.kind === "progress_event") {
      entry.lastYieldAtMs = event.atMs ?? this.now()
      entry.lastSubtype = event.subtype
      if (event.subtype === "tool_start") {
        entry.pendingToolCount++
      } else if (event.subtype === "tool_terminal") {
        entry.pendingToolCount = Math.max(0, entry.pendingToolCount - 1)
      }
      // A successful yield after a restart resets the restart counter
      if (!entry.stalled && entry.restartCount > 0) {
        entry.restartCount = 0
      }
    }
  }

  private static readonly STANDALONE_MAX_RESTARTS = 3
  private static readonly STANDALONE_LEASE_MS: Partial<Record<DetectorProgressSubtype, number>> = {
    part_progress: 180_000,
    assistant_turn: 180_000,
    tool_terminal: 240_000,
    unknown: 180_000,
  }

  /** Reset a standalone session after a successful interrupt-restart. */
  resetStandaloneSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry || entry.mode !== "standalone") return
    entry.lastYieldAtMs = this.now()
    entry.stalled = false
  }

  /**
   * Standalone session stall detection. Unlike pipeline sessions (which nudge then escalate),
   * standalone sessions fire a single `onStandaloneStalled` callback for the orchestrator
   * to attempt an interrupt-restart. Tools executing locally suppress stall detection.
   */
  private evaluateStandaloneSession(entry: StandaloneLedger, now: number): void {
    // Refresh from authoritative engine state
    const engineState = this.deps.getEngineSessionState?.(entry.sessionId)
    if (engineState) {
      if (!engineState.busy) {
        this.sessions.delete(entry.sessionId)
        if (this.sessions.size === 0) this.stopSweep()
        return
      }
      // Use the more recent yield timestamp (engine is authoritative)
      if (engineState.lastYieldAt > entry.lastYieldAtMs) {
        entry.lastYieldAtMs = engineState.lastYieldAt
        entry.lastSubtype = engineState.lastSubtype
      }
      entry.pendingToolCount = engineState.pendingToolCount
    }

    // Tools executing locally — never stall
    if (entry.pendingToolCount > 0) return

    // Already reported stall and not reset — wait
    if (entry.stalled || entry.permanentlyStalled) return

    // Check lease
    const leaseMs = SessionMonitor.STANDALONE_LEASE_MS[entry.lastSubtype]
      ?? SessionMonitor.STANDALONE_LEASE_MS.unknown!
    const elapsed = now - entry.lastYieldAtMs
    if (elapsed < leaseMs) return

    // Stall detected
    entry.stalled = true
    entry.restartCount++

    if (entry.restartCount > SessionMonitor.STANDALONE_MAX_RESTARTS) {
      entry.permanentlyStalled = true
      this.deps.onStandaloneStalled?.(
        entry.sessionId,
        `No SDK yield for ${Math.round(elapsed / 1000)}s — giving up after ${SessionMonitor.STANDALONE_MAX_RESTARTS} restarts`,
        entry.restartCount,
      )
      return
    }

    this.deps.onStandaloneStalled?.(
      entry.sessionId,
      `No SDK yield for ${Math.round(elapsed / 1000)}s — restart ${entry.restartCount}/${SessionMonitor.STANDALONE_MAX_RESTARTS}`,
      entry.restartCount,
    )
  }

  // =========================================================================
  // Private: pipeline session helpers (exact copy of IdleDetector logic)
  // =========================================================================

  private recordPipelineEvent(
    entry: PipelineLedger,
    event: DetectorNormalizedEvent & { sessionId: string },
    atMs: number,
  ): void {
    // rate_limited signals should NOT reset the idle timer
    if (event.kind === "rate_limited") {
      entry.rateLimitedUntilMs = event.resetsAtMs
      return
    }
    entry.lastEventAtMs = atMs
    entry.lastEventKind = event.kind
    if (event.kind === "busy_edge") {
      entry.busy = true
      entry.busySinceMs = atMs
    }
    if (event.kind === "idle_edge") {
      entry.busy = false
      entry.busySinceMs = undefined
      if (
        atMs >= entry.leaseUntilMs
        && entry.pendingInteractionIds.size === 0
        && entry.infraState === "connected"
      ) {
        this.transitionPipeline(entry, "QUIET_PENDING", "idle_edge_no_lease")
      }
    }
    if (event.kind === "session_error") {
      entry.infraState = "reconnecting"
      entry.infraUncertainSinceMs = atMs
      this.transitionPipeline(entry, "INFRA_UNCERTAIN", "session_error")
    }
    if (event.kind === "progress_event") {
      entry.lastProgressSubtype = event.subtype
      const leaseMs = entry.config.leaseBySubtypeMs[event.subtype] ?? entry.config.leaseBySubtypeMs.unknown
      entry.leaseUntilMs = atMs + leaseMs
      entry.doneUnsignaledSinceMs = undefined
      entry.escalated = false
      entry.rateLimitedUntilMs = undefined // agent resumed, rate limit no longer applies
      if (event.subtype === "tool_start") {
        entry.pendingToolCount++
      } else if (event.subtype === "tool_terminal") {
        entry.pendingToolCount = Math.max(0, entry.pendingToolCount - 1)
      }
      this.log?.debug("atelier", "watchdog", "progress_event_recorded", {
        sessionId: event.sessionId,
        data: { subtype: event.subtype, leaseMs, pendingTools: entry.pendingToolCount },
      })
      this.transitionPipeline(entry, "WORKING", `progress_${event.subtype}`)
    }
  }

  private evaluatePipelineSession(entry: PipelineLedger, now: number): void {
    if (entry.state === "TERMINAL") return

    // Rate-limited sessions: suppress all evaluation until the limit resets
    if (entry.rateLimitedUntilMs) {
      if (now < entry.rateLimitedUntilMs) return
      entry.rateLimitedUntilMs = undefined // expired
    }

    if (entry.infraState !== "connected") {
      this.log?.debug("atelier", "watchdog", "evaluate_infra_unhealthy", {
        sessionId: entry.sessionId,
        data: { infraState: entry.infraState },
      })
      this.transitionPipeline(entry, "INFRA_UNCERTAIN", "infra_unhealthy")
      return
    }

    if (entry.state === "INFRA_UNCERTAIN") {
      if (
        !entry.reconnectStableSinceMs
        || now - entry.reconnectStableSinceMs < entry.config.reconnectStabilizationWindowMs
      ) {
        return
      }
      // If no new events since reconnect, wait up to INFRA_IDLE_GRACE_MS before
      // falling through to normal idle evaluation.
      if (
        entry.lastEventAtMs < entry.reconnectStableSinceMs
        && now - entry.reconnectStableSinceMs < INFRA_IDLE_GRACE_MS
      ) {
        return
      }
      this.transitionPipeline(entry, "WORKING", "infra_recovered")
    }

    if (entry.pendingInteractionIds.size > 0) {
      this.log?.debug("atelier", "watchdog", "evaluate_interactive_wait", {
        sessionId: entry.sessionId,
        data: { pendingCount: entry.pendingInteractionIds.size },
      })
      this.transitionPipeline(entry, "WORKING", "interactive_wait")
      return
    }

    // Tools executing locally can take arbitrarily long — suppress idle detection.
    if (entry.pendingToolCount > 0) {
      this.log?.debug("atelier", "watchdog", "evaluate_tools_executing", {
        sessionId: entry.sessionId,
        data: { pendingToolCount: entry.pendingToolCount },
      })
      this.transitionPipeline(entry, "WORKING", "tools_executing")
      return
    }

    const leaseActive = now < entry.leaseUntilMs
    const busyFresh =
      entry.busy
      && entry.busySinceMs !== undefined
      && now - entry.busySinceMs < entry.config.busyCorroborationWindowMs
    if (leaseActive || busyFresh) {
      this.transitionPipeline(entry, "WORKING", leaseActive ? "lease_active" : "busy_fresh")
      return
    }

    const artifactPresent = this.hasAssignedArtifact(entry)

    if (artifactPresent) {
      this.log?.debug("atelier", "watchdog", "evaluate_artifact_detected", {
        sessionId: entry.sessionId,
        data: { assignedOutputPath: entry.assignedOutputPath },
      })
      if (entry.doneUnsignaledSinceMs === undefined) {
        entry.doneUnsignaledSinceMs = now
      }
      if (now - entry.doneUnsignaledSinceMs >= entry.config.doneUnsignaledWindowMs) {
        this.transitionPipeline(entry, "DONE_UNSIGNALED", "artifact_present_quiet")
        this.escalateToStuck(entry, "done_unsignaled_timeout")
        return
      }
    }

    const quietForMs = now - entry.lastEventAtMs
    if (quietForMs >= entry.config.quietWindowMs + entry.config.quietCorroborationMs) {
      this.log?.debug("atelier", "watchdog", "evaluate_idle_corroborated", {
        sessionId: entry.sessionId,
        data: { quietForMs },
      })
      this.transitionPipeline(entry, "IDLE_DETECTED", "quiet_corroborated")
      this.escalateToStuck(entry, "idle_timeout")
      return
    }

    if (quietForMs >= entry.config.quietWindowMs) {
      this.transitionPipeline(entry, "QUIET_PENDING", "quiet_window_elapsed")
      return
    }

    this.transitionPipeline(entry, "WORKING", "recent_activity")
  }

  private escalateToStuck(entry: PipelineLedger, reason: string): void {
    if (entry.stageMode === "interactive") return
    if (entry.escalated) return
    entry.escalated = true
    this.deps.onExhausted({
      pipelineId: entry.pipelineId,
      stageId: entry.stageId,
      sessionId: entry.sessionId,
      reason,
    })
    this.transitionPipeline(entry, "TERMINAL", reason)
  }

  private hasAssignedArtifact(entry: PipelineLedger): boolean {
    if (!entry.assignedOutputPath) return false
    if (!this.deps.artifactExists) return false
    return this.deps.artifactExists(entry.assignedOutputPath)
  }

  private transitionPipeline(entry: PipelineLedger, next: DetectorState, reason: string): void {
    if (entry.state === next) return
    const prev = entry.state
    this.log?.debug("atelier", "watchdog", "state_transition", {
      sessionId: entry.sessionId,
      pipelineId: entry.pipelineId,
      stageId: entry.stageId,
      data: { from: prev, to: next, reason },
    })
    entry.state = next
    entry.stateEnteredAtMs = this.now()
    this.deps.onStateChanged?.({
      pipelineId: entry.pipelineId,
      stageId: entry.stageId,
      stage: entry.stage,
      sessionId: entry.sessionId,
      from: prev,
      to: next,
      reason,
    })
  }

  // =========================================================================
  // Private: sweep timer management
  // =========================================================================

  private ensureSweepRunning(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweep(), this.deps.sweepIntervalMs ?? 5_000)
  }

  private stopSweep(): void {
    if (!this.sweepTimer) return
    clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }
}
