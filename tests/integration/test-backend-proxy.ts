import type { BackendProxy } from "@atelier/server/engine/backend-proxy"

export class TestBackendProxy implements BackendProxy {
  private sessions: Record<string, unknown>[] = []
  private messages = new Map<string, Array<{ message: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>()
  private config = { models: [] as Array<{ id: string; name: string; providerID: string; [key: string]: unknown }>, workspacePath: "/tmp" }
  private pendingPermissions: Array<{ id: string; sessionID: string; [key: string]: unknown }> = []
  private pendingQuestions: Array<{ id: string; sessionID: string; [key: string]: unknown }> = []

  // Test inspection
  sentMessages: Array<{ sessionId: string; params: Record<string, unknown> }> = []
  permissionReplies: Array<{ sessionId: string; requestId: string; reply: string }> = []
  questionReplies: Array<{ sessionId: string; requestId: string; answers: string[][] }> = []
  questionRejections: Array<{ sessionId: string; requestId: string }> = []

  // Seeding
  addSession(session: Record<string, unknown>): void { this.sessions.push(session) }
  addMessages(sessionId: string, msgs: Array<{ message: Record<string, unknown>; parts: Array<Record<string, unknown>> }>): void {
    this.messages.set(sessionId, msgs)
  }
  setConfig(config: { models: Array<{ id: string; name: string; providerID: string; [key: string]: unknown }>; workspacePath: string }): void {
    this.config = config
  }
  addPendingPermission(perm: { id: string; sessionID: string; [key: string]: unknown }): void { this.pendingPermissions.push(perm) }
  addPendingQuestion(q: { id: string; sessionID: string; [key: string]: unknown }): void { this.pendingQuestions.push(q) }

  // BackendProxy interface
  async listSessions(): Promise<Record<string, unknown>[]> { return this.sessions }
  async getSession(id: string): Promise<Record<string, unknown>> {
    return this.sessions.find(s => (s as any).id === id) ?? { id }
  }
  async deleteSession(id: string): Promise<void> {
    this.sessions = this.sessions.filter(s => (s as any).id !== id)
  }
  async abortSession(_id: string): Promise<void> {}
  async getMessages(sessionId: string, opts?: { before?: number; after?: number; limit?: number }): Promise<{
    messages: Array<{ message: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
    start: number; end: number; total: number
  }> {
    const all = this.messages.get(sessionId) ?? []
    const limit = opts?.limit ?? all.length
    let start = 0
    let end = all.length
    if (opts?.before !== undefined) {
      end = opts.before
      start = Math.max(0, end - limit)
    } else {
      start = Math.max(0, all.length - limit)
      end = start + Math.min(limit, all.length - start)
    }
    return { messages: all.slice(start, end), start, end, total: all.length }
  }
  async sendMessage(sessionId: string, params: Record<string, unknown>): Promise<void> {
    this.sentMessages.push({ sessionId, params })
  }
  async getConfig(): Promise<{ models: Array<{ id: string; name: string; providerID: string; [key: string]: unknown }>; workspacePath: string }> {
    return this.config
  }
  async replyPermission(sessionId: string, requestId: string, reply: string): Promise<void> {
    this.permissionReplies.push({ sessionId, requestId, reply })
    this.pendingPermissions = this.pendingPermissions.filter(p => p.id !== requestId)
  }
  async replyQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void> {
    this.questionReplies.push({ sessionId, requestId, answers })
    this.pendingQuestions = this.pendingQuestions.filter(q => q.id !== requestId)
  }
  async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
    this.questionRejections.push({ sessionId, requestId })
    this.pendingQuestions = this.pendingQuestions.filter(q => q.id !== requestId)
  }
  async listPendingPermissions(): Promise<Array<{ id: string; sessionID: string; [key: string]: unknown }>> {
    return this.pendingPermissions
  }
  async listPendingQuestions(): Promise<Array<{ id: string; sessionID: string; [key: string]: unknown }>> {
    return this.pendingQuestions
  }
  async updateSessionTitle(_sessionId: string, _title: string): Promise<void> {}
}
