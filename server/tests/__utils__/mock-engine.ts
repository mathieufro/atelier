import crypto from "node:crypto"
import type { AgentEngine, SessionConfig, MessageInput, AgentSession, SessionOutput } from "@atelier/core/agent-engine"

export class MockAgentEngine implements AgentEngine {
  sessions = new Set<string>()
  sessionConfigs = new Map<string, SessionConfig>()
  messages: Array<MessageInput & { sessionId: string }> = []
  interruptedSessions: string[] = []
  titles = new Map<string, string>()
  nextOutput: SessionOutput = { text: "", tokens: { input: 0, output: 0 } }
  onWaitForIdle?: (sessionId: string) => Promise<void>
  private idleResolvers = new Map<string, () => void>()

  async createSession(config: SessionConfig): Promise<AgentSession> {
    const id = crypto.randomUUID()
    this.sessions.add(id)
    this.sessionConfigs.set(id, config)
    return { id }
  }

  async sendMessage(sessionId: string, message: MessageInput): Promise<void> {
    if (!this.sessions.has(sessionId)) throw new Error(`Session ${sessionId} not found`)
    this.messages.push({ ...message, sessionId })
    // Trigger pending waitForIdle after message is recorded (mirrors real behavior
    // where session.idle fires after message processing completes)
    const resolver = this.idleResolvers.get(sessionId)
    if (resolver) {
      this.idleResolvers.delete(sessionId)
      if (this.onWaitForIdle) await this.onWaitForIdle(sessionId)
      resolver()
    }
  }

  async waitForIdle(sessionId: string, _timeoutMs?: number): Promise<void> {
    if (!this.onWaitForIdle) return
    return new Promise(resolve => {
      this.idleResolvers.set(sessionId, resolve)
    })
  }

  async getSessionOutput(sessionId: string): Promise<SessionOutput> {
    return this.nextOutput
  }

  async interruptSession(sessionId: string): Promise<void> {
    this.interruptedSessions.push(sessionId)
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    this.titles.set(sessionId, title)
  }

  forkResults = new Map<string, string>()

  async forkSession(sessionId: string, _options?: { title?: string }): Promise<AgentSession> {
    if (!this.sessions.has(sessionId)) throw new Error(`Session ${sessionId} not found`)
    const forkId = this.forkResults.get(sessionId) ?? crypto.randomUUID()
    this.sessions.add(forkId)
    return { id: forkId }
  }

  evictSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false
    this.sessions.delete(sessionId)
    return true
  }
}
