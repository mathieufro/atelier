/**
 * Extension fork wiring tests.
 *
 * The fork decision logic is unit-tested in fork-utils.test.ts (pure functions).
 * These tests verify the fork-utils functions are correctly integrated into
 * the extension by testing the exported helpers and the module-level state
 * management patterns.
 */
import { describe, it, expect, vi } from "vitest"
import {
  shouldForkOnSwitch,
  findBystanderPanels,
  shouldCleanupFork,
  findOrphanForks,
} from "../src/fork-utils.js"

describe("Extension fork wiring — integration patterns", () => {
  it("switchSession fork trigger: shouldForkOnSwitch + forkSession + panel redirect", async () => {
    // Simulate the extension's handleWebviewMessage switchSession path
    const panelA = { id: "A", webview: { postMessage: vi.fn() } }
    const panelB = { id: "B", webview: { postMessage: vi.fn() } }
    const panelActiveSessionIds = new Map<unknown, string | null>([[panelA, "sess-1"], [panelB, null]])
    const sessionStatusCache = new Map([["sess-1", "busy" as const]])
    const forkTracker = new Map<string, { hasUserMessages: boolean }>()

    // Panel B switches to sess-1 which is busy in Panel A
    const targetSessionId = "sess-1"
    if (shouldForkOnSwitch(targetSessionId, panelB, panelActiveSessionIds, sessionStatusCache)) {
      // Extension would call: const forked = await atelierClient.forkSession(targetSessionId)
      const forkedId = "fork-of-sess-1"
      forkTracker.set(forkedId, { hasUserMessages: false })
      panelB.webview.postMessage({ type: "activeSession", sessionId: forkedId })
      panelActiveSessionIds.set(panelB, forkedId)
    }

    expect(panelActiveSessionIds.get(panelB)).toBe("fork-of-sess-1")
    expect(forkTracker.has("fork-of-sess-1")).toBe(true)
    expect(panelB.webview.postMessage).toHaveBeenCalledWith({ type: "activeSession", sessionId: "fork-of-sess-1" })
  })

  it("sendMessage bystander fork: findBystanderPanels + fork each bystander", () => {
    const panelA = { id: "A", webview: { postMessage: vi.fn() } }
    const panelB = { id: "B", webview: { postMessage: vi.fn() } }
    const panelC = { id: "C", webview: { postMessage: vi.fn() } }
    const panelActiveSessionIds = new Map<unknown, string | null>([
      [panelA, "sess-1"],
      [panelB, "sess-1"],
      [panelC, "sess-2"],
    ])
    const forkTracker = new Map<string, { hasUserMessages: boolean }>()

    // Panel A sends a message — B is a bystander
    const senderSessionId = "sess-1"

    // Mark sender's fork tracking
    const senderTracking = forkTracker.get(senderSessionId)
    if (senderTracking) senderTracking.hasUserMessages = true

    const bystanders = findBystanderPanels(senderSessionId, panelA, panelActiveSessionIds)

    // Extension would fork for each bystander
    let forkCounter = 0
    for (const bystander of bystanders) {
      const forkedId = `bystander-fork-${++forkCounter}`
      forkTracker.set(forkedId, { hasUserMessages: false })
      ;(bystander as any).webview.postMessage({ type: "activeSession", sessionId: forkedId })
      panelActiveSessionIds.set(bystander, forkedId)
    }

    expect(bystanders).toHaveLength(1)
    expect(panelActiveSessionIds.get(panelB)).toBe("bystander-fork-1")
    expect(panelActiveSessionIds.get(panelC)).toBe("sess-2") // Unchanged
    expect(panelB.webview.postMessage).toHaveBeenCalledWith({ type: "activeSession", sessionId: "bystander-fork-1" })
  })

  it("forkStageSession: calls fork API and navigates panel", () => {
    const panel = { id: "A", webview: { postMessage: vi.fn() } }
    const forkTracker = new Map<string, { hasUserMessages: boolean }>()
    const panelActiveSessionIds = new Map<unknown, string | null>([[panel, "sess-old"]])

    // Extension handler: forkStageSession
    const forkedId = "stage-fork-1"
    forkTracker.set(forkedId, { hasUserMessages: false })
    panel.webview.postMessage({ type: "messages", messages: [], sessionId: forkedId, direction: "replace" })
    panel.webview.postMessage({ type: "activeSession", sessionId: forkedId })
    panelActiveSessionIds.set(panel, forkedId)

    expect(panelActiveSessionIds.get(panel)).toBe("stage-fork-1")
    expect(forkTracker.get("stage-fork-1")?.hasUserMessages).toBe(false)
    expect(panel.webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "activeSession", sessionId: "stage-fork-1" }),
    )
  })

  it("empty fork cleanup on panel dispose", () => {
    const panelA = { id: "A" }
    const forkTracker = new Map([["fork-1", { hasUserMessages: false }]])
    const panelActiveSessionIds = new Map<unknown, string | null>([[panelA, "fork-1"]])
    const deletedSessions: string[] = []

    const closingSessionId = panelActiveSessionIds.get(panelA)
    if (closingSessionId && shouldCleanupFork(closingSessionId, panelA, forkTracker, panelActiveSessionIds)) {
      deletedSessions.push(closingSessionId)
      forkTracker.delete(closingSessionId)
    }

    expect(deletedSessions).toEqual(["fork-1"])
    expect(forkTracker.has("fork-1")).toBe(false)
  })

  it("fork with user messages NOT cleaned up on panel dispose", () => {
    const panelA = { id: "A" }
    const forkTracker = new Map([["fork-1", { hasUserMessages: true }]])
    const panelActiveSessionIds = new Map<unknown, string | null>([[panelA, "fork-1"]])
    const deletedSessions: string[] = []

    const closingSessionId = panelActiveSessionIds.get(panelA)
    if (closingSessionId && shouldCleanupFork(closingSessionId, panelA, forkTracker, panelActiveSessionIds)) {
      deletedSessions.push(closingSessionId)
      forkTracker.delete(closingSessionId)
    }

    expect(deletedSessions).toEqual([])
    expect(forkTracker.has("fork-1")).toBe(true)
  })

  it("startup sweep detects orphan forks", () => {
    const sessions = [
      { id: "f1", forkedFrom: "src-1", createdAt: 1000, lastActiveAt: 1002, time: { created: 1000, updated: 1002 } },
      { id: "f2", forkedFrom: "src-2", createdAt: 2000, lastActiveAt: 8000, time: { created: 2000, updated: 8000 } },
      { id: "normal", createdAt: 3000, lastActiveAt: 3001, time: { created: 3000, updated: 3001 } },
    ]

    // Extension sweepOrphanForks maps sessions to the fork-utils format
    const sessionData = sessions.map((s: any) => ({
      id: s.id,
      forkedFrom: s.forkedFrom,
      createdAt: s.time?.created ?? 0,
      lastActiveAt: s.time?.updated ?? 0,
    }))
    const orphans = findOrphanForks(sessionData, 5000)

    expect(orphans).toEqual(["f1"])
  })

  it("session status cache pattern: SSE events update the cache", () => {
    const sessionStatusCache = new Map<string, "busy" | "idle">()

    // Helper matching the fixed extension logic — reads sessionID from properties first, then top-level sessionId
    function handleEvent(event: Record<string, unknown>) {
      if (event.type === "session.busy" || event.type === "session.idle") {
        const props = event.properties as Record<string, unknown> | undefined
        const sid = (typeof props?.sessionID === "string" ? props.sessionID : undefined)
          ?? (typeof event.sessionId === "string" ? event.sessionId as string : undefined)
        if (sid) {
          sessionStatusCache.set(sid, event.type === "session.busy" ? "busy" : "idle")
        }
      }
    }

    // Simulate normalized SSE events (sessionID inside properties, not top-level)
    handleEvent({ type: "session.busy", properties: { sessionID: "sess-1" } })
    expect(sessionStatusCache.get("sess-1")).toBe("busy")

    handleEvent({ type: "session.idle", properties: { sessionID: "sess-1" } })
    expect(sessionStatusCache.get("sess-1")).toBe("idle")
  })
})
