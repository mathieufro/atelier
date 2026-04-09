/**
 * E2E: Full conversation flow through the App component.
 *
 * Exercises the complete pipeline:
 *   host sends sessions -> App renders -> user types -> App posts sendMessage ->
 *   host streams events (message.updated, part.updated, part.delta) ->
 *   stores update -> components re-render with streamed content
 */
import { describe, it, expect, afterEach } from "vitest"
import {
  renderApp,
  makeSession,
  makeUserMessage,
  makeAssistantMessage,
  makeTextPart,
  makeToolPart,
  findButton,
  messageUpdatedEvent,
  partUpdatedEvent,
  partDeltaEvent,
  sessionIdleEvent,
  sessionStatusEvent,
  type AppHarness,
} from "./helpers.jsx"

/** Select a session and respond with empty messages (as the host would) */
async function activateSession(app: AppHarness, title: string) {
  app.selectSession(title)
  await app.flush()
  app.receive({ type: "messages", messages: [] })
  await app.flush()
}

describe("E2E: Conversation flow", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("boots from loading -> ready after receiving sessions", async () => {
    app = renderApp()
    expect(app.container.textContent).toContain("Connecting...")

    app.boot({ sessions: [makeSession({ id: "s1", title: "First chat" })] })
    await app.flush()

    expect(app.container.textContent).not.toContain("Connecting...")
    expect(app.container.textContent).toContain("First chat")
  })

  it("sends ready message on mount", async () => {
    app = renderApp()
    await app.flush()
    expect(app.sent).toContainEqual({ type: "ready" })
  })

  it("sends a message and receives streaming response", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "My Chat" })] })
    await app.flush()

    await activateSession(app, "My Chat")

    // Type and send a message
    const textarea = app.container.querySelector("textarea")!
    textarea.value = "Hello AI"
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    await app.flush()

    const sendBtn = findButton(app.container, "Send")
    sendBtn?.click()
    await app.flush()

    const sendMsg = app.sent.find((m) => m.type === "sendMessage")
    expect(sendMsg).toBeDefined()

    // Simulate host streaming a response
    app.receive(sessionStatusEvent(sid, { type: "busy" }))
    await app.flush()

    const userMsg = makeUserMessage(sid, { id: "u1" })
    app.receive(messageUpdatedEvent(userMsg))
    await app.flush()

    const assistantMsg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(assistantMsg))
    const textPart = makeTextPart("a1", sid, "Hello there", { id: "tp1" })
    app.receive(partUpdatedEvent(textPart))
    await app.flush()

    // Streaming deltas
    app.receive(partDeltaEvent(sid, "a1", "tp1", "text", ", human! How are you?"))
    await app.flush()

    app.receive(sessionIdleEvent(sid))
    await app.flush()

    expect(app.container.textContent).toContain("Hello there, human!")
  })

  it("renders tool call parts during a conversation", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Tools" })] })
    await app.flush()

    await activateSession(app, "Tools")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    const now = Date.now()
    const toolPart = makeToolPart("a1", sid, "bash", {
      id: "tp1",
      state: {
        status: "completed",
        input: { command: "ls -la" },
        output: "file1.txt\nfile2.txt",
        time: { start: now - 100, end: now },
      },
    })
    app.receive(partUpdatedEvent(toolPart))
    await app.flush()

    expect(app.container.textContent).toContain("Bash")
  })

  it("renders clickable file links from assistant text references", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Links" })] })
    await app.flush()

    await activateSession(app, "Links")

    app.receive(messageUpdatedEvent(makeAssistantMessage(sid, { id: "a1" })))
    app.receive(partUpdatedEvent(makeTextPart("a1", sid, "Check packages/ui/src/components/ChatView.tsx:169 for details")))
    await app.flush()

    const link = app.container.querySelector("a[data-file-path='packages/ui/src/components/ChatView.tsx']") as HTMLAnchorElement
    expect(link).toBeDefined()
    expect(link.href).toContain("command:atelier.openFile")
  })

  it("shows Stop button when session is busy", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Busy" })] })
    await app.flush()

    await activateSession(app, "Busy")

    app.receive(sessionStatusEvent(sid, { type: "busy" }))
    await app.flush()

    const stopBtn = findButton(app.container, "Stop")
    expect(stopBtn).toBeDefined()

    stopBtn?.click()
    await app.flush()

    const abortMsg = app.sent.find((m) => m.type === "abortSession")
    expect(abortMsg).toBeDefined()
    expect(findButton(app.container, "Stop")).toBeDefined()
  })

  it("sends message immediately even while session is busy", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Queue" })] })
    await app.flush()

    await activateSession(app, "Queue")

    app.receive(sessionStatusEvent(sid, { type: "busy" }))
    await app.flush()

    const textarea = app.container.querySelector("textarea")!
    textarea.value = "send while busy"
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    await app.flush()

    findButton(app.container, "Send")?.click()
    await app.flush()

    expect(app.sent.some((m) => m.type === "sendMessage" && (m as any).content === "send while busy")).toBe(true)
  })

  it("displays token usage from step-finish parts in status bar", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({
      sessions: [makeSession({ id: sid, title: "Tokens" })],
      statuses: { s1: { type: "idle" } },
    })
    await app.flush()

    await activateSession(app, "Tokens")

    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(
      partUpdatedEvent({
        id: "sf1",
        sessionID: sid,
        messageID: "a1",
        type: "step-finish" as any,
        tokens: { input: 500, output: 200, reasoning: 0, cache: { read: 100, write: 0 } },
        cost: 0.01,
        finish: "stop",
      } as any),
    )
    await app.flush()

    expect(app.container.textContent).toMatch(/500/)
    expect(app.container.textContent).toMatch(/200/)
  })

  it("shows interrupted marker and stops thinking animation for aborted replies", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "Interrupted" })] })
    await app.flush()

    await activateSession(app, "Interrupted")

    app.receive(sessionStatusEvent(sid, { type: "busy" }))
    app.receive(messageUpdatedEvent(makeAssistantMessage(sid, {
      id: "a1",
      error: { name: "MessageAbortedError", data: { message: "aborted" } },
      time: { created: Date.now(), completed: Date.now() },
    } as any)))
    app.receive(partUpdatedEvent({
      id: "rp1",
      sessionID: sid,
      messageID: "a1",
      type: "reasoning",
      text: "thinking",
      time: { start: Date.now() },
    } as any))
    await app.flush()

    expect(app.container.textContent).toContain("interrupted")
    expect(app.container.querySelectorAll(".dots").length).toBe(0)
  })
})
