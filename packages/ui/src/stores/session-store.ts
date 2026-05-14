import { createSignal, createMemo } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { Session, OpenCodeForwardedEvent, AtelierSessionStatus } from "@atelier/core"
import { debug } from "../debug.js"

interface SessionStoreState {
  byId: Record<string, Session>
  statuses: Record<string, AtelierSessionStatus>
  interrupted: Record<string, boolean>
  compacting: Record<string, boolean>
}

export function createSessionStore() {
  const [state, setState] = createStore<SessionStoreState>({
    byId: {},
    statuses: {},
    interrupted: {},
    compacting: {},
  })
  const [activeSessionId, setActiveSessionId] = createSignal<string | null>(null)

  const sessions = createMemo(() =>
    Object.values(state.byId).sort((a, b) => b.time.updated - a.time.updated),
  )

  const activeSession = createMemo(() => {
    const id = activeSessionId()
    return id ? state.byId[id] ?? null : null
  })

  function loadSessions(sessions: Session[]) {
    setState("byId", reconcile(Object.fromEntries(sessions.map((s) => [s.id, s]))))
  }

  function getStatus(sessionId: string): AtelierSessionStatus {
    return state.statuses[sessionId] ?? { type: "idle" }
  }

  function isInterrupted(sessionId: string): boolean {
    return state.interrupted[sessionId] ?? false
  }

  function isCompacting(sessionId: string): boolean {
    return state.compacting[sessionId] ?? false
  }

  function handleEvent(event: OpenCodeForwardedEvent) {
    debug("session_event", { type: event.type, sessionId: (event as any).properties?.info?.id })
    switch (event.type) {
      case "session.created":
        // Skip pipeline sub-sessions — they shouldn't appear in the chat list
        if (event.properties.info.parentID) break
        setState("byId", event.properties.info.id, event.properties.info)
        // Do not auto-activate on broadcast events; selection is panel-local and
        // should be driven by explicit activeSession messages from the host.
        break
      case "session.updated":
        // Skip pipeline sub-sessions — they shouldn't appear in the chat list
        if (event.properties.info.parentID) break
        setState("byId", event.properties.info.id, event.properties.info)
        break
      case "session.deleted": {
        const id = event.properties.info.id
        setState(
          produce((s) => {
            delete s.byId[id]
            delete s.statuses[id]
          }),
        )
        if (activeSessionId() === id) {
          // Auto-select the most recent remaining session instead of leaving null
          const remaining = Object.values(state.byId)
            .sort((a, b) => b.time.updated - a.time.updated)
          setActiveSessionId(remaining[0]?.id ?? null)
        }
        break
      }
      case "session.status":
        setState("statuses", event.properties.sessionID, event.properties.status)
        break
      case "session.busy":
        setState("statuses", event.properties.sessionID, reconcile({ type: "busy" as const }))
        setState("interrupted", event.properties.sessionID, false)
        break
      case "session.interrupted":
        setState("interrupted", event.properties.sessionID, true)
        break
      case "session.stalled":
        setState("statuses", event.properties.sessionID, reconcile({
          type: "stalled" as const,
          reason: (event.properties as any).reason,
        }))
        break
      // I3: Handle session.idle event
      case "session.idle":
        setState("statuses", event.properties.sessionID, reconcile({ type: "idle" as const }))
        break
      // session.error carries error details but sessionID is optional; reset to idle
      case "session.error":
        if (event.properties.sessionID) {
          setState("statuses", event.properties.sessionID, reconcile({ type: "idle" as const }))
        }
        break
      case "session.next.compaction.started":
        setState("compacting", event.properties.sessionID, true)
        break
      case "session.next.compaction.ended":
      case "session.compacted":
        setState("compacting", event.properties.sessionID, false)
        break
    }
  }

  function removeSession(id: string) {
    setState(produce((s) => {
      delete s.byId[id]
      delete s.statuses[id]
      delete s.interrupted[id]
    }))
  }

  function setActiveSession(id: string | null) {
    debug("set_active_session", { sessionId: id })
    setActiveSessionId(id)
  }

  return {
    sessions,
    activeSession,
    activeSessionId,
    loadSessions,
    setActiveSession,
    removeSession,
    getStatus,
    isInterrupted,
    isCompacting,
    handleEvent,
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>
