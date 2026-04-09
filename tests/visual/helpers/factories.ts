let idCounter = 0

export function makeSession(id?: string, title = "Test Chat") {
  const sid = id ?? `session-${++idCounter}`
  return {
    id: sid,
    title,
    parentID: null,
    time: { created: Date.now(), updated: Date.now() },
  }
}

export function makeTextPart(messageId: string, sessionId: string, text: string) {
  return {
    id: `${messageId}-text-${++idCounter}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "text",
    text,
  }
}

export function makeReasoningPart(messageId: string, sessionId: string, text: string, streaming = false) {
  return {
    id: `${messageId}-thinking`,
    sessionID: sessionId,
    messageID: messageId,
    type: "reasoning",
    text,
    time: streaming ? { start: Date.now() } : { start: Date.now() - 1000, end: Date.now() },
  }
}

export function makeToolPart(messageId: string, sessionId: string, toolName: string, state: Record<string, unknown>) {
  return {
    id: `${messageId}-tool-${++idCounter}`,
    sessionID: sessionId,
    messageID: messageId,
    type: "tool",
    tool: toolName,
    callID: `call-${idCounter}`,
    state,
  }
}

export function makeToolRunning(messageId: string, sessionId: string, toolName: string, input: Record<string, unknown> = {}) {
  return makeToolPart(messageId, sessionId, toolName, {
    type: "running",
    status: "running",
    input,
    title: toolName,
    time: { start: Date.now() },
  })
}

export function makeToolCompleted(messageId: string, sessionId: string, toolName: string, output: string, input: Record<string, unknown> = {}) {
  return makeToolPart(messageId, sessionId, toolName, {
    type: "completed",
    status: "completed",
    input,
    output,
    title: toolName,
    metadata: {},
    time: { start: Date.now() - 500, end: Date.now() },
  })
}

export function makeToolError(messageId: string, sessionId: string, toolName: string, error: string) {
  return makeToolPart(messageId, sessionId, toolName, {
    type: "error",
    status: "error",
    input: {},
    error,
    time: { start: Date.now() - 500, end: Date.now() },
  })
}

export function makeStageStarted(pipelineId: string, stageId: string, stage: string, sessionId?: string) {
  return {
    type: "stage_started",
    pipelineId,
    stageId,
    stage,
    sessionId,
  }
}

export function makeStageCompleted(pipelineId: string, stageId: string) {
  return { type: "stage_completed", pipelineId, stageId }
}

export function makeStageInterrupted(pipelineId: string, stageId: string, sessionId: string) {
  return { type: "stage_interrupted", pipelineId, stageId, sessionId }
}

export function makeStuckEscalation(pipelineId: string, stageId: string, stage: string, sessionId: string) {
  return { type: "stuck_escalation", pipelineId, stageId, stage, sessionId }
}

export function makeUserMessage(sessionId: string, content: string, id?: string) {
  const mid = id ?? `msg-${++idCounter}`
  return {
    message: { id: mid, sessionID: sessionId, role: "user", time: { created: Date.now() } },
    parts: [makeTextPart(mid, sessionId, content)],
  }
}

export function makeAssistantMessage(sessionId: string, parts: any[], id?: string) {
  const mid = id ?? `msg-${++idCounter}`
  return {
    message: { id: mid, sessionID: sessionId, role: "assistant", time: { created: Date.now() } },
    parts,
  }
}
