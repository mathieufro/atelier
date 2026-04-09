export interface BackendProxy {
  listSessions(): Promise<Record<string, unknown>[]>
  getSession(id: string): Promise<Record<string, unknown>>
  deleteSession(id: string): Promise<void>
  abortSession(id: string): Promise<void>
  getMessages(id: string, opts?: { before?: number; after?: number; limit?: number }): Promise<{
    messages: Array<{ message: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
    start: number
    end: number
    total: number
  }>
  sendMessage(sessionId: string, params: Record<string, unknown>): Promise<void>
  getConfig(): Promise<{ models: Array<{ id: string; name: string; providerID: string; [key: string]: unknown }>; workspacePath: string }>
  replyPermission(sessionId: string, requestId: string, reply: string): Promise<void>
  replyQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void>
  rejectQuestion(sessionId: string, requestId: string): Promise<void>
  listPendingPermissions(): Promise<Array<{ id: string; sessionID: string; [key: string]: unknown }>>
  listPendingQuestions(): Promise<Array<{ id: string; sessionID: string; [key: string]: unknown }>>
  updateSessionTitle(sessionId: string, title: string): Promise<void>
}
