/**
 * E2E: Session management through the App component.
 *
 * Exercises: create session -> auto-select -> switch -> messages load ->
 * delete -> dropdown updates -> active session clears.
 *
 * Updated for the redesigned UI: SessionDropdown (replaces sidebar).
 */
import { describe, it, expect, afterEach } from "vitest"
import {
  renderApp,
  makeSession,
  makeModel,
  makeUserMessage,
  makeAssistantMessage,
  makeTextPart,
  findButton,
  findDeleteButton,
  sessionCreatedEvent,
  sessionDeletedEvent,
  messageUpdatedEvent,
  partUpdatedEvent,
  type AppHarness,
} from "./helpers.jsx"

describe("E2E: Session management", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("new chat enters pending state without eager session creation", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Old chat" })] })
    await app.flush()

    const newBtn = findButton(app.container, "+ New Chat")
    expect(newBtn).toBeDefined()
    newBtn?.click()
    await app.flush()

    // No eager createSession — session is created lazily on first sendMessage
    expect(app.sent.some((m) => m.type === "createSession")).toBe(false)
    // Dropdown shows "New Chat" when no active session
    expect(app.container.textContent).toContain("New Chat")
  })

  it("switches sessions and loads messages", async () => {
    const s1 = makeSession({ id: "s1", title: "Chat A" })
    const s2 = makeSession({ id: "s2", title: "Chat B" })

    app = renderApp()
    app.boot({ sessions: [s1, s2] })
    await app.flush()

    app.selectSession("Chat B")
    await app.flush()

    const switchMsg = app.sent.find((m) => m.type === "switchSession" && m.sessionId === "s2")
    expect(switchMsg).toBeDefined()

    // Simulate host responding with messages for s2
    const userMsg = makeUserMessage("s2", { id: "u1" })
    const assistantMsg = makeAssistantMessage("s2", { id: "a1" })
    app.receive({
      type: "messages",
      messages: [
        { message: userMsg, parts: [makeTextPart("u1", "s2", "Hello from chat B.")] },
        { message: assistantMsg, parts: [makeTextPart("a1", "s2", "Response in chat B.")] },
      ],
    })
    await app.flush()

    expect(app.container.textContent).toContain("Response in chat B")
  })

  it("deletes a session via dropdown delete button", async () => {
    const s1 = makeSession({ id: "s1", title: "Chat A" })
    const s2 = makeSession({ id: "s2", title: "Chat B" })

    app = renderApp()
    app.boot({ sessions: [s1, s2] })
    await app.flush()

    const deleteBtn = findDeleteButton(app.container, "Chat A")
    expect(deleteBtn).toBeDefined()
    deleteBtn?.click()
    await app.flush()

    const deleteMsg = app.sent.find((m) => m.type === "deleteSession")
    expect(deleteMsg).toBeDefined()
    if (deleteMsg && deleteMsg.type === "deleteSession") {
      expect(deleteMsg.sessionId).toBe("s1")
    }

    // Simulate server confirming deletion
    app.receive(sessionDeletedEvent(s1))
    await app.flush()

    expect(app.container.textContent).not.toContain("Chat A")
    expect(app.container.textContent).toContain("Chat B")
  })

  it("clears messages when switching sessions", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: sid, title: "First" }), makeSession({ id: "s2", title: "Second" })] })
    await app.flush()

    // Select s1 and load messages
    app.selectSession("First")
    await app.flush()
    app.receive({ type: "messages", messages: [] })
    await app.flush()

    // Inject messages via event stream
    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(partUpdatedEvent(makeTextPart("a1", sid, "Content from session one.", { id: "tp1" })))
    await app.flush()
    expect(app.container.textContent).toContain("Content from session one")

    // Switch to s2
    app.selectSession("Second")
    await app.flush()

    expect(app.container.textContent).not.toContain("Content from session one")
  })

  it("receives session.created event and adds to dropdown", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Existing" })] })
    await app.flush()

    const newSession = makeSession({ id: "s3", title: "External session" })
    app.receive(sessionCreatedEvent(newSession))
    await app.flush()

    app.openDropdown()
    await app.flush()
    expect(app.container.textContent).toContain("External session")
  })
})

describe("E2E: Model picker — history restore and invariant", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  const modelA = makeModel({ id: "sonnet", providerID: "anthropic", name: "Sonnet" })
  const modelB = makeModel({ id: "opus", providerID: "anthropic", name: "Opus" })

  it("initializes model pill to first model from config", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Chat" })], models: [modelA, modelB] })
    await app.flush()

    // Model pill should show the first model, not be blank
    const pill = app.container.querySelector("[data-testid='model-pill']")
    expect(pill?.textContent).toContain("Sonnet")
  })

  it("restores model from user message when loading history", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Chat" })], models: [modelA, modelB] })
    await app.flush()

    app.selectSession("Chat")
    await app.flush()

    // History contains a user message that used Opus
    const userMsg = makeUserMessage("s1", {
      model: { providerID: "anthropic", modelID: "opus" },
    })
    app.receive({ type: "messages", messages: [{ message: userMsg, parts: [] }] })
    await app.flush()

    const pill = app.container.querySelector("[data-testid='model-pill']")
    expect(pill?.textContent).toContain("Opus")
  })

  it("restores model from assistant message using providerID", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Chat" })], models: [modelA, modelB] })
    await app.flush()

    app.selectSession("Chat")
    await app.flush()

    // Last message in history is an assistant message that used Opus
    const assistantMsg = makeAssistantMessage("s1", { modelID: "opus", providerID: "anthropic" })
    app.receive({ type: "messages", messages: [{ message: assistantMsg, parts: [] }] })
    await app.flush()

    const pill = app.container.querySelector("[data-testid='model-pill']")
    expect(pill?.textContent).toContain("Opus")
  })

  it("displayed model always matches the model sent to backend", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Chat" })], models: [modelA, modelB] })
    await app.flush()

    // Activate session and load history with Opus as the last used model
    app.selectSession("Chat")
    await app.flush()
    const assistantMsg = makeAssistantMessage("s1", { modelID: "opus", providerID: "anthropic" })
    app.receive({ type: "messages", messages: [{ message: assistantMsg, parts: [] }] })
    await app.flush()

    // Verify pill shows Opus
    const pill = app.container.querySelector("[data-testid='model-pill']")
    expect(pill?.textContent).toContain("Opus")

    // Send a message — the sendMessage params must include Opus
    const textarea = app.container.querySelector("textarea")!
    textarea.value = "Hello"
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    await app.flush()

    findButton(app.container, "Send")?.click()
    await app.flush()

    const sendMsg = app.sent.find((m) => m.type === "sendMessage") as any
    expect(sendMsg).toBeDefined()
    expect(sendMsg?.model?.providerID).toBe("anthropic")
    expect(sendMsg?.model?.modelID).toBe("opus")
  })

  it("changing model on a historical chat updates the sent model", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Chat" })], models: [modelA, modelB] })
    await app.flush()

    app.selectSession("Chat")
    await app.flush()

    // History has Sonnet as the last model
    const userMsg = makeUserMessage("s1", {
      model: { providerID: "anthropic", modelID: "sonnet" },
    })
    app.receive({ type: "messages", messages: [{ message: userMsg, parts: [] }] })
    await app.flush()

    // User opens picker by clicking the trigger button, then switches to Opus
    const pill = app.container.querySelector("[data-testid='model-pill']") as HTMLElement
    const pillTrigger = pill?.querySelector("button") as HTMLButtonElement
    pillTrigger?.click()
    await app.flush()

    // Dropdown is now open — find and click the Opus option
    const opusBtn = Array.from(app.container.querySelectorAll("[data-testid='model-pill'] button"))
      .find((b) => b.textContent?.includes("Opus")) as HTMLButtonElement
    opusBtn?.click()
    await app.flush()

    // Pill should now show Opus
    expect(pill.textContent).toContain("Opus")

    // Send a message — params must use Opus, and a fork is needed since model changed
    const textarea = app.container.querySelector("textarea")!
    textarea.value = "Continue"
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    await app.flush()

    findButton(app.container, "Send")?.click()
    await app.flush()

    const sendMsg = app.sent.find((m) => m.type === "sendMessage") as any
    expect(sendMsg?.model?.modelID).toBe("opus")
  })

  it("ignores subagent assistant messages when syncing model and variant", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Chat" })], models: [modelA, modelB] })
    await app.flush()

    app.selectSession("Chat")
    await app.flush()

    const userMsg = makeUserMessage("s1", {
      id: "u1",
      model: { providerID: "anthropic", modelID: "sonnet" },
      variant: "high",
    })
    const rootAssistant = makeAssistantMessage("s1", {
      id: "a1",
      parentID: "u1",
      modelID: "sonnet",
      providerID: "anthropic",
      variant: "high",
      finish: "stop",
    })
    app.receive({ type: "messages", messages: [{ message: userMsg, parts: [] }, { message: rootAssistant, parts: [] }] })
    await app.flush()

    app.receive(messageUpdatedEvent(makeAssistantMessage("s1", {
      id: "a2",
      parentID: "a1",
      modelID: "opus",
      providerID: "anthropic",
      finish: "stop",
      agent: "general",
    })))
    await app.flush()

    const textarea = app.container.querySelector("textarea")!
    textarea.value = "Continue"
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    await app.flush()

    findButton(app.container, "Send")?.click()
    await app.flush()

    const sendMsg = [...app.sent].reverse().find((m) => m.type === "sendMessage") as any
    expect(sendMsg?.model?.modelID).toBe("sonnet")
    expect(sendMsg?.variant).toBe("high")
  })
})

describe("E2E: Favorites behavior", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("+ New Chat applies top valid favorite and sends model on first message", async () => {
    app = renderApp()
    app.boot({
      sessions: [makeSession({ id: "s1", title: "Chat" })],
      models: [makeModel({ id: "sonnet", providerID: "anthropic", variants: { thinking: {} } as any })],
      favorites: [{ favoriteKey: "anthropic::sonnet::thinking", providerID: "anthropic", modelID: "sonnet", variant: "thinking" }],
    } as any)
    await app.flush()
    findButton(app.container, "+ New Chat")?.click()
    await app.flush()

    // No eager createSession — session created lazily with correct model
    expect(app.sent.some((m) => m.type === "createSession")).toBe(false)

    const textarea = app.container.querySelector("textarea")!
    textarea.value = "hello"
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    await app.flush()
    findButton(app.container, "Send")?.click()
    await app.flush()
    const send = [...app.sent].reverse().find((m) => m.type === "sendMessage") as any
    expect(send.model).toEqual({ providerID: "anthropic", modelID: "sonnet" })
    expect(send.variant).toBe("thinking")
  })

  it("stale top favorite is skipped and next valid favorite is selected", async () => {
    app = renderApp()
    app.boot({
      sessions: [makeSession({ id: "s1", title: "Chat" })],
      models: [makeModel({ id: "sonnet", providerID: "anthropic", variants: { thinking: {} } as any })],
      favorites: [
        { favoriteKey: "x::missing::__none__", providerID: "x", modelID: "missing" },
        { favoriteKey: "anthropic::sonnet::thinking", providerID: "anthropic", modelID: "sonnet", variant: "thinking" },
      ],
    } as any)
    await app.flush()
    findButton(app.container, "+ New Chat")?.click()
    await app.flush()

    const textarea = app.container.querySelector("textarea")!
    textarea.value = "hello"
    textarea.dispatchEvent(new Event("input", { bubbles: true }))
    await app.flush()
    findButton(app.container, "Send")?.click()
    await app.flush()
    const send = [...app.sent].reverse().find((m) => m.type === "sendMessage") as any
    expect(send.model).toEqual({ providerID: "anthropic", modelID: "sonnet" })
    expect(send.variant).toBe("thinking")
  })

  it("command-triggered upsert with no models shows onboarding card", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Chat" })], models: [] } as any)
    await app.flush()
    // OnboardingCard gates ChatView — favorites command has no effect
    expect(app.container.textContent).toContain("No backend detected")
    expect(app.sent.some((m) => m.type === "favorites.upsert")).toBe(false)
  })

  it("App -> ChatView -> InputBar -> ModelPill wiring emits favorites.upsert", async () => {
    app = renderApp()
    app.boot({
      sessions: [makeSession({ id: "s1", title: "Chat" })],
      models: [makeModel({ id: "sonnet", providerID: "anthropic" })],
    } as any)
    await app.flush()
    const trigger = app.container.querySelector("[data-testid='model-pill'] > button") as HTMLButtonElement
    trigger.click()
    await app.flush()
    const star = app.container.querySelector("button[aria-label='Favorite model/variant']") as HTMLButtonElement
    star.click()
    await app.flush()
    expect(app.sent).toContainEqual({
      type: "favorites.upsert",
      favorite: { providerID: "anthropic", modelID: "sonnet", variant: undefined },
    })
  })
})
