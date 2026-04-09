import type { AgentEntry, Attachment, ConnectionState, FavoritePair, FavoriteRecord, MessageWithParts, Model, PipelineDetail, PipelineSummary, PresetRecord, Session, SkillInfo, StageModelConfig } from "@atelier/core"

export interface AtelierClient {
  // HTTP methods
  listSessions(): Promise<Session[]>
  createSession(): Promise<{ id: string }>
  getSession(id: string): Promise<Session>
  deleteSession(id: string): Promise<void>
  abortSession(id: string): Promise<void>
  forkSession(sessionId: string, title?: string): Promise<{ id: string }>
  resumeSession(id: string): Promise<void>
  getMessages(id: string, opts?: { before?: number; after?: number; limit?: number }): Promise<{ messages: MessageWithParts[]; start: number; end: number; total: number }>
  sendMessage(params: { content: string; mode: string; sessionId?: string; pipelineId?: string; attachments?: Attachment[]; model?: { providerID: string; modelID: string }; variant?: string; sourceSessionId?: string }): Promise<{ sessionId?: string; pipelineId?: string }>
  replyPermission(sessionId: string, requestId: string, reply: string): Promise<void>
  replyQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void>
  rejectQuestion(sessionId: string, requestId: string): Promise<void>
  getConfig(): Promise<{ agents: AgentEntry[]; models: Model[]; workspacePath: string; favorites?: FavoriteRecord[] }>
  upsertFavorite(favorite: FavoritePair): Promise<{ favorites: FavoriteRecord[] }>
  removeFavorite(favoriteKey: string): Promise<{ favorites: FavoriteRecord[] }>
  reorderFavorites(favoriteKeys: string[]): Promise<{ favorites: FavoriteRecord[] }>
  listSkills(): Promise<SkillInfo[]>
  invokeSkill(params: { skillName: string; content: string; sessionId?: string; attachments?: Attachment[]; model?: { providerID: string; modelID: string }; variant?: string }): Promise<{ sessionId: string }>
  listPipelines(): Promise<PipelineSummary[]>
  getPipeline(id: string): Promise<PipelineDetail>
  restartPipeline(fromPipeline: string, fromStage: string): Promise<{ pipelineId: string }>
  signalPipeline(signal: { type: string; sessionId: string; outputPath?: string; reason?: string }): Promise<void>
  retryStuck(pipelineId: string, stageId: string, action: "fixer" | "resume"): Promise<void>
  abortPipeline(pipelineId: string): Promise<void>
  startRalphLoop(params: { promptPath: string; maxIterations?: number; completionPromise?: string; model?: { providerID: string; modelID: string }; variant?: string }): Promise<{ sessionId: string }>
  cancelRalphLoop(sessionId: string): Promise<Record<string, unknown>>
  health(): Promise<{ status: string; backends: Record<string, string> }>

  // Stage models and presets
  confirmStageModels(pipelineId: string, stageModels: Record<string, StageModelConfig>): Promise<void>
  updateStageModel(pipelineId: string, stage: string, config: StageModelConfig): Promise<void>
  listPresets(pipelineType: string): Promise<PresetRecord[]>
  savePreset(pipelineType: string, name: string, stageModels: Record<string, StageModelConfig>): Promise<PresetRecord>
  deletePreset(presetId: string): Promise<void>

  // SSE connection
  connect(): Promise<void>
  disconnect(): void
  onEvent(handler: (event: Record<string, unknown>) => void): () => void
  onRefreshNeeded(handler: () => void): () => void
  onConnectionStateChange(handler: (state: ConnectionState) => void): () => void

  // Current seq tracking
  lastSeq: number
}

/** Subscribe a handler to a list, returning an unsubscribe function. */
function subscribe<T>(handlers: T[], handler: T): () => void {
  handlers.push(handler)
  return () => {
    const i = handlers.indexOf(handler)
    if (i >= 0) handlers.splice(i, 1)
  }
}

/** Call every handler in a list, swallowing individual handler errors. */
function emit<T extends (...args: never[]) => void>(handlers: T[], ...args: Parameters<T>): void {
  for (const handler of handlers) {
    try { handler(...args) } catch (e) { console.error("[atelier-client] Event handler error:", e) }
  }
}

export function createAtelierClient(baseUrl: string, log?: (level: string, action: string, detail?: string) => void): AtelierClient {
  let lastSeq = 0
  const eventHandlers: Array<(event: Record<string, unknown>) => void> = []
  const refreshHandlers: Array<() => void> = []
  const connectionStateHandlers: Array<(state: ConnectionState) => void> = []
  let abortController: AbortController | null = null
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let disconnected = false
  let retries = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  async function request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {}
    if (body !== undefined) {
      headers["Content-Type"] = "application/json"
    }
    const ac = AbortController ? new AbortController() : undefined
    const timeout = ac ? setTimeout(() => ac.abort(), 15_000) : undefined
    const opts: RequestInit = { method, headers, signal: ac?.signal }
    if (body !== undefined) {
      opts.body = JSON.stringify(body)
    }

    log?.("debug", "http_request", `${method} ${path}`)

    let res: Response
    try {
      res = await fetch(`${baseUrl}${path}`, opts)
    } catch (err) {
      if (ac?.signal.aborted) {
        log?.("debug", "http_timeout", `${method} ${path}`)
        throw new Error(`Request timed out: ${method} ${path}`)
      }
      throw err
    } finally {
      if (timeout) clearTimeout(timeout)
    }

    log?.("debug", "http_response", `${method} ${path} → ${res.status}`)

    const seqHeader = res.headers.get("X-Atelier-Seq")
    if (seqHeader) {
      lastSeq = parseInt(seqHeader, 10)
    }

    if (!res.ok) {
      let errorMessage = `HTTP ${res.status}`
      try {
        const errorBody = await res.json()
        if (errorBody.error) errorMessage = errorBody.error
      } catch {}
      throw new Error(errorMessage)
    }

    return res.json() as Promise<T>
  }

  async function processSSEStream(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        log?.("debug", "sse_stream_ended", baseUrl)
        break
      }

      buffer += decoder.decode(value, { stream: true })

      const messages = buffer.split("\n\n")
      buffer = messages.pop()!

      for (const message of messages) {
        if (!message.trim()) continue

        const dataLines: string[] = []
        for (const line of message.split("\n")) {
          if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6))
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5))
          }
        }
        const data = dataLines.length > 0 ? dataLines.join("\n") : null

        if (!data) continue

        try {
          const parsed = JSON.parse(data)
          if (parsed.seq) lastSeq = parsed.seq

          if (parsed.type === "full_refresh_required") {
            emit(refreshHandlers)
          } else {
            emit(eventHandlers, parsed)
          }
        } catch {
          log?.("debug", "sse_parse_error", "malformed JSON in SSE data")
        }
      }
    }
  }

  function scheduleReconnect(): void {
    if (disconnected) return
    emit(connectionStateHandlers, "reconnecting")
    const delay = Math.min(1000 * 2 ** retries, 30000)
    log?.("debug", "sse_reconnect_scheduled", `attempt=${retries} delay=${delay}ms`)
    retries++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (!disconnected) doConnect()
    }, delay)
  }

  async function doConnect(): Promise<void> {
    log?.("debug", "sse_connecting", baseUrl)
    abortController = new AbortController()
    try {
      const res = await fetch(`${baseUrl}/events`, {
        headers: lastSeq > 0 ? { "Last-Event-ID": String(lastSeq) } : {},
        signal: abortController.signal,
      })

      if (!res.ok || !res.body) {
        scheduleReconnect()
        return
      }

      log?.("debug", "sse_connected", baseUrl)
      emit(connectionStateHandlers, "connected")
      retries = 0

      const reader = res.body.getReader()
      activeReader = reader
      processSSEStream(reader).then(() => {
        activeReader = null
        if (!disconnected) scheduleReconnect()
      }).catch(() => {
        activeReader = null
        if (!disconnected) scheduleReconnect()
      })
    } catch {
      if (!disconnected) scheduleReconnect()
    }
  }

  const client: AtelierClient = {
    get lastSeq() { return lastSeq },

    // --- HTTP methods ---
    async listSessions() {
      return request<Session[]>("GET", "/sessions")
    },

    async createSession() {
      return request<{ id: string }>("POST", "/session")
    },

    async getSession(id: string) {
      return request<Session>("GET", `/session/${encodeURIComponent(id)}`)
    },

    async deleteSession(id: string) {
      return request<void>("DELETE", `/session/${encodeURIComponent(id)}`)
    },

    async abortSession(id: string) {
      return request<void>("POST", `/session/${encodeURIComponent(id)}/abort`)
    },

    async forkSession(sessionId: string, title?: string) {
      return request<{ id: string }>("POST", `/session/${encodeURIComponent(sessionId)}/fork`, title !== undefined ? { title } : undefined)
    },

    async resumeSession(id: string) {
      return request<void>("POST", `/session/${encodeURIComponent(id)}/resume`)
    },

    async getMessages(id: string, opts) {
      const params = new URLSearchParams()
      if (opts?.before !== undefined) params.set("before", String(opts.before))
      if (opts?.after !== undefined) params.set("after", String(opts.after))
      if (opts?.limit !== undefined) params.set("limit", String(opts.limit))
      const query = params.toString()
      const suffix = query ? `?${query}` : ""
      return request<{ messages: MessageWithParts[]; start: number; end: number; total: number }>("GET", `/session/${encodeURIComponent(id)}/messages${suffix}`)
    },

    async sendMessage(params) {
      return request<{ sessionId?: string; pipelineId?: string }>("POST", "/message", params)
    },

    async replyPermission(sessionId: string, requestId: string, reply: string) {
      return request<void>("POST", `/session/${encodeURIComponent(sessionId)}/permission`, { requestId, reply })
    },

    async replyQuestion(sessionId: string, requestId: string, answers: string[][]) {
      return request<void>("POST", `/session/${encodeURIComponent(sessionId)}/question`, { requestId, answers })
    },

    async rejectQuestion(sessionId: string, requestId: string) {
      return request<void>("POST", `/session/${encodeURIComponent(sessionId)}/question/reject`, { requestId })
    },

    async getConfig() {
      return request<{ agents: AgentEntry[]; models: Model[]; workspacePath: string; favorites?: FavoriteRecord[] }>("GET", "/config")
    },

    async upsertFavorite(favorite: FavoritePair) {
      return request<{ favorites: FavoriteRecord[] }>("PUT", "/favorites", favorite)
    },

    async removeFavorite(favoriteKey: string) {
      return request<{ favorites: FavoriteRecord[] }>("DELETE", `/favorites/${encodeURIComponent(favoriteKey)}`)
    },

    async reorderFavorites(favoriteKeys: string[]) {
      return request<{ favorites: FavoriteRecord[] }>("POST", "/favorites/reorder", { favoriteKeys })
    },

    async listSkills() {
      return request<SkillInfo[]>("GET", "/skills")
    },

    async invokeSkill(params) {
      return request<{ sessionId: string }>("POST", "/skill", params)
    },

    async listPipelines() {
      return request<PipelineSummary[]>("GET", "/pipelines")
    },

    async getPipeline(id: string) {
      return request<PipelineDetail>("GET", `/pipeline/${encodeURIComponent(id)}`)
    },

    async restartPipeline(fromPipeline: string, fromStage: string) {
      return request<{ pipelineId: string }>("POST", "/pipeline/restart", { fromPipeline, fromStage })
    },

    async signalPipeline(signal) {
      return request<void>("POST", "/pipeline/signal", signal)
    },

    async retryStuck(pipelineId: string, stageId: string, action: "fixer" | "resume") {
      return request<void>("POST", "/pipeline/retry-stuck", { pipelineId, stageId, action })
    },

    async abortPipeline(pipelineId: string) {
      return request<void>("POST", "/pipeline/abort", { pipelineId })
    },

    async startRalphLoop(params) {
      return request<{ sessionId: string }>("POST", "/ralph-loop", params)
    },

    async cancelRalphLoop(sessionId: string) {
      return request<Record<string, unknown>>("POST", `/ralph-loop/${encodeURIComponent(sessionId)}/cancel`)
    },

    async health() {
      return request<{ status: string; backends: Record<string, string> }>("GET", "/health")
    },

    // --- Stage models and presets ---
    async confirmStageModels(pipelineId: string, stageModels: Record<string, StageModelConfig>) {
      return request<void>("POST", `/pipelines/${encodeURIComponent(pipelineId)}/stage-models`, { stageModels, confirmed: true })
    },

    async updateStageModel(pipelineId: string, stage: string, config: StageModelConfig) {
      return request<void>("POST", `/pipelines/${encodeURIComponent(pipelineId)}/stage-models`, { stageModels: { [stage]: config } })
    },

    async listPresets(pipelineType: string) {
      return request<PresetRecord[]>("GET", `/presets/${encodeURIComponent(pipelineType)}`)
    },

    async savePreset(pipelineType: string, name: string, stageModels: Record<string, StageModelConfig>) {
      return request<PresetRecord>("POST", `/presets/${encodeURIComponent(pipelineType)}`, { name, stageModels })
    },

    async deletePreset(presetId: string) {
      return request<void>("DELETE", `/presets/${encodeURIComponent(presetId)}`)
    },

    // --- SSE ---
    async connect() {
      disconnected = false
      retries = 0
      await doConnect()
    },

    disconnect() {
      disconnected = true
      activeReader?.cancel().catch(() => {})
      activeReader = null
      abortController?.abort()
      abortController = null
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
      emit(connectionStateHandlers, "disconnected")
    },

    onEvent(handler) {
      return subscribe(eventHandlers, handler)
    },

    onRefreshNeeded(handler) {
      return subscribe(refreshHandlers, handler)
    },

    onConnectionStateChange(handler) {
      return subscribe(connectionStateHandlers, handler)
    },
  }

  return client
}
