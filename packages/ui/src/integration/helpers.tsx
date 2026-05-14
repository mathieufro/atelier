/**
 * E2E test helpers — simulate the host<->webview postMessage protocol.
 *
 * renderApp() mounts the full App component with a mock postMessage,
 * then provides helpers to inject HostMessages and read outgoing
 * WebviewMessages. Bridges the gap between extension host and UI.
 */
import { render } from "@solidjs/testing-library"
import { App } from "../App.jsx"
import type { HostMessage, WebviewMessage, Session, Message, Part, Event, Model, UnifiedEvent, FavoriteRecord, MessageWithParts } from "@atelier/core"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface AppHarness {
  container: HTMLElement
  /** All WebviewMessages the App has sent via postMessage */
  sent: WebviewMessage[]
  /** Simulate a HostMessage arriving via window.postMessage */
  receive(msg: HostMessage | Record<string, unknown>): void
  /** Shorthand: send "ready" and inject sessions/config responses */
  boot(options?: BootOptions): void
  /** Open the session dropdown */
  openDropdown(): void
  /** Select a session in the dropdown by clicking its title text */
  selectSession(title: string): void
  /** Wait for pending microtasks + rAF callbacks to settle */
  flush(): Promise<void>
  unmount: () => void
}

export interface BootOptions {
  sessions?: Session[]
  agents?: Array<{ name: string; config: Record<string, unknown> }>
  models?: Model[]
  favorites?: FavoriteRecord[]
  statuses?: Record<string, unknown>
}

/** Create a minimal Model object for testing */
export function makeModel(overrides: Partial<Model> & { id: string; providerID: string }): Model {
  return {
    name: overrides.name ?? overrides.id,
    ...overrides,
  } as Model
}

export function renderApp(initial?: { activeSessionId?: string; activePipelineId?: string }): AppHarness {
  const sent: WebviewMessage[] = []
  const postMessage = (msg: WebviewMessage) => sent.push(msg)

  const result = render(() => (
    <App
      postMessage={postMessage}
      initialActiveSessionId={initial?.activeSessionId}
      initialActivePipelineId={initial?.activePipelineId}
    />
  ))

  function receive(msg: HostMessage | Record<string, unknown>) {
    window.dispatchEvent(new MessageEvent("message", { data: msg }))
  }

  function boot(options: BootOptions = {}) {
    const {
      sessions = [],
      agents = [],
      models = [makeModel({ id: "default", providerID: "test" })],
      favorites = [],
      statuses = {},
    } = options
    receive({ type: "sessions", sessions })
    receive({ type: "config", agents, models, favorites, workspacePath: "" })
    // Auto-select first session (mimics host behavior)
    if (sessions.length > 0) {
      receive({ type: "activeSession", sessionId: sessions[0]!.id })
    }
    for (const sessionID of Object.keys(statuses)) {
      receive(sessionStatusEvent(sessionID, statuses[sessionID]!))
    }
  }

  function openDropdown() {
    const dropdownBtn = result.container.querySelector("button.truncate") as HTMLButtonElement
    dropdownBtn?.click()
  }

  function selectSession(title: string) {
    openDropdown()
    const spans = result.container.querySelectorAll("span.truncate")
    for (const span of spans) {
      if (span.textContent?.includes(title)) {
        const row = span.closest("div.cursor-pointer")
        if (row) {
          ;(row as HTMLElement).click()
          return
        }
      }
    }
  }

  async function flush() {
    // Multiple cycles: microtasks -> rAF callbacks -> SolidJS effects
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0))
      if (typeof requestAnimationFrame !== "undefined") {
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
      }
    }
    await new Promise((r) => setTimeout(r, 0))
  }

  return {
    container: result.container,
    sent,
    receive,
    boot,
    openDropdown,
    selectSession,
    flush,
    unmount: result.unmount,
  }
}

// ---------------------------------------------------------------------------
// DOM query helpers
// ---------------------------------------------------------------------------

/** Find a button by its visible text content or aria-label */
export function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (btn) => btn.textContent?.trim() === text || btn.getAttribute("aria-label") === text,
  ) as HTMLButtonElement | undefined
}

/** Find the delete (x) button for a session by title. Opens the dropdown first. */
export function findDeleteButton(container: HTMLElement, sessionTitle: string): HTMLButtonElement | undefined {
  const dropdownBtn = container.querySelector("button.truncate") as HTMLButtonElement
  dropdownBtn?.click()
  const spans = container.querySelectorAll("span.truncate")
  for (const span of spans) {
    if (span.textContent?.includes(sessionTitle)) {
      const row = span.closest("div.cursor-pointer")
      if (row) return row.querySelector("button") as HTMLButtonElement | undefined
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Factory helpers — create realistic SDK-shaped objects
// ---------------------------------------------------------------------------

let idCounter = 0
function nextId(prefix = "id") {
  return `${prefix}_${++idCounter}`
}

let seqCounter = 0
function nextSeq() {
  return ++seqCounter
}

export function makeSession(overrides: Partial<Session> = {}): Session {
  const id = overrides.id ?? nextId("sess")
  return {
    id,
    parentID: "",
    title: overrides.title ?? `Session ${id}`,
    time: { created: Date.now(), updated: Date.now() },
    ...overrides,
  } as Session
}

export function makeUserMessage(sessionID: string, overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? nextId("umsg"),
    sessionID,
    role: "user" as const,
    time: { created: Date.now() },
    agent: "coder",
    model: { providerID: "anthropic", modelID: "claude" },
    ...overrides,
  } as Message
}

export function makeAssistantMessage(sessionID: string, overrides: Partial<Message> = {}): Message {
  return {
    id: overrides.id ?? nextId("amsg"),
    sessionID,
    role: "assistant" as const,
    time: { created: Date.now() },
    parentID: "u1",
    modelID: "claude",
    providerID: "anthropic",
    mode: "default",
    agent: "coder",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  } as Message
}

export function makeTextPart(messageID: string, sessionID: string, text = "", overrides: Partial<Part> = {}): Part {
  return {
    id: overrides.id ?? nextId("part"),
    sessionID,
    messageID,
    type: "text" as const,
    text,
    ...overrides,
  } as Part
}

export function makeToolPart(messageID: string, sessionID: string, tool: string, overrides: Record<string, unknown> = {}): Part {
  const now = Date.now()
  return {
    id: overrides.id ?? nextId("part"),
    sessionID,
    messageID,
    type: "tool" as const,
    tool,
    state: {
      status: "completed",
      input: {},
      output: "done",
      time: { start: now - 100, end: now },
    },
    ...overrides,
  } as Part
}

// ---------------------------------------------------------------------------
// Event factory — wrap Event payloads as unified SSE events
// ---------------------------------------------------------------------------

/** Wrap an OpenCode Event as a unified HostMessage */
export function wrapEvent(event: Event): HostMessage {
  return {
    type: "event",
    event: { ...event, seq: nextSeq() } as UnifiedEvent,
  }
}

export function sessionCreatedEvent(session: Session): HostMessage {
  return wrapEvent({ type: "session.created", properties: { info: session } } as Event)
}

export function sessionDeletedEvent(session: Session): HostMessage {
  return wrapEvent({ type: "session.deleted", properties: { info: session } } as Event)
}

export function sessionIdleEvent(sessionID: string): HostMessage {
  return wrapEvent({ type: "session.idle", properties: { sessionID } } as Event)
}

export function sessionStatusEvent(sessionID: string, status: unknown): HostMessage {
  return wrapEvent({ type: "session.status", properties: { sessionID, status } } as Event)
}

export function messageUpdatedEvent(message: Message): HostMessage {
  return wrapEvent({ type: "message.updated", properties: { info: message } } as Event)
}

export function partUpdatedEvent(part: Part): HostMessage {
  return wrapEvent({ type: "message.part.updated", properties: { part } } as Event)
}

export function partDeltaEvent(sessionID: string, messageID: string, partID: string, field: string, delta: string): HostMessage {
  return wrapEvent({
    type: "message.part.delta",
    properties: { sessionID, messageID, partID, field, delta },
  } as Event)
}

export function permissionAskedEvent(id: string, permission = "bash"): HostMessage {
  return wrapEvent({
    type: "permission.asked",
    id: `evt-${id}`,
    properties: { id, sessionID: "s1", permission, patterns: [], metadata: {}, always: [] },
  } as Event)
}

export function permissionRepliedEvent(id: string): HostMessage {
  return wrapEvent({
    type: "permission.replied",
    properties: { sessionID: "s1", requestID: id, reply: "once" },
  } as Event)
}

export function questionAskedEvent(
  id: string,
  question = "Which option?",
  options: Array<{ label: string; description: string }> = [
    { label: "A", description: "Option A" },
    { label: "B", description: "Option B" },
  ],
): HostMessage {
  return wrapEvent({
    type: "question.asked",
    properties: {
      id,
      sessionID: "s1",
      questions: [{ question, header: "Choice", options }],
    },
  } as Event)
}

export function questionRepliedEvent(id: string): HostMessage {
  return wrapEvent({
    type: "question.replied",
    properties: {
      sessionID: "s1",
      requestID: id,
      answers: [["A"]],
    },
  } as Event)
}

// ---------------------------------------------------------------------------
// Pipeline event factories
// ---------------------------------------------------------------------------

export function stageStartedEvent(pipelineId: string, stageId: string, stage: string, sessionId?: string): HostMessage {
  return {
    type: "event",
    event: { type: "stage_started", pipelineId, stageId, stage, sessionId, seq: nextSeq() } as UnifiedEvent,
  }
}

export function stageCompletedEvent(pipelineId: string, stageId: string, outputPath?: string): HostMessage {
  return {
    type: "event",
    event: { type: "stage_completed", pipelineId, stageId, outputPath, seq: nextSeq() } as UnifiedEvent,
  }
}

export function stageInterruptedEvent(pipelineId: string, stageId: string, sessionId: string): HostMessage {
  return {
    type: "event",
    event: { type: "stage_interrupted", pipelineId, stageId, sessionId, seq: nextSeq() } as UnifiedEvent,
  }
}

export function stageResumedEvent(pipelineId: string, stageId: string, sessionId: string): HostMessage {
  return {
    type: "event",
    event: { type: "stage_resumed", pipelineId, stageId, sessionId, seq: nextSeq() } as UnifiedEvent,
  }
}

export function pipelineCompletedEvent(pipelineId: string): HostMessage {
  return {
    type: "event",
    event: { type: "pipeline_completed", pipelineId, seq: nextSeq() } as UnifiedEvent,
  }
}

export function connectionLostEvent(): HostMessage {
  return {
    type: "event",
    event: { type: "connection_lost", seq: nextSeq() } as UnifiedEvent,
  }
}

export function connectionRestoredEvent(): HostMessage {
  return {
    type: "event",
    event: { type: "connection_restored", seq: nextSeq() } as UnifiedEvent,
  }
}

export function fullRefreshRequiredEvent(): HostMessage {
  return {
    type: "event",
    event: { type: "full_refresh_required", seq: nextSeq() } as UnifiedEvent,
  }
}

/** Build a "messages" HostMessage with required pagination fields filled in. */
export function makeMessagesMsg(sessionId: string, messages: MessageWithParts[]): HostMessage {
  return {
    type: "messages",
    messages,
    sessionId,
    start: 0,
    end: messages.length,
    total: messages.length,
    direction: "replace" as const,
  }
}
