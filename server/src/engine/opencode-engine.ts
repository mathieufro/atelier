import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import type { AgentEngine, SessionConfig, MessageInput, AgentSession, SessionOutput } from "@atelier/core/agent-engine"
import type { AtelierEvent } from "@atelier/core"
import { normalizeSseEvent, type DetectorNormalizedEvent, type DetectorInfraState } from "../orchestration/idle-detector-events.js"
import { extractSessionId } from "./engine-utils.js"
import type { SessionMetadataStore } from "./session-metadata-store.js"
import { resolveMcpInstructions } from "./mcp-instructions.js"

interface IdleListener {
  resolve: () => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  timeoutMs: number
}

export class OpenCodeEngine implements AgentEngine {
  private client: OpencodeClient
  private idleListeners = new Map<string, IdleListener[]>()
  private sessionDirectories = new Map<string, string>()
  private abortController = new AbortController()
  private sseConnected = false
  private messageCallback: ((sessionId: string, messageId: string, role: string) => void) | null = null
  private activityCallback: ((sessionId: string) => void) | null = null
  private busyCallback: ((sessionId: string) => void) | null = null
  private idleCallback: ((sessionId: string) => void) | null = null
  private rawEventCallback: ((event: AtelierEvent) => void) | null = null
  private rawOpenCodeEventCallback: ((event: Record<string, unknown>) => void) | null = null
  private questionCallback: ((sessionId: string, requestId: string, questions?: unknown[]) => void) | null = null
  private permissionCallback: ((sessionId: string, requestId: string) => void) | null = null
  private normalizedEventCallback: ((event: DetectorNormalizedEvent) => void) | null = null
  private reconnectAttempts: number[] = []
  private lastReconnectWarningAt = 0

  // SSE event rate instrumentation
  private sseEventCount = 0
  private sseEventWindowStart = Date.now()
  private static readonly SSE_RATE_LOG_INTERVAL_MS = 10_000
  private static readonly SSE_RATE_LOG_THRESHOLD = 50

  private static readonly RECONNECT_WINDOW_MS = 30_000
  private static readonly RECONNECT_WARN_THRESHOLD = 5
  private static readonly RECONNECT_WARN_COOLDOWN_MS = 10_000

  private metadataStore?: SessionMetadataStore

  constructor(baseUrl: string, options?: { metadataStore?: SessionMetadataStore }) {
    this.client = createOpencodeClient({ baseUrl })
    this.metadataStore = options?.metadataStore
  }

  // NOTE: The set*Callback methods below could be simplified into a single
  // on(event, handler) interface or a callbacks object in the constructor.
  // Keeping the current API to avoid breaking callers.
  setMessageCallback(cb: (sessionId: string, messageId: string, role: string) => void): void {
    this.messageCallback = cb
  }

  setActivityCallback(cb: (sessionId: string) => void): void {
    this.activityCallback = cb
  }

  setBusyCallback(cb: (sessionId: string) => void): void {
    this.busyCallback = cb
  }

  setIdleCallback(cb: (sessionId: string) => void): void {
    this.idleCallback = cb
  }

  setRawEventCallback(cb: (event: AtelierEvent) => void): void {
    this.rawEventCallback = cb
  }

  /** Legacy callback for raw OpenCode SSE events — used by forwardOpenCodeEvent in the event merger. */
  setRawOpenCodeEventCallback(cb: (event: Record<string, unknown>) => void): void {
    this.rawOpenCodeEventCallback = cb
  }

  setQuestionCallback(cb: (sessionId: string, requestId: string, questions?: unknown[]) => void): void {
    this.questionCallback = cb
  }

  setPermissionCallback(cb: (sessionId: string, requestId: string) => void): void {
    this.permissionCallback = cb
  }

  setNormalizedEventCallback(cb: (event: DetectorNormalizedEvent) => void): void {
    this.normalizedEventCallback = cb
  }

  async connectSSE(): Promise<void> {
    if (this.sseConnected) return
    this.sseConnected = true
    this.subscribeToEvents()
  }

  private async subscribeToEvents(): Promise<void> {
    const signal = this.abortController.signal
    let retryCount = 0

    while (!signal.aborted) {
      try {
        this.emitInfraState("connected")
        const result = await this.client.global.event()
        retryCount = 0
        let batchCount = 0
        for await (const event of result.stream) {
          if (signal.aborted) return
          this.handleSSEEvent((event as { payload: Record<string, unknown> }).payload)
          // Yield to event loop periodically to prevent starving HTTP handlers
          if (++batchCount >= 200) {
            batchCount = 0
            await new Promise(r => setImmediate(r))
          }
        }
        this.recordReconnectAttempt("stream_end")
        this.emitInfraState("reconnecting")
        // Stream ended normally — wait before reconnecting to avoid tight loop.
        // Without this delay, a stream that closes immediately (e.g. during OpenCode
        // restart or transient SSE reset) causes 100% CPU in a spin loop.
        if (!signal.aborted) {
          await new Promise(r => setTimeout(r, 1000))
        }
      } catch {
        if (signal.aborted) return
        this.recordReconnectAttempt("error")
        this.emitInfraState("reconnecting")
        const delay = Math.min(1000 * Math.pow(2, retryCount), 30_000)
        retryCount++
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  private recordReconnectAttempt(reason: "stream_end" | "error"): void {
    const now = Date.now()
    const windowStart = now - OpenCodeEngine.RECONNECT_WINDOW_MS
    this.reconnectAttempts = this.reconnectAttempts.filter((ts) => ts >= windowStart)
    this.reconnectAttempts.push(now)

    const shouldWarn =
      this.reconnectAttempts.length >= OpenCodeEngine.RECONNECT_WARN_THRESHOLD &&
      now - this.lastReconnectWarningAt >= OpenCodeEngine.RECONNECT_WARN_COOLDOWN_MS

    if (shouldWarn) {
      this.lastReconnectWarningAt = now
      // No structured logger available at engine layer — console is intentional
      console.warn(
        `[Atelier] OpenCode SSE reconnecting frequently (${this.reconnectAttempts.length} attempts in ${OpenCodeEngine.RECONNECT_WINDOW_MS / 1000}s, last reason: ${reason})`,
      )
    }
  }

  private handleSSEEvent(payload: Record<string, unknown>): void {
    if (!payload) return

    // Rate instrumentation — log event throughput every 10s
    this.sseEventCount++
    const now = Date.now()
    const elapsed = now - this.sseEventWindowStart
    if (elapsed >= OpenCodeEngine.SSE_RATE_LOG_INTERVAL_MS) {
      const rate = (this.sseEventCount / elapsed * 1000).toFixed(1)
      if (this.sseEventCount > OpenCodeEngine.SSE_RATE_LOG_THRESHOLD) {
        // No structured logger available at engine layer — console is intentional
        console.log(`[Atelier] SSE event rate: ${this.sseEventCount} events in ${(elapsed / 1000).toFixed(1)}s (${rate}/s), last type: ${payload.type}`)
      }
      this.sseEventCount = 0
      this.sseEventWindowStart = now
    }

    const sessionId = extractSessionId(payload)
    const normalized = normalizeSseEvent(payload)
    if (normalized) {
      this.normalizedEventCallback?.(normalized)
    }

    // Activity tracking: notify idle detector for any event with a session ID.
    // Skip idle/error events — these signal the end of activity, not new activity.
    if (sessionId && payload.type !== "session.idle" && payload.type !== "session.error") {
      this.activityCallback?.(sessionId)
      this.resetIdleListenerTimer(sessionId)
    }

    // Session busy: agent is actively processing
    if (payload.type === "session.busy" && sessionId) {
      this.busyCallback?.(sessionId)
      this.metadataStore?.update(sessionId, { status: "busy", lastActiveAt: Date.now() })
    }

    // Session lifecycle: resolve or reject waitForIdle promises
    if (payload.type === "session.idle" || payload.type === "session.error") {
      this.handleSessionLifecycleEvent(payload, sessionId)
    }

    // Forward message.updated to orchestrator for direct intervention detection
    if (payload.type === "message.updated" && this.messageCallback) {
      const props = payload.properties as Record<string, unknown> | undefined
      const info = props?.info as Record<string, unknown> | undefined
      if (info?.sessionID && info?.id && info?.role) {
        this.messageCallback(info.sessionID as string, info.id as string, info.role as string)
      }
    }

    // Auto-handle questions and permissions for pipeline sessions
    if (payload.type === "question.asked" && this.questionCallback) {
      const props = payload.properties as Record<string, unknown> | undefined
      if (props?.id && props?.sessionID) {
        this.questionCallback(props.sessionID as string, props.id as string, props.questions as unknown[] | undefined)
      }
    }

    if (payload.type === "permission.asked" && this.permissionCallback) {
      const props = payload.properties as Record<string, unknown> | undefined
      if (props?.id && props?.sessionID) {
        this.permissionCallback(props.sessionID as string, props.id as string)
      }
    }

    // Forward raw event to legacy OpenCode SSE stream
    this.rawOpenCodeEventCallback?.(payload)

    // Translate and emit as AtelierEvent
    const translated = this.translateToAtelierEvent(payload, sessionId)
    if (translated) {
      this.rawEventCallback?.(translated)
    }
  }

  private handleSessionLifecycleEvent(payload: Record<string, unknown>, sessionId: string | undefined): void {
    if (!sessionId) return

    this.metadataStore?.update(sessionId, { status: "idle", lastActiveAt: Date.now() })

    const listeners = this.idleListeners.get(sessionId)
    if (listeners && listeners.length > 0) {
      this.idleListeners.delete(sessionId)
      // Timer is cleared inside listener.resolve/reject wrappers
      if (payload.type === "session.error") {
        const props = payload.properties as Record<string, unknown> | undefined
        const error = new Error((props?.error as string) ?? "Session error")
        for (const l of listeners) l.reject(error)
      } else {
        for (const l of listeners) l.resolve()
      }
    } else if (payload.type === "session.idle") {
      // No waitForIdle listener -- autonomous stage went idle
      this.idleCallback?.(sessionId)
    }
  }

  /** Reset the inactivity timer on all existing waitForIdle listeners for a session. */
  private resetIdleListenerTimer(sessionId: string): void {
    const listeners = this.idleListeners.get(sessionId)
    if (!listeners) return

    for (const listener of listeners) {
      clearTimeout(listener.timer)
      listener.timer = setTimeout(() => {
        const arr = this.idleListeners.get(sessionId)
        if (arr) {
          const idx = arr.indexOf(listener)
          if (idx !== -1) arr.splice(idx, 1)
          if (arr.length === 0) this.idleListeners.delete(sessionId)
        }
        listener.reject(new Error(
          `waitForIdle timed out after ${Math.round(listener.timeoutMs / 1000)}s of inactivity for session ${sessionId}`,
        ))
      }, listener.timeoutMs)
    }
  }

  async createSession(config: SessionConfig): Promise<AgentSession> {
    const res = await this.client.session.create({
      // OpenCode validates parentID starts with "ses" — pipeline IDs are UUIDs, skip them
      parentID: config.parentID?.startsWith("ses") ? config.parentID : undefined,
      directory: config.directory,
    })
    if (res.error) throw new Error(`Failed to create opencode session: ${JSON.stringify(res.error)}`)
    const id = (res.data as { id: string }).id

    this.sessionDirectories.set(id, config.directory)

    this.metadataStore?.create({
      id,
      title: "",
      backend: "opencode",
      model: (config as any).model ?? { providerID: "unknown", modelID: "unknown" },
      variant: (config as any).variant,
      workspacePath: config.directory,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      parentId: config.parentID ?? null,
      status: "idle",
    })

    return { id }
  }

  async sendMessage(sessionId: string, message: MessageInput): Promise<void> {
    const parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }> = [{ type: "text", text: message.content }]
    if (message.attachments) {
      for (const att of message.attachments) {
        parts.push({ type: "file", mime: att.mime, url: att.url, filename: att.filename })
      }
    }

    // Inject MCP server instructions into system prompt so the agent knows
    // when and how to use MCP tools (OpenCode only passes tool definitions,
    // not the instructions field from MCP servers).
    const directory = this.sessionDirectories.get(sessionId)
    let system = message.system
    if (directory) {
      const mcpBlock = await resolveMcpInstructions(directory)
      if (mcpBlock) {
        system = system ? `${system}\n\n${mcpBlock}` : mcpBlock
      }
    }

    await this.client.session.prompt({
      sessionID: sessionId,
      parts: parts as Parameters<typeof this.client.session.prompt>[0]["parts"],
      system,
      model: message.model,
      variant: message.variant,
    })
  }

  waitForIdle(sessionId: string, timeoutMs = 60_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const listener: IdleListener = {
        resolve: () => { clearTimeout(listener.timer); resolve() },
        reject: (err: Error) => { clearTimeout(listener.timer); reject(err) },
        timer: setTimeout(() => {
          const arr = this.idleListeners.get(sessionId)
          if (arr) {
            const idx = arr.indexOf(listener)
            if (idx !== -1) arr.splice(idx, 1)
            if (arr.length === 0) this.idleListeners.delete(sessionId)
          }
          reject(new Error(`waitForIdle timed out after ${Math.round(timeoutMs / 1000)}s of inactivity for session ${sessionId}`))
        }, timeoutMs),
        timeoutMs,
      }
      const existing = this.idleListeners.get(sessionId) ?? []
      existing.push(listener)
      this.idleListeners.set(sessionId, existing)
    })
  }

  async getSessionOutput(sessionId: string): Promise<SessionOutput> {
    interface MessageItem { info?: { role?: string }; parts?: Array<{ type: string; text?: string }> }
    const res = await this.client.session.messages({ sessionID: sessionId })
    const messages = res.error ? [] : (res.data as MessageItem[]) ?? []
    const lastAssistant = [...messages].reverse().find((m) => m.info?.role === "assistant")
    const text = lastAssistant?.parts?.find((p) => p.type === "text")?.text ?? ""
    return { text, tokens: { input: 0, output: 0 } }
  }

  async interruptSession(sessionId: string): Promise<void> {
    await this.client.session.abort({ sessionID: sessionId })
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.session.delete({ sessionID: sessionId })
    this.metadataStore?.delete(sessionId)
  }

  async forkSession(sessionId: string, options?: { title?: string }): Promise<AgentSession> {
    const meta = this.metadataStore?.get(sessionId)
    if (!meta) throw new Error(`Session ${sessionId} not found in metadata store`)

    const directory = this.sessionDirectories.get(sessionId) ?? meta.workspacePath

    // SDK types may not include fork yet — use type assertion
    const res = await (this.client.session as any).fork({ sessionID: sessionId, directory })
    if (res.error) throw new Error(`Failed to fork opencode session: ${JSON.stringify(res.error)}`)

    const forkedSession = res.data as { id: string; [key: string]: unknown }
    const newId = forkedSession.id
    const title = options?.title ?? (meta.title ? `${meta.title} (fork)` : "(fork)")

    this.sessionDirectories.set(newId, directory)

    this.metadataStore?.create({
      id: newId,
      title,
      backend: "opencode",
      model: meta.model,
      variant: meta.variant,
      workspacePath: directory,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      parentId: null,
      status: "idle",
      forkedFrom: sessionId,
    })

    return { id: newId }
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    try {
      await this.client.session.update({ sessionID: sessionId, title })
      this.metadataStore?.update(sessionId, { title })
    } catch {
      // Non-critical -- title is cosmetic
    }
  }

  reconnect(newBaseUrl: string): void {
    this.emitInfraState("reconnecting")
    this.rejectAllIdleListeners(new Error("OpenCode restarted"))
    this.abortController.abort()
    this.client = createOpencodeClient({ baseUrl: newBaseUrl })
    this.abortController = new AbortController()
    this.sseConnected = false
    this.connectSSE()
  }

  disconnect(): void {
    this.emitInfraState("disconnected")
    this.rejectAllIdleListeners(new Error("Disconnected"))
    this.abortController.abort()
  }

  private rejectAllIdleListeners(error: Error): void {
    for (const listeners of this.idleListeners.values()) {
      for (const listener of listeners) {
        clearTimeout(listener.timer)
        listener.reject(error)
      }
    }
    this.idleListeners.clear()
  }

  private emitInfraState(state: DetectorInfraState): void {
    this.normalizedEventCallback?.({ kind: "infra_state_changed", state })
    // Also emit as AtelierEvent for the unified event stream
    const atelierState = state === "connected" ? "ready" : state === "reconnecting" ? "starting" : "error"
    this.rawEventCallback?.({ type: "connection.status", backend: "opencode", state: atelierState })
  }

  private translateToAtelierEvent(payload: Record<string, unknown>, sessionId: string | undefined): AtelierEvent | null {
    const type = payload.type as string
    const props = payload.properties as Record<string, unknown> | undefined
    const info = props?.info as Record<string, unknown> | undefined

    switch (type) {
      case "session.busy":
        return sessionId ? { type: "session.busy", sessionId } : null
      case "session.idle":
        return sessionId ? { type: "session.idle", sessionId, usage: { inputTokens: 0, outputTokens: 0 } } : null
      case "session.error":
        return sessionId ? { type: "session.error", sessionId, error: (props?.error as string) ?? "Unknown error" } : null
      case "message.created":
        if (info?.id && info?.role) {
          return { type: "message.created", sessionId: sessionId ?? "", messageId: info.id as string, role: info.role as "user" | "assistant" }
        }
        return null
      case "message.completed":
        if (info?.id && info?.role) {
          return { type: "message.completed", sessionId: sessionId ?? "", messageId: info.id as string, role: info.role as "user" | "assistant", contentBlocks: [] }
        }
        return null
      case "question.asked":
        if (props?.id && props?.sessionID) {
          const tool = props.tool as { messageID: string; callID: string } | undefined
          return { type: "question.asked", sessionId: props.sessionID as string, requestId: props.id as string, question: props.questions, ...(tool ? { tool } : {}) }
        }
        return null
      case "permission.asked":
        if (props?.id && props?.sessionID) {
          return { type: "permission.asked", sessionId: props.sessionID as string, requestId: props.id as string, toolName: (props.toolName as string) ?? "", toolInput: {} }
        }
        return null
      default:
        return null
    }
  }
}
