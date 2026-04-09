export type DetectorProgressSubtype =
  | "assistant_turn"
  | "part_progress"
  | "tool_start"
  | "tool_running"
  | "tool_terminal"
  | "subagent_progress"
  | "file_write_adjacent"
  | "unknown"

export type DetectorInfraState = "connected" | "reconnecting" | "disconnected"

export type DetectorNormalizedEvent =
  | { kind: "progress_event"; sessionId: string; subtype: DetectorProgressSubtype; atMs?: number }
  | { kind: "busy_edge"; sessionId: string; atMs?: number }
  | { kind: "idle_edge"; sessionId: string; atMs?: number }
  | { kind: "session_error"; sessionId: string; atMs?: number; error?: string }
  | { kind: "infra_state_changed"; atMs?: number; state: DetectorInfraState }
  | { kind: "rate_limited"; sessionId: string; resetsAtMs: number; atMs?: number }

interface SsePayload {
  type?: string
  timestamp?: number
  sessionID?: string
  properties?: {
    info?: { sessionID?: string; id?: string; role?: string; timestamp?: number; [key: string]: unknown }
    sessionID?: string
    part?: { type?: string; state?: { type?: string }; id?: string; [key: string]: unknown }
    error?: string
    timestamp?: number
    [key: string]: unknown
  }
  [key: string]: unknown
}

function extractSessionId(payload: SsePayload): string | undefined {
  return payload.properties?.info?.sessionID ?? payload.properties?.sessionID ?? payload.properties?.info?.id
}

function isAssistantRole(payload: SsePayload): boolean {
  return payload.properties?.info?.role === "assistant"
}

function isToolInvocation(part: { type?: string; [key: string]: unknown } | undefined): boolean {
  return part?.type === "tool-invocation"
}

function classifyProgressSubtype(payload: SsePayload): DetectorProgressSubtype {
  const type = payload.type
  const part = payload.properties?.part

  if (type === "message.completed" && isAssistantRole(payload)) {
    return "file_write_adjacent"
  }

  if ((type === "message.created" || type === "message.updated") && isAssistantRole(payload)) {
    return "assistant_turn"
  }

  if (type === "part.created" || type === "message.part.created") {
    if (part?.type === "tool-invocation" || part?.type === "tool") return "tool_start"
    if (part?.type === "agent") return "subagent_progress"
    return "part_progress"
  }

  if (type === "part.updated" || type === "message.part.updated") {
    if (part?.type === "tool-invocation" || part?.type === "tool") {
      const state = part?.state?.type
      if (state === "running") return "tool_running"
      if (state === "completed" || state === "error") return "tool_terminal"
      return "tool_running"
    }
    if (part?.type === "agent") return "subagent_progress"
    return "part_progress"
  }

  return "unknown"
}

function extractTimestamp(payload: SsePayload): number | undefined {
  const ts = payload.properties?.timestamp ?? payload.properties?.info?.timestamp ?? payload.timestamp
  return typeof ts === "number" ? ts : undefined
}

export function normalizeSseEvent(payload: SsePayload): DetectorNormalizedEvent | null {
  if (!payload.type) return null

  const sessionId = extractSessionId(payload)
  const atMs = extractTimestamp(payload)
  switch (payload.type) {
    case "session.busy":
      return sessionId ? { kind: "busy_edge", sessionId, atMs } : null
    case "session.idle":
      return sessionId ? { kind: "idle_edge", sessionId, atMs } : null
    case "session.error":
      return sessionId ? { kind: "session_error", sessionId, error: payload.properties?.error, atMs } : null
    case "message.created":
    case "message.updated":
    case "message.completed":
    case "part.created":
    case "message.part.created":
    case "part.updated":
    case "message.part.updated": {
      if (!sessionId) return null
      const subtype = classifyProgressSubtype(payload)
      return { kind: "progress_event", sessionId, subtype, atMs }
    }
    default:
      return null
  }
}
