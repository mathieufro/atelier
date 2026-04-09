import type { AtelierEvent } from "@atelier/core"

// --- AtelierEvent factories ---

export function sessionBusy(sessionId: string): AtelierEvent {
  return { type: "session.busy", sessionId }
}

export function sessionIdle(sessionId: string, usage = { inputTokens: 10, outputTokens: 5 }): AtelierEvent {
  return { type: "session.idle", sessionId, usage }
}

export function sessionInterrupted(sessionId: string): AtelierEvent {
  return { type: "session.interrupted", sessionId }
}

export function sessionError(sessionId: string, error = "test error"): AtelierEvent {
  return { type: "session.error", sessionId, error }
}

export function messageCreated(sessionId: string, messageId: string, role: "user" | "assistant" = "assistant"): AtelierEvent {
  return { type: "message.created", sessionId, messageId, role }
}

export function messageDelta(sessionId: string, messageId: string, delta: string, contentType: "text" | "thinking" = "text"): AtelierEvent {
  return { type: "message.delta", sessionId, messageId, contentType, delta }
}

export function messageCompletedText(sessionId: string, messageId: string, text: string): AtelierEvent {
  return { type: "message.completed", sessionId, messageId, role: "assistant", contentBlocks: [{ type: "text", text }] }
}

export function toolStarted(sessionId: string, toolUseId: string, toolName: string, input: Record<string, unknown> = {}, messageId?: string): AtelierEvent {
  return { type: "tool.started", sessionId, toolUseId, toolName, messageId, input }
}

export function toolCompleted(sessionId: string, toolUseId: string, toolName: string, output = "", opts?: { isError?: boolean; durationMs?: number; messageId?: string; input?: Record<string, unknown> }): AtelierEvent {
  return {
    type: "tool.completed", sessionId, toolUseId, toolName,
    output, isError: opts?.isError ?? false, durationMs: opts?.durationMs ?? 100,
    messageId: opts?.messageId, input: opts?.input,
  }
}

export function permissionAsked(sessionId: string, requestId: string, toolName: string, toolInput: Record<string, unknown> = {}): AtelierEvent {
  return { type: "permission.asked", sessionId, requestId, toolName, toolInput }
}

export function permissionReplied(sessionId: string, requestId: string, behavior: "allow" | "deny" = "allow"): AtelierEvent {
  return { type: "permission.replied", sessionId, requestId, behavior }
}

export function questionAsked(sessionId: string, requestId: string, question: Record<string, unknown> = {}): AtelierEvent {
  return { type: "question.asked", sessionId, requestId, question }
}

export function questionReplied(sessionId: string, requestId: string): AtelierEvent {
  return { type: "question.replied", sessionId, requestId }
}

export function questionRejected(sessionId: string, requestId: string): AtelierEvent {
  return { type: "question.rejected", sessionId, requestId }
}

export function connectionStatus(backend: "claude-code" | "opencode", state: "ready" | "starting" | "error" | "not_started"): AtelierEvent {
  return { type: "connection.status", backend, state }
}

export function rateLimit(sessionId: string, status: "allowed" | "allowed_warning" | "rejected"): AtelierEvent {
  return { type: "rate_limit", sessionId, status }
}

// --- Ralph loop event factories ---

export function ralphStarted(sessionId: string, opts: { promptPath?: string; maxIterations?: number; completionPromise?: string | null; iteration?: number } = {}): AtelierEvent {
  return {
    type: "ralph.started",
    sessionId,
    promptPath: opts.promptPath ?? "/test/prompt.md",
    maxIterations: opts.maxIterations ?? 0,
    completionPromise: opts.completionPromise ?? null,
    iteration: opts.iteration ?? 1,
  }
}

export function ralphIteration(sessionId: string, iteration: number, maxIterations = 0): AtelierEvent {
  return { type: "ralph.iteration", sessionId, iteration, maxIterations }
}

export function ralphComplete(sessionId: string, iteration: number, reason: "promise_fulfilled" | "max_iterations" | "cancelled" | "error", detail?: string): AtelierEvent {
  return {
    type: "ralph.complete", sessionId, iteration, reason,
    ...(detail !== undefined ? { detail } : {}),
  } as AtelierEvent
}

// --- Pipeline event factories (emitted via eventMerger.emit, not AtelierEvent) ---

export function stageStarted(pipelineId: string, stageId: string, stage: string, sessionId?: string): Record<string, unknown> {
  return { type: "stage_started", pipelineId, stageId, stage, sessionId }
}

export function stageCompleted(pipelineId: string, stageId: string, outputPath?: string): Record<string, unknown> {
  return { type: "stage_completed", pipelineId, stageId, outputPath }
}

export function pipelineCompleted(pipelineId: string): Record<string, unknown> {
  return { type: "pipeline_completed", pipelineId }
}

export function fixStageInserted(pipelineId: string, stageId: string, fixStage: string, parentReviewStageId: string): Record<string, unknown> {
  return { type: "fix_stage_inserted", pipelineId, stageId, fixStage, parentReviewStageId }
}

export function stuckEscalation(pipelineId: string, stageId: string, stage: string, sessionId: string): Record<string, unknown> {
  return { type: "stuck_escalation", pipelineId, stageId, stage, sessionId }
}
