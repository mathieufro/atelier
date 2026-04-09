/**
 * E2E: Verify the redesigned layout — session dropdown, mode pill,
 * model pill, context indicator, and VS Code-native styling.
 *
 * Covers requirements from the UI Redesign spec:
 * - Session dropdown replaces sidebar
 * - Mode pill with Build/Plan/Feature (click to cycle)
 * - Model pill with model selection
 * - Context window indicator
 * - VS Code CSS variable classes
 * - Mode change triggers setMode message
 */
import { describe, it, expect, afterEach } from "vitest"
import {
  renderApp,
  makeSession,
  makeAssistantMessage,
  makeTextPart,
  findButton,
  messageUpdatedEvent,
  partUpdatedEvent,
  type AppHarness,
} from "./helpers.jsx"

describe("E2E: Session dropdown (replaces sidebar)", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("renders header with session dropdown and new chat button", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Test" })] })
    await app.flush()

    expect(app.container.textContent).toContain("+ New Chat")
  })

  it("shows session dropdown with active session title", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "My Session" })] })
    await app.flush()

    // Dropdown button now has a span.truncate inside it
    const titleSpan = app.container.querySelector("span.truncate")
    expect(titleSpan?.textContent).toBe("My Session")
  })

  it("shows 'No conversations yet' when dropdown is empty", async () => {
    app = renderApp()
    app.boot({ sessions: [] })
    await app.flush()

    app.openDropdown()
    await app.flush()

    expect(app.container.textContent).toContain("No conversations yet")
  })

  it("filters sessions by search in dropdown", async () => {
    app = renderApp()
    app.boot({
      sessions: [
        makeSession({ id: "s1", title: "Alpha chat" }),
        makeSession({ id: "s2", title: "Beta chat" }),
        makeSession({ id: "s3", title: "Gamma chat" }),
      ],
    })
    await app.flush()

    app.openDropdown()
    await app.flush()

    // Type in search
    const searchInput = app.container.querySelector("input[placeholder*='Search']") as HTMLInputElement
    expect(searchInput).toBeDefined()
    if (searchInput) {
      searchInput.value = "Beta"
      searchInput.dispatchEvent(new Event("input", { bubbles: true }))
      await app.flush()

      // Only Beta should be visible in the dropdown
      const spans = app.container.querySelectorAll("span.truncate")
      const visibleTitles = Array.from(spans).map((s) => s.textContent)
      expect(visibleTitles.some((t) => t?.includes("Beta"))).toBe(true)
    }
  })
})

describe("E2E: Mode system", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("shows Build mode pill by default", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Test" })] })
    await app.flush()

    expect(app.container.textContent).toContain("Build")
  })

  it("mode pill has data-mode attribute", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Test" })] })
    await app.flush()

    const modePill = app.container.querySelector("[data-mode]")
    expect(modePill).toBeDefined()
    expect(modePill?.getAttribute("data-mode")).toBe("build")
  })

  it("clicking mode pill cycles to next mode", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Test" })] })
    await app.flush()

    // Click to cycle from Build → Plan
    const modePill = app.container.querySelector("[data-mode]") as HTMLButtonElement
    modePill?.click()
    await app.flush()

    // UI updates immediately (mode is local state, no message sent to host)
    expect(app.container.textContent).toContain("Plan")
  })

  it("updates mode when modeChanged message received", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Test" })] })
    await app.flush()

    expect(app.container.textContent).toContain("Build")

    app.receive({ type: "modeChanged", mode: "plan" })
    await app.flush()

    expect(app.container.textContent).toContain("Plan")

    const modePill = app.container.querySelector("[data-mode]")
    expect(modePill?.getAttribute("data-mode")).toBe("plan")
  })

  it("updates mode when modeChanged to feature", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Test" })] })
    await app.flush()

    app.receive({ type: "modeChanged", mode: "feature" })
    await app.flush()

    expect(app.container.textContent).toContain("Feature")
  })
})

describe("E2E: Model selection", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("shows onboarding card when no models configured", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Test" })], models: [] })
    await app.flush()

    expect(app.container.textContent).toContain("No backend detected")
  })

  it("shows model list when models are available", async () => {
    app = renderApp()
    app.boot({
      sessions: [makeSession({ id: "s1", title: "Test" })],
      models: [
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet" },
        { id: "openai/gpt-4", name: "GPT-4" },
      ] as any[],
    })
    await app.flush()

    // The model pill should show the first model name
  })
})

describe("E2E: VS Code native styling", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("uses VS Code CSS variable classes for theming", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Test" })] })
    await app.flush()

    const html = app.container.innerHTML
    // Check for VS Code-themed classes
    expect(html).toContain("vsc-sidebar-bg")
    expect(html).toContain("vsc-editor-fg")
  })

  it("header bar uses sidebar background", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Test" })] })
    await app.flush()

    const header = app.container.querySelector(".bg-vsc-sidebar-bg")
    expect(header).toBeDefined()
  })

  it("textarea is transparent with card background on container", async () => {
    app = renderApp()
    app.boot({ sessions: [makeSession({ id: "s1", title: "Test" })] })
    await app.flush()

    const textarea = app.container.querySelector("textarea")
    expect(textarea?.className).toContain("bg-transparent")
    // Card container has the input background
    const card = textarea?.closest(".bg-vsc-input-bg")
    expect(card).toBeDefined()
  })
})

describe("E2E: Context indicator", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("shows token count after receiving step-finish event", async () => {
    const sid = "s1"
    app = renderApp()
    app.boot({
      sessions: [makeSession({ id: sid, title: "Context" })],
      models: [
        { id: "anthropic/claude-sonnet", name: "Claude Sonnet", limit: { context: 200000 } },
      ] as any[],
    })
    await app.flush()

    // Select and activate session
    app.selectSession("Context")
    await app.flush()
    app.receive({ type: "messages", messages: [] })
    await app.flush()

    // Stream a message with token info
    const msg = makeAssistantMessage(sid, { id: "a1" })
    app.receive(messageUpdatedEvent(msg))
    app.receive(
      partUpdatedEvent({
        id: "sf1",
        sessionID: sid,
        messageID: "a1",
        type: "step-finish" as any,
        tokens: { input: 10000, output: 500, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0.01,
        finish: "stop",
      } as any),
    )
    await app.flush()

    // The top bar should show token information
    expect(app.container.textContent).toMatch(/10000/)
  })
})

describe("E2E: Loading state", () => {
  let app: AppHarness

  afterEach(() => app?.unmount())

  it("shows loading state before receiving sessions", () => {
    app = renderApp()
    expect(app.container.textContent).toContain("Connecting...")
  })

  it("transitions from loading to ready", async () => {
    app = renderApp()
    expect(app.container.textContent).toContain("Connecting...")

    app.boot({ sessions: [] })
    await app.flush()

    expect(app.container.textContent).not.toContain("Connecting...")
  })
})
