import { describe, it, expect, vi } from "vitest"
import { SessionMonitor } from "../src/engine/session-monitor.js"

describe("SessionMonitor pipeline mode", () => {
  it("exposes pipeline lifecycle APIs", () => {
    const monitor = new SessionMonitor({
      onExhausted: vi.fn(),
    })

    expect(typeof monitor.recordNormalizedEvent).toBe("function")
    expect(typeof monitor.sweep).toBe("function")
    expect(typeof monitor.resetPipeline).toBe("function")
  })

  it("resetPipeline clears known session entries", () => {
    const monitor = new SessionMonitor({
      onExhausted: vi.fn(),
    })

    monitor.registerPipelineSession({
      pipelineId: "p1",
      stageId: "st1",
      stage: "implement",
      stageMode: "autonomous",
      sessionId: "sess-1",
    })

    monitor.recordNormalizedEvent({
      kind: "progress_event",
      sessionId: "sess-1",
      subtype: "assistant_turn",
      atMs: 100,
    })

    monitor.resetPipeline(["sess-1"])

    expect(monitor.getSessionSnapshot("sess-1")).toBeNull()
  })

  it("is a no-op for unknown sessions", () => {
    const monitor = new SessionMonitor({
      onExhausted: vi.fn(),
    })

    expect(() => monitor.sweep()).not.toThrow()
    monitor.resetPipeline(["missing"])
    expect(monitor.getSessionSnapshot("missing")).toBeNull()
  })

  describe("lease expiry transitions", () => {
    it("refreshes lease by subtype and transitions WORKING -> QUIET_PENDING after expiry", () => {
      let now = 0
      const exhausted = vi.fn()
      const monitor = new SessionMonitor({
        now: () => now,
        onExhausted: exhausted,
      })

      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "implement",
        stageMode: "autonomous",
        sessionId: "sess-lease",
      })

      monitor.recordNormalizedEvent({
        kind: "progress_event",
        sessionId: "sess-lease",
        subtype: "assistant_turn",
        atMs: now,
      })

      now = 44_999
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-lease")?.state).toBe("WORKING")

      now = 45_000
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-lease")?.state).toBe("QUIET_PENDING")

      now = 60_001
      monitor.sweep()
      // After corroboration, escalateToStuck fires and transitions to TERMINAL
      expect(monitor.getSessionSnapshot("sess-lease")?.state).toBe("TERMINAL")
    })

    it("keeps long tool lease idle-suppressed until tool completes", () => {
      let now = 0
      const exhausted = vi.fn()
      const monitor = new SessionMonitor({
        now: () => now,
        onExhausted: exhausted,
      })

      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "implement",
        stageMode: "autonomous",
        sessionId: "sess-tool-lease",
        stageOverride: { quietWindowMs: 0, quietCorroborationMs: 0 },
      })

      monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "sess-tool-lease", subtype: "tool_start", atMs: now })

      // While tool is executing (pendingToolCount > 0), idle detection is fully suppressed
      now = 600_000
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-tool-lease")?.state).toBe("WORKING")
      expect(exhausted).not.toHaveBeenCalled()

      // After tool completes, idle detection resumes with normal lease timing
      now = 600_001
      monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "sess-tool-lease", subtype: "tool_terminal", atMs: now })
      const toolTerminalLease = 90_000 // tool_terminal lease
      now = 600_001 + toolTerminalLease
      monitor.sweep()
      // Escalates directly to TERMINAL (no intermediate nudge step)
      expect(monitor.getSessionSnapshot("sess-tool-lease")?.state).toBe("TERMINAL")
      expect(exhausted).toHaveBeenCalledTimes(1)
    })

    it("suppresses pipeline idle detection while engine has a silent turn pending", () => {
      let now = 0
      const exhausted = vi.fn()
      const monitor = new SessionMonitor({
        now: () => now,
        onExhausted: exhausted,
        getEngineSessionState: () => ({
          busy: true,
          hasPendingInteractions: false,
          lastYieldAt: 0,
          lastSubtype: "unknown",
          pendingToolCount: 0,
        }),
      })

      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "implement",
        stageMode: "autonomous",
        sessionId: "sess-silent-thinking",
        stageOverride: { quietWindowMs: 0, quietCorroborationMs: 0 },
      })

      now = 600_000
      monitor.sweep()

      expect(monitor.getSessionSnapshot("sess-silent-thinking")?.state).toBe("WORKING")
      expect(exhausted).not.toHaveBeenCalled()
    })

    it("resolves config precedence as stage override > pipeline config > defaults", () => {
      let now = 0
      const monitor = new SessionMonitor({
        now: () => now,
        onExhausted: vi.fn(),
      })

      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "implement",
        stageMode: "autonomous",
        sessionId: "sess-precedence",
        pipelineConfig: {
          leaseBySubtypeMs: { assistant_turn: 5_000 },
        },
        stageOverride: {
          leaseBySubtypeMs: { assistant_turn: 9_000 },
          quietWindowMs: 0,
          quietCorroborationMs: 0,
        },
      })

      monitor.recordNormalizedEvent({
        kind: "progress_event",
        sessionId: "sess-precedence",
        subtype: "assistant_turn",
        atMs: now,
      })

      now = 8_999
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-precedence")?.state).toBe("WORKING")
      now = 9_000
      monitor.sweep()
      // Idle detected + immediately escalated to TERMINAL
      expect(monitor.getSessionSnapshot("sess-precedence")?.state).toBe("TERMINAL")
    })

    it("skips stuck escalation for interactive stages (idle and done_unsignaled)", () => {
      let now = 0
      const exhausted = vi.fn()
      const monitor = new SessionMonitor({
        now: () => now,
        artifactExists: () => true,
        onExhausted: exhausted,
      })

      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "brainstorm",
        stageMode: "interactive",
        sessionId: "sess-interactive",
        assignedOutputPath: ".atelier/pipelines/p1/spec.md",
        stageOverride: {
          quietWindowMs: 1,
          quietCorroborationMs: 1,
          doneUnsignaledWindowMs: 1,
        },
      })

      // Idle detected but no escalation for interactive stage
      now = 100
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-interactive")?.state).toBe("IDLE_DETECTED")
      expect(exhausted).not.toHaveBeenCalled()

      // Done-unsignaled also not escalated (artifact present)
      now = 200
      monitor.sweep()
      expect(exhausted).not.toHaveBeenCalled()
    })
  })

  describe("state machine transitions", () => {
    it("covers WORKING -> QUIET_PENDING -> TERMINAL via done_unsignaled for autonomous stage with artifact", () => {
      let now = 0
      const exhausted = vi.fn()
      const monitor = new SessionMonitor({
        now: () => now,
        artifactExists: () => true,
        onExhausted: exhausted,
      })

      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "implement",
        stageMode: "autonomous",
        sessionId: "sess-sm",
        assignedOutputPath: ".atelier/pipelines/p1/out.md",
      })

      monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "sess-sm", subtype: "assistant_turn", atMs: now })
      now = 45_000
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-sm")?.state).toBe("QUIET_PENDING")

      now = 60_001
      monitor.sweep()
      // Transitions through DONE_UNSIGNALED then immediately escalates to TERMINAL
      expect(monitor.getSessionSnapshot("sess-sm")?.state).toBe("TERMINAL")
      expect(exhausted).toHaveBeenCalledTimes(1)
    })

    it("enters and exits INFRA_UNCERTAIN with stabilization + fresh evidence", () => {
      let now = 0
      const monitor = new SessionMonitor({
        now: () => now,
        onExhausted: vi.fn(),
      })

      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "implement",
        stageMode: "autonomous",
        sessionId: "sess-infra",
      })

      monitor.recordNormalizedEvent({ kind: "infra_state_changed", state: "reconnecting", atMs: now })
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-infra")?.state).toBe("INFRA_UNCERTAIN")

      now = 5_000
      monitor.recordNormalizedEvent({ kind: "infra_state_changed", state: "connected", atMs: now })
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-infra")?.state).toBe("INFRA_UNCERTAIN")

      now = 15_000
      monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "sess-infra", subtype: "assistant_turn", atMs: now })
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-infra")?.state).toBe("WORKING")
    })

    it("session_error does not poison infraState — recovery on progress_event keeps watchdog quiet", () => {
      // Regression: opencode emits session.error for transient model/provider issues
      // (rate-limit, content filter, 5xx). Previously this set entry.infraState to
      // "reconnecting" with no path back to "connected" — every 5s sweep re-flipped
      // the entry to INFRA_UNCERTAIN, making slow gpt responses look frozen.
      let now = 0
      const monitor = new SessionMonitor({
        now: () => now,
        onExhausted: vi.fn(),
      })

      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "implement",
        stageMode: "autonomous",
        sessionId: "sess-err",
      })

      monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "sess-err", subtype: "assistant_turn", atMs: now })
      expect(monitor.getSessionSnapshot("sess-err")?.state).toBe("WORKING")

      // Provider hiccup
      now = 2_000
      monitor.recordNormalizedEvent({ kind: "session_error", sessionId: "sess-err", error: "openai 503", atMs: now })
      expect(monitor.getSessionSnapshot("sess-err")?.state).toBe("INFRA_UNCERTAIN")
      // Infra is fine — only the model errored. infraState must stay "connected".
      expect(monitor.getSessionSnapshot("sess-err")?.infraState).toBe("connected")

      // Model resumes streaming
      now = 4_000
      monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "sess-err", subtype: "assistant_turn", atMs: now })
      expect(monitor.getSessionSnapshot("sess-err")?.state).toBe("WORKING")

      // Subsequent sweeps must NOT flip back to INFRA_UNCERTAIN — the bug was
      // evaluatePipelineSession seeing infraState !== "connected" on every tick.
      now = 9_000
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-err")?.state).toBe("WORKING")
      now = 14_000
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-err")?.state).toBe("WORKING")
    })

    it("keeps WORKING while pending interactions exist", () => {
      let now = 0
      const monitor = new SessionMonitor({
        now: () => now,
        onExhausted: vi.fn(),
      })
      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "brainstorm",
        stageMode: "interactive",
        sessionId: "sess-pending",
      })

      monitor.addPendingInteraction("sess-pending", "req-1")
      now = 90_000
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-pending")?.state).toBe("WORKING")

      monitor.clearPendingInteraction("sess-pending", "req-1")
      monitor.sweep()
      expect(monitor.getSessionSnapshot("sess-pending")?.state).toBe("IDLE_DETECTED")
    })

    it("moves to QUIET_PENDING immediately on idle_edge when no lease is active", () => {
      let now = 0
      const monitor = new SessionMonitor({
        now: () => now,
        onExhausted: vi.fn(),
      })

      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "implement",
        stageMode: "autonomous",
        sessionId: "sess-idle-edge",
      })

      now = 100
      monitor.recordNormalizedEvent({ kind: "idle_edge", sessionId: "sess-idle-edge", atMs: now })
      expect(monitor.getSessionSnapshot("sess-idle-edge")?.state).toBe("QUIET_PENDING")
    })
  })

  describe("direct escalation to stuck", () => {
    it("directly escalates to stuck (onExhausted) when idle is detected for autonomous stage", () => {
      let now = 0
      const exhausted = vi.fn()
      const monitor = new SessionMonitor({
        now: () => now,
        onExhausted: exhausted,
      })

      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "implement",
        stageMode: "autonomous",
        sessionId: "sess-escalate",
        stageOverride: { quietWindowMs: 0, quietCorroborationMs: 0 },
      })

      monitor.sweep()

      // Should directly escalate to stuck without any intermediate nudge step
      expect(exhausted).toHaveBeenCalledTimes(1)
    })
  })

  describe("done unsignaled", () => {
    it("escalates to TERMINAL via done_unsignaled when assigned artifact exists and stage is quiet", () => {
      let now = 0
      const exhausted = vi.fn()
      const monitor = new SessionMonitor({
        now: () => now,
        artifactExists: () => true,
        onExhausted: exhausted,
      })

      monitor.registerPipelineSession({
        pipelineId: "p1",
        stageId: "st1",
        stage: "implement",
        stageMode: "autonomous",
        sessionId: "sess-done",
        assignedOutputPath: ".atelier/pipelines/p1/out.md",
      })

      monitor.sweep()
      now = 16_000
      monitor.sweep()
      // Transitions through DONE_UNSIGNALED then immediately escalates to TERMINAL
      expect(monitor.getSessionSnapshot("sess-done")?.state).toBe("TERMINAL")
      expect(exhausted).toHaveBeenCalledTimes(1)
    })
  })
})
