import { describe, it, expect, vi } from "vitest"
import { render, fireEvent } from "@solidjs/testing-library"
import { App } from "./App.jsx"

describe("App layout", () => {
  it("renders without crashing", () => {
    const { container } = render(() => <App />)
    expect(container).toBeDefined()
  })

  it("shows loading state initially", () => {
    const { container } = render(() => <App />)
    expect(container.textContent).toContain("Connecting...")
  })

  it("does not render SessionSidebar", () => {
    const { container } = render(() => <App />)
    expect(container.querySelector(".w-64")).toBeNull()
  })
})

describe("App view states", () => {
  function receive(msg: Record<string, unknown>) {
    window.dispatchEvent(new MessageEvent("message", { data: msg }))
  }

  /** Robust flush — matches the 3-cycle approach from integration helpers */
  async function flush() {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0))
      if (typeof requestAnimationFrame !== "undefined") {
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
      }
    }
    await new Promise((r) => setTimeout(r, 0))
  }

  it("shows 'Connecting to backends...' after sessions arrive but before config", async () => {
    const { container } = render(() => <App />)
    receive({ type: "sessions", sessions: [] })
    await flush()
    expect(container.textContent).toContain("Connecting to backends")
    expect(container.textContent).not.toContain("No backend detected")
  })

  it("shows onboarding card when config arrives with empty models", async () => {
    const { container } = render(() => <App />)
    receive({ type: "sessions", sessions: [] })
    receive({ type: "config", models: [], agents: [], workspacePath: "" })
    await flush()
    expect(container.textContent).toContain("No backend detected")
  })

  it("shows chat view when config arrives with models", async () => {
    const { container } = render(() => <App />)
    receive({ type: "sessions", sessions: [] })
    receive({
      type: "config",
      models: [{ id: "claude-3", providerID: "anthropic", name: "Claude 3" }],
      agents: [],
      workspacePath: "",
    })
    await flush()
    // ChatView renders the header bar
    expect(container.querySelector('[data-testid="header-bar"]')).not.toBeNull()
    expect(container.textContent).not.toContain("No backend detected")
  })
})

describe("App header stage button", () => {
  function receive(msg: Record<string, unknown>) {
    window.dispatchEvent(new MessageEvent("message", { data: msg }))
  }

  async function flush() {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0))
      if (typeof requestAnimationFrame !== "undefined") {
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
      }
    }
    await new Promise((r) => setTimeout(r, 0))
  }

  it("header stage button opens dropdown on click", async () => {
    const { getByTestId, getByText, queryByText } = render(() => <App />)

    receive({ type: "sessions", sessions: [] })
    receive({
      type: "config",
      models: [{ id: "claude-sonnet-4", providerID: "anthropic", limit: { context: 200000 } }],
      workspacePath: "/test",
    })

    receive({
      type: "pipeline",
      pipeline: {
        id: "pipe-1",
        prompt: "Test",
        status: "running",
        currentStage: "brainstorm",
        type: "feature",
        stages: [{ id: "s1", stage: "brainstorm", status: "running", sessionId: "sess1" }],
      },
    })
    receive({ type: "modeChanged", mode: "feature" })
    await flush()

    const stageButton = getByTestId("header-stage-button")
    expect(stageButton.textContent).toContain("Brainstorm")
    await fireEvent.click(stageButton)

    // Dropdown opened — should show the Confirm button from StageModelPicker
    expect(getByText("Confirm")).toBeTruthy()
  })
})
