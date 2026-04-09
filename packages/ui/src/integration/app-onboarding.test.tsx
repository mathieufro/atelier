import { describe, it, expect, afterEach } from "vitest"
import { renderApp, makeModel, makeSession, type AppHarness } from "./helpers.jsx"

describe("E2E: Onboarding flow", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("shows onboarding when booted with no models, then transitions on config refresh", async () => {
    app = renderApp()
    // Boot with sessions but no models
    app.receive({ type: "sessions", sessions: [makeSession({ id: "s1" })] })
    app.receive({ type: "config", agents: [], models: [], workspacePath: "" })
    await app.flush()

    // Onboarding card is visible
    expect(app.container.textContent).toContain("No backend detected")
    expect(app.container.textContent).toContain("Claude Code")
    expect(app.container.textContent).toContain("OpenCode")

    // Header bar is NOT visible during onboarding
    expect(app.container.querySelector('[data-testid="header-bar"]')).toBeNull()

    // Click "Check again"
    const checkBtn = Array.from(app.container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Check again"
    )
    expect(checkBtn).toBeDefined()
    checkBtn!.click()
    await app.flush()

    // Should have sent refreshConfig
    expect(app.sent.some((m) => m.type === "refreshConfig")).toBe(true)

    // Simulate config arriving with models
    app.receive({
      type: "config",
      agents: [],
      models: [makeModel({ id: "claude-3", providerID: "anthropic", name: "Claude 3" })],
      workspacePath: "",
    })
    await app.flush()

    // Onboarding is gone, header bar is visible
    expect(app.container.textContent).not.toContain("No backend detected")
    expect(app.container.querySelector('[data-testid="header-bar"]')).not.toBeNull()
  })

  it("shows connecting-to-backends before config arrives", async () => {
    app = renderApp()
    // Only send sessions, no config
    app.receive({ type: "sessions", sessions: [] })
    await app.flush()

    expect(app.container.textContent).toContain("Connecting to backends")
    expect(app.container.textContent).not.toContain("No backend detected")
    expect(app.container.querySelector('[data-testid="header-bar"]')).toBeNull()
  })

  it("auto-transitions when config.updated SSE event triggers refresh", async () => {
    app = renderApp()
    app.receive({ type: "sessions", sessions: [makeSession({ id: "s1" })] })
    app.receive({ type: "config", agents: [], models: [], workspacePath: "" })
    await app.flush()

    expect(app.container.textContent).toContain("No backend detected")

    // Simulate config.updated SSE event (backend came online)
    app.receive({
      type: "event",
      event: { type: "config.updated", seq: 1 },
    })
    await app.flush()

    // App should have requested refreshConfig
    expect(app.sent.some((m) => m.type === "refreshConfig")).toBe(true)

    // Simulate the refreshed config with models
    app.receive({
      type: "config",
      agents: [],
      models: [makeModel({ id: "gpt-4o", providerID: "openai", name: "GPT-4o" })],
      workspacePath: "",
    })
    await app.flush()

    // Transitioned to chat
    expect(app.container.textContent).not.toContain("No backend detected")
    expect(app.container.querySelector('[data-testid="header-bar"]')).not.toBeNull()
  })

  it("skips onboarding entirely when models arrive with initial config", async () => {
    app = renderApp()
    app.boot({
      sessions: [makeSession({ id: "s1" })],
      models: [makeModel({ id: "claude-3", providerID: "anthropic" })],
    })
    await app.flush()

    // Straight to chat, no onboarding
    expect(app.container.textContent).not.toContain("No backend detected")
    expect(app.container.textContent).not.toContain("Connecting to backends")
    expect(app.container.querySelector('[data-testid="header-bar"]')).not.toBeNull()
  })

  it("shows 'Connecting...' when config arrives before sessions", async () => {
    app = renderApp()
    // Config arrives first (no sessions yet, ready=false)
    app.receive({ type: "config", agents: [], models: [makeModel({ id: "m1", providerID: "test" })], workspacePath: "" })
    await app.flush()
    expect(app.container.textContent).toContain("Connecting...")
    expect(app.container.textContent).not.toContain("Connecting to backends")
    expect(app.container.textContent).not.toContain("No backend detected")

    // Sessions arrive → straight to chat (config already loaded with models)
    app.receive({ type: "sessions", sessions: [makeSession({ id: "s1" })] })
    await app.flush()
    expect(app.container.querySelector('[data-testid="header-bar"]')).not.toBeNull()
  })
})
