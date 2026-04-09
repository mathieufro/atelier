import { describe, it, expect } from "vitest"
import {
  shouldForkOnSwitch,
  findBystanderPanels,
  shouldCleanupFork,
  findOrphanForks,
} from "../src/fork-utils.js"

describe("shouldForkOnSwitch", () => {
  it("returns true when target session is busy in another panel", () => {
    const panelA = { id: "A" }
    const panelB = { id: "B" }
    const panelSessions = new Map<unknown, string | null>([[panelA, "sess-1"], [panelB, null]])
    const statusCache = new Map([["sess-1", "busy" as const]])

    expect(shouldForkOnSwitch("sess-1", panelB, panelSessions, statusCache)).toBe(true)
  })

  it("returns false when target session is idle in another panel", () => {
    const panelA = { id: "A" }
    const panelB = { id: "B" }
    const panelSessions = new Map<unknown, string | null>([[panelA, "sess-1"], [panelB, null]])
    const statusCache = new Map([["sess-1", "idle" as const]])

    expect(shouldForkOnSwitch("sess-1", panelB, panelSessions, statusCache)).toBe(false)
  })

  it("returns false when target session is not in any other panel", () => {
    const panelA = { id: "A" }
    const panelSessions = new Map<unknown, string | null>([[panelA, "other-sess"]])
    const statusCache = new Map([["sess-1", "busy" as const]])

    expect(shouldForkOnSwitch("sess-1", panelA, panelSessions, statusCache)).toBe(false)
  })

  it("returns false when session status is unknown (not in cache)", () => {
    const panelA = { id: "A" }
    const panelB = { id: "B" }
    const panelSessions = new Map<unknown, string | null>([[panelA, "sess-1"], [panelB, null]])
    const statusCache = new Map<string, "busy" | "idle">()

    expect(shouldForkOnSwitch("sess-1", panelB, panelSessions, statusCache)).toBe(false)
  })
})

describe("findBystanderPanels", () => {
  it("returns panels viewing the session excluding the sender", () => {
    const panelA = { id: "A" }
    const panelB = { id: "B" }
    const panelC = { id: "C" }
    const map = new Map<unknown, string | null>([[panelA, "sess-1"], [panelB, "sess-1"], [panelC, "sess-2"]])

    expect(findBystanderPanels("sess-1", panelA, map)).toEqual([panelB])
  })

  it("returns empty when no other panel views the session", () => {
    const panelA = { id: "A" }
    const map = new Map<unknown, string | null>([[panelA, "sess-1"]])

    expect(findBystanderPanels("sess-1", panelA, map)).toEqual([])
  })

  it("returns multiple bystanders for 3+ panels on same session", () => {
    const p1 = { id: "1" }
    const p2 = { id: "2" }
    const p3 = { id: "3" }
    const map = new Map<unknown, string | null>([[p1, "s"], [p2, "s"], [p3, "s"]])

    const result = findBystanderPanels("s", p1, map)
    expect(result).toHaveLength(2)
    expect(result).toContain(p2)
    expect(result).toContain(p3)
  })
})

describe("shouldCleanupFork", () => {
  it("returns true for fork with no user messages and no other panel", () => {
    const panel = { id: "A" }
    const forkTracker = new Map([["fork-1", { hasUserMessages: false }]])
    const panelSessions = new Map<unknown, string | null>([[panel, "fork-1"]])

    expect(shouldCleanupFork("fork-1", panel, forkTracker, panelSessions)).toBe(true)
  })

  it("returns false for fork with user messages", () => {
    const panel = { id: "A" }
    const forkTracker = new Map([["fork-1", { hasUserMessages: true }]])
    const panelSessions = new Map<unknown, string | null>([[panel, "fork-1"]])

    expect(shouldCleanupFork("fork-1", panel, forkTracker, panelSessions)).toBe(false)
  })

  it("returns false when another panel also views the fork", () => {
    const panelA = { id: "A" }
    const panelB = { id: "B" }
    const forkTracker = new Map([["fork-1", { hasUserMessages: false }]])
    const panelSessions = new Map<unknown, string | null>([[panelA, "fork-1"], [panelB, "fork-1"]])

    expect(shouldCleanupFork("fork-1", panelA, forkTracker, panelSessions)).toBe(false)
  })

  it("returns false when session is not a tracked fork", () => {
    const panel = { id: "A" }
    const forkTracker = new Map<string, { hasUserMessages: boolean }>()
    const panelSessions = new Map<unknown, string | null>([[panel, "normal-1"]])

    expect(shouldCleanupFork("normal-1", panel, forkTracker, panelSessions)).toBe(false)
  })
})

describe("findOrphanForks", () => {
  it("returns forks where lastActiveAt - createdAt < threshold", () => {
    const sessions = [
      { id: "f1", forkedFrom: "src-1", createdAt: 1000, lastActiveAt: 1002 },
      { id: "f2", forkedFrom: "src-2", createdAt: 2000, lastActiveAt: 8000 },
      { id: "normal", createdAt: 3000, lastActiveAt: 3001 },
    ]
    expect(findOrphanForks(sessions, 5000)).toEqual(["f1"])
  })

  it("returns empty when no orphan forks exist", () => {
    const sessions = [
      { id: "f1", forkedFrom: "src-1", createdAt: 1000, lastActiveAt: 9000 },
    ]
    expect(findOrphanForks(sessions, 5000)).toEqual([])
  })

  it("ignores sessions without forkedFrom", () => {
    const sessions = [
      { id: "n1", createdAt: 1000, lastActiveAt: 1001 },
    ]
    expect(findOrphanForks(sessions, 5000)).toEqual([])
  })
})
