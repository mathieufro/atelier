import crypto from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { listProcesses, terminateProcessTree } from "@atelier/core/process-platform"
import type { AgentEngine, SessionConfig, MessageInput, AgentSession, SessionOutput } from "@atelier/core/agent-engine"
import type { Logger, AtelierEvent } from "@atelier/core"
import type { DetectorNormalizedEvent, DetectorProgressSubtype } from "../orchestration/idle-detector-events.js"
import { AsyncChannel } from "./async-channel.js"
import { resolveMcpInstructions } from "./mcp-instructions.js"

/**
 * Create a filesystem link from target → source. Tries symlink first (works everywhere
 * on Unix; on Windows requires admin or Developer Mode), falls back to hardlink
 * (same inode, works without privileges but requires same filesystem), then copy.
 */
function linkOrCopy(source: string, target: string): void {
  try { fs.symlinkSync(source, target); return } catch {}
  try { fs.linkSync(source, target); return } catch {}
  try { fs.copyFileSync(source, target) } catch {}
}

/**
 * Map variant string to maxThinkingTokens for the Claude Agent SDK.
 * The SDK has no "effort" option — it only supports maxThinkingTokens.
 * Returns undefined to use model defaults (no thinking cap).
 */
function variantToMaxThinkingTokens(variant: string | undefined): number | undefined {
  switch (variant) {
    case "low": return 1024
    case "medium": return 8192
    case "high": return 32768
    case "max": return undefined // no cap — let model use its full budget
    default: return undefined
  }
}

interface LiveSession {
  id: string
  channel: AsyncChannel<unknown>
  queryHandle: AsyncGenerator<unknown> & { interrupt(): Promise<void>; close(): void } | null
  eventCounter: number
  pendingPermissions: Map<string, { resolve: (result: unknown) => void; input?: Record<string, unknown> }>
  pendingQuestions: Map<string, { resolve: (result: unknown) => void }>
  lastOutput: SessionOutput | null
  config: SessionConfig
  status: "pending" | "active"
  /** Maps tool_use ID → { toolName, messageId, input, startedAt } for correlating tool results back to the assistant message */
  toolUseMap: Map<string, { toolName: string; messageId: string; input: Record<string, unknown>; startedAt: number }>
  /** Guards against concurrent sendMessage calls on the same session */
  sendInFlight?: boolean
  /** Current streaming message ID (for delta correlation) */
  _streamingMessageId?: string
  /** Promise that resolves when the current event loop finishes */
  _eventLoopPromise: Promise<void> | null
  /** Guards against re-entrant interruptSession calls */
  _interrupting?: boolean
  /** Suppresses respawn inside interruptSession (set by deleteSession) */
  _deleting?: boolean
  /** True while the SDK is actively processing a turn (first event through result).
   *  False between turns (after result, waiting on channel). */
  _midTurn?: boolean
  /** Guards against concurrent interruptAndRestart calls */
  _restarting?: boolean
  /** Tracks the content block ID of an actively-streaming tool_use block.
   *  Set on content_block_start (tool_use), cleared on content_block_stop.
   *  While set, input_json_delta events are classified as tool_running instead of part_progress. */
  _activeToolBlockId?: string
  /** Number of tools currently executing locally (between tool.started and tool.completed).
   *  Authoritative counter — the session monitor reads from this via getSessionState. */
  pendingToolCount: number
  /** Timestamp (Date.now()) of the last SDK generator yield — for session monitor stall detection */
  lastYieldAt: number
  /** Last classified progress subtype — for session monitor lease-based detection */
  lastProgressSubtype?: DetectorProgressSubtype
  /** AbortController passed to the SDK — aborting it cascades to subagent processes */
  _abortController?: AbortController
  /** SDK session ID cached in-memory (set from system.init event) */
  sdkSessionId?: string
}

interface ClaudeCodeEngineOptions {
  /** Injected query factory for testing (replaces real SDK import) */
  queryFactory?: (opts: unknown) => AsyncGenerator<unknown> & { interrupt(): Promise<void>; close(): void }
  /** State directory containing tools/mcp/atelier_signal_mcp.ts (for MCP signal tool) */
  stateDir?: string
  /** Atelier server port (for MCP signal tool env) */
  port?: number
  /** Optional metadata store for lifecycle integration (Task 16) */
  metadataStore?: import("./session-metadata-store.js").SessionMetadataStore
  /** Directory to write session JSONL transcripts (e.g. ~/.claude/projects/<encoded-ws>) */
  transcriptDir?: string
  /** Injected SDK forkSession for testing (replaces real SDK import) */
  forkSessionFactory?: (sessionId: string, options?: { dir?: string; upToMessageId?: string; title?: string }) => Promise<{ sessionId: string }>
  /** Optional logger for debugging */
  logger?: Logger
}

export interface EngineSessionState {
  lastYieldAt: number
  lastSubtype: DetectorProgressSubtype
  busy: boolean
  hasPendingInteractions: boolean
  /** Number of tools currently executing locally — authoritative, from the engine session. */
  pendingToolCount: number
}

export class ClaudeCodeEngine implements AgentEngine {
  private sessions = new Map<string, LiveSession>()
  private waiters = new Map<string, Array<{ resolve: () => void; reject: (err: Error) => void }>>()
  private queryFactory: ClaudeCodeEngineOptions["queryFactory"]
  private forkSessionFactory: ClaudeCodeEngineOptions["forkSessionFactory"]
  private stateDir?: string
  private port?: number
  private metadataStore?: import("./session-metadata-store.js").SessionMetadataStore
  private transcriptDir?: string
  private log?: Logger

  // Callbacks (same pattern as OpenCodeEngine)
  private messageCallback: ((sessionId: string, messageId: string, role: string) => void) | null = null
  private activityCallback: ((sessionId: string) => void) | null = null
  private busyCallback: ((sessionId: string) => void) | null = null
  private idleCallback: ((sessionId: string) => void) | null = null
  private rawEventCallback: ((event: AtelierEvent) => void) | null = null
  private questionCallback: ((sessionId: string, requestId: string, questions?: unknown[]) => void) | null = null
  private permissionCallback: ((sessionId: string, requestId: string) => void) | null = null
  private normalizedEventCallback: ((event: DetectorNormalizedEvent) => void) | null = null
  private sessionCreatedCallback: ((sessionId: string) => void) | null = null

  constructor(options?: ClaudeCodeEngineOptions) {
    this.queryFactory = options?.queryFactory
    this.forkSessionFactory = options?.forkSessionFactory
    this.stateDir = options?.stateDir
    this.port = options?.port
    this.metadataStore = options?.metadataStore
    this.transcriptDir = options?.transcriptDir
    this.log = options?.logger?.child({ source: "claude-code-engine" })
  }

  setMessageCallback(cb: (sessionId: string, messageId: string, role: string) => void): void { this.messageCallback = cb }
  setActivityCallback(cb: (sessionId: string) => void): void { this.activityCallback = cb }
  setBusyCallback(cb: (sessionId: string) => void): void { this.busyCallback = cb }
  setIdleCallback(cb: (sessionId: string) => void): void { this.idleCallback = cb }
  setRawEventCallback(cb: (event: AtelierEvent) => void): void { this.rawEventCallback = cb }
  setQuestionCallback(cb: (sessionId: string, requestId: string, questions?: unknown[]) => void): void { this.questionCallback = cb }
  setPermissionCallback(cb: (sessionId: string, requestId: string) => void): void { this.permissionCallback = cb }
  setNormalizedEventCallback(cb: (event: DetectorNormalizedEvent) => void): void { this.normalizedEventCallback = cb }
  setSessionCreatedCallback(cb: (sessionId: string) => void): void { this.sessionCreatedCallback = cb }

  /** Returns engine-authoritative session state for the monitor, or null if not found. */
  getSessionState(sessionId: string): EngineSessionState | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return {
      lastYieldAt: session.lastYieldAt,
      lastSubtype: session.lastProgressSubtype ?? "unknown",
      busy: session.status === "active" && session.queryHandle !== null,
      hasPendingInteractions: session.pendingPermissions.size > 0 || session.pendingQuestions.size > 0,
      pendingToolCount: session.pendingToolCount,
    }
  }

  async createSession(config: SessionConfig): Promise<AgentSession> {
    const id = crypto.randomUUID()
    const session: LiveSession = {
      id,
      channel: new AsyncChannel(),
      queryHandle: null,
      eventCounter: 0,
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      lastOutput: null,
      config: { ...config },
      status: "pending",
      toolUseMap: new Map(),
      pendingToolCount: 0,
      _eventLoopPromise: null,
      lastYieldAt: 0,
    }
    this.sessions.set(id, session)

    this.log?.debug("atelier", "session", "claude_session_created", { sessionId: id, data: { directory: config.directory } })

    const now = Date.now()
    this.metadataStore?.create({
      id,
      title: config.title ?? "",
      backend: "claude-code",
      model: config.model ?? { providerID: "anthropic", modelID: "unknown" },
      variant: config.variant,
      workspacePath: config.directory,
      createdAt: now,
      lastActiveAt: now,
      parentId: config.parentID ?? null,
      status: "idle",
    })

    this.sessionCreatedCallback?.(id)
    return { id }
  }

  async sendMessage(sessionId: string, message: MessageInput): Promise<void> {
    let session = this.sessions.get(sessionId)

    // Reconstruct from metadata store if session exists on disk but not in memory (server restart)
    if (!session && this.metadataStore) {
      const meta = this.metadataStore.get(sessionId)
      if (meta && meta.backend === "claude-code") {
        session = {
          id: sessionId,
          channel: new AsyncChannel(),
          queryHandle: null,
          eventCounter: 0,
          pendingPermissions: new Map(),
          pendingQuestions: new Map(),
          lastOutput: null,
          config: {
            directory: meta.workspacePath,
            model: meta.model,
            variant: meta.variant,
            parentID: meta.parentId ?? undefined,
          } as SessionConfig & { model?: { providerID: string; modelID: string }; variant?: string },
          status: "active", // Mark as active so we hit the resume path below
          toolUseMap: new Map(),
          pendingToolCount: 0,
          _eventLoopPromise: null,
          lastYieldAt: 0,
          sdkSessionId: meta.sdkSessionId,
        }
        this.sessions.set(sessionId, session!)
        this.log?.debug("atelier", "session", "claude_session_reconstructed", { sessionId })
      }
    }

    if (!session) throw new Error(`Session ${sessionId} not found`)
    const isPipelineSession = typeof session.config.parentID === "string" && session.config.parentID.length > 0
    if (session.sendInFlight) throw new Error(`Session ${sessionId} has a send already in flight`)
    session.sendInFlight = true

    try {
    if (session.status === "pending") {
      // Spawn the query
      const isAutonomous = session.config.permission?.some(
        (p: { action: string }) => p.action === "allow"
      )

      const variant = message.variant ?? session.config.variant
      // Build system prompt using the SDK's preset format to preserve Claude Code's
      // built-in instructions (tool usage, safety, MCP tool docs, coding guidelines).
      // Skill content + MCP server instructions are appended via the `append` field.
      const mcpBlock = await resolveMcpInstructions(session.config.directory)
      const appendParts = [message.system, mcpBlock].filter(Boolean)
      const systemPrompt = appendParts.length > 0
        ? { type: "preset" as const, preset: "claude_code" as const, append: appendParts.join("\n\n") }
        : { type: "preset" as const, preset: "claude_code" as const }

      const abortController = new AbortController()
      session._abortController = abortController

      const options: Record<string, unknown> = {
        cwd: session.config.directory,
        model: (message.model ?? session.config.model)?.modelID,
        systemPrompt,
        mcpServers: this.buildMcpServers(session.id),
        maxThinkingTokens: variantToMaxThinkingTokens(variant),
        settingSources: ["user", "project", "local"],
        includePartialMessages: true,
        abortController,
        env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "128000" },
      }

      if (!isAutonomous) {
        options.canUseTool = (toolName: string, input: unknown, toolOptions: {
          toolUseID: string
          signal: AbortSignal
          suggestions?: unknown
          decisionReason?: string
        }) => {
          // Backfill tool input — content_block_start stores input: {} (empty) because
          // the real JSON arrives via input_json_delta. canUseTool receives the fully
          // parsed input, so update the toolUseMap now so tool.completed carries it.
          const tracked = session.toolUseMap.get(toolOptions.toolUseID)
          if (tracked) tracked.input = input as Record<string, unknown>

          return new Promise((resolve) => {
            if (toolName === "AskUserQuestion") {
              session.pendingQuestions.set(toolOptions.toolUseID, { resolve })
              // Claude Code SDK sends input as { questions: [...] } — unwrap so the
              // AtelierEvent carries the array directly (matching OpenCode's format).
              const raw = input as Record<string, unknown>
              const questions = Array.isArray(raw.questions) ? raw.questions : raw
              const trackedTool = session.toolUseMap.get(toolOptions.toolUseID)
              this.dispatchEvent({
                type: "question.asked",
                sessionId: session.id,
                requestId: toolOptions.toolUseID,
                question: questions,
                tool: trackedTool ? { messageID: trackedTool.messageId, callID: toolOptions.toolUseID } : undefined,
              })
              this.questionCallback?.(session.id, toolOptions.toolUseID, questions as unknown[])
            } else {
              session.pendingPermissions.set(toolOptions.toolUseID, { resolve, input: input as Record<string, unknown> })
              this.dispatchEvent({
                type: "permission.asked",
                sessionId: session.id,
                requestId: toolOptions.toolUseID,
                toolName,
                toolInput: input as Record<string, unknown>,
                suggestions: toolOptions.suggestions,
                decisionReason: toolOptions.decisionReason,
              })
              this.permissionCallback?.(session.id, toolOptions.toolUseID)
            }

            // Wire abort signal (once: true so the listener is auto-removed on fire)
            toolOptions.signal?.addEventListener("abort", () => {
              session.pendingPermissions.delete(toolOptions.toolUseID)
              session.pendingQuestions.delete(toolOptions.toolUseID)
              resolve({ behavior: "deny", message: "Aborted" })
            }, { once: true })
          })
        }
      } else {
        // Autonomous mode: auto-approve all tool calls except AskUserQuestion,
        // which must still be routed through the question flow to the UI.
        // Note: Do NOT set permissionMode/allowDangerouslySkipPermissions — those
        // flags cause the SDK to bypass canUseTool entirely, silently auto-approving
        // AskUserQuestion without surfacing it.
        options.canUseTool = (toolName: string, input: unknown, toolOptions: {
          toolUseID: string
          signal: AbortSignal
        }) => {
          // Backfill tool input (same as interactive mode — see comment above)
          const tracked = session.toolUseMap.get(toolOptions.toolUseID)
          if (tracked) tracked.input = input as Record<string, unknown>

          if (toolName === "AskUserQuestion") {
            return new Promise((resolve) => {
              session.pendingQuestions.set(toolOptions.toolUseID, { resolve })
              // Unwrap questions array from SDK input (same as interactive mode)
              const raw = input as Record<string, unknown>
              const questions = Array.isArray(raw.questions) ? raw.questions : raw
              const trackedTool = session.toolUseMap.get(toolOptions.toolUseID)
              this.dispatchEvent({
                type: "question.asked",
                sessionId: session.id,
                requestId: toolOptions.toolUseID,
                question: questions,
                tool: trackedTool ? { messageID: trackedTool.messageId, callID: toolOptions.toolUseID } : undefined,
              })
              this.questionCallback?.(session.id, toolOptions.toolUseID, questions as unknown[])
              toolOptions.signal?.addEventListener("abort", () => {
                session.pendingQuestions.delete(toolOptions.toolUseID)
                resolve({ behavior: "deny", message: "Aborted" })
              })
            })
          }
          return Promise.resolve({ behavior: "allow", updatedInput: input as Record<string, unknown> })
        }
      }

      const queryFn = this.queryFactory
      if (!queryFn) throw new Error("Claude Code SDK not available")

      session.queryHandle = queryFn({ prompt: session.channel, options })
      session.status = "active"

      // Push first message BEFORE starting the event loop so the channel is populated
      // before the SDK generator begins iterating it.
      // The SDK persists all messages to its own JSONL — Atelier does not write transcripts.
      session.channel.push({
        type: "user",
        message: { role: "user", content: message.content },
      })
      // Emit user message event so the UI displays the injected prompt (pipeline sessions only).
      // Normal sessions show the user message via optimistic UI + JSONL page load; emitting
      // message.completed there causes a duplicate.
      if (isPipelineSession) {
        this.dispatchEvent({
          type: "message.completed",
          sessionId: session.id,
          messageId: `user-${crypto.randomUUID()}`,
          role: "user",
          contentBlocks: [{ type: "text", text: message.content }],
        })
      }

      this.log?.debug("atelier", "session", "claude_event_loop_started", { sessionId: session.id })

      // Start event loop (fire and forget)
      session._eventLoopPromise = this.runEventLoop(session)
      session._eventLoopPromise.catch(() => {})
    } else {
      // Active session — respawn if handle is dead, otherwise queue into live channel
      // If event loop exited (queryHandle null), respawn before pushing to channel.
      if (!session.queryHandle) {
        this.respawnSession(session)
      } else {
        // Live handle — runEventLoop already running, re-emit session.busy for the new turn
        this.dispatchEvent({ type: "session.busy", sessionId: session.id })
        this.busyCallback?.(session.id)
        this.normalizedEventCallback?.({ kind: "busy_edge", sessionId: session.id })
        this.metadataStore?.update(session.id, { status: "busy", lastActiveAt: Date.now() })
      }

      // The SDK persists all messages to its own JSONL — Atelier does not write transcripts.
      session.channel.push({ type: "user", message: { role: "user", content: message.content } })
      // Emit user message event for pipeline sessions so the UI displays the injected prompt.
      // Normal sessions show user messages via optimistic UI + JSONL page load.
      if (isPipelineSession) {
        this.dispatchEvent({
          type: "message.completed",
          sessionId: session.id,
          messageId: `user-${crypto.randomUUID()}`,
          role: "user",
          contentBlocks: [{ type: "text", text: message.content }],
        })
      }
      this.log?.debug("atelier", "session", "claude_message_queued", { sessionId: session.id, data: { contentLength: message.content?.length ?? 0 } })
    }
    } finally {
      session.sendInFlight = false
    }
  }

  waitForIdle(sessionId: string, timeoutMs?: number): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.reject(new Error(`Session ${sessionId} not found`))

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject }
      const existing = this.waiters.get(sessionId) ?? []
      existing.push(waiter)
      this.waiters.set(sessionId, existing)

      if (timeoutMs !== undefined && timeoutMs > 0) {
        setTimeout(() => {
          const arr = this.waiters.get(sessionId)
          if (arr) {
            const idx = arr.indexOf(waiter)
            if (idx !== -1) {
              arr.splice(idx, 1)
              if (arr.length === 0) this.waiters.delete(sessionId)
              reject(new Error(`waitForIdle timed out after ${timeoutMs}ms`))
            }
          }
        }, timeoutMs)
      }
    })
  }

  async getSessionOutput(sessionId: string): Promise<SessionOutput> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    return session.lastOutput ?? { text: "", tokens: { input: 0, output: 0 } }
  }

  async interruptSession(sessionId: string, opts?: { drainQueue?: boolean }): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session || session._interrupting) return
    session._interrupting = true

    this.log?.debug("atelier", "session", "claude_interrupt_started", { sessionId })

    try {
      // Deny all pending permissions
      for (const [, pending] of session.pendingPermissions) {
        pending.resolve({ behavior: "deny", message: "Interrupted" })
      }
      session.pendingPermissions.clear()

      // Deny all pending questions
      for (const [, pending] of session.pendingQuestions) {
        pending.resolve({ behavior: "deny", message: "Interrupted" })
      }
      session.pendingQuestions.clear()

      if (session.queryHandle) {
        this.dispatchEvent({ type: "session.interrupted", sessionId: session.id })

        // Graceful interrupt with timeout — the SDK stops the current turn but keeps
        // the process alive with full conversation context in memory.  The event
        // loop's `for await` stays running, blocked on the channel for the
        // next user message.  No respawn needed.
        //
        // If the SDK doesn't respond to interrupt() within 5 seconds, escalate:
        // abort the AbortController and force-close the handle to kill the subprocess.
        // The event loop's finally block will emit session.idle.
        let interruptOk = false
        let timerId: ReturnType<typeof setTimeout> | undefined
        try {
          await Promise.race([
            session.queryHandle.interrupt().then(() => { interruptOk = true }),
            new Promise<never>((_, reject) => {
              timerId = setTimeout(() => reject(new Error("interrupt timeout")), 5000)
            }),
          ])
        } catch {
          if (!interruptOk) {
            // Graceful interrupt failed or timed out — force-close the handle.
            // Aborting the controller cascades to subagent processes.
            // close() kills the subprocess; the event loop's finally block emits session.idle.
            this.log?.debug("atelier", "session", "claude_interrupt_force_close", { sessionId })
            if (session._abortController && !session._abortController.signal.aborted) {
              session._abortController.abort()
            }
            try { session.queryHandle?.close() } catch {}
          }
        } finally {
          if (timerId !== undefined) clearTimeout(timerId)
        }

        // Reset tool counter — interrupted tools are gone
        session.pendingToolCount = 0

        if (opts?.drainQueue) {
          // Explicit user abort — discard any queued messages, just stop.
          session.channel.drain()
        }

        // The SDK's interrupt yields a result message which triggers idle
        // emission in the event loop.  On timeout, close() kills the subprocess
        // and the event loop's finally block emits idle instead.
      }
      // No queryHandle — process is dead (crash/restart). Nothing to interrupt.
      // Next sendMessage will trigger respawnSession.
    } finally {
      session._interrupting = false
      this.log?.debug("atelier", "session", "claude_interrupt_completed", { sessionId })
    }
  }

  /**
   * Interrupt the current generator and restart the session with a "continue" message.
   * Used by the SessionMonitor to recover from stalled SDK generators.
   * Returns true if the restart was initiated, false if the session was already idle or restarting.
   */
  async interruptAndRestart(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    if (session._restarting) return false
    if (!session.queryHandle) return false

    session._restarting = true
    try {
      await this.interruptSession(sessionId)
      await this.sendMessage(sessionId, { content: "continue" })
      return true
    } catch (err) {
      this.log?.error("atelier", "session", "interrupt_restart_failed", {
        sessionId,
        data: { error: String(err) },
      })
      return false
    } finally {
      session._restarting = false
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) session._deleting = true
    await this.interruptSession(sessionId)
    // After graceful interrupt, close the handle to kill the subprocess.
    if (session?.queryHandle) {
      try { session.queryHandle.close() } catch {}
    }
    // Wait for event loop to finish (its finally block sets queryHandle = null)
    if (session?._eventLoopPromise) {
      try { await session._eventLoopPromise } catch {}
    }
    // Nuclear fallback — ensure the subprocess is dead.
    this.killSdkSubprocess(sessionId)
    if (session) session.channel.close()
    this.sessions.delete(sessionId)
    this.metadataStore?.delete(sessionId)
    this.log?.debug("atelier", "session", "claude_session_deleted", { sessionId })
  }

  /** Evict a completed session from in-memory tracking.
   *  Metadata on disk (metadata store, transcripts) is preserved.
   *  No-op if the session is still active or unknown. */
  evictSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    // Don't evict active sessions — they're still producing events
    if (session.queryHandle !== null) return false
    session.channel.close()
    this.sessions.delete(sessionId)
    this.log?.debug("atelier", "session", "session_evicted", { sessionId })
    return true
  }

  async forkSession(sessionId: string, options?: { title?: string }): Promise<AgentSession> {
    const meta = this.metadataStore?.get(sessionId)
    if (!meta) throw new Error(`Session ${sessionId} not found`)
    if (!meta.sdkSessionId) throw new Error(`Session ${sessionId} has no SDK session ID — cannot fork`)

    const forkFn = this.forkSessionFactory
    if (!forkFn) throw new Error("Fork session factory not available")

    const title = options?.title ?? (meta.title ? `${meta.title} (fork)` : "(fork)")

    const result = await forkFn(meta.sdkSessionId, {
      dir: meta.workspacePath,
      title,
    })

    const newId = crypto.randomUUID()
    const now = Date.now()

    this.metadataStore?.create({
      id: newId,
      title,
      backend: "claude-code",
      model: meta.model,
      variant: meta.variant,
      workspacePath: meta.workspacePath,
      createdAt: now,
      lastActiveAt: now,
      parentId: null,
      status: "idle",
      sdkSessionId: result.sessionId,
      forkedFrom: sessionId,
    })

    // Symlink: {atelierUUID}.jsonl → {sdkForkedId}.jsonl
    // so ClaudeCodeProxy.getMessages can read by Atelier ID.
    // The SDK resolves workspace paths with realpath (e.g., /var → /private/var on macOS),
    // so the forked JSONL may be in a different project directory than ours. Check both.
    if (this.transcriptDir) {
      try {
        const forkJsonl = `${result.sessionId}.jsonl`
        let sdkFile = path.join(this.transcriptDir, forkJsonl)
        if (!fs.existsSync(sdkFile)) {
          // SDK may have written to the realpath-encoded project directory
          const realWs = fs.realpathSync(meta.workspacePath)
          if (realWs !== meta.workspacePath) {
            const realEncoded = realWs.replace(/[^a-zA-Z0-9]/g, "-")
            const realDir = path.join(path.dirname(this.transcriptDir), realEncoded)
            const realFile = path.join(realDir, forkJsonl)
            if (fs.existsSync(realFile)) {
              sdkFile = realFile
            }
          }
        }
        const atelierFile = path.join(this.transcriptDir, `${newId}.jsonl`)
        if (fs.existsSync(sdkFile) && !fs.existsSync(atelierFile)) {
          linkOrCopy(sdkFile, atelierFile)
        }
      } catch {
        // Non-critical
      }
    }

    this.log?.debug("atelier", "session", "claude_session_forked", {
      sessionId: newId,
      data: { sourceId: sessionId, sdkSessionId: result.sessionId },
    })

    return { id: newId }
  }

  /** Returns true if any session has an active query handle (busy or streaming). */
  hasActiveSessions(): boolean {
    for (const session of this.sessions.values()) {
      if (session.queryHandle !== null) return true
    }
    return false
  }

  /** Interrupt all active sessions and kill subprocesses (for graceful server shutdown). */
  async shutdown(): Promise<void> {
    const ids = [...this.sessions.keys()]
    await Promise.allSettled(ids.map(id => this.interruptSession(id)))
    // Close all handles to kill subprocesses (interrupt keeps them alive)
    for (const id of ids) {
      const session = this.sessions.get(id)
      if (session?.queryHandle) {
        try { session.queryHandle.close() } catch {}
      }
    }
    // Wait for all event loops to finish
    const promises = ids.map(id => this.sessions.get(id)?._eventLoopPromise).filter(Boolean)
    await Promise.allSettled(promises as Promise<void>[])
    // Nuclear fallback — ensure all subprocesses are dead.
    for (const id of ids) this.killSdkSubprocess(id)
  }

  /**
   * Kill the SDK CLI subprocess for a session by scanning for processes whose
   * --mcp-config contains the session's ATELIER_SESSION_ID.
   * This is the nuclear option — called when AbortController.abort() fails to
   * kill the subprocess (which happens with the current SDK version).
   */
  private killSdkSubprocess(sessionId: string): void {
    const procs = listProcesses((proc) =>
      proc.command.includes("claude-agent-sdk")
      && proc.command.includes(`"ATELIER_SESSION_ID":"${sessionId}"`)
    )
    for (const proc of procs) {
      this.log?.debug("atelier", "session", "killing_sdk_subprocess", { sessionId, data: { pid: proc.pid } })
      terminateProcessTree(proc.pid).catch(() => {})
    }
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    // Claude Code doesn't have a title concept in the SDK — but update metadata store
    this.metadataStore?.update(sessionId, { title })
  }

  getPendingPermissions(): Array<{ id: string; sessionID: string }> {
    const result: Array<{ id: string; sessionID: string }> = []
    for (const [sessionId, session] of this.sessions) {
      for (const requestId of session.pendingPermissions.keys()) {
        result.push({ id: requestId, sessionID: sessionId })
      }
    }
    return result
  }

  getPendingQuestions(): Array<{ id: string; sessionID: string }> {
    const result: Array<{ id: string; sessionID: string }> = []
    for (const [sessionId, session] of this.sessions) {
      for (const requestId of session.pendingQuestions.keys()) {
        result.push({ id: requestId, sessionID: sessionId })
      }
    }
    return result
  }

  /** Get the subagent task_id and SDK session_id for a tool_use_id (from system.task_started entries). */
  getSubagentMapping(sessionId: string, toolUseId: string): { taskId: string; sdkSessionId: string } | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    const tracked = session.toolUseMap.get(`__subagent_task:${toolUseId}`)
    if (!tracked || tracked.toolName !== "__subagent") return null
    return { taskId: tracked.messageId, sdkSessionId: (tracked.input as Record<string, unknown>)?.sdkSessionId as string ?? "" }
  }

  /** Get all subagent mappings for a session. */
  getAllSubagentMappings(sessionId: string): Array<{ toolUseId: string; taskId: string; sdkSessionId: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) return []
    const results: Array<{ toolUseId: string; taskId: string; sdkSessionId: string }> = []
    for (const [key, tracked] of session.toolUseMap) {
      if (key.startsWith("__subagent_task:") && tracked.toolName === "__subagent") {
        const toolUseId = key.slice("__subagent_task:".length)
        results.push({ toolUseId, taskId: tracked.messageId, sdkSessionId: (tracked.input as Record<string, unknown>)?.sdkSessionId as string ?? "" })
      }
    }
    return results
  }

  resolvePermission(sessionId: string, requestId: string, result: unknown): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const pending = session.pendingPermissions.get(requestId)
    if (pending) {
      session.pendingPermissions.delete(requestId)
      // If allowing, ensure updatedInput carries the original tool input so the CLI
      // doesn't replace it with an empty object (CLI does: updatedInput || originalInput)
      const r = result as Record<string, unknown>
      if (r?.behavior === "allow" && (!r.updatedInput || Object.keys(r.updatedInput as object).length === 0)) {
        r.updatedInput = pending.input
      }
      pending.resolve(r)
      // Emit permission.replied so the UI clears the permission banner
      const permBehavior = r?.behavior === "deny" ? "deny" : "allow"
      this.dispatchEvent({ type: "permission.replied", sessionId, requestId, behavior: permBehavior as "allow" | "deny" })
      this.log?.debug("atelier", "session", "claude_permission_resolved", { sessionId, data: { requestId } })
    }
  }

  resolveQuestion(sessionId: string, requestId: string, result: unknown): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const pending = session.pendingQuestions.get(requestId)
    if (pending) {
      session.pendingQuestions.delete(requestId)
      pending.resolve(result)
      // Emit question.replied/rejected so the UI clears the question banner
      const r = result as Record<string, unknown>
      const eventType = r?.behavior === "deny" ? "question.rejected" : "question.replied"
      this.dispatchEvent({ type: eventType, sessionId, requestId })
      this.log?.debug("atelier", "session", "claude_question_resolved", { sessionId, data: { requestId } })
    }
  }

  /**
   * Re-spawn the SDK query with resume option — for process-death recovery only
   * (VS Code restart, unexpected crash).  Mid-turn interrupts use the graceful
   * queryHandle.interrupt() instead (which keeps the process alive).
   */
  private respawnSession(session: LiveSession): void {
    const queryFn = this.queryFactory
    if (!queryFn) throw new Error("Claude Code SDK not available")

    session._midTurn = false

    const sdkResumeId = session.sdkSessionId
      ?? this.metadataStore?.get(session.id)?.sdkSessionId

    if (!sdkResumeId) {
      this.log?.error("atelier", "session", "respawn_no_sdk_session_id", { sessionId: session.id })
      throw new Error(`Cannot respawn session ${session.id}: no SDK session ID for resume`)
    }

    // Fresh channel — the old one is dead (process died, iterator exhausted)
    session.channel = new AsyncChannel()

    const abortController = new AbortController()
    session._abortController = abortController

    const resumeOptions: Record<string, unknown> = {
      cwd: session.config.directory,
      resume: sdkResumeId,
      model: session.config.model?.modelID,
      maxThinkingTokens: variantToMaxThinkingTokens(session.config.variant),
      mcpServers: this.buildMcpServers(session.id),
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      abortController,
      env: { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "128000" },
      canUseTool: (toolName: string, input: unknown, toolOptions?: { toolUseID?: string; signal?: AbortSignal }) => {
        // Backfill tool input (same as main canUseTool — see comment there)
        if (toolOptions?.toolUseID) {
          const tracked = session.toolUseMap.get(toolOptions.toolUseID)
          if (tracked) tracked.input = input as Record<string, unknown>
        }
        // Route AskUserQuestion through the question flow (don't auto-approve)
        if (toolName === "AskUserQuestion" && toolOptions?.toolUseID) {
          return new Promise((resolve) => {
            session.pendingQuestions.set(toolOptions.toolUseID!, { resolve })
            const raw = input as Record<string, unknown>
            const questions = Array.isArray(raw.questions) ? raw.questions : raw
            const trackedTool = session.toolUseMap.get(toolOptions.toolUseID!)
            this.dispatchEvent({
              type: "question.asked",
              sessionId: session.id,
              requestId: toolOptions.toolUseID!,
              question: questions,
              tool: trackedTool ? { messageID: trackedTool.messageId, callID: toolOptions.toolUseID! } : undefined,
            })
            this.questionCallback?.(session.id, toolOptions.toolUseID!, questions as unknown[])
            toolOptions.signal?.addEventListener("abort", () => {
              session.pendingQuestions.delete(toolOptions.toolUseID!)
              resolve({ behavior: "deny", message: "Aborted" })
            }, { once: true })
          })
        }
        return Promise.resolve({ behavior: "allow", updatedInput: input as Record<string, unknown> })
      },
    }

    this.log?.debug("atelier", "session", "claude_session_respawned", { sessionId: session.id, data: { sdkResumeId } })
    session.queryHandle = queryFn({
      prompt: session.channel,
      options: resumeOptions,
    })
    session._eventLoopPromise = this.runEventLoop(session)
    session._eventLoopPromise.catch(() => {})
  }

  private async runEventLoop(session: LiveSession): Promise<void> {
    if (!session.queryHandle) return
    let emittedIdle = false
    let hadError = false

    try {
      this.dispatchEvent({ type: "session.busy", sessionId: session.id })
      this.busyCallback?.(session.id)
      this.normalizedEventCallback?.({ kind: "busy_edge", sessionId: session.id })
      this.metadataStore?.update(session.id, { status: "busy", lastActiveAt: Date.now() })

      for await (const message of session.queryHandle) {
        session.eventCounter++
        session.lastYieldAt = Date.now()
        session._midTurn = true
        const msg = message as Record<string, unknown>
        this.activityCallback?.(session.id)

        // Capture SDK's own session ID from system.init for resume support.
        // The SDK owns JSONL persistence — Atelier only reads it for UI display.
        // Create a reverse symlink (atelierSessionId → sdkSessionId) so the proxy
        // can read the SDK's JSONL by Atelier session ID.
        if (msg.type === "system" && (msg as any).subtype === "init" && (msg as any).session_id) {
          const sdkSessionId = (msg as any).session_id as string
          session.sdkSessionId = sdkSessionId
          this.metadataStore?.update(session.id, { sdkSessionId })
          this.createReadSymlink(session.id, sdkSessionId)
        }

        const atelierEvents = this.translateSdkMessage(msg, session.id)
        let emittedProgress = false
        for (const event of atelierEvents) {
          this.dispatchEvent(event)
          // Feed idle detector with progress from SDK events
          if (this.normalizedEventCallback) {
            const subtype = ClaudeCodeEngine.classifyAtelierProgress(event)
            if (subtype) {
              // Authoritative tool counter — tracks tools executing locally (Bash, Write, etc.)
              if (subtype === "tool_start") session.pendingToolCount++
              else if (subtype === "tool_terminal") session.pendingToolCount = Math.max(0, session.pendingToolCount - 1)
              session.lastProgressSubtype = subtype
              this.normalizedEventCallback({ kind: "progress_event", sessionId: session.id, subtype })
              emittedProgress = true
            }
          }
        }

        // Universal yield heartbeat — every SDK generator yield proves the agent is alive.
        // Only fires when no AtelierEvent already emitted a more specific progress event
        // for this yield (avoids downgrading tool_terminal/file_write_adjacent to part_progress).
        //
        // Uses _activeToolBlockId to pick the right subtype: tool_running (300s lease)
        // while tool arguments are streaming, part_progress (30s) otherwise.
        if (!emittedProgress && this.normalizedEventCallback && msg.type !== "result") {
          const heartbeatSubtype: DetectorProgressSubtype = session._activeToolBlockId ? "tool_running" : "part_progress"
          session.lastProgressSubtype = heartbeatSubtype
          this.normalizedEventCallback({ kind: "progress_event", sessionId: session.id, subtype: heartbeatSubtype })
        }

        // Deferred clearing of _activeToolBlockId — must happen AFTER the heartbeat above
        // so content_block_stop gets the generous tool_running lease instead of part_progress.
        if (msg.type === "stream_event") {
          const streamEvt = msg.event as Record<string, unknown> | undefined
          if ((streamEvt?.type as string) === "content_block_stop" && session._activeToolBlockId) {
            session._activeToolBlockId = undefined
          }
        }

        if (msg.type === "result") {
          // Turn completed normally
          session._midTurn = false
          session.lastOutput = this.extractOutput(msg)
          const usage = (msg.usage as { input_tokens?: number; output_tokens?: number }) ?? {}
          const idleEvent: AtelierEvent = {
            type: "session.idle",
            sessionId: session.id,
            usage: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 },
            costUsd: msg.cost_usd as number | undefined,
            durationMs: msg.duration_ms as number | undefined,
          }
          this.log?.debug("atelier", "session", "claude_turn_completed", { sessionId: session.id, data: { inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 } })
          this.dispatchEvent(idleEvent)
          emittedIdle = true
          this.metadataStore?.update(session.id, { status: "idle", lastActiveAt: Date.now() })

          const waiters = this.waiters.get(session.id)
          if (waiters && waiters.length > 0) {
            this.waiters.delete(session.id)
            for (const w of waiters) w.resolve()
          } else {
            this.idleCallback?.(session.id)
          }
          this.normalizedEventCallback?.({ kind: "idle_edge", sessionId: session.id })
        }
      }
    } catch (err) {
      hadError = true
      const waiters = this.waiters.get(session.id)
      if (waiters && waiters.length > 0) {
        this.waiters.delete(session.id)
        const error = err instanceof Error ? err : new Error(String(err))
        for (const w of waiters) w.reject(error)
      }

      this.log?.error("atelier", "session", "claude_event_loop_error", { sessionId: session.id, error: String(err) })
      this.dispatchEvent({
        type: "session.error",
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err),
      })
      this.normalizedEventCallback?.({ kind: "session_error", sessionId: session.id, error: String(err) })
    } finally {
      // The event loop only reaches here when the process actually died
      // (crash, close(), or VS Code restart).  Clean up and mark queryHandle
      // as null so the next sendMessage knows to call respawnSession.
      session.queryHandle = null
      this.log?.debug("atelier", "session", "claude_event_loop_ended", { sessionId: session.id })
      // Spec invariant: session.error is always followed by session.idle.
      // Also emit idle if the generator ended without a result message.
      if (!emittedIdle || hadError) {
        this.dispatchEvent({
          type: "session.idle",
          sessionId: session.id,
          usage: { inputTokens: 0, outputTokens: 0 },
        })
        this.metadataStore?.update(session.id, { status: "idle", lastActiveAt: Date.now() })
        this.idleCallback?.(session.id)
        this.normalizedEventCallback?.({ kind: "idle_edge", sessionId: session.id })
      }
    }
  }

  private translateSdkMessage(msg: Record<string, unknown>, sessionId: string): AtelierEvent[] {
    const events: AtelierEvent[] = []
    const type = msg.type as string
    const session = this.sessions.get(sessionId)

    // Capture subagent task_id → tool_use_id mapping from system.task_started entries.
    // This lets the proxy read the subagent's own JSONL file (agent-<taskId>.jsonl).
    if (type === "system") {
      const subtype = msg.subtype as string | undefined
      if (subtype === "task_started") {
        const taskId = msg.task_id as string | undefined
        const toolUseId = msg.tool_use_id as string | undefined
        const sdkSessionId = msg.session_id as string | undefined
        if (taskId && toolUseId) {
          session?.toolUseMap.set(`__subagent_task:${toolUseId}`, { toolName: "__subagent", messageId: taskId, input: { sdkSessionId }, startedAt: Date.now() })
        }
      }
      return events
    }

    // Route subagent entries to their virtual child session instead of the parent.
    // Stream events and user/assistant entries carry parent_tool_use_id when they belong to a subagent.
    const parentToolId = msg.parent_tool_use_id as string | undefined
    const effectiveSessionId = parentToolId ? `subagent-${parentToolId}` : sessionId

    switch (type) {
      case "assistant": {
        const message = msg.message as { id?: string; role?: string; content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }> }
        if (message) {
          const messageId = message.id ?? ""
          const contentBlocks = (message.content ?? [])
            .map((block) => {
            switch (block.type) {
              case "text": return { type: "text" as const, text: block.text ?? "" }
              case "thinking": return { type: "thinking" as const, text: block.thinking ?? block.text ?? "" }
              case "tool_use": {
                // Track tool_use ID → name+messageId+input for correlating results later
                const toolInput = (block.input ?? {}) as Record<string, unknown>
                session?.toolUseMap.set(block.id ?? "", { toolName: block.name ?? "", messageId, input: toolInput, startedAt: Date.now() })
                return { type: "tool_use" as const, toolUseId: block.id ?? "", name: block.name ?? "", input: toolInput }
              }
              default: return { type: "text" as const, text: "" }
            }
          })
          events.push({
            type: "message.completed",
            sessionId: effectiveSessionId,
            messageId,
            role: (message.role ?? "assistant") as "user" | "assistant",
            contentBlocks,
            model: (session?.config as any)?.model,
            variant: (session?.config as any)?.variant,
          })
          this.messageCallback?.(sessionId, messageId, message.role ?? "assistant")
        }
        break
      }
      case "user": {
        const message = msg.message as { id?: string; content?: Array<{ type: string; content?: unknown; output?: string; is_error?: boolean; tool_use_id?: string }> }
        if (message?.content) {
          for (const block of message.content) {
            if (block.type === "tool_result" && block.tool_use_id) {
              // Look up tool name and originating assistant message from the tracked map
              const tracked = session?.toolUseMap.get(block.tool_use_id)
              const toolName = tracked?.toolName ?? ""
              const messageId = tracked?.messageId ?? ""
              // Extract output: may be in .output (string) or .content (array of blocks)
              let output = ""
              if (typeof block.output === "string") {
                output = block.output
              } else if (typeof block.content === "string") {
                output = block.content
              } else if (Array.isArray(block.content)) {
                output = (block.content as Array<{ type?: string; text?: string }>)
                  .filter((c) => c.type === "text")
                  .map((c) => c.text ?? "")
                  .join("\n")
              }
              events.push({
                type: "tool.completed",
                sessionId: effectiveSessionId,
                toolUseId: block.tool_use_id,
                toolName,
                messageId,
                output,
                durationMs: tracked?.startedAt ? Date.now() - tracked.startedAt : 0,
                isError: block.is_error ?? false,
                input: tracked?.input ?? {},
              })
            }
          }
        }
        break
      }
      case "stream_event": {
        // Streaming deltas from the SDK — translate to message.created / message.delta
        const streamEvent = msg.event as Record<string, unknown> | undefined
        if (!streamEvent) break
        const eventType = streamEvent.type as string

        if (eventType === "message_start") {
          // New assistant message starting — emit message.created
          const streamMsg = streamEvent.message as { id?: string; role?: string } | undefined
          if (streamMsg) {
            const messageId = streamMsg.id ?? `stream-${session?.eventCounter ?? 0}`
            events.push({
              type: "message.created",
              sessionId: effectiveSessionId,
              messageId,
              role: (streamMsg.role ?? "assistant") as "user" | "assistant",
            })
            // Track current streaming message ID (only for the main session, not subagents)
            if (session && !parentToolId) session._streamingMessageId = messageId
          }
        } else if (eventType === "content_block_delta") {
          const delta = streamEvent.delta as { type?: string; text?: string; thinking?: string } | undefined
          const messageId = session?._streamingMessageId ?? ""
          if (delta?.type === "text_delta" && delta.text) {
            events.push({ type: "message.delta", sessionId: effectiveSessionId, messageId, contentType: "text", delta: delta.text })
          } else if (delta?.type === "thinking_delta" && delta.thinking) {
            events.push({ type: "message.delta", sessionId: effectiveSessionId, messageId, contentType: "thinking", delta: delta.thinking })
          }
        } else if (eventType === "content_block_start") {
          const contentBlock = streamEvent.content_block as { type?: string; id?: string; name?: string; input?: unknown } | undefined
          const messageId = session?._streamingMessageId ?? ""
          if (contentBlock?.type === "tool_use" && contentBlock.id && contentBlock.name) {
            // Track active tool streaming so input_json_delta gets classified as tool_running
            if (session) session._activeToolBlockId = contentBlock.id
            // Track tool use for later result correlation
            session?.toolUseMap.set(contentBlock.id, { toolName: contentBlock.name, messageId, input: (contentBlock.input ?? {}) as Record<string, unknown>, startedAt: Date.now() })
            events.push({
              type: "tool.started",
              sessionId: effectiveSessionId,
              toolUseId: contentBlock.id,
              toolName: contentBlock.name,
              messageId,
              input: (contentBlock.input ?? {}) as Record<string, unknown>,
            })
          }
        } else if (eventType === "content_block_stop") {
          // Don't clear _activeToolBlockId here — defer to after the stream event
          // classification in runEventLoop so content_block_stop gets classified as
          // tool_running (300s) instead of part_progress (30s). The flag is cleared
          // after the heartbeat in runEventLoop.
        }
        break
      }
      case "rate_limit_event": {
        const status = (msg.status as "allowed" | "allowed_warning" | "rejected") ?? "allowed"
        const resetsAt = msg.resets_at as number | undefined
        events.push({
          type: "rate_limit",
          sessionId: effectiveSessionId,
          status,
          resetsAt,
          utilization: msg.utilization as number | undefined,
        })
        // Notify orchestrator of rejected rate limits so SessionMonitor can suppress idle detection
        if (status === "rejected" && resetsAt) {
          this.normalizedEventCallback?.({
            kind: "rate_limited",
            sessionId: effectiveSessionId,
            resetsAtMs: resetsAt,
          })
        }
        break
      }
    }

    return events
  }

  private extractOutput(msg: Record<string, unknown>): SessionOutput {
    const usage = (msg.usage as { input_tokens?: number; output_tokens?: number }) ?? {}
    return {
      text: (msg.result as string) ?? "",
      tokens: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
      },
    }
  }

  private dispatchEvent(event: AtelierEvent): void {
    this.rawEventCallback?.(event)
  }

  /** Classify an AtelierEvent into an idle-detector progress subtype, or null if not relevant. */
  private static classifyAtelierProgress(event: AtelierEvent): DetectorProgressSubtype | null {
    switch (event.type) {
      case "message.created": return "assistant_turn"
      case "message.delta": return "part_progress"
      case "message.completed": {
        // When the assistant message contains tool_use blocks, the SDK is about to
        // execute those tools locally (bash, write, etc). During local execution the
        // SDK generator is completely suspended — zero yields until the tool finishes.
        // Classify as tool_running (300s) instead of file_write_adjacent (90s) so the
        // idle detector doesn't false-fire on long-running bash commands or writes.
        if (event.type === "message.completed" && "contentBlocks" in event) {
          const blocks = (event as any).contentBlocks as Array<{ type: string }> | undefined
          if (blocks?.some((b) => b.type === "tool_use")) return "tool_running"
        }
        return "file_write_adjacent"
      }
      case "tool.started": return "tool_start"
      case "tool.completed": return "tool_terminal"
      default: return null
    }
  }

  /** Fetch supported models from the Claude Code CLI via a lightweight query */
  async fetchSupportedModels(): Promise<Array<{ value: string; displayName: string; description: string }>> {
    const queryFn = this.queryFactory
    if (!queryFn) throw new Error("Claude Code SDK not available")

    const q = queryFn({ prompt: "hi", options: { maxTurns: 1 } })
    try {
      if (typeof (q as any).supportedModels !== "function") {
        throw new Error("supportedModels not available on query object")
      }
      const models = await (q as any).supportedModels()
      return models
    } finally {
      try { q.close() } catch {}
    }
  }

  /**
   * Create a read-only symlink: atelierSessionId.jsonl → sdkSessionId.jsonl
   * so the proxy can read the SDK's JSONL by Atelier session ID.
   * The SDK owns and writes the JSONL; Atelier only reads via symlink.
   *
   * Also handles realpath mismatch: the SDK resolves workspace paths with
   * realpath (e.g. /Volumes/X → /private/var/X on macOS), so its JSONL may
   * be in a different project directory than Atelier's transcriptDir.
   */
  private createReadSymlink(atelierSessionId: string, sdkSessionId: string): void {
    if (!this.transcriptDir) return
    if (!/^[a-f0-9-]+$/i.test(sdkSessionId) || !/^[a-f0-9-]+$/i.test(atelierSessionId)) return
    try {
      const sdkFile = path.join(this.transcriptDir, `${sdkSessionId}.jsonl`)
      const atelierFile = path.join(this.transcriptDir, `${atelierSessionId}.jsonl`)

      // Find the SDK's JSONL — check our dir first, then realpath-encoded dir
      let target = sdkFile
      if (!fs.existsSync(target)) {
        const meta = this.metadataStore?.get(atelierSessionId)
        if (meta?.workspacePath) {
          try {
            const realWs = fs.realpathSync(meta.workspacePath)
            if (realWs !== meta.workspacePath) {
              const realEncoded = realWs.replace(/[^a-zA-Z0-9]/g, "-")
              const realDir = path.join(path.dirname(this.transcriptDir), realEncoded)
              const realFile = path.join(realDir, `${sdkSessionId}.jsonl`)
              if (fs.existsSync(realFile)) target = realFile
            }
          } catch {}
        }
      }

      // Create link: atelierSessionId.jsonl → SDK's JSONL (symlink preferred, hardlink fallback on Windows)
      if (fs.existsSync(target) && !fs.existsSync(atelierFile)) {
        linkOrCopy(target, atelierFile)
      }
    } catch {
      // Non-critical
    }
  }

  /** Build mcpServers config for SDK query options — injects the signal tool MCP server
   *  and (for responder sessions) the responder MCP server. */
  private buildMcpServers(sessionId: string): Record<string, unknown> | undefined {
    if (!this.stateDir || !this.port) return undefined
    const session = this.sessions.get(sessionId)
    const servers: Record<string, unknown> = {
      "atelier-signal": {
        command: "bun",
        args: ["run", path.join(this.stateDir, "tools/mcp/atelier_signal_mcp.ts")],
        env: {
          ATELIER_PORT: String(this.port),
          ATELIER_SESSION_ID: sessionId,
        },
      },
    }
    // Add responder tools for responder sessions
    if (session?.config.responderPipelineId) {
      servers["atelier-responder"] = {
        command: "bun",
        args: ["run", path.join(this.stateDir, "tools/mcp/atelier_responder_mcp.ts")],
        env: {
          ATELIER_PORT: String(this.port),
          ATELIER_PIPELINE_ID: session.config.responderPipelineId,
        },
      }
    }
    return servers
  }
}
