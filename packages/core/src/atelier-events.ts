export type BackendId = "claude-code" | "opencode"

// --- Content blocks (backend-agnostic) ---

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; toolUseId: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; output: string; isError: boolean }
  | { type: "thinking"; text: string }

// --- Backend-agnostic message ---

export interface AtelierMessage {
  id: string
  role: "user" | "assistant"
  contentBlocks: ContentBlock[]
  timestamp: number
  usage?: { inputTokens: number; outputTokens: number }
}

// --- AtelierEvent discriminated union ---

export type AtelierEvent =
  // Session lifecycle
  | { type: "session.busy"; sessionId: string }
  | { type: "session.idle"; sessionId: string; usage: { inputTokens: number; outputTokens: number }; costUsd?: number; durationMs?: number }
  | { type: "session.interrupted"; sessionId: string }
  | { type: "session.stalled"; sessionId: string; reason: string; silentForMs: number }
  | { type: "session.error"; sessionId: string; error: string }
  // Message content
  | { type: "message.created"; sessionId: string; messageId: string; role: "user" | "assistant" }
  | { type: "message.delta"; sessionId: string; messageId: string; contentType: "text" | "thinking"; delta: string }
  | { type: "message.completed"; sessionId: string; messageId: string; role: "user" | "assistant"; contentBlocks: ContentBlock[]; model?: { providerID: string; modelID: string }; variant?: string }
  // Tool activity
  | { type: "tool.started"; sessionId: string; toolUseId: string; toolName: string; messageId?: string; input: Record<string, unknown> }
  | { type: "tool.completed"; sessionId: string; toolUseId: string; toolName: string; messageId?: string; output: string; durationMs: number; isError: boolean; input?: Record<string, unknown> }
  // Interactions
  | { type: "permission.asked"; sessionId: string; requestId: string; toolName: string; toolInput: Record<string, unknown>; suggestions?: unknown; decisionReason?: string }
  | { type: "permission.replied"; sessionId: string; requestId: string; behavior: "allow" | "deny" }
  | { type: "question.asked"; sessionId: string; requestId: string; question: unknown; tool?: { messageID: string; callID: string } }
  | { type: "question.replied"; sessionId: string; requestId: string }
  | { type: "question.rejected"; sessionId: string; requestId: string }
  // Infrastructure
  | { type: "connection.status"; backend: BackendId; state: "not_started" | "starting" | "ready" | "error"; error?: string }
  | { type: "rate_limit"; sessionId: string; status: "allowed" | "allowed_warning" | "rejected"; resetsAt?: number; utilization?: number }
  // Ralph loop
  | { type: "ralph.started"; sessionId: string; promptPath: string; maxIterations: number; completionPromise: string | null; iteration: number }
  | { type: "ralph.iteration"; sessionId: string; iteration: number; maxIterations: number }
  | { type: "ralph.complete"; sessionId: string; iteration: number; reason: "promise_fulfilled" | "max_iterations" | "cancelled" | "error"; detail?: string }
