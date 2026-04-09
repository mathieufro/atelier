import type { BackendProxy } from "./backend-proxy.js"
import type { ClaudeCodeEngine } from "./claude-code-engine.js"
import type { SessionMetadataStore } from "./session-metadata-store.js"
import * as fs from "node:fs/promises"
import * as fsSync from "node:fs"
import * as path from "node:path"

/**
 * Sort parts within each message so reasoning appears before text/tool.
 * The SDK writes multiple JSONL entries per message (streaming + final) and the
 * merge order depends on file order, which can place text before reasoning.
 */
const PART_TYPE_ORDER: Record<string, number> = { reasoning: 0, text: 1, tool: 2 }
function sortPartsInPlace(messages: Array<{ parts: Array<Record<string, unknown>> }>): void {
  for (const entry of messages) {
    if (entry.parts.length > 1) {
      entry.parts.sort((a, b) => (PART_TYPE_ORDER[a.type as string] ?? 9) - (PART_TYPE_ORDER[b.type as string] ?? 9))
    }
  }
}

/**
 * Fix orphaned "running" tool parts — tool_use blocks with no matching tool_result.
 * Happens when the session/subprocess was killed while a tool was executing.
 */
function fixOrphanedRunningTools(messages: Array<{ parts: Array<Record<string, unknown>> }>): void {
  for (const entry of messages) {
    for (const part of entry.parts) {
      if (part.type === "tool") {
        const state = part.state as Record<string, unknown> | undefined
        if (state?.status === "running") {
          const time = state.time as Record<string, unknown> | undefined
          state.status = "error"
          state.error = "interrupted"
          if (time) time.end = time.start
        }
      }
    }
  }
}

interface ClaudeCodeProxyOptions {
  engine: ClaudeCodeEngine
  metadataStore: SessionMetadataStore
  claudeProjectsDir: string  // ~/.claude/projects
  workspacePath: string
}

export class ClaudeCodeProxy implements BackendProxy {
  private static readonly MODELS_CACHE_TTL_MS = 30_000
  private engine: ClaudeCodeEngine
  private metaStore: SessionMetadataStore
  private sessionDir: string
  private workspacePath: string
  /** Cache of subagent messages keyed by virtual session ID ("subagent-<toolUseId>") */
  private subagentCache = new Map<string, Array<{ message: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>()

  constructor(options: ClaudeCodeProxyOptions) {
    this.engine = options.engine
    this.metaStore = options.metadataStore
    this.workspacePath = options.workspacePath
    const encodedWs = ClaudeCodeProxy.encodeWorkspacePath(options.workspacePath)
    this.sessionDir = path.join(options.claudeProjectsDir, encodedWs)
  }

  static encodeWorkspacePath(workspacePath: string): string {
    return workspacePath.replace(/[^a-zA-Z0-9]/g, "-")
  }

  async listSessions(): Promise<Record<string, unknown>[]> {
    return this.metaStore.listRootSessions(this.workspacePath).map((meta) => ({
      id: meta.id,
      title: meta.title,
      directory: meta.workspacePath,
      backend: meta.backend,
      createdAt: meta.createdAt,
      lastActiveAt: meta.lastActiveAt,
    }))
  }

  async getSession(id: string): Promise<Record<string, unknown>> {
    const meta = this.metaStore.get(id)
    if (!meta) throw new Error(`Session ${id} not found`)
    return { ...meta }
  }

  async deleteSession(id: string): Promise<void> {
    try {
      await fs.unlink(path.join(this.sessionDir, `${id}.jsonl`))
    } catch {}
    await this.engine.deleteSession(id)
    this.metaStore.delete(id)
  }

  async abortSession(id: string): Promise<void> {
    // Don't drain the queue — if the user queued a message while the model was
    // working and then hit Stop, the queued message should survive and the
    // session should resume with it automatically.
    await this.engine.interruptSession(id)
  }

  async getMessages(id: string, opts?: { before?: number; after?: number; limit?: number }): Promise<{
    messages: Array<{ message: Record<string, unknown>; parts: Array<Record<string, unknown>> }>
    start: number
    end: number
    total: number
  }> {
    // Virtual subagent sessions — read from the subagent's own JSONL file if available,
    // fall back to cache populated from parent JSONL's parent_tool_use_id entries.
    if (id.startsWith("subagent-")) {
      const toolUseId = id.slice("subagent-".length)
      const messages = await this.loadSubagentMessages(toolUseId, id)
      if (messages.length > 0) {
        fixOrphanedRunningTools(messages)
        sortPartsInPlace(messages)
        return { messages, start: 0, end: messages.length, total: messages.length }
      }
      const cached = this.subagentCache.get(id) ?? []
      fixOrphanedRunningTools(cached)
      sortPartsInPlace(cached)
      return { messages: cached, start: 0, end: cached.length, total: cached.length }
    }

    const meta = this.metaStore.get(id)
    const sessionModel = meta?.model
    const sessionVariant = meta?.variant
    const sessionSkill = meta?.skillName
    let skillAttached = false
    let filePath = path.join(this.sessionDir, `${id}.jsonl`)
    let lines: string[]
    try {
      const stat = await fs.stat(filePath)
      if (stat.size > 50 * 1024 * 1024) {
        const now = Date.now()
        return {
          messages: [{
            message: { id: "error", sessionID: id, role: "assistant", time: { created: now } },
            parts: [{ id: "error-part-0", sessionID: id, messageID: "error", type: "text", text: `Session transcript too large (${Math.round(stat.size / 1024 / 1024)}MB). Skipped.` }],
          }],
          start: 0, end: 1, total: 1,
        }
      }
      const content = await fs.readFile(filePath, "utf-8")
      lines = content.split("\n").filter((l) => l.trim())
    } catch {
      // Symlink doesn't exist yet (server restart, first load after reload).
      // Try to resolve the SDK's JSONL directly from the metadata store's sdkSessionId
      // and create the symlink on-demand so subsequent reads work.
      const resolved = this.resolveAndSymlink(id, meta)
      if (resolved) {
        filePath = resolved
        try {
          const content = await fs.readFile(filePath, "utf-8")
          lines = content.split("\n").filter((l) => l.trim())
        } catch {
          return { messages: [], start: 0, end: 0, total: 0 }
        }
      } else {
        return { messages: [], start: 0, end: 0, total: 0 }
      }
    }

    const allMessages: Array<{ message: Record<string, unknown>; parts: Array<Record<string, unknown>> }> = []
    // Track messages by ID so duplicate JSONL entries (same msg, different content blocks) get merged.
    // Claude Code SDK writes text and tool_use blocks as separate JSONL entries with the same message ID.
    const messagesByMsgId = new Map<string, { message: Record<string, unknown>; parts: Array<Record<string, unknown>> }>()
    // Track tool_use parts across messages so tool_result (in user messages) can merge into
    // tool_use parts (from assistant messages). Claude Code puts these in separate JSONL entries.
    const crossMsgToolParts = new Map<string, Record<string, unknown>>()
    // Collect subagent messages by parent_tool_use_id for virtual child sessions
    const subagentMessages = new Map<string, Array<{ message: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>()
    const subagentToolParts = new Map<string, Map<string, Record<string, unknown>>>()
    // Track per-message partIdx counters so merged entries get unique part IDs
    const msgPartCounters = new Map<string, number>()
    let skippedCount = 0
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as {
          type?: string
          parent_tool_use_id?: string
          message?: {
            id?: string
            role?: string
            model?: string
            content?: Array<{ type: string; text?: string; thinking?: string; signature?: string; id?: string; name?: string; input?: unknown; output?: string; content?: string; is_error?: boolean; tool_use_id?: string }>
          }
        }
        if (!parsed.message) continue

        // Route subagent entries to their virtual child session
        const parentToolId = parsed.parent_tool_use_id
        if (parentToolId) {
          const childSessionId = `subagent-${parentToolId}`
          this.buildMessageEntry(parsed, childSessionId, subagentMessages, subagentToolParts)
          continue
        }

        const role = (parsed.message.role ?? parsed.type ?? "user") as "user" | "assistant"
        const msgId = parsed.message.id ?? `line-${allMessages.length}`
        const now = Date.now()
        const blocks = parsed.message.content ?? []

        // Build parts in OpenCode format. Merge tool_use + tool_result into single ToolParts.
        const parts: Array<Record<string, unknown>> = []
        const toolParts = crossMsgToolParts
        // Use per-message counter so merged entries (SDK writes each block twice) get unique IDs
        let partIdx = msgPartCounters.get(msgId) ?? 0

        for (const block of blocks) {
          const partId = `${msgId}-part-${partIdx++}`
          const base = { id: partId, sessionID: id, messageID: msgId }
          switch (block.type) {
            case "text":
              parts.push({ ...base, type: "text", text: block.text ?? "" })
              break
            case "thinking":
              parts.push({ ...base, type: "reasoning", text: block.thinking ?? block.text ?? "", time: { start: now, end: now } })
              break
            case "tool_use": {
              // Use same ID scheme as event-merger: ${messageId}-tool-${toolUseId}
              const toolPartId = `${msgId}-tool-${block.id ?? partIdx}`
              const toolBase = { id: toolPartId, sessionID: id, messageID: msgId }
              const isAgent = (block.name ?? "").toLowerCase() === "agent"
              const childSessionId = isAgent && block.id ? `subagent-${block.id}` : undefined
              const toolPart = {
                ...toolBase,
                type: "tool",
                callID: block.id ?? "",
                tool: isAgent ? "task" : (block.name ?? "").toLowerCase(),
                state: {
                  status: "running" as string,
                  input: (block.input ?? {}) as Record<string, unknown>,
                  title: isAgent ? "task" : (block.name ?? "").toLowerCase(),
                  time: { start: now },
                  ...(childSessionId ? { metadata: { sessionId: childSessionId } } : {}),
                },
              }
              parts.push(toolPart)
              // Only set crossMsgToolParts if not already tracked (duplicate SDK entries
              // create new objects that would break tool_result merge references)
              if (block.id && !toolParts.has(block.id)) toolParts.set(block.id, toolPart)
              break
            }
            case "tool_result": {
              const existing = block.tool_use_id ? toolParts.get(block.tool_use_id) : undefined
              if (existing) {
                // Merge result into existing tool_use part
                const input = ((existing.state as Record<string, unknown>)?.input ?? {}) as Record<string, unknown>
                const prevMeta = (existing.state as Record<string, unknown>)?.metadata as Record<string, unknown> | undefined
                const resultText = block.output ?? block.content ?? ""
                existing.state = block.is_error
                  ? { status: "error", input, error: resultText, time: { start: now, end: now }, ...(prevMeta ? { metadata: prevMeta } : {}) }
                  : { status: "completed", input, output: resultText, title: String((existing as Record<string, unknown>).tool ?? "").toLowerCase(), metadata: { ...prevMeta }, time: { start: now, end: now } }
              } else {
                // Standalone tool_result (no matching tool_use) — create a completed tool part
                parts.push({
                  ...base,
                  type: "tool",
                  callID: block.tool_use_id ?? "",
                  tool: "",
                  state: block.is_error
                    ? { status: "error", input: {}, error: block.output ?? block.content ?? "", time: { start: now, end: now } }
                    : { status: "completed", input: {}, output: block.output ?? block.content ?? "", title: "", metadata: {}, time: { start: now, end: now } },
                })
              }
              break
            }
          }
        }

        // Save the partIdx counter so subsequent entries for the same message get unique IDs
        msgPartCounters.set(msgId, partIdx)

        // Skip user messages that only had tool_result blocks (already merged into assistant's tool parts)
        if (role === "user" && parts.length === 0) continue

        // Merge duplicate JSONL entries (same message ID, different content block types).
        // Claude Code SDK writes each content block twice (streaming + final), so dedup by
        // content identity: same type + same callID for tools, same type + same text for text/reasoning.
        const existingMsg = msgId ? messagesByMsgId.get(msgId) : undefined
        if (existingMsg) {
          for (const p of parts) {
            const isDup = existingMsg.parts.some((ep) => {
              if (ep.type !== p.type) return false
              if (p.type === "tool") return ep.callID === p.callID
              if (p.type === "text") return ep.text === p.text
              if (p.type === "reasoning") return ep.text === p.text
              return ep.id === p.id
            })
            if (!isDup) existingMsg.parts.push(p)
          }
          continue
        }

        const message: Record<string, unknown> = { id: msgId, sessionID: id, role, time: { created: now } }
        if (sessionModel) {
          if (role === "user") message.model = sessionModel
          else { message.providerID = sessionModel.providerID; message.modelID = sessionModel.modelID }
        }
        if (sessionVariant) message.variant = sessionVariant
        // Attach skill name to the first user message so the UI can show the header on reload
        if (sessionSkill && role === "user" && !skillAttached) {
          message.skill = sessionSkill
          skillAttached = true
        }
        const entry = { message, parts }
        allMessages.push(entry)
        if (msgId) messagesByMsgId.set(msgId, entry)
      } catch {
        skippedCount++
      }
    }

    if (skippedCount > 0) {
      // No structured logger available at proxy layer — console is intentional
      console.warn(`[ClaudeCodeProxy] Skipped ${skippedCount} malformed JSONL line(s) in session ${id}`)
    }

    fixOrphanedRunningTools(allMessages)

    // Ensure reasoning parts appear before text/tool parts within each message.
    sortPartsInPlace(allMessages)

    const total = allMessages.length
    const rawLimit = opts?.limit ?? 80
    const limit = Math.max(1, Math.min(rawLimit, 200))
    let start = 0
    let end = total

    if (opts?.before !== undefined) {
      end = Math.max(0, Math.min(opts.before, total))
      start = Math.max(0, end - limit)
    } else if (opts?.after !== undefined) {
      start = Math.max(0, Math.min(opts.after + 1, total))
      end = Math.min(total, start + limit)
    } else {
      end = total
      start = Math.max(0, end - limit)
    }

    // Cache subagent messages so they can be fetched by TaskToolView via getMessages("subagent-<toolUseId>")
    for (const [childSid, childMsgs] of subagentMessages) {
      this.subagentCache.set(childSid, childMsgs)
    }

    return { messages: allMessages.slice(start, end), start, end, total }
  }

  /**
   * Resolve the SDK's JSONL file from metadata and create a symlink on-demand.
   * Called when the direct symlink path doesn't exist (e.g. after server restart).
   * Returns the resolved file path, or null if not found.
   */
  private resolveAndSymlink(
    atelierSessionId: string,
    meta: ReturnType<SessionMetadataStore["get"]>,
  ): string | null {
    const sdkSessionId = meta?.sdkSessionId
    if (!sdkSessionId) return null
    if (!/^[a-f0-9-]+$/i.test(sdkSessionId)) return null

    // Check sessionDir first (SDK's JSONL may be in the same project directory)
    let target = path.join(this.sessionDir, `${sdkSessionId}.jsonl`)
    if (!fsSync.existsSync(target)) {
      // SDK resolves workspace paths with realpath (e.g. /Volumes/X → /private/var/X on macOS),
      // so the JSONL may be in a different project directory.
      if (meta?.workspacePath) {
        try {
          const realWs = fsSync.realpathSync(meta.workspacePath)
          if (realWs !== meta.workspacePath) {
            const realEncoded = realWs.replace(/[^a-zA-Z0-9]/g, "-")
            const realDir = path.join(path.dirname(this.sessionDir), realEncoded)
            const realFile = path.join(realDir, `${sdkSessionId}.jsonl`)
            if (fsSync.existsSync(realFile)) target = realFile
            else return null
          } else {
            return null
          }
        } catch {
          return null
        }
      } else {
        return null
      }
    }

    // Create symlink so subsequent reads (and other code paths) work directly
    try {
      const atelierFile = path.join(this.sessionDir, `${atelierSessionId}.jsonl`)
      if (!fsSync.existsSync(atelierFile)) {
        fsSync.symlinkSync(target, atelierFile)
      }
    } catch {
      // Non-critical — we can still read from target directly
    }

    return target
  }

  /** Build a message entry from a parsed JSONL line into a subagent message collection */
  private buildMessageEntry(
    parsed: { type?: string; message?: { id?: string; role?: string; model?: string; content?: Array<{ type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; output?: string; content?: string; is_error?: boolean; tool_use_id?: string }> } },
    childSessionId: string,
    subagentMessages: Map<string, Array<{ message: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>,
    subagentToolPartsMap: Map<string, Map<string, Record<string, unknown>>>,
  ): void {
    if (!parsed.message) return
    const role = (parsed.message.role ?? parsed.type ?? "user") as "user" | "assistant"
    const msgId = parsed.message.id ?? `subagent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()
    const blocks = parsed.message.content ?? []
    const parts: Array<Record<string, unknown>> = []
    let toolParts = subagentToolPartsMap.get(childSessionId)
    if (!toolParts) { toolParts = new Map(); subagentToolPartsMap.set(childSessionId, toolParts) }
    let partIdx = 0

    for (const block of blocks) {
      const partId = `${msgId}-part-${partIdx++}`
      const base = { id: partId, sessionID: childSessionId, messageID: msgId }
      switch (block.type) {
        case "text":
          parts.push({ ...base, type: "text", text: block.text ?? "" })
          break
        case "thinking":
          parts.push({ ...base, type: "reasoning", text: block.thinking ?? block.text ?? "", time: { start: now, end: now } })
          break
        case "tool_use": {
          const toolPartId = `${msgId}-tool-${block.id ?? partIdx}`
          const toolPart = {
            id: toolPartId, sessionID: childSessionId, messageID: msgId,
            type: "tool", callID: block.id ?? "",
            tool: (block.name ?? "").toLowerCase(),
            state: { status: "running", input: (block.input ?? {}) as Record<string, unknown>, title: (block.name ?? "").toLowerCase(), time: { start: now } },
          }
          parts.push(toolPart)
          if (block.id) toolParts.set(block.id, toolPart)
          break
        }
        case "tool_result": {
          const existing = block.tool_use_id ? toolParts.get(block.tool_use_id) : undefined
          if (existing) {
            const input = ((existing.state as Record<string, unknown>)?.input ?? {}) as Record<string, unknown>
            const resultText = block.output ?? block.content ?? ""
            existing.state = block.is_error
              ? { status: "error", input, error: resultText, time: { start: now, end: now } }
              : { status: "completed", input, output: resultText, title: String((existing as Record<string, unknown>).tool ?? "").toLowerCase(), metadata: {}, time: { start: now, end: now } }
          }
          break
        }
      }
    }

    if (role === "user" && parts.length === 0) return

    if (!subagentMessages.has(childSessionId)) subagentMessages.set(childSessionId, [])
    const msgs = subagentMessages.get(childSessionId)!
    // Merge duplicate message IDs
    const existing = msgs.find((m) => m.message.id === msgId)
    if (existing) { existing.parts.push(...parts); return }
    msgs.push({
      message: { id: msgId, sessionID: childSessionId, role, time: { created: now } },
      parts,
    })
  }

  /** Load messages from a subagent's own JSONL file (agent-<taskId>.jsonl in subagents/ dir). */
  private async loadSubagentMessages(toolUseId: string, childSessionId: string): Promise<Array<{ message: Record<string, unknown>; parts: Array<Record<string, unknown>> }>> {
    // Search all claude-code session JSONLs for a system.task_started entry matching this tool_use_id.
    // This is stateless — doesn't rely on engine in-memory state (survives server restarts).
    let taskId: string | null = null
    let sdkSessionId: string | null = null

    // First try engine's in-memory mapping (fast path during live sessions)
    for (const meta of this.metaStore.listRootSessions(this.workspacePath)) {
      if (meta.backend !== "claude-code") continue
      const mapping = this.engine.getSubagentMapping(meta.id, toolUseId)
      if (mapping) { taskId = mapping.taskId; sdkSessionId = mapping.sdkSessionId; break }
    }

    // Fall back to scanning parent JSONL files for system.task_started entries
    if (!taskId) {
      for (const meta of this.metaStore.listRootSessions(this.workspacePath)) {
        if (meta.backend !== "claude-code") continue
        const parentPath = path.join(this.sessionDir, `${meta.id}.jsonl`)
        try {
          const content = await fs.readFile(parentPath, "utf-8")
          for (const line of content.split("\n")) {
            if (!line.includes("task_started")) continue
            try {
              const obj = JSON.parse(line) as Record<string, unknown>
              if (obj.type === "system" && obj.subtype === "task_started" && obj.tool_use_id === toolUseId) {
                taskId = obj.task_id as string
                sdkSessionId = obj.session_id as string
                break
              }
            } catch { /* skip */ }
          }
          if (taskId) break
        } catch { /* skip missing files */ }
      }
    }

    if (!taskId || !sdkSessionId) return []

    const agentPath = path.join(this.sessionDir, sdkSessionId, "subagents", `agent-${taskId}.jsonl`)
    let content: string
    try { content = await fs.readFile(agentPath, "utf-8") } catch { return [] }

    const lines = content.split("\n").filter((l) => l.trim())
    const subagentMessages = new Map<string, Array<{ message: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>()
    const subagentToolParts = new Map<string, Map<string, Record<string, unknown>>>()
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { type?: string; message?: Record<string, unknown> }
        if (!parsed.message) continue
        this.buildMessageEntry(parsed as any, childSessionId, subagentMessages, subagentToolParts)
      } catch { /* skip malformed */ }
    }
    return subagentMessages.get(childSessionId) ?? []
  }

  async sendMessage(sessionId: string, params: Record<string, unknown>): Promise<void> {
    const model = params.model as { providerID: string; modelID: string } | undefined
    if (model?.providerID === "anthropic") {
      let models = await this.fetchModels()
      let modelExists = models.some((m) => m.id === model.modelID)
      if (!modelExists) {
        models = await this.fetchModels({ forceRefresh: true })
        modelExists = models.some((m) => m.id === model.modelID)
      }
      if (!modelExists) {
        const available = models.map((m) => m.id).join(", ")
        throw new Error(`Unknown model 'anthropic:${model.modelID}'. Available models: ${available}`)
      }
    }

    await this.engine.sendMessage(sessionId, {
      content: params.content as string,
      system: params.system as string | undefined,
      model,
      variant: params.variant as string | undefined,
    })
  }

  private cachedModels: Array<{ id: string; name: string; providerID: string; variants?: Record<string, unknown> }> | null = null
  private cachedModelsFetchedAt = 0
  private modelFetchPromise: Promise<Array<{ id: string; name: string; providerID: string; variants?: Record<string, unknown> }>> | null = null

  /** Fetch models from the SDK with TTL-based refresh and stale-cache fallback on fetch errors. */
  private fetchModels(opts?: { forceRefresh?: boolean }): Promise<Array<{ id: string; name: string; providerID: string; variants?: Record<string, unknown> }>> {
    const forceRefresh = opts?.forceRefresh === true
    const cacheIsFresh = this.cachedModels !== null
      && Date.now() - this.cachedModelsFetchedAt < ClaudeCodeProxy.MODELS_CACHE_TTL_MS
    if (!forceRefresh && cacheIsFresh) return Promise.resolve(this.cachedModels!)
    if (this.modelFetchPromise) return this.modelFetchPromise

    this.modelFetchPromise = this.engine.fetchSupportedModels().then((models) => {
      // SDK supports effort levels as variants — expose them so validation passes
      const EFFORT_VARIANTS: Record<string, unknown> = {
        low: { id: "low" },
        medium: { id: "medium" },
        high: { id: "high" },
        max: { id: "max" },
      }
      this.cachedModels = models.map((m) => ({
        id: m.value,
        // Prefer SDK displayName so UI labels track provider-side renames.
        // Fall back to description (trimmed before metadata separator) then model ID.
        name: m.displayName?.trim()
          || (m.description ? m.description.split(" · ")[0]!.trim() : "")
          || m.value,
        providerID: "anthropic",
        variants: EFFORT_VARIANTS,
      }))
      this.cachedModelsFetchedAt = Date.now()
      this.modelFetchPromise = null
      return this.cachedModels!
    }).catch(() => {
      this.modelFetchPromise = null
      if (this.cachedModels) return this.cachedModels
      return []
    })
    return this.modelFetchPromise
  }

  /** Start fetching models in the background (call on boot). */
  warmModels(): void {
    this.fetchModels().catch(() => {})
  }

  async getConfig(): Promise<{ models: Array<{ id: string; name: string; providerID: string; [key: string]: unknown }>; workspacePath: string }> {
    const models = await this.fetchModels()
    return { models, workspacePath: this.workspacePath }
  }

  async replyPermission(sessionId: string, requestId: string, reply: string): Promise<void> {
    if (reply === "reject") {
      this.engine.resolvePermission(sessionId, requestId, { behavior: "deny", message: "User denied" })
    } else {
      this.engine.resolvePermission(sessionId, requestId, { behavior: "allow", updatedInput: {} })
    }
  }

  async replyQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void> {
    this.engine.resolveQuestion(sessionId, requestId, {
      behavior: "allow",
      updatedInput: { answers },
    })
  }

  async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
    // Deny the pending question tool so the SDK promise resolves…
    this.engine.resolveQuestion(sessionId, requestId, {
      behavior: "deny",
      message: "User dismissed",
    })
    // …then interrupt the session so it goes idle and the user can type a
    // free-form reply instead of picking from the question's choices.
    await this.engine.interruptSession(sessionId)
  }

  async listPendingPermissions(): Promise<Array<{ id: string; sessionID: string; [key: string]: unknown }>> {
    return this.engine.getPendingPermissions()
  }

  async listPendingQuestions(): Promise<Array<{ id: string; sessionID: string; [key: string]: unknown }>> {
    return this.engine.getPendingQuestions()
  }

  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    this.metaStore.update(sessionId, { title })
  }
}
