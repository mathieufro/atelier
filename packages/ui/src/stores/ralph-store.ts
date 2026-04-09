import { createStore, produce } from "solid-js/store"

export interface RalphLoopInfo {
  sessionId: string
  promptPath: string
  maxIterations: number
  iteration: number
  status: "running" | "completed" | "cancelled" | "error"
  reason?: string
  detail?: string
}

export type RalphDividerEvent =
  | { type: "iteration"; sessionId: string; iteration: number; maxIterations: number; timestamp: number }
  | { type: "complete"; sessionId: string; iteration: number; reason: string; detail?: string; timestamp: number }

interface RalphStoreState {
  loops: Record<string, RalphLoopInfo>
  events: Record<string, RalphDividerEvent[]>
}

export function createRalphStore() {
  const [state, setState] = createStore<RalphStoreState>({
    loops: {},
    events: {},
  })

  function handleEvent(event: Record<string, unknown>) {
    const type = event.type as string
    if (!type?.startsWith("ralph.")) return

    const sessionId = event.sessionId as string

    switch (type) {
      case "ralph.started":
        setState("loops", sessionId, {
          sessionId,
          promptPath: event.promptPath as string,
          maxIterations: event.maxIterations as number,
          iteration: event.iteration as number,
          status: "running",
        })
        // Don't add a divider event for started — it's implicit
        break

      case "ralph.iteration":
        setState("loops", sessionId, "iteration", event.iteration as number)
        setState("events", produce((events) => {
          if (!events[sessionId]) events[sessionId] = []
          events[sessionId].push({
            type: "iteration",
            sessionId,
            iteration: event.iteration as number,
            maxIterations: event.maxIterations as number,
            timestamp: (event.timestamp as number) ?? Date.now(),
          })
        }))
        break

      case "ralph.complete": {
        const reason = event.reason as string
        const detail = event.detail as string | undefined
        const status = reason === "cancelled" ? "cancelled" : reason === "error" ? "error" : "completed"
        setState("loops", sessionId, { status, reason, detail, iteration: event.iteration as number })
        setState("events", produce((events) => {
          if (!events[sessionId]) events[sessionId] = []
          events[sessionId].push({
            type: "complete",
            sessionId,
            iteration: event.iteration as number,
            reason,
            detail,
            timestamp: (event.timestamp as number) ?? Date.now(),
          })
        }))
        break
      }
    }
  }

  function getLoop(sessionId: string): RalphLoopInfo | null {
    return state.loops[sessionId] ?? null
  }

  function isLoopActive(sessionId: string): boolean {
    return state.loops[sessionId]?.status === "running"
  }

  function getEvents(sessionId: string): RalphDividerEvent[] {
    return state.events[sessionId] ?? []
  }

  return { handleEvent, getLoop, isLoopActive, getEvents }
}

export type RalphStore = ReturnType<typeof createRalphStore>
