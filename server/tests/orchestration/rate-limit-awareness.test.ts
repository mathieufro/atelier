import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SessionMonitor } from "../../src/engine/session-monitor.js"
import type { SessionMonitorDeps } from "../../src/engine/session-monitor.js"

function createDeps(overrides?: Partial<SessionMonitorDeps>): SessionMonitorDeps & { time: { value: number } } {
  const time = { value: 1000 }
  return {
    time,
    onExhausted: vi.fn(),
    getEngineSessionState: vi.fn(() => null),
    now: () => time.value,
    ...overrides,
  }
}

describe("Rate limit awareness in SessionMonitor", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("suppresses escalation while session is rate-limited", () => {
    const deps = createDeps()
    const monitor = new SessionMonitor(deps)

    // Register a pipeline session with short quiet/corroboration windows
    monitor.registerPipelineSession({
      pipelineId: "p1",
      stageId: "s1",
      stage: "implement",
      stageMode: "autonomous",
      sessionId: "sess1",
      stageOverride: {
        quietWindowMs: 1000,
        quietCorroborationMs: 500,
      },
    })

    // Mark session as rate-limited until time = 60000
    monitor.recordNormalizedEvent({
      kind: "rate_limited",
      sessionId: "sess1",
      resetsAtMs: 60000,
    })

    // Advance time past quiet window (normally would trigger escalation)
    deps.time.value = 10000
    monitor.sweep()

    // No escalation should have fired
    expect(deps.onExhausted).not.toHaveBeenCalled()

    // Advance past rate limit expiry
    deps.time.value = 61000
    monitor.sweep()

    // Now escalation should fire (rate limit expired, session is idle)
    expect(deps.onExhausted).toHaveBeenCalled()

    monitor.dispose()
  })

  it("clears rate limit state on new progress event", () => {
    const deps = createDeps()
    const monitor = new SessionMonitor(deps)

    monitor.registerPipelineSession({
      pipelineId: "p1",
      stageId: "s1",
      stage: "implement",
      stageMode: "autonomous",
      sessionId: "sess1",
      stageOverride: {
        quietWindowMs: 1000,
        quietCorroborationMs: 500,
        leaseBySubtypeMs: { assistant_turn: 500, unknown: 500 },
      },
    })

    // Set rate limit
    monitor.recordNormalizedEvent({
      kind: "rate_limited",
      sessionId: "sess1",
      resetsAtMs: 60000,
    })

    // Agent resumes with a progress event — clears rate limit
    deps.time.value = 2000
    monitor.recordNormalizedEvent({
      kind: "progress_event",
      sessionId: "sess1",
      subtype: "assistant_turn",
      atMs: deps.time.value,
    })

    // Advance past lease (500ms) + quiet window (1000ms) + corroboration (500ms)
    deps.time.value = 5000
    monitor.sweep()

    // Escalation should fire (rate limit was cleared by progress event)
    expect(deps.onExhausted).toHaveBeenCalled()

    monitor.dispose()
  })

  it("rate limit with status 'allowed_warning' does NOT suppress escalation", () => {
    const deps = createDeps()
    const monitor = new SessionMonitor(deps)

    monitor.registerPipelineSession({
      pipelineId: "p1",
      stageId: "s1",
      stage: "implement",
      stageMode: "autonomous",
      sessionId: "sess1",
      stageOverride: {
        quietWindowMs: 1000,
        quietCorroborationMs: 500,
      },
    })

    // Only "rate_limited" events suppress escalation — allowed_warning is not a rate_limited event
    // (The engine only emits rate_limited for rejected status)
    // So no rate_limited event here — just advance time past quiet window

    deps.time.value = 5000
    monitor.sweep()

    // Escalation should fire normally
    expect(deps.onExhausted).toHaveBeenCalled()

    monitor.dispose()
  })

  it("rate limit with resetsAt in the past is immediately cleared on next sweep", () => {
    const deps = createDeps()
    const monitor = new SessionMonitor(deps)

    monitor.registerPipelineSession({
      pipelineId: "p1",
      stageId: "s1",
      stage: "implement",
      stageMode: "autonomous",
      sessionId: "sess1",
      stageOverride: {
        quietWindowMs: 1000,
        quietCorroborationMs: 500,
        leaseBySubtypeMs: { unknown: 500 },
      },
    })

    // Set rate limit with resetsAtMs already in the past
    // First advance past lease + quiet + corroboration from registration
    deps.time.value = 50000
    monitor.recordNormalizedEvent({
      kind: "rate_limited",
      sessionId: "sess1",
      resetsAtMs: 49000, // already expired
    })

    // Sweep — rate limit should be cleared immediately, normal evaluation proceeds
    monitor.sweep()

    // Escalation should fire (rate limit was expired, session is idle)
    expect(deps.onExhausted).toHaveBeenCalled()

    monitor.dispose()
  })
})
