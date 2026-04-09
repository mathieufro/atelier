import { createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import type { OpenCodeForwardedEvent, Message, MessageWithParts, Part, StepFinishPart } from "@atelier/core"
import { ALLOWED_DELTA_FIELDS } from "@atelier/core"
import { debug } from "../debug.js"

export interface MessageEntry {
  message: Message
  parts: Part[]
  skill?: string
  fileContext?: string
}

interface SessionMessages {
  byId: Record<string, MessageEntry>
  order: string[]
  start: number
  total: number
  loadingOlder: boolean
  loadingNewer: boolean
}

interface MessageStoreState {
  bySession: Record<string, SessionMessages>
}

function ensureSession(state: MessageStoreState, sessionId: string): void {
  if (!state.bySession[sessionId]) {
    state.bySession[sessionId] = {
      byId: {},
      order: [],
      start: 0,
      total: 0,
      loadingOlder: false,
      loadingNewer: false,
    }
  }
}

type PageDirection = "replace" | "prepend" | "append"

const MAX_WINDOW_MESSAGES = 240

function trimWindow(session: SessionMessages, direction: PageDirection): string[] {
  if (session.order.length <= MAX_WINDOW_MESSAGES) return []
  const overflow = session.order.length - MAX_WINDOW_MESSAGES
  if (direction === "prepend") {
    const removedTail = session.order.splice(session.order.length - overflow, overflow)
    for (const id of removedTail) delete session.byId[id]
    return removedTail
  }
  const removedHead = session.order.splice(0, overflow)
  for (const id of removedHead) delete session.byId[id]
  session.start += overflow
  return removedHead
}

function getUserText(entry: MessageEntry | undefined): string | undefined {
  if (!entry || entry.message.role !== "user") return undefined
  const textPart = entry.parts.find((part) => part.type === "text") as { text?: string } | undefined
  return typeof textPart?.text === "string" ? textPart.text : undefined
}

export function createMessageStore() {
  const [state, setState] = createStore<MessageStoreState>({
    bySession: {},
  })
  const [deltaVersions, setDeltaVersions] = createSignal<Record<string, number>>({})
  const optimisticUserBySession = new Map<string, string[]>()
  /** Pending skill to attach to the next user message arriving in a session (for new-session skill invocations). */
  const pendingSkillBySession = new Map<string, string>()

  function messages(sessionId: string): MessageEntry[] {
    const session = state.bySession[sessionId]
    if (!session) return []
    return session.order.map((id) => session.byId[id]).filter((e): e is MessageEntry => Boolean(e))
  }

  function tokenUsage(sessionId: string): { input: number; output: number; cache: number; total: number } | undefined {
    const msgs = messages(sessionId)
    for (let i = msgs.length - 1; i >= 0; i--) {
      const entry = msgs[i]!
      if (entry.message.role !== "assistant") continue
      if ((entry.message as unknown as Record<string, unknown>).summary) continue
      const finish = entry.parts.find((p): p is StepFinishPart => p.type === "step-finish")
      if (!finish) continue
      const total = finish.tokens.total || (finish.tokens.input + finish.tokens.output + finish.tokens.cache.read + finish.tokens.cache.write)
      return {
        input: finish.tokens.input,
        output: finish.tokens.output,
        cache: finish.tokens.cache.read,
        total,
      }
    }
    return undefined
  }

  function applyMessagePage(
    sessionId: string,
    msgs: MessageWithParts[],
    meta?: { start?: number; end?: number; total?: number; direction?: PageDirection },
  ) {
    const direction = meta?.direction ?? "replace"
    debug("apply_page", { sessionId, direction, count: msgs.length })
    const incomingById: Record<string, MessageEntry> = {}
    const incomingOrder: string[] = []
    for (const { message, parts } of msgs) {
      const entry: MessageEntry = { message, parts }
      // Derive skill badge from message metadata
      if (message.role === "user") {
        const msgRecord = message as Record<string, unknown>
        // 1. Direct skill field (Claude Code proxy attaches this from session metadata)
        if (typeof msgRecord.skill === "string") {
          entry.skill = msgRecord.skill
        }
        // 2. Derive from system prompt heading (OpenCode includes system on user messages)
        if (!entry.skill) {
          const system = msgRecord.system as string | undefined
          if (system) {
            const heading = system.match(/^#\s+(.+)/m)
            entry.skill = heading ? heading[1]!.trim().toLowerCase().replace(/\s+/g, "-") : "skill"
          }
        }
        // 3. Consume pending skill from skill.used SSE event
        if (!entry.skill) {
          const pending = pendingSkillBySession.get(sessionId)
          if (pending) {
            entry.skill = pending
            pendingSkillBySession.delete(sessionId)
          }
        }
      }
      incomingById[message.id] = entry
      incomingOrder.push(message.id)
    }

    setState(
      produce((s) => {
        ensureSession(s, sessionId)
        const session = s.bySession[sessionId]!

        if (direction === "replace") {
          const optimisticQueue = optimisticUserBySession.get(sessionId) ?? []
          // Snapshot optimistic entries before replacing the session data
          const optimisticSnapshots = optimisticQueue
            .map((oid) => ({ id: oid, entry: session.byId[oid], text: getUserText(session.byId[oid]) }))
            .filter((snap): snap is { id: string; entry: MessageEntry; text: string | undefined } => Boolean(snap.entry))
          // Preserve skill metadata from existing entries (SSE events may have set it before REST load)
          for (const id of Object.keys(incomingById)) {
            const existing = session.byId[id]
            if (existing?.skill && !incomingById[id]!.skill) {
              incomingById[id]!.skill = existing.skill
            }
          }
          session.byId = incomingById
          session.order = incomingOrder
          session.start = meta?.start ?? 0
          session.total = meta?.total ?? incomingOrder.length
          // Re-attach optimistic messages that weren't matched by incoming real messages
          const surviving: string[] = []
          for (const snap of optimisticSnapshots) {
            if (session.byId[snap.id]) { surviving.push(snap.id); continue } // already present
            const matchedId = snap.text !== undefined
              ? session.order.find((id) => getUserText(session.byId[id]) === snap.text)
              : undefined
            if (matchedId) {
              // Transfer skill metadata from optimistic → delivered real message
              if (snap.entry.skill && !session.byId[matchedId]!.skill) {
                session.byId[matchedId]!.skill = snap.entry.skill
              }
            } else {
              // Not yet delivered — re-insert optimistic entry
              session.byId[snap.id] = snap.entry
              session.order.push(snap.id)
              session.total = Math.max(session.total, session.start + session.order.length)
              surviving.push(snap.id)
            }
          }
          if (surviving.length > 0) {
            optimisticUserBySession.set(sessionId, surviving)
          } else {
            optimisticUserBySession.delete(sessionId)
          }
        } else if (direction === "prepend") {
          for (const id of incomingOrder) {
            const existing = session.byId[id]
            if (existing?.skill && !incomingById[id]!.skill) incomingById[id]!.skill = existing.skill
            session.byId[id] = incomingById[id]!
          }
          const existing = session.order.filter((id) => !incomingById[id])
          session.order = [...incomingOrder, ...existing]
          session.start = meta?.start ?? Math.max(0, session.start - incomingOrder.length)
          session.total = meta?.total ?? Math.max(session.total, session.start + session.order.length)
        } else {
          for (const id of incomingOrder) {
            const existing = session.byId[id]
            if (existing?.skill && !incomingById[id]!.skill) incomingById[id]!.skill = existing.skill
            session.byId[id] = incomingById[id]!
          }
          const dedupIncoming = incomingOrder.filter((id) => !session.order.includes(id))
          session.order = [...session.order, ...dedupIncoming]
          session.total = meta?.total ?? Math.max(session.total, session.start + session.order.length)
        }

        session.loadingOlder = false
        session.loadingNewer = false
        const evicted = trimWindow(session, direction)
        if (evicted.length > 0) {
          debug("window_trimmed", { sessionId, removed: evicted.length })
        }
        // C-10: clear stale optimistic references if their entries were evicted from the window
        if (evicted.length > 0) {
          const queue = optimisticUserBySession.get(sessionId)
          if (queue) {
            const remaining = queue.filter((oid) => !evicted.includes(oid))
            if (remaining.length === 0) optimisticUserBySession.delete(sessionId)
            else optimisticUserBySession.set(sessionId, remaining)
          }
        }
      }),
    )
  }

  function setLoadingOlder(sessionId: string, loading: boolean) {
    setState(
      produce((s) => {
        ensureSession(s, sessionId)
        s.bySession[sessionId]!.loadingOlder = loading
      }),
    )
  }

  function setLoadingNewer(sessionId: string, loading: boolean) {
    setState(
      produce((s) => {
        ensureSession(s, sessionId)
        s.bySession[sessionId]!.loadingNewer = loading
      }),
    )
  }

  function windowInfo(sessionId: string): {
    start: number
    end: number
    total: number
    hasOlder: boolean
    hasNewer: boolean
    loadingOlder: boolean
    loadingNewer: boolean
  } {
    const session = state.bySession[sessionId]
    if (!session) {
      return {
        start: 0,
        end: 0,
        total: 0,
        hasOlder: false,
        hasNewer: false,
        loadingOlder: false,
        loadingNewer: false,
      }
    }
    const end = session.start + session.order.length
    return {
      start: session.start,
      end,
      total: session.total,
      hasOlder: session.start > 0,
      hasNewer: end < session.total,
      loadingOlder: session.loadingOlder,
      loadingNewer: session.loadingNewer,
    }
  }

  function getParts(sessionId: string, messageId: string): Part[] {
    return state.bySession[sessionId]?.byId[messageId]?.parts ?? []
  }

  function getMessage(sessionId: string, messageId: string): Message | undefined {
    return state.bySession[sessionId]?.byId[messageId]?.message
  }

  function addOptimisticUserMessage(
    sessionId: string,
    content: string,
    model?: { providerID: string; modelID: string },
    skillName?: string,
    fileContext?: string,
  ) {
    const id = `optimistic-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setState(
      produce((s) => {
        ensureSession(s, sessionId)
        const session = s.bySession[sessionId]!
        session.byId[id] = {
          message: {
            id,
            sessionID: sessionId,
            role: "user",
            time: { created: Date.now() },
            model,
          } as Message,
          parts: [
            {
              id: `${id}-part`,
              sessionID: sessionId,
              messageID: id,
              type: "text",
              text: content,
            } as Part,
          ],
          skill: skillName,
          fileContext,
        }
        session.order.push(id)
        session.total = Math.max(session.total + 1, session.start + session.order.length)
      }),
    )
    const queue = optimisticUserBySession.get(sessionId) ?? []
    queue.push(id)
    optimisticUserBySession.set(sessionId, queue)
  }

  function clearOptimisticUserMessage(sessionId: string, realMessageId?: string) {
    const queue = optimisticUserBySession.get(sessionId)
    if (!queue || queue.length === 0) return
    const id = queue.shift()!
    if (queue.length === 0) optimisticUserBySession.delete(sessionId)
    setState(
      produce((s) => {
        const session = s.bySession[sessionId]
        if (!session?.byId[id]) return
        // Transfer skill metadata from optimistic → real message.
        // The real message may not be in byId yet (message.updated fires before the entry is added),
        // so defer via pendingSkillBySession when direct transfer isn't possible.
        const skill = session.byId[id]!.skill
        if (skill && realMessageId) {
          if (session.byId[realMessageId]) {
            session.byId[realMessageId]!.skill = skill
          } else {
            pendingSkillBySession.set(sessionId, skill)
          }
        }
        delete session.byId[id]
        session.order = session.order.filter((messageId) => messageId !== id)
        if (session.total > 0) session.total -= 1
      }),
    )
  }

  function handleEvent(event: OpenCodeForwardedEvent) {
    switch (event.type) {
      case "message.updated": {
        const msg = event.properties.info
        const sid = msg.sessionID
        if (msg.role === "user") clearOptimisticUserMessage(sid, msg.id)
        // Check for pending skill (new-session skill invocations where no optimistic message existed)
        let pendingSkill = msg.role === "user" ? pendingSkillBySession.get(sid) : undefined
        if (pendingSkill) pendingSkillBySession.delete(sid)
        // Fallback: if msg has a system field (OpenCode includes it), derive skill name from heading
        if (!pendingSkill && msg.role === "user") {
          const system = (msg as Record<string, unknown>).system as string | undefined
          if (system) {
            const heading = system.match(/^#\s+(.+)/m)
            pendingSkill = heading ? heading[1]!.trim().toLowerCase().replace(/\s+/g, "-") : "skill"
          }
        }
        setState(
          produce((s) => {
            ensureSession(s, sid)
            const session = s.bySession[sid]!
            if (session.byId[msg.id]) {
              session.byId[msg.id]!.message = msg
              // Apply pending skill if not already set (transfer from optimistic may have set it)
              if (pendingSkill && !session.byId[msg.id]!.skill) {
                session.byId[msg.id]!.skill = pendingSkill
              }
            } else {
              const end = session.start + session.order.length
              const atTail = end >= session.total
              if (atTail || session.order.length === 0) {
                session.byId[msg.id] = { message: msg, parts: [], skill: pendingSkill }
                session.order.push(msg.id)
                session.total = Math.max(session.total + 1, session.start + session.order.length)
                const evicted = trimWindow(session, "append")
                if (evicted.length > 0) {
                  const queue = optimisticUserBySession.get(sid)
                  if (queue) {
                    const remaining = queue.filter((oid) => !evicted.includes(oid))
                    if (remaining.length === 0) optimisticUserBySession.delete(sid)
                    else optimisticUserBySession.set(sid, remaining)
                  }
                }
              } else {
                session.total += 1
              }
            }
          }),
        )
        break
      }

      case "message.removed": {
        const { sessionID, messageID } = event.properties
        setState(
          produce((s) => {
            const session = s.bySession[sessionID]
            if (!session) return
            const wasInWindow = Boolean(session.byId[messageID])
            if (wasInWindow) {
              delete session.byId[messageID]
              session.order = session.order.filter((id) => id !== messageID)
            }
            // Only decrement total if the message was actually in the current window;
            // out-of-window deletions (server-side pruning) should not skew the count.
            if (wasInWindow && session.total > 0) session.total -= 1
            const end = session.start + session.order.length
            if (end > session.total) {
              session.start = Math.max(0, session.total - session.order.length)
            }
          }),
        )
        break
      }

      case "message.part.updated": {
        const part = event.properties.part
        const sid = part.sessionID
        setState(
          produce((s) => {
            const session = s.bySession[sid]
            if (!session) return
            const entry = session.byId[part.messageID]
            if (!entry) return
            const idx = entry.parts.findIndex((p) => p.id === part.id)
            if (idx >= 0) {
              entry.parts[idx] = part
            } else if (part.type === "reasoning") {
              // Thinking must appear before text — insert at start of parts
              entry.parts.unshift(part)
            } else {
              entry.parts.push(part)
            }
          }),
        )
        setDeltaVersions((prev) => ({ ...prev, [sid]: (prev[sid] ?? 0) + 1 }))
        break
      }

      case "message.part.delta": {
        const { sessionID, messageID, partID, field, delta } = event.properties
        if (!ALLOWED_DELTA_FIELDS.has(field)) return
        setState(
          produce((s) => {
            const session = s.bySession[sessionID]
            if (!session) return
            const entry = session.byId[messageID]
            if (!entry) return
            const part = entry.parts.find((p) => p.id === partID)
            if (!part) return
            if (!(field in part)) return
            const existing = (part as Record<string, unknown>)[field]
            if (typeof existing !== "string") return
            ;(part as Record<string, string>)[field] = existing + delta
          }),
        )
        setDeltaVersions((prev) => ({ ...prev, [sessionID]: (prev[sessionID] ?? 0) + 1 }))
        break
      }

      case "message.part.removed": {
        const { sessionID, messageID, partID } = event.properties
        setState(
          produce((s) => {
            const session = s.bySession[sessionID]
            if (!session) return
            const entry = session.byId[messageID]
            if (!entry) return
            entry.parts = entry.parts.filter((p) => p.id !== partID)
          }),
        )
        break
      }

      case "session.interrupted": {
        const sid = event.properties.sessionID as string
        if (!sid) break
        setState(
          produce((s) => {
            const session = s.bySession[sid]
            if (!session) return
            // Find the last assistant message, mark it interrupted and stop running tools
            for (let i = session.order.length - 1; i >= 0; i--) {
              const entry = session.byId[session.order[i]!]
              if (!entry || entry.message.role !== "assistant") continue
              // Set error on the message so isInterruptedMessage returns true
              ;(entry.message as any).error = { name: "MessageAbortedError", message: "Interrupted" }
              for (const part of entry.parts) {
                if (part.type === "tool" && (part as any).state?.status === "running") {
                  const toolPart = part as any
                  const time = toolPart.state.time ?? { start: Date.now() }
                  toolPart.state = {
                    ...toolPart.state,
                    status: "error",
                    error: "Interrupted",
                    time: { ...time, end: Date.now() },
                  }
                }
              }
              break // Only process the last assistant message
            }
          }),
        )
        break
      }
    }
  }

  function setPendingSkill(sessionId: string, skillName: string) {
    pendingSkillBySession.set(sessionId, skillName)
    // Retroactively attach to the first user message if the session already has messages
    // (handles race: REST getMessages may have loaded before this SSE event arrived)
    const session = state.bySession[sessionId]
    if (session) {
      setState(
        produce((s) => {
          const sess = s.bySession[sessionId]
          if (!sess) return
          for (const id of sess.order) {
            const entry = sess.byId[id]
            if (entry?.message.role === "user" && !entry.skill) {
              entry.skill = skillName
              pendingSkillBySession.delete(sessionId)
              break
            }
          }
        }),
      )
    }
  }

  return {
    messages,
    tokenUsage,
    deltaVersion(sessionId?: string): number {
      const versions = deltaVersions()
      if (sessionId) return versions[sessionId] ?? 0
      // Fallback: sum all (backward compat if called without sessionId)
      let total = 0
      for (const k in versions) total += versions[k]!
      return total
    },
    applyMessagePage,
    setLoadingOlder,
    setLoadingNewer,
    windowInfo,
    getParts,
    getMessage,
    getSkill(sessionId: string, messageId: string): string | undefined {
      return state.bySession[sessionId]?.byId[messageId]?.skill
    },
    getFileContext(sessionId: string, messageId: string): string | undefined {
      return state.bySession[sessionId]?.byId[messageId]?.fileContext
    },
    addOptimisticUserMessage,
    clearOptimisticUserMessage,
    setPendingSkill,
    handleEvent,
  }
}

export type MessageStore = ReturnType<typeof createMessageStore>
