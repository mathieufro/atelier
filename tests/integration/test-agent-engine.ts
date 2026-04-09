import type { AgentEngine, SessionConfig, MessageInput, AgentSession, SessionOutput } from "@atelier/core/agent-engine"
import type { AtelierEvent } from "@atelier/core"
import type { SessionMetadataStore } from "@atelier/server/engine/session-metadata-store"
import crypto from "node:crypto"

export type ScenarioStep =
  | { type: "emit"; event: AtelierEvent }
  | { type: "pause"; label: string }
  | { type: "wait"; ms: number }

export function emit(event: AtelierEvent): ScenarioStep {
  return { type: "emit", event }
}

export function pause(label: string): ScenarioStep {
  return { type: "pause", label }
}

export function wait(ms: number): ScenarioStep {
  return { type: "wait", ms }
}

export class TestAgentEngine implements AgentEngine {
  private scenario: ScenarioStep[]
  private cursor = 0
  private sessions = new Map<string, { config: SessionConfig }>()
  private _emittedEvents: AtelierEvent[] = []
  private _receivedMessages: Array<{ sessionId: string; message: MessageInput }> = []
  private _interruptedSessions: string[] = []
  private _eventListeners: Array<(event: AtelierEvent) => void> = []
  metadataStore?: SessionMetadataStore

  constructor(scenario: ScenarioStep[]) {
    this.scenario = scenario
  }

  // --- Test stepping API ---

  async advance(): Promise<AtelierEvent | null> {
    while (this.cursor < this.scenario.length) {
      const step = this.scenario[this.cursor++]!
      switch (step.type) {
        case "emit":
          this._emittedEvents.push(step.event)
          for (const listener of this._eventListeners) listener(step.event)
          return step.event
        case "pause":
          return this.advance() // skip pauses when advancing one-by-one
        case "wait":
          await new Promise((resolve) => setTimeout(resolve, step.ms))
          continue
      }
    }
    return null
  }

  async advanceTo(label: string): Promise<void> {
    while (this.cursor < this.scenario.length) {
      const step = this.scenario[this.cursor]!
      if (step.type === "pause" && step.label === label) {
        this.cursor++ // consume the pause
        return
      }
      await this.advance()
    }
    throw new Error(`Pause label "${label}" not found in scenario`)
  }

  async advanceAll(): Promise<void> {
    while (this.cursor < this.scenario.length) {
      await this.advance()
    }
  }

  // --- Test inspection ---

  get emittedEvents(): AtelierEvent[] { return this._emittedEvents }
  get receivedMessages(): Array<{ sessionId: string; message: MessageInput }> { return this._receivedMessages }
  get interruptedSessions(): string[] { return this._interruptedSessions }

  onEvent(listener: (event: AtelierEvent) => void): void {
    this._eventListeners.push(listener)
  }

  // --- AgentEngine interface ---

  async createSession(config: SessionConfig): Promise<AgentSession> {
    const id = crypto.randomUUID()
    this.sessions.set(id, { config })
    this.metadataStore?.create({
      id,
      title: config.title ?? "",
      backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o-mini" },
      workspacePath: config.directory,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      parentId: config.parentID ?? null,
      status: "idle",
    })
    return { id }
  }

  async sendMessage(sessionId: string, message: MessageInput): Promise<void> {
    this._receivedMessages.push({ sessionId, message })
  }

  async waitForIdle(_sessionId: string, _timeoutMs?: number): Promise<void> {
    // No-op in test engine — tests control timing via stepping
  }

  async getSessionOutput(_sessionId: string): Promise<SessionOutput> {
    return { text: "", tokens: { input: 0, output: 0 } }
  }

  async interruptSession(sessionId: string): Promise<void> {
    this._interruptedSessions.push(sessionId)
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
    this.metadataStore?.delete(sessionId)
  }

  async updateSessionTitle(_sessionId: string, _title: string): Promise<void> {
    // No-op
  }

  async forkSession(sessionId: string, options?: { title?: string }): Promise<AgentSession> {
    if (!this.sessions.has(sessionId)) throw new Error(`Session ${sessionId} not found`)
    const id = crypto.randomUUID()
    const source = this.sessions.get(sessionId)!
    this.sessions.set(id, { config: { ...source.config } })
    const sourceMeta = this.metadataStore?.get(sessionId)
    const title = options?.title ?? (sourceMeta?.title ? `${sourceMeta.title} (fork)` : "(fork)")
    this.metadataStore?.create({
      id,
      title,
      backend: "opencode",
      model: sourceMeta?.model ?? { providerID: "openai", modelID: "gpt-4o-mini" },
      workspacePath: source.config.directory,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      parentId: null,
      status: "idle",
      forkedFrom: sessionId,
    })
    return { id }
  }
}
