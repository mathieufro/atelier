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

describe("SessionMonitor pipelineSnapshots pruning", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("evicts oldest pipelineSnapshots when limit exceeded", () => {
    const deps = createDeps()
    const monitor = new SessionMonitor(deps)

    // Register 60 pipeline sessions and send progress events to create snapshots
    for (let i = 0; i < 60; i++) {
      const sessionId = `sess-${i}`
      monitor.registerPipelineSession({
        pipelineId: `p-${i}`,
        stageId: `s-${i}`,
        stage: "implement",
        stageMode: "autonomous",
        sessionId,
      })

      deps.time.value = 1000 + i * 100
      monitor.recordNormalizedEvent({
        kind: "progress_event",
        sessionId,
        subtype: "assistant_turn",
        atMs: deps.time.value,
      })
    }

    // The pipelineSnapshots map should be bounded at 50
    const snapshotCount = (monitor as any).pipelineSnapshots.size
    expect(snapshotCount).toBeLessThanOrEqual(50)

    // The earliest snapshot should have been evicted from the cache
    // (getSessionSnapshot still returns data for sess-0 because it's in the sessions Map,
    // but the pipelineSnapshots cache should not contain it)
    expect((monitor as any).pipelineSnapshots.has("sess-0")).toBe(false)

    // The most recent should still be in the cache
    expect((monitor as any).pipelineSnapshots.has("sess-59")).toBe(true)

    monitor.dispose()
  })

  it("eviction does not break getSessionSnapshot for active sessions", () => {
    const deps = createDeps()
    const monitor = new SessionMonitor(deps)

    // Register 60 sessions to trigger eviction
    for (let i = 0; i < 60; i++) {
      const sessionId = `sess-${i}`
      monitor.registerPipelineSession({
        pipelineId: `p-${i}`,
        stageId: `s-${i}`,
        stage: "implement",
        stageMode: "autonomous",
        sessionId,
      })

      deps.time.value = 1000 + i * 100
      monitor.recordNormalizedEvent({
        kind: "progress_event",
        sessionId,
        subtype: "assistant_turn",
        atMs: deps.time.value,
      })
    }

    // Last session is still active (in sessions Map, not just pipelineSnapshots)
    // So getSessionSnapshot should return the live snapshot from the sessions Map
    const activeSnapshot = monitor.getSessionSnapshot("sess-59")
    expect(activeSnapshot).toBeTruthy()
    expect(activeSnapshot!.pipelineId).toBe("p-59")

    monitor.dispose()
  })

  it("rapid events on same session update snapshot in place without growing", () => {
    const deps = createDeps()
    const monitor = new SessionMonitor(deps)

    monitor.registerPipelineSession({
      pipelineId: "p1",
      stageId: "s1",
      stage: "implement",
      stageMode: "autonomous",
      sessionId: "sess1",
    })

    // Send 100 progress events on the same session
    for (let i = 0; i < 100; i++) {
      deps.time.value = 1000 + i * 10
      monitor.recordNormalizedEvent({
        kind: "progress_event",
        sessionId: "sess1",
        subtype: "assistant_turn",
        atMs: deps.time.value,
      })
    }

    // Snapshot map should have exactly 1 entry (same key, updated in place)
    const snapshotCount = (monitor as any).pipelineSnapshots.size
    expect(snapshotCount).toBe(1)

    monitor.dispose()
  })
})
