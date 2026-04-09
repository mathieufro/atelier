import { describe, it, expect } from "vitest"
import { createRoot } from "solid-js"
import { createSessionStore } from "./session-store.js"
import type { Session, Event } from "@atelier/core"

const makeSession = (id: string, title = "Test"): Session => ({
  id,
  slug: id,
  projectID: "p1",
  directory: "/test",
  title,
  version: "1",
  time: { created: Date.now(), updated: Date.now() },
})

describe("SessionStore", () => {
  it("initializes empty", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      expect(store.sessions()).toEqual([])
      expect(store.activeSessionId()).toBeNull()
      dispose()
    })
  })

  it("loads sessions from list", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1"), makeSession("s2")])
      expect(store.sessions()).toHaveLength(2)
      dispose()
    })
  })

  it("sets active session", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1")])
      store.setActiveSession("s1")
      expect(store.activeSessionId()).toBe("s1")
      expect(store.activeSession()?.id).toBe("s1")
      dispose()
    })
  })

  it("handles session.created event", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.handleEvent({
        type: "session.created",
        properties: { info: makeSession("s1") },
      } as any)
      expect(store.sessions()).toHaveLength(1)
      expect(store.activeSessionId()).toBeNull()
      dispose()
    })
  })

  it("does not change active session on session.created when one is already selected", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1")])
      store.setActiveSession("s1")
      store.handleEvent({
        type: "session.created",
        properties: { info: makeSession("s2") },
      } as any)
      expect(store.activeSessionId()).toBe("s1")
      dispose()
    })
  })

  it("ignores session.created for pipeline sub-sessions (parentID set)", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.handleEvent({
        type: "session.created",
        properties: { info: { ...makeSession("child1"), parentID: "parent1" } },
      } as any)
      expect(store.sessions()).toHaveLength(0)
      dispose()
    })
  })

  it("ignores session.updated for pipeline sub-sessions (parentID set)", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.handleEvent({
        type: "session.updated",
        properties: { info: { ...makeSession("child1"), parentID: "parent1" } },
      } as any)
      expect(store.sessions()).toHaveLength(0)
      dispose()
    })
  })

  it("handles session.updated event", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1", "Old")])
      store.handleEvent({
        type: "session.updated",
        properties: { info: { ...makeSession("s1"), title: "New" } },
      } as any)
      expect(store.sessions()[0]!.title).toBe("New")
      dispose()
    })
  })

  it("handles session.deleted event", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1")])
      store.handleEvent({
        type: "session.deleted",
        properties: { info: makeSession("s1") },
      } as any)
      expect(store.sessions()).toHaveLength(0)
      dispose()
    })
  })

  it("handles session.status event", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1")])
      store.handleEvent({
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "busy" } },
      } as any)
      expect(store.getStatus("s1")).toEqual({ type: "busy" })
      dispose()
    })
  })

  // I3: Handle session.idle event
  it("handles session.idle event", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1")])
      // First set to busy
      store.handleEvent({
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "busy" } },
      } as any)
      expect(store.getStatus("s1")).toEqual({ type: "busy" })
      // Then idle
      store.handleEvent({
        type: "session.idle",
        properties: { sessionID: "s1" },
      } as any)
      expect(store.getStatus("s1")).toEqual({ type: "idle" })
      dispose()
    })
  })

  // session.error resets to idle (error is not a valid SessionStatus variant)
  it("handles session.error event by resetting to idle", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1")])
      store.handleEvent({
        type: "session.error",
        properties: { sessionID: "s1" },
      } as any)
      expect(store.getStatus("s1")).toEqual({ type: "idle" })
      dispose()
    })
  })

  it("auto-selects next session on delete if active was deleted", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1"), makeSession("s2")])
      store.setActiveSession("s1")
      store.handleEvent({
        type: "session.deleted",
        properties: { info: makeSession("s1") },
      } as any)
      // Auto-selects most recent remaining session instead of null
      expect(store.activeSessionId()).toBe("s2")
      dispose()
    })
  })

  it("clears active session to null when last session is deleted", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1")])
      store.setActiveSession("s1")
      store.handleEvent({
        type: "session.deleted",
        properties: { info: makeSession("s1") },
      } as any)
      expect(store.activeSessionId()).toBeNull()
      dispose()
    })
  })

  it("handles session.stalled event", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1")])
      store.handleEvent({
        type: "session.stalled",
        properties: { sessionID: "s1", reason: "No SDK yield for 91s", silentForMs: 91000 },
      } as any)
      expect(store.getStatus("s1")).toEqual({ type: "stalled", reason: "No SDK yield for 91s" })
      dispose()
    })
  })

  it("session.busy after stalled clears stalled status", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1")])
      // Set to stalled
      store.handleEvent({
        type: "session.stalled",
        properties: { sessionID: "s1", reason: "stalled", silentForMs: 91000 },
      } as any)
      expect(store.getStatus("s1")).toEqual({ type: "stalled", reason: "stalled" })
      // Then busy (restart succeeded)
      store.handleEvent({
        type: "session.busy",
        properties: { sessionID: "s1" },
      } as any)
      expect(store.getStatus("s1")).toEqual({ type: "busy" })
      dispose()
    })
  })

  it("returns idle for unknown session status", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      expect(store.getStatus("unknown")).toEqual({ type: "idle" })
      dispose()
    })
  })

  it("sorts sessions by updated time descending", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      const s1 = makeSession("s1")
      const s2 = makeSession("s2")
      s1.time.updated = 1000
      s2.time.updated = 2000
      store.loadSessions([s1, s2])
      expect(store.sessions()[0]!.id).toBe("s2")
      dispose()
    })
  })

  it("ignores unknown event types", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      expect(() => store.handleEvent({ type: "session.unknown", properties: {} } as any)).not.toThrow()
      dispose()
    })
  })

  it("loadSessions replaces previous data", () => {
    createRoot((dispose) => {
      const store = createSessionStore()
      store.loadSessions([makeSession("s1")])
      store.loadSessions([makeSession("s2"), makeSession("s3")])
      expect(store.sessions()).toHaveLength(2)
      dispose()
    })
  })

})
