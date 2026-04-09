import type { Logger, AtelierEvent } from "@atelier/core"
import { extractSessionId } from "./engine-utils.js"

export interface EventMergerOptions {
  bufferSize?: number
  /** Shared set of internal session IDs for filtering.
   *  Allows the same set to be shared with the proxy for session list filtering. */
  internalSessions?: Set<string>
  /** Optional logger for capturing OpenCode events to the observability system. */
  logger?: Logger
}

export function createEventMerger(options?: EventMergerOptions) {
  const bufferSize = options?.bufferSize ?? 5000
  let seq = 0
  // Ring buffer — O(1) push, no shift() overhead
  const ring: Array<{ seq: number; [key: string]: unknown } | null> = new Array(bufferSize).fill(null)
  let head = 0   // next write position
  let count = 0  // number of valid entries (≤ bufferSize)
  const internalSessions = options?.internalSessions ?? new Set<string>()
  const subscribers: Array<(event: Record<string, unknown>, json: string) => void> = []
  const log = options?.logger?.child({ source: "event-merger" }) ?? null
  // Track session titles so OpenCode SSE events with empty titles don't overwrite
  // titles we already set (e.g. via generateSessionTitle in the message endpoint).
  const sessionTitles = new Map<string, string>()

  /** Strip large payloads for replay buffer storage. Live subscribers get the original. */
  function stripForBuffer(event: { seq: number; [key: string]: unknown }): { seq: number; [key: string]: unknown } {
    const type = event.type as string
    if (type === "part.updated" || type === "part.created") {
      const props = event.properties as Record<string, unknown> | undefined
      const part = props?.part as Record<string, unknown> | undefined
      if (part?.text && (part.text as string).length > 200) {
        return { ...event, properties: { ...props, part: { ...part, text: (part.text as string).slice(0, 200) + "…[truncated]" } } }
      }
      const state = part?.state as Record<string, unknown> | undefined
      if (state?.output && (state.output as string).length > 200) {
        return { ...event, properties: { ...props, part: { ...part, state: { ...state, output: (state.output as string).slice(0, 200) + "…[truncated]" } } } }
      }
    }
    if (type === "message.completed") {
      const props = event.properties as Record<string, unknown> | undefined
      const info = props?.info as Record<string, unknown> | undefined
      if (info?.parts) {
        return { ...event, properties: { ...props, info: { ...info, parts: undefined } } }
      }
    }
    return event
  }

  function emit(event: Record<string, unknown>) {
    // Track session titles from session.updated / session.created events
    const evtType = event.type as string
    if (evtType === "session.updated" || evtType === "session.created") {
      const info = (event.properties as Record<string, unknown>)?.info as Record<string, unknown> | undefined
      if (info?.id && info?.title) {
        sessionTitles.set(info.id as string, info.title as string)
      }
    } else if (evtType === "session.deleted") {
      const info = (event.properties as Record<string, unknown>)?.info as Record<string, unknown> | undefined
      if (info?.id) sessionTitles.delete(info.id as string)
    }

    const seqEvent = { ...event, seq: ++seq }
    const json = JSON.stringify(seqEvent)
    // Notify live subscribers with original event + pre-serialized JSON
    for (const sub of subscribers) {
      try { sub(seqEvent, json) } catch (err) { log?.error("atelier", "server", "subscriber_notification_error", { error: String(err) }) }
    }
    // Store stripped version in ring buffer for replay
    const buffered = stripForBuffer(seqEvent)
    ring[head] = buffered
    head = (head + 1) % bufferSize
    if (count < bufferSize) count++
  }

  const toolStartTimes = new Map<string, number>() // `${sessionId}:${partId}` → timestamp

  function logOpenCodeEvent(event: Record<string, unknown>, sessionId: string | undefined): void {
    if (!log) return
    const type = event.type as string
    const props = event.properties as Record<string, unknown> | undefined
    const info = props?.info as Record<string, unknown> | undefined
    const part = props?.part as Record<string, unknown> | undefined
    const usage = props?.usage as Record<string, unknown> | undefined

    switch (type) {
      case "session.created":
        log.debug("opencode", "session", "session_created", { sessionId })
        break
      case "session.idle":
        log.debug("opencode", "session", "session_idle", { sessionId })
        break
      case "session.busy":
        log.trace("opencode", "session", "session_busy", { sessionId })
        break
      case "message.created": {
        if (info?.role === "assistant") {
          log.debug("opencode", "assistant", "turn_started", { sessionId })
        }
        break
      }
      case "message.completed": {
        if (info?.role === "assistant") {
          log.debug("opencode", "assistant", "turn_completed", { sessionId })
        }
        break
      }
      case "part.created":
      case "message.part.created": {
        if (part?.type === "tool-invocation") {
          const partId = part.id as string | undefined
          if (partId) toolStartTimes.set(`${sessionId}:${partId}`, Date.now())
          log.debug("opencode", "tool", "tool_call_started", { sessionId, data: { toolName: part.toolName } })
        }
        break
      }
      case "part.updated":
      case "message.part.updated": {
        const partState = (part?.state as Record<string, unknown> | undefined)?.type
        if (part?.type === "tool-invocation" && partState === "completed") {
          const partId = part.id as string | undefined
          const compositeKey = partId ? `${sessionId}:${partId}` : undefined
          const startTime = compositeKey ? toolStartTimes.get(compositeKey) : undefined
          const durationMs = startTime ? Date.now() - startTime : undefined
          if (compositeKey) toolStartTimes.delete(compositeKey)
          log.debug("opencode", "tool", "tool_call_completed", { sessionId, data: { toolName: part.toolName, durationMs } })
        } else if (part?.type === "tool-invocation" && partState === "error") {
          log.error("opencode", "tool", "tool_call_failed", { sessionId, error: String((part.state as Record<string, unknown>)?.error ?? ""), data: { toolName: part.toolName } })
        }
        break
      }
      case "message.usage": {
        log.trace("opencode", "assistant", "token_usage", {
          sessionId,
          data: { inputTokens: usage?.input, outputTokens: usage?.output },
        })
        break
      }
    }
  }

  let pendingInternalCreations = 0

  // Track messages that have had thinking content (to avoid removing thinking parts from
  // subsequent message.completed calls that only contain text/tool_use blocks).
  const messagesWithThinking = new Set<string>()
  /** Tracks the last assistant message being streamed per session (for interrupt labelling). */
  const streamingMessage = new Map<string, { messageId: string; sessionId: string }>()
  /** Tracks when thinking streaming started per message (for accurate duration). */
  const thinkingStartTime = new Map<string, number>()

  // --- OpenCode reasoning part merger ---
  // OpenCode creates a separate reasoning part (with unique ID) per token/chunk, each with
  // time.end already set. Merge them into a single accumulated reasoning part per message
  // so the UI shows one "Thinking" block instead of dozens of fragments.
  // Tracks per-part-ID text contributions so that:
  //  - New part IDs (GLM per-token pattern) → text appended
  //  - Same part ID updated (normal model pattern) → text replaced
  // Key: `${sessionID}:${messageID}` → { partContributions, startTime, endTime }
  const mergedReasoning = new Map<string, { parts: Map<string, string>; startTime: number; endTime: number }>()

  // --- Diff size cap ---
  // OpenCode embeds full file content in summary.diffs. Transcript files can grow to tens of MB,
  // producing 100MB+ SSE events that peg the CPU during JSON.stringify. Cap each diff entry.
  const MAX_DIFF_ENTRY_CHARS = 50_000 // ~50 KB per diff entry — enough for normal files

  // --- Text streaming throttle ---
  // Accumulate text part.updated events and flush every 100ms instead of dispatching each one.
  // Tool invocation state changes (completed/error) always pass through immediately.
  const TEXT_THROTTLE_MS = 100
  const pendingTextUpdates = new Map<string, Record<string, unknown>>() // partId → latest event
  let throttleTimer: ReturnType<typeof setInterval> | null = null

  function startThrottle() {
    if (throttleTimer) return
    throttleTimer = setInterval(flushTextUpdates, TEXT_THROTTLE_MS)
  }

  function clearThrottleTimer() {
    if (throttleTimer) { clearInterval(throttleTimer); throttleTimer = null }
  }

  function flushTextUpdates() {
    if (pendingTextUpdates.size === 0) {
      clearThrottleTimer()
      return
    }
    const pendingCount = pendingTextUpdates.size
    for (const event of pendingTextUpdates.values()) {
      emit(event)
    }
    log?.trace("atelier", "server", "text_throttle_flushed", { data: { count: pendingCount } })
    pendingTextUpdates.clear()
    clearThrottleTimer()
  }

  /** Flush pending throttled updates and stop the timer. */
  function stopThrottle() {
    flushTextUpdates()
    clearThrottleTimer()
  }

  function stripLiveToolOutput(event: Record<string, unknown>): Record<string, unknown> {
    const props = event.properties as Record<string, unknown> | undefined
    const part = props?.part as Record<string, unknown> | undefined
    if (!part || part.type !== "tool-invocation") return event
    const state = part.state as Record<string, unknown> | undefined
    if (!state) return event
    const status = state.type as string | undefined
    if (status === "completed" || status === "error") return event
    if (typeof state.output !== "string") return event
    // Running tool output is extremely noisy and not rendered live by the UI.
    // Drop it from streamed updates to keep SSE payloads lightweight.
    return {
      ...event,
      properties: {
        ...props,
        part: {
          ...part,
          state: {
            ...state,
            output: "",
          },
        },
      },
    }
  }

  function isThrottleablePartUpdate(type: string, props: Record<string, unknown> | undefined): boolean {
    if (type !== "part.updated" && type !== "message.part.updated") return false
    const part = props?.part as Record<string, unknown> | undefined
    if (!part) return false
    // Throttle text streaming updates.
    if (part.type !== "tool-invocation") return true
    // Throttle running tool updates; let terminal transitions through immediately.
    const state = part.state as Record<string, unknown> | undefined
    const toolState = state?.type
    return toolState !== "completed" && toolState !== "error"
  }

  function forwardOpenCodeEvent(event: Record<string, unknown>) {
    const type = event.type as string
    let props = event.properties as Record<string, unknown> | undefined
    const propsInfo = props?.info as Record<string, unknown> | undefined
    const sessionID = extractSessionId(event)

    // Cap oversized summary.diffs entries in message.updated events.
    // OpenCode embeds full file content (before/after) in diffs — including rapidly-growing
    // transcript files, which can produce events of 100MB+. Truncate individual diff entries
    // that exceed the threshold to prevent CPU-pegging during JSON.stringify + dispatch.
    const summary = propsInfo?.summary as Record<string, unknown> | undefined
    if (type === "message.updated" && summary?.diffs) {
      const diffs = summary.diffs as Array<{ file?: string; before?: string; after?: string; [k: string]: unknown }>
      let needsClone = false
      for (const d of diffs) {
        if ((d.before && d.before.length > MAX_DIFF_ENTRY_CHARS) || (d.after && d.after.length > MAX_DIFF_ENTRY_CHARS)) {
          needsClone = true
          break
        }
      }
      if (needsClone) {
        const capped = diffs.map((d) => {
          const before = typeof d.before === "string" && d.before.length > MAX_DIFF_ENTRY_CHARS
            ? d.before.slice(0, MAX_DIFF_ENTRY_CHARS) + `\n…[truncated ${d.before.length - MAX_DIFF_ENTRY_CHARS} chars]`
            : d.before
          const after = typeof d.after === "string" && d.after.length > MAX_DIFF_ENTRY_CHARS
            ? d.after.slice(0, MAX_DIFF_ENTRY_CHARS) + `\n…[truncated ${d.after.length - MAX_DIFF_ENTRY_CHARS} chars]`
            : d.after
          return { ...d, before, after }
        })
        log?.debug("atelier", "server", "diff_size_capped", { sessionId: sessionID, data: { diffCount: capped.length } })
        props = { ...props, info: { ...propsInfo, summary: { ...summary, diffs: capped } } }
        event = { ...event, properties: props }
      }
    }

    // Race condition guard: session.created SSE event can arrive before addInternalSession
    // is called (since createSession is async). During pending creations, auto-register and suppress.
    if (pendingInternalCreations > 0 && type === "session.created" && sessionID) {
      internalSessions.add(sessionID)
      return
    }

    if (sessionID && internalSessions.has(sessionID)) {
      // Forward message + tool + session status + question/permission events for internal sessions —
      // messages needed for StageBlock display, part/tool events for tool call visibility,
      // status for busy/idle state, question/permission for interactive brainstorm stage.
      // session.created/updated/deleted are still filtered to keep them hidden from the dropdown.
      if (
        !type.startsWith("message.") &&
        !type.startsWith("part.") &&
        !type.startsWith("question.") &&
        !type.startsWith("permission.") &&
        type !== "session.busy" &&
        type !== "session.idle" &&
        type !== "session.status"
      ) {
        log?.trace("atelier", "server", "internal_session_filtered", { sessionId: sessionID, data: { eventType: type } })
        return
      }
    }

    // Clean up toolStartTimes when a session ends to prevent memory leaks.
    // Only remove entries for the specific session (keyed by `${sessionId}:${partId}`).
    if ((type === "session.idle" || type === "session.error") && sessionID) {
      const prefix = `${sessionID}:`
      for (const key of toolStartTimes.keys()) {
        if (key.startsWith(prefix)) toolStartTimes.delete(key)
      }
    }

    if (log) logOpenCodeEvent(event, sessionID)

    // Enrich session.updated / session.created from OpenCode with cached titles.
    // OpenCode emits session.created with a default title ("New session - <timestamp>")
    // before our updateSessionTitle() call completes, overwriting the title we set via
    // generateSessionTitle(). Always prefer the cached title when we have one.
    if ((type === "session.updated" || type === "session.created") && sessionID) {
      const info = propsInfo as Record<string, unknown> | undefined
      if (info) {
        const cached = sessionTitles.get(sessionID)
        if (cached && info.title !== cached) {
          event = { ...event, properties: { ...props, info: { ...info, title: cached } } }
        }
      }
    }

    // Merge per-token reasoning parts from OpenCode into a single accumulated part.
    // OpenCode (e.g. with GLM models) creates a new reasoning part for every token,
    // each with a unique ID and time.end already set. Rewrite these into a single
    // stable-ID part so the UI renders one "Thinking" block.
    // Safe for normal models too: if the same part ID is updated, its text is replaced
    // (not appended), so the merge degrades to a no-op passthrough.
    if ((type === "part.updated" || type === "message.part.updated") && props) {
      const part = props.part as Record<string, unknown> | undefined
      if (part?.type === "reasoning" && part.text !== undefined && sessionID) {
        const messageID = (part.messageID ?? part.message_id ?? "") as string
        const partId = (part.id as string) ?? "unknown"
        const time = part.time as { start?: number; end?: number } | undefined
        const key = `${sessionID}:${messageID}`
        let entry = mergedReasoning.get(key)
        if (!entry) {
          entry = { parts: new Map(), startTime: time?.start ?? Date.now(), endTime: time?.end ?? 0 }
          mergedReasoning.set(key, entry)
        }
        // Store/replace the text contribution for this specific part ID.
        // New IDs (GLM per-token) → adds entry. Same ID updated → replaces.
        entry.parts.set(partId, (part.text as string) ?? "")
        if (time?.end) entry.endTime = time.end
        // Concatenate all part contributions in insertion order
        let mergedText = ""
        for (const t of entry.parts.values()) mergedText += t
        // Rewrite event with stable synthetic ID and accumulated text
        const mergedEvent: Record<string, unknown> = {
          ...event,
          type: "message.part.updated",
          properties: {
            ...props,
            part: {
              ...part,
              id: `${messageID}-reasoning`,
              text: mergedText,
              time: { start: entry.startTime, end: entry.endTime || undefined },
            },
          },
        }
        // Feed into the existing throttle with the stable ID
        pendingTextUpdates.set(`${messageID}-reasoning`, mergedEvent)
        startThrottle()
        return
      }
    }

    // Clean up merged reasoning state when a session ends
    if ((type === "session.idle" || type === "session.error" || type === "message.completed") && sessionID) {
      for (const key of mergedReasoning.keys()) {
        if (key.startsWith(`${sessionID}:`)) mergedReasoning.delete(key)
      }
    }

    // Throttle text streaming updates — accumulate and flush every 100ms
    if (isThrottleablePartUpdate(type, props)) {
      const partProps = props?.part as Record<string, unknown> | undefined
      const partId = (partProps?.id as string | undefined) ?? `${sessionID}-unknown`
      pendingTextUpdates.set(partId, stripLiveToolOutput(event))
      startThrottle()
      return
    }

    // Non-text events flush any pending text updates first (preserves ordering)
    if (pendingTextUpdates.size > 0) flushTextUpdates()

    emit(event)
  }

  /** Whether an AtelierEvent type is throttleable (text deltas). */
  function isThrottleableAtelierEvent(event: AtelierEvent): boolean {
    return event.type === "message.delta"
  }

  /**
   * Normalize a single AtelierEvent into one or more OpenCode-compatible events.
   * Returns an array because some AtelierEvents expand to multiple UI events
   * (e.g. message.completed → message.updated + message.part.updated for each block).
   */
  function normalizeForUI(event: AtelierEvent): Record<string, unknown>[] {
    switch (event.type) {
      case "session.busy":
        return [{ type: "session.busy", properties: { sessionID: event.sessionId } }]
      case "session.idle": {
        streamingMessage.delete(event.sessionId)
        // Clean up toolStartTimes entries for this session (Claude Code path)
        const idlePrefix = `${event.sessionId}:`
        for (const key of toolStartTimes.keys()) {
          if (key.startsWith(idlePrefix)) toolStartTimes.delete(key)
        }
        // Cap messagesWithThinking to prevent unbounded growth
        if (messagesWithThinking.size > 10_000) messagesWithThinking.clear()
        return [{ ...event, type: "session.idle", properties: { sessionID: event.sessionId } }]
      }
      case "session.interrupted": {
        const intEvents: Record<string, unknown>[] = [
          { type: "session.interrupted", properties: { sessionID: event.sessionId } },
        ]
        // Mark the streaming assistant message as interrupted so the UI shows the label
        const intTracked = streamingMessage.get(event.sessionId)
        if (intTracked) {
          intEvents.unshift({
            type: "message.updated",
            properties: {
              info: {
                id: intTracked.messageId,
                sessionID: intTracked.sessionId,
                role: "assistant",
                error: { name: "MessageAbortedError", message: "Message aborted" },
              },
            },
          })
          streamingMessage.delete(event.sessionId)
        }
        return intEvents
      }
      case "session.stalled":
        return [{ type: "session.stalled", properties: { sessionID: event.sessionId, reason: event.reason, silentForMs: event.silentForMs } }]
      case "session.error": {
        const events: Record<string, unknown>[] = [
          { type: "session.error", properties: { sessionID: event.sessionId, error: event.error } },
        ]
        // If a Claude-backend assistant message was mid-stream, mark it as interrupted
        // so the UI renders the "interrupted" label (mirrors what the OpenCode SDK emits naturally).
        const tracked = streamingMessage.get(event.sessionId)
        if (tracked) {
          events.unshift({
            type: "message.updated",
            properties: {
              info: {
                id: tracked.messageId,
                sessionID: tracked.sessionId,
                role: "assistant",
                error: { name: "MessageAbortedError", message: "Message aborted" },
              },
            },
          })
          streamingMessage.delete(event.sessionId)
        }
        return events
      }
      case "message.created": {
        const e = event as { sessionId: string; messageId: string; role: string }
        const now = Date.now()
        // Track for interrupt detection
        if (e.role === "assistant") streamingMessage.set(e.sessionId, { messageId: e.messageId, sessionId: e.sessionId })
        const events: Record<string, unknown>[] = [
          {
            type: "message.updated",
            properties: {
              info: { id: e.messageId, sessionID: e.sessionId, role: e.role, time: { created: now } },
            },
          },
        ]
        // Create initial empty text part for streaming deltas into.
        // Thinking placeholder is created lazily on the first thinking delta
        // to avoid showing "Thinking..." when the model goes straight to tool use.
        if (e.role === "assistant") {
          events.push({
            type: "message.part.updated",
            properties: {
              part: { id: `${e.messageId}-text`, sessionID: e.sessionId, messageID: e.messageId, type: "text", text: "" },
            },
          })
        }
        return events
      }
      case "message.delta": {
        const e = event as { sessionId: string; messageId: string; contentType: string; delta: string }
        const isThinking = e.contentType === "thinking"
        return [{
          type: "message.part.delta",
          properties: {
            sessionID: e.sessionId,
            messageID: e.messageId,
            partID: isThinking ? `${e.messageId}-thinking` : `${e.messageId}-text`,
            field: "text",
            delta: e.delta,
          },
        }]
      }
      case "message.completed": {
        const e = event as { sessionId: string; messageId: string; role: string; contentBlocks: Array<{ type: string; text?: string; toolUseId?: string; name?: string; input?: Record<string, unknown>; output?: string; isError?: boolean }>; model?: { providerID: string; modelID: string }; variant?: string }
        // Message completed normally — no longer needs interrupt tracking
        streamingMessage.delete(e.sessionId)
        const now = Date.now()
        const thinkStart = thinkingStartTime.get(e.messageId) ?? now
        thinkingStartTime.delete(e.messageId)
        const info: Record<string, unknown> = { id: e.messageId, sessionID: e.sessionId, role: e.role, finish: "end_turn", time: { created: now } }
        if (e.model) {
          if (e.role === "user") info.model = e.model
          else { info.providerID = e.model.providerID; info.modelID = e.model.modelID }
        }
        if (e.variant) info.variant = e.variant
        const events: Record<string, unknown>[] = [
          { type: "message.updated", properties: { info } },
        ]
        // Emit final parts for each content block
        let textIdx = 0
        let thinkIdx = 0
        for (const block of e.contentBlocks) {
          const base = { sessionID: e.sessionId, messageID: e.messageId }
          switch (block.type) {
            case "text": {
              // Use stable ID that matches streaming part IDs (first text = ${messageId}-text)
              const textPartId = textIdx === 0 ? `${e.messageId}-text` : `${e.messageId}-text-${textIdx}`
              textIdx++
              events.push({ type: "message.part.updated", properties: { part: { ...base, id: textPartId, type: "text", text: block.text ?? "" } } })
              break
            }
            case "thinking": {
              const thinkPartId = thinkIdx === 0 ? `${e.messageId}-thinking` : `${e.messageId}-thinking-${thinkIdx}`
              thinkIdx++
              events.push({ type: "message.part.updated", properties: { part: { ...base, id: thinkPartId, type: "reasoning", text: block.text ?? "", time: { start: thinkStart, end: now } } } })
              break
            }
            case "tool_use": {
              // Use toolUseId-based part ID so tool.completed can update this same part
              const toolPartId = `${e.messageId}-tool-${block.toolUseId}`
              const isAgentTool = (block.name ?? "").toLowerCase() === "agent"
              const toolName = isAgentTool ? "task" : (block.name ?? "").toLowerCase()
              const agentMeta = isAgentTool && block.toolUseId ? { metadata: { sessionId: `subagent-${block.toolUseId}` } } : {}
              events.push({ type: "message.part.updated", properties: { part: { ...base, id: toolPartId, type: "tool", callID: block.toolUseId ?? "", tool: toolName, state: { status: "running", input: block.input ?? {}, title: toolName, time: { start: now }, ...agentMeta } } } })
              break
            }
            case "tool_result": {
              events.push({ type: "message.part.updated", properties: { part: { ...base, type: "tool", callID: block.toolUseId ?? "", tool: "", state: block.isError ? { status: "error", input: {}, error: block.output ?? "", time: { start: now, end: now } } : { status: "completed", input: {}, output: block.output ?? "", title: "", metadata: {}, time: { start: now, end: now } } } } })
              break
            }
          }
        }
        // Track messages that had thinking content
        if (thinkIdx > 0) messagesWithThinking.add(e.messageId)
        return events
      }
      case "tool.started": {
        const e = event as { sessionId: string; toolUseId: string; toolName: string; messageId?: string; input: Record<string, unknown> }
        const isAgent = e.toolName.toLowerCase() === "agent"
        const toolName = isAgent ? "task" : e.toolName.toLowerCase()
        const metadata = isAgent ? { sessionId: `subagent-${e.toolUseId}` } : undefined
        // Use messageId-based part ID so tool.completed can update this same part
        const partId = e.messageId ? `${e.messageId}-tool-${e.toolUseId}` : `tool-${e.toolUseId}`
        const messageID = e.messageId ?? ""
        return [{
          type: "message.part.updated",
          properties: {
            part: { id: partId, sessionID: e.sessionId, messageID, type: "tool", callID: e.toolUseId, tool: toolName, state: { status: "running", input: e.input, title: toolName, time: { start: Date.now() }, ...(metadata ? { metadata } : {}) } },
          },
        }]
      }
      case "tool.completed": {
        const e = event as { sessionId: string; toolUseId: string; toolName: string; messageId?: string; output: string; isError: boolean; durationMs: number; input?: Record<string, unknown> }
        const now = Date.now()
        const isAgent = e.toolName.toLowerCase() === "agent"
        const toolLower = isAgent ? "task" : e.toolName.toLowerCase()
        const input = e.input ?? {}
        const agentMeta = isAgent ? { sessionId: `subagent-${e.toolUseId}` } : {}
        // Use messageId-based part ID when available (links result to the assistant message's tool_use part)
        const partId = e.messageId ? `${e.messageId}-tool-${e.toolUseId}` : `tool-${e.toolUseId}`
        const messageID = e.messageId ?? ""
        return [{
          type: "message.part.updated",
          properties: {
            part: { id: partId, sessionID: e.sessionId, messageID, type: "tool", callID: e.toolUseId, tool: toolLower, state: e.isError ? { status: "error", input, error: e.output, time: { start: now - e.durationMs, end: now }, metadata: agentMeta } : { status: "completed", input, output: e.output, title: toolLower, metadata: agentMeta, time: { start: now - e.durationMs, end: now } } },
          },
        }]
      }
      case "permission.asked": {
        const e = event as { sessionId: string; requestId: string; toolName: string; toolInput: Record<string, unknown>; suggestions?: unknown; decisionReason?: string }
        return [{
          type: "permission.asked",
          properties: {
            id: e.requestId,
            sessionID: e.sessionId,
            permission: { tool: e.toolName, input: e.toolInput },
            suggestions: e.suggestions,
            decisionReason: e.decisionReason,
          },
        }]
      }
      case "question.asked": {
        const e = event as { sessionId: string; requestId: string; question: unknown; tool?: { messageID: string; callID: string } }
        // Build a QuestionRequest-shaped object: { id, sessionID, questions: QuestionInfo[], tool? }
        // Claude Code engine sends `question` as the unwrapped questions array.
        const questions = Array.isArray(e.question) ? e.question : []
        return [{
          type: "question.asked",
          properties: {
            id: e.requestId,
            sessionID: e.sessionId,
            questions,
            ...(e.tool ? { tool: e.tool } : {}),
          },
        }]
      }
      case "permission.replied": {
        const e = event as { sessionId: string; requestId: string }
        return [{
          type: "permission.replied",
          properties: { id: e.requestId, sessionID: e.sessionId },
        }]
      }
      case "question.replied":
      case "question.rejected": {
        const e = event as { sessionId: string; requestId: string }
        return [{
          type: event.type,
          properties: { id: e.requestId, sessionID: e.sessionId },
        }]
      }
      default:
        return [event as unknown as Record<string, unknown>]
    }
  }

  function forwardEvent(event: AtelierEvent) {
    const sessionId = "sessionId" in event ? (event as { sessionId: string }).sessionId : undefined

    // Internal session filtering: only forward message/question/permission/tool events + busy/idle for status
    if (sessionId && internalSessions.has(sessionId)) {
      if (
        !event.type.startsWith("message.") &&
        !event.type.startsWith("question.") &&
        !event.type.startsWith("permission.") &&
        !event.type.startsWith("tool.") &&
        event.type !== "session.busy" && event.type !== "session.idle" && event.type !== "session.interrupted" && event.type !== "session.error"
      ) return
    }

    // Lazily create thinking part on first thinking delta (emitted immediately, not throttled)
    if (event.type === "message.delta") {
      const e = event as { sessionId: string; messageId: string; contentType: string }
      if (e.contentType === "thinking" && !thinkingStartTime.has(e.messageId)) {
        const now = Date.now()
        thinkingStartTime.set(e.messageId, now)
        emit({
          type: "message.part.updated",
          properties: {
            part: { id: `${e.messageId}-thinking`, sessionID: e.sessionId, messageID: e.messageId, type: "reasoning", text: "", time: { start: now } },
          },
        })
      }
    }

    // Throttle text streaming deltas — accumulate incremental deltas, replace full-text updates
    if (isThrottleableAtelierEvent(event)) {
      const normalized = normalizeForUI(event)
      for (const ev of normalized) {
        const props = ev.properties as Record<string, unknown> | undefined
        const partId = (props?.partID as string) ?? (props?.part as Record<string, unknown>)?.id as string ?? `${sessionId}-unknown`
        if (ev.type === "message.part.delta") {
          // Incremental delta — accumulate text instead of replacing
          const existing = pendingTextUpdates.get(partId)
          if (existing && existing.type === "message.part.delta") {
            const existingProps = existing.properties as Record<string, unknown>
            existingProps.delta = (existingProps.delta as string) + ((props?.delta as string) ?? "")
          } else {
            pendingTextUpdates.set(partId, ev)
          }
        } else {
          // Full-text update (OpenCode path) — replace is correct
          pendingTextUpdates.set(partId, ev)
        }
      }
      startThrottle()
      return
    }

    // Non-throttled events flush pending first
    if (pendingTextUpdates.size > 0) flushTextUpdates()

    for (const normalized of normalizeForUI(event)) {
      emit(normalized)
    }
  }

  /** Read ring buffer contents in order (oldest → newest). */
  function readRing(): Array<{ seq: number; [key: string]: unknown }> {
    if (count === 0) return []
    const result: Array<{ seq: number; [key: string]: unknown }> = new Array(count)
    const start = (head - count + bufferSize) % bufferSize
    for (let i = 0; i < count; i++) {
      result[i] = ring[(start + i) % bufferSize]!
    }
    return result
  }

  function getEventsAfter(lastSeq: number): Array<{ seq: number; [key: string]: unknown }> | null {
    if (count === 0) return lastSeq === 0 ? [] : null

    const oldest = ring[(head - count + bufferSize) % bufferSize]!
    const newest = ring[(head - 1 + bufferSize) % bufferSize]!
    const bufferStart = oldest.seq
    const bufferEnd = newest.seq

    if (lastSeq === 0) {
      // Return all buffered events even if the buffer has wrapped (oldest seq > 1).
      // Returning null here triggers full_refresh_required on the client, which causes
      // the webview to miss events like the compiled prompt user message.
      return readRing()
    }

    if (lastSeq > bufferEnd) return null

    // lastSeq is before the buffer -- check for contiguity
    if (lastSeq < bufferStart) {
      if (lastSeq + 1 !== bufferStart) {
        log?.debug("atelier", "server", "ring_buffer_overflow", { data: { requestedSeq: lastSeq } })
      }
      return lastSeq + 1 === bufferStart ? readRing() : null
    }

    // Find the event with lastSeq in the ring and return everything after it
    const all = readRing()
    const idx = all.findIndex(e => e.seq === lastSeq)
    if (idx === -1) return null
    return all.slice(idx + 1)
  }

  return {
    emit,
    forwardOpenCodeEvent,
    forwardEvent,
    getEventsAfter,
    currentSeq: () => seq,
    subscribe(handler: (event: Record<string, unknown>, json: string) => void) {
      subscribers.push(handler)
      return () => {
        const i = subscribers.indexOf(handler)
        if (i >= 0) subscribers.splice(i, 1)
      }
    },
    addInternalSession: (id: string) => internalSessions.add(id),
    removeInternalSession: (id: string) => internalSessions.delete(id),
    stopThrottle,
    beginInternalCreation: () => { pendingInternalCreations++ },
    completeInternalCreation: (id: string) => {
      internalSessions.add(id)
      pendingInternalCreations = Math.max(0, pendingInternalCreations - 1)
    },
  }
}
