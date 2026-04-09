/**
 * E2E: Permission & question flows, plus error handling through the App.
 *
 * Exercises: permission.asked event -> banner renders -> user clicks ->
 * postMessage sent -> permission.replied -> banner clears.
 * Same for question flows. Also tests error event handling.
 */
import { describe, it, expect, afterEach } from "vitest"
import {
  renderApp,
  makeSession,
  findButton,
  permissionAskedEvent,
  permissionRepliedEvent,
  questionAskedEvent,
  questionRepliedEvent,
  type AppHarness,
} from "./helpers.jsx"

describe("E2E: Permission flow", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("shows permission banner on permission.asked, clears on reply", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1" })] })
    await app.flush()

    app.receive(permissionAskedEvent("perm1", "bash"))
    await app.flush()

    expect(app.container.textContent).toContain("bash")

    const allowBtn = findButton(app.container, "Allow")
    expect(allowBtn).toBeDefined()
    allowBtn?.click()
    await app.flush()

    const reply = app.sent.find((m) => m.type === "permissionReply")
    expect(reply).toBeDefined()
    if (reply && reply.type === "permissionReply") {
      expect(reply.sessionId).toBe("s1")
      expect(reply.requestId).toBe("perm1")
      expect(reply.reply).toBe("once")
    }

    app.receive(permissionRepliedEvent("perm1"))
    await app.flush()

    const allowBtnAfter = findButton(app.container, "Allow")
    expect(allowBtnAfter).toBeUndefined()
  })

  it("sends reject when Deny is clicked", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1" })] })
    await app.flush()

    app.receive(permissionAskedEvent("perm2"))
    await app.flush()

    findButton(app.container, "Deny")?.click()
    await app.flush()

    const reply = app.sent.find(
      (m) => m.type === "permissionReply" && m.reply === "reject",
    )
    expect(reply).toBeDefined()
  })

  it("sends always reply when Always is clicked", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1" })] })
    await app.flush()

    app.receive(permissionAskedEvent("perm3"))
    await app.flush()

    findButton(app.container, "Always")?.click()
    await app.flush()

    const reply = app.sent.find(
      (m) => m.type === "permissionReply" && m.reply === "always",
    )
    expect(reply).toBeDefined()
  })
})

describe("E2E: Question flow", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("shows question banner on question.asked, clears on reply", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1" })] })
    await app.flush()

    app.receive(questionAskedEvent("q1", "Which framework?", [
      { label: "React", description: "React framework" },
      { label: "Solid", description: "SolidJS framework" },
    ]))
    await app.flush()

    expect(app.container.textContent).toContain("Which framework?")

    const reactBtn = Array.from(app.container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === "React",
    )
    reactBtn?.click()
    await app.flush()

    findButton(app.container, "Submit")?.click()
    await app.flush()

    const reply = app.sent.find((m) => m.type === "questionReply")
    expect(reply).toBeDefined()
    if (reply && reply.type === "questionReply") {
      expect(reply.sessionId).toBe("s1")
      expect(reply.requestId).toBe("q1")
    }

    // After submit, the question banner should be replaced by an answered card
    // The pending banner disappears but the answered card remains
    const submitBtnAfter = findButton(app.container, "Submit")
    expect(submitBtnAfter).toBeUndefined()

    // The answered card shows the question text with the selected answer
    expect(app.container.textContent).toContain("Which framework?")
    expect(app.container.textContent).toContain("React")
  })

  it("sends questionReject when dismissed", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1" })] })
    await app.flush()

    app.receive(questionAskedEvent("q2", "Pick one"))
    await app.flush()

    findButton(app.container, "Dismiss")?.click()
    await app.flush()

    const reject = app.sent.find((m) => m.type === "questionReject")
    expect(reject).toBeDefined()
    if (reject && reject.type === "questionReject") {
      expect(reject.sessionId).toBe("s1")
      expect(reject.requestId).toBe("q2")
    }

    // After dismiss, an answered card should show "Dismissed"
    expect(app.container.textContent).toContain("Dismissed")
  })
})

describe("E2E: Error handling", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("shows green dot when connected", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1" })] })
    await app.flush()

    // Connection indicator dot should be green (bg-vsc-success)
    const dot = app.container.querySelector(".bg-vsc-success")
    expect(dot).not.toBeNull()
  })

  it("shows error dot on CONNECTION_LOST error", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1" })] })
    await app.flush()

    app.receive({ type: "error", code: "CONNECTION_LOST", message: "Server went away" })
    await app.flush()

    const errorDot = app.container.querySelector(".bg-vsc-error")
    expect(errorDot).not.toBeNull()
  })

  it("shows warning dot on reconnecting state", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1" })] })
    await app.flush()

    app.receive({ type: "connectionState", state: "reconnecting" })
    await app.flush()

    const warningDot = app.container.querySelector(".bg-vsc-warning")
    expect(warningDot).not.toBeNull()
  })

  it("returns to green dot on reconnected", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1" })] })
    await app.flush()

    // Go to reconnecting
    app.receive({ type: "connectionState", state: "reconnecting" })
    await app.flush()
    expect(app.container.querySelector(".bg-vsc-warning")).not.toBeNull()

    // Come back to connected
    app.receive({ type: "connectionState", state: "connected" })
    await app.flush()
    expect(app.container.querySelector(".bg-vsc-success")).not.toBeNull()
  })
})
