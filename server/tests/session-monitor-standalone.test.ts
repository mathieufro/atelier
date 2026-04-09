import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { SessionMonitor } from "../src/engine/session-monitor.js"
import type { SessionMonitorDeps } from "../src/engine/session-monitor.js"
import type { EngineSessionState } from "../src/engine/claude-code-engine.js"

function createMockDeps(overrides?: Partial<SessionMonitorDeps>): SessionMonitorDeps {
  let time = 1000
  return {
    onExhausted: vi.fn(),
    onStandaloneStalled: vi.fn(),
    getEngineSessionState: vi.fn(() => null),
    now: overrides?.now ?? (() => time),
    ...overrides,
  }
}

describe("SessionMonitor standalone mode", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("auto-registers session on busy_edge, unregisters on idle_edge", () => {
    let time = 1000
    const deps = createMockDeps({ now: () => time })
    const monitor = new SessionMonitor(deps)

    monitor.recordNormalizedEvent({ kind: "busy_edge", sessionId: "s1", atMs: time })
    expect(monitor.isTracked("s1")).toBe(true)

    monitor.recordNormalizedEvent({ kind: "idle_edge", sessionId: "s1", atMs: time })
    expect(monitor.isTracked("s1")).toBe(false)

    monitor.dispose()
  })

  it("does NOT auto-register pipeline sessions (they must use registerPipelineSession)", () => {
    let time = 1000
    const deps = createMockDeps({ now: () => time })
    const monitor = new SessionMonitor(deps)

    // Register as pipeline first
    monitor.registerPipelineSession({
      pipelineId: "p1",
      stageId: "st1",
      stage: "implement",
      stageMode: "autonomous",
      sessionId: "pipeline-s1",
    })

    // busy_edge for a known pipeline session should NOT create a standalone entry
    monitor.recordNormalizedEvent({ kind: "busy_edge", sessionId: "pipeline-s1", atMs: time })
    expect(monitor.isTracked("pipeline-s1")).toBe(false) // isTracked only checks standalone

    monitor.dispose()
  })

  it("detects stall when text streaming stops for > lease", () => {
    let time = 1000
    const deps = createMockDeps({ now: () => time })
    const monitor = new SessionMonitor(deps)

    monitor.recordNormalizedEvent({ kind: "busy_edge", sessionId: "s1", atMs: time })
    monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "s1", subtype: "part_progress", atMs: time })

    // Advance past the standalone part_progress lease (180s from updated config)
    time += 181_000
    monitor.sweep()

    expect(deps.onStandaloneStalled).toHaveBeenCalledOnce()
    expect(deps.onStandaloneStalled).toHaveBeenCalledWith("s1", expect.stringContaining("No SDK yield"), expect.any(Number))

    monitor.dispose()
  })

  it("does NOT fire stall during active tool execution (pendingToolCount > 0)", () => {
    let time = 1000
    const deps = createMockDeps({ now: () => time })
    const monitor = new SessionMonitor(deps)

    monitor.recordNormalizedEvent({ kind: "busy_edge", sessionId: "s1", atMs: time })
    monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "s1", subtype: "tool_start", atMs: time })

    // Advance way past hard ceiling — tool execution is never a stall
    time += 1_201_000
    monitor.sweep()

    expect(deps.onStandaloneStalled).not.toHaveBeenCalled()

    // After tool completes, stall detection resumes
    monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "s1", subtype: "tool_terminal", atMs: time })
    time += 241_000
    monitor.sweep()

    expect(deps.onStandaloneStalled).toHaveBeenCalledOnce()

    monitor.dispose()
  })

  it("fires onStandaloneStalled only once per session until reset", () => {
    let time = 1000
    const deps = createMockDeps({ now: () => time })
    const monitor = new SessionMonitor(deps)

    monitor.recordNormalizedEvent({ kind: "busy_edge", sessionId: "s1", atMs: time })
    monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "s1", subtype: "part_progress", atMs: time })

    time += 181_000
    monitor.sweep()
    expect(deps.onStandaloneStalled).toHaveBeenCalledOnce()

    // Sweep again — should NOT fire again
    time += 10_000
    monitor.sweep()
    expect(deps.onStandaloneStalled).toHaveBeenCalledOnce()

    // Reset and trigger again
    monitor.resetStandaloneSession("s1")
    time += 181_000
    monitor.sweep()
    expect(deps.onStandaloneStalled).toHaveBeenCalledTimes(2)

    monitor.dispose()
  })

  it("updates lastYieldAt and subtype on progress events", () => {
    let time = 1000
    const deps = createMockDeps({ now: () => time })
    const monitor = new SessionMonitor(deps)

    monitor.recordNormalizedEvent({ kind: "busy_edge", sessionId: "s1", atMs: time })

    time += 5000
    monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "s1", subtype: "tool_start", atMs: time })

    // Advance past part_progress lease but within tool_start lease
    time += 195_000
    monitor.sweep()

    // Should NOT stall — last subtype is tool_start with long lease, and tools are executing
    expect(deps.onStandaloneStalled).not.toHaveBeenCalled()

    monitor.dispose()
  })

  it("stops restarting after maxRestarts exceeded", () => {
    let time = 1000
    const deps = createMockDeps({ now: () => time })
    const monitor = new SessionMonitor(deps)

    monitor.recordNormalizedEvent({ kind: "busy_edge", sessionId: "s1", atMs: time })
    monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "s1", subtype: "part_progress", atMs: time })

    // Stall 1
    time += 181_000
    monitor.sweep()
    expect(deps.onStandaloneStalled).toHaveBeenCalledTimes(1)
    expect((deps.onStandaloneStalled as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain("restart 1/3")

    // Reset (simulates successful interrupt-restart)
    monitor.resetStandaloneSession("s1")

    // Stall 2
    time += 181_000
    monitor.sweep()
    expect(deps.onStandaloneStalled).toHaveBeenCalledTimes(2)
    expect((deps.onStandaloneStalled as ReturnType<typeof vi.fn>).mock.calls[1][1]).toContain("restart 2/3")

    // Reset
    monitor.resetStandaloneSession("s1")

    // Stall 3
    time += 181_000
    monitor.sweep()
    expect(deps.onStandaloneStalled).toHaveBeenCalledTimes(3)
    expect((deps.onStandaloneStalled as ReturnType<typeof vi.fn>).mock.calls[2][1]).toContain("restart 3/3")

    // Reset
    monitor.resetStandaloneSession("s1")

    // Stall 4 — exceeds max
    time += 181_000
    monitor.sweep()
    expect(deps.onStandaloneStalled).toHaveBeenCalledTimes(4)
    expect((deps.onStandaloneStalled as ReturnType<typeof vi.fn>).mock.calls[3][1]).toContain("giving up")

    // Sweep again — permanently stalled, should not fire
    time += 181_000
    monitor.sweep()
    expect(deps.onStandaloneStalled).toHaveBeenCalledTimes(4)

    monitor.dispose()
  })

  it("restartCount resets on successful yield", () => {
    let time = 1000
    const deps = createMockDeps({ now: () => time })
    const monitor = new SessionMonitor(deps)

    monitor.recordNormalizedEvent({ kind: "busy_edge", sessionId: "s1", atMs: time })
    monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "s1", subtype: "part_progress", atMs: time })

    // Stall 1
    time += 181_000
    monitor.sweep()
    expect(deps.onStandaloneStalled).toHaveBeenCalledTimes(1)
    expect((deps.onStandaloneStalled as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain("restart 1/3")

    // Reset, then successful yield (progress event)
    monitor.resetStandaloneSession("s1")
    time += 1000
    monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "s1", subtype: "part_progress", atMs: time })

    // Stall again — should be restart 1/3, NOT 2/3 (restartCount was reset by yield)
    time += 181_000
    monitor.sweep()
    expect(deps.onStandaloneStalled).toHaveBeenCalledTimes(2)
    expect((deps.onStandaloneStalled as ReturnType<typeof vi.fn>).mock.calls[1][1]).toContain("restart 1/3")

    monitor.dispose()
  })

  it("refreshes from engine state during sweep", () => {
    let time = 1000
    const engineState: EngineSessionState = {
      lastYieldAt: 1000,
      lastSubtype: "part_progress",
      busy: true,
      hasPendingInteractions: false,
      pendingToolCount: 0,
    }
    const deps = createMockDeps({
      getEngineSessionState: vi.fn(() => engineState),
      now: () => time,
    })
    const monitor = new SessionMonitor(deps)

    monitor.recordNormalizedEvent({ kind: "busy_edge", sessionId: "s1", atMs: time })
    monitor.recordNormalizedEvent({ kind: "progress_event", sessionId: "s1", subtype: "part_progress", atMs: time })

    // Engine reports a more recent yield than our last event
    time += 90_000
    engineState.lastYieldAt = time  // engine saw a yield

    time += 90_000  // now at 181000, 90s since engine's last yield — within 180s lease
    monitor.sweep()

    expect(deps.onStandaloneStalled).not.toHaveBeenCalled()

    monitor.dispose()
  })

  it("removes entry when engine reports session not busy", () => {
    let time = 1000
    const deps = createMockDeps({
      getEngineSessionState: vi.fn(() => ({
        lastYieldAt: 1000,
        lastSubtype: "part_progress" as const,
        busy: false,
        hasPendingInteractions: false,
        pendingToolCount: 0,
      })),
      now: () => time,
    })
    const monitor = new SessionMonitor(deps)

    monitor.recordNormalizedEvent({ kind: "busy_edge", sessionId: "s1", atMs: time })
    expect(monitor.isTracked("s1")).toBe(true)

    time += 200_000
    monitor.sweep()

    expect(monitor.isTracked("s1")).toBe(false)
    expect(deps.onStandaloneStalled).not.toHaveBeenCalled()

    monitor.dispose()
  })
})
