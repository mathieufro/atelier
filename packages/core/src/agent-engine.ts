import type { PermissionRuleset, ModelRef, Attachment } from "./types.js"

export interface SessionConfig {
  directory: string
  permission: PermissionRuleset
  parentID?: string
  title?: string
  model?: ModelRef
  variant?: string
  /** Pipeline ID this responder session monitors (for MCP tool injection). */
  responderPipelineId?: string
}

export interface MessageInput {
  content: string
  system?: string
  model?: ModelRef
  variant?: string
  attachments?: Attachment[]
}

export interface AgentSession {
  id: string
}

export interface SessionOutput {
  text: string
  tokens: { input: number; output: number }
}

export interface AgentEngine {
  createSession(config: SessionConfig): Promise<AgentSession>
  sendMessage(sessionId: string, message: MessageInput): Promise<void>
  waitForIdle(sessionId: string, timeoutMs?: number): Promise<void>
  getSessionOutput(sessionId: string): Promise<SessionOutput>
  interruptSession(sessionId: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  updateSessionTitle(sessionId: string, title: string): Promise<void>
  /** Fork a session, creating a new session with the full transcript copied.
   *  Returns the new session. Throws if session not found or has no transcript. */
  forkSession(sessionId: string, options?: { title?: string }): Promise<AgentSession>
  /** Evict a completed session from in-memory tracking.
   *  Metadata on disk is preserved. No-op if session is active or unknown.
   *  Optional — backends that manage their own memory can skip this. */
  evictSession?(sessionId: string): boolean
  /** Check if any sessions are currently active. Optional — used for idle shutdown detection. */
  hasActiveSessions?(): boolean
  /** Gracefully shut down all sessions and clean up resources. Optional — used during server teardown. */
  shutdown?(): Promise<void>
}
