import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { resolvePanelFrom, resolvePanelTitle, deriveIconStateFromEvent, deriveIconStateFromPipeline, resolveIconPath } from "../src/extension.js"

// ---------------------------------------------------------------------------
// Mock vscode — capture command handlers and return controllable panels
// ---------------------------------------------------------------------------

const registeredCommands = new Map<string, Function>()
const mockSubscriptions: any[] = []

let panelIdCounter = 0
function createMockPanel() {
  const id = `panel-${++panelIdCounter}`
  const disposeHandlers: Function[] = []
  const viewStateHandlers: Function[] = []
  const messageHandlers: Function[] = []
  const posted: any[] = []

  const panel = {
    id,
    active: false,
    title: "Atelier",
    webview: {
      html: "",
      postMessage: vi.fn((msg: any) => posted.push(msg)),
      onDidReceiveMessage: vi.fn((handler: Function) => {
        messageHandlers.push(handler)
      }),
      asWebviewUri: (u: any) => u,
      cspSource: "",
    },
    reveal: vi.fn(),
    onDidDispose: vi.fn((handler: Function) => {
      disposeHandlers.push(handler)
    }),
    onDidChangeViewState: vi.fn((handler: Function) => {
      viewStateHandlers.push(handler)
    }),
    dispose: vi.fn(() => {
      for (const h of disposeHandlers) h()
    }),
    _test: { posted },
  }
  return panel
}

vi.mock("vscode", () => ({
  Uri: {
    file: (p: string) => ({ path: p, scheme: "file", fsPath: p }),
    joinPath: (...args: any[]) => ({ path: args.map(String).join("/") }),
    parse: (s: string) => ({ path: s }),
  },
  ProgressLocation: { Notification: 15, SourceControl: 1, Window: 10 },
  env: {
    remoteName: "ssh-remote",
    uiKind: 1,
    clipboard: { writeText: vi.fn() },
  },
  window: {
    showErrorMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showInformationMessage: vi.fn().mockResolvedValue(undefined),
    showTextDocument: vi.fn().mockResolvedValue({ selection: null, revealRange: () => {} }),
    registerWebviewViewProvider: () => ({ dispose: () => {} }),
    registerWebviewPanelSerializer: vi.fn((_viewType: string, _serializer: any) => ({ dispose: () => {} })),
    createWebviewPanel: vi.fn(() => createMockPanel()),
    withProgress: vi.fn((_opts: any, task: any) => task({ report: vi.fn() }, { onCancellationRequested: () => ({ dispose: () => {} }) })),
    activeTextEditor: undefined,
    createOutputChannel: vi.fn(() => ({ appendLine: vi.fn(), show: vi.fn(), dispose: vi.fn() })),
    showQuickPick: vi.fn().mockResolvedValue(undefined),
    onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: () => {} })),
    onDidChangeTextEditorSelection: vi.fn(() => ({ dispose: () => {} })),
    tabGroups: {
      activeTabGroup: { activeTab: undefined },
      onDidChangeTabs: vi.fn(() => ({ dispose: () => {} })),
    },
  },
  workspace: {
    openTextDocument: vi.fn().mockResolvedValue({}),
    getConfiguration: () => ({ get: () => null }),
    findFiles: vi.fn().mockResolvedValue([]),
    workspaceFolders: [{ uri: { fsPath: "/workspace" } }],
    onDidChangeConfiguration: vi.fn(() => ({ dispose: () => {} })),
    asRelativePath: vi.fn((p: string) => p),
  },
  commands: {
    registerCommand: vi.fn((name: string, handler: Function) => {
      registeredCommands.set(name, handler)
      return { dispose: () => registeredCommands.delete(name) }
    }),
    executeCommand: vi.fn(),
  },
  ViewColumn: { One: 1, Two: 2, Three: 3 },
  Position: class { constructor(public line: number, public character: number) {} },
  Selection: class { constructor(public anchor: any, public active: any) {} },
  Range: class { constructor(public start: any, public end: any) {} },
}))

// ---------------------------------------------------------------------------
// Mock AtelierServerManager
// ---------------------------------------------------------------------------

const mockAtelierManagerInstance = vi.hoisted(() => ({
  state: "running" as string,
  atelierUrl: "http://127.0.0.1:8888",
  reconnect: vi.fn().mockResolvedValue(false),
  start: vi.fn().mockResolvedValue({ atelierUrl: "http://127.0.0.1:8888" }),
  stop: vi.fn(),
  restart: vi.fn().mockResolvedValue(undefined),
  onStateChange: vi.fn().mockReturnValue(() => {}),
  setLogger: vi.fn(),
}))

vi.mock("../src/atelier-server-manager.js", () => ({
  AtelierServerManager: vi.fn(() => mockAtelierManagerInstance),
}))

// ---------------------------------------------------------------------------
// Mock AtelierClient
// ---------------------------------------------------------------------------

const mockAtelierClient = vi.hoisted(() => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  onEvent: vi.fn().mockReturnValue(() => {}),
  onConnectionStateChange: vi.fn().mockReturnValue(() => {}),
  onRefreshNeeded: vi.fn().mockReturnValue(() => {}),
  abortPipeline: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../src/atelier-client.js", () => ({
  createAtelierClient: vi.fn(() => mockAtelierClient),
}))

// ---------------------------------------------------------------------------
// Mock bridge and extension-wiring and webview-panel
// ---------------------------------------------------------------------------

vi.mock("../src/bridge.js", () => ({
  createBridge: vi.fn(() => ({
    handleMessage: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock("../src/extension-wiring.js", () => ({
  wireClientToWebview: vi.fn((_client: any, _postToWebview: any) => vi.fn()),
}))

vi.mock("../src/webview-panel.js", () => ({
  getWebviewContent: vi.fn(() => "<html></html>"),
}))

const mockInstallOpencode = vi.hoisted(() => vi.fn().mockResolvedValue("/home/.opencode/bin/opencode"))
vi.mock("../src/install-opencode.js", () => ({
  installOpencode: mockInstallOpencode,
}))

const mockOutputChannel = vi.hoisted(() => ({
  setLevel: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
  dispose: vi.fn(),
  log: vi.fn(),
  updateBaseUrl: vi.fn(),
}))

vi.mock("../src/output-channel-controller.js", () => ({
  OutputChannelController: vi.fn(() => mockOutputChannel),
}))

describe("Remote SSH startup diagnostics", () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    registeredCommands.clear()
    mockSubscriptions.length = 0
    panelIdCounter = 0
    mockAtelierManagerInstance.reconnect.mockResolvedValue(false)
    mockAtelierManagerInstance.start.mockResolvedValue({ atelierUrl: "http://127.0.0.1:8888" })
    mockAtelierManagerInstance.atelierUrl = "http://127.0.0.1:8888"

    const mod = await import("../src/extension.js")
    await mod.deactivate()
  })

  afterEach(async () => {
    const mod = await import("../src/extension.js")
    await mod.deactivate()
  })

  it("logs remote name, UI kind, and workspace path during startup", async () => {
    const mod = await import("../src/extension.js")
    const context = {
      extensionUri: { path: "/ext" },
      extensionPath: "/ext",
      subscriptions: mockSubscriptions,
      workspaceState: { get: vi.fn().mockReturnValue("info"), update: vi.fn() },
    }

    await mod.activate(context as any)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockOutputChannel.log).toHaveBeenCalledWith(
      "info",
      "startup_context",
      "remoteName=ssh-remote uiKind=1 workspacePath=/workspace",
    )
  })
})

// ---------------------------------------------------------------------------
// Pure unit tests
// ---------------------------------------------------------------------------

describe("Panel tracking", () => {
  describe("resolvePanelFrom()", () => {
    it("returns lastFocused when it exists in the set", () => {
      const p1 = { id: "a" }
      const p2 = { id: "b" }
      const panels = new Set([p1, p2])
      expect(resolvePanelFrom(p1, panels)).toBe(p1)
    })

    it("falls through to any panel when lastFocused is not in set", () => {
      const p1 = { id: "a" }
      const p2 = { id: "b" }
      const panels = new Set([p2])
      expect(resolvePanelFrom(p1, panels)).toBe(p2)
    })

    it("falls through to any panel when lastFocused is null", () => {
      const p1 = { id: "a" }
      const panels = new Set([p1])
      expect(resolvePanelFrom(null, panels)).toBe(p1)
    })

    it("returns null when set is empty", () => {
      const panels = new Set<{ id: string }>()
      expect(resolvePanelFrom(null, panels)).toBeNull()
    })

    it("returns null when lastFocused is not in empty set", () => {
      const p1 = { id: "a" }
      const panels = new Set<{ id: string }>()
      expect(resolvePanelFrom(p1, panels)).toBeNull()
    })
  })

  describe("resolvePanelTitle()", () => {
    it("uses active session title when available", () => {
      expect(resolvePanelTitle({
        activeSessionId: "s1",
        activePipelineId: null,
        sessionTitles: new Map([["s1", "Fix auth flow"]]),
        pipelineTitles: new Map(),
      })).toBe("Fix auth flow")
    })

    it("prefers active pipeline title over session title", () => {
      expect(resolvePanelTitle({
        activeSessionId: "s1",
        activePipelineId: "p1",
        sessionTitles: new Map([["s1", "Chat"]]),
        pipelineTitles: new Map([["p1", "implement dashboard feature"]]),
      })).toBe("implement dashboard feature")
    })

    it("prefers pipeline slug over stage session title", () => {
      expect(resolvePanelTitle({
        activeSessionId: null,
        activePipelineId: "p1",
        activePipelineStageSessionId: "stage-s1",
        sessionTitles: new Map([["stage-s1", "🔧 Bugfix"]]),
        pipelineTitles: new Map([["p1", "investigate tab slug naming"]]),
      })).toBe("investigate tab slug naming")
    })

    it("falls back to stage session title when pipeline has no title", () => {
      expect(resolvePanelTitle({
        activeSessionId: null,
        activePipelineId: "p1",
        activePipelineStageSessionId: "stage-s1",
        sessionTitles: new Map([["stage-s1", "🔧 Bugfix"]]),
        pipelineTitles: new Map(),
      })).toBe("🔧 Bugfix")
    })

    it("falls back to Atelier when no active title is known", () => {
      expect(resolvePanelTitle({
        activeSessionId: null,
        activePipelineId: null,
        sessionTitles: new Map(),
        pipelineTitles: new Map(),
      })).toBe("Atelier")
    })
  })

  describe("deriveIconStateFromEvent()", () => {
    it("returns 'running' on stage_started for active pipeline", () => {
      expect(deriveIconStateFromEvent("idle", { type: "stage_started", pipelineId: "p1" }, "p1")).toBe("running")
    })

    it("returns 'halted' on stage_interrupted for active pipeline", () => {
      expect(deriveIconStateFromEvent("running", { type: "stage_interrupted", pipelineId: "p1" }, "p1")).toBe("halted")
    })

    it("returns 'running' on stage_resumed for active pipeline", () => {
      expect(deriveIconStateFromEvent("halted", { type: "stage_resumed", pipelineId: "p1" }, "p1")).toBe("running")
    })

    it("returns 'halted' on stuck_escalation for active pipeline", () => {
      expect(deriveIconStateFromEvent("running", { type: "stuck_escalation", pipelineId: "p1" }, "p1")).toBe("halted")
    })

    it("returns 'idle' on pipeline_completed for active pipeline", () => {
      expect(deriveIconStateFromEvent("running", { type: "pipeline_completed", pipelineId: "p1" }, "p1")).toBe("idle")
    })

    it("ignores events from non-active pipeline", () => {
      expect(deriveIconStateFromEvent("idle", { type: "stage_started", pipelineId: "p2" }, "p1")).toBe("idle")
    })

    it("ignores events when no pipeline is active", () => {
      expect(deriveIconStateFromEvent("idle", { type: "stage_started", pipelineId: "p1" }, null)).toBe("idle")
    })

    it("preserves current state on unrelated event types", () => {
      expect(deriveIconStateFromEvent("running", { type: "session.updated", pipelineId: "p1" }, "p1")).toBe("running")
    })

    it("returns 'done' on session.idle for active stage session", () => {
      expect(deriveIconStateFromEvent("running", { type: "session.idle", sessionId: "ses1" }, "p1", "ses1")).toBe("done")
    })

    it("returns 'running' on session.busy for active stage session", () => {
      expect(deriveIconStateFromEvent("done", { type: "session.busy", sessionId: "ses1" }, "p1", "ses1")).toBe("running")
    })

    it("ignores session.idle for non-active stage session", () => {
      expect(deriveIconStateFromEvent("running", { type: "session.idle", sessionId: "ses-other" }, "p1", "ses1")).toBe("running")
    })

    it("ignores session.idle when no stage session is tracked", () => {
      expect(deriveIconStateFromEvent("running", { type: "session.idle", sessionId: "ses1" }, "p1", null)).toBe("running")
    })
  })

  describe("deriveIconStateFromPipeline()", () => {
    it("returns 'running' for running pipeline with no blocked stages", () => {
      expect(deriveIconStateFromPipeline({
        status: "running",
        stages: [{ status: "running", interrupted: false }],
      })).toBe("running")
    })

    it("returns 'halted' for running pipeline with interrupted stage", () => {
      expect(deriveIconStateFromPipeline({
        status: "running",
        stages: [{ status: "completed" }, { status: "running", interrupted: true }],
      })).toBe("halted")
    })

    it("returns 'halted' for running pipeline with stuck stage", () => {
      expect(deriveIconStateFromPipeline({
        status: "running",
        stages: [{ status: "stuck" }],
      })).toBe("halted")
    })

    it("returns 'halted' for stuck pipeline", () => {
      expect(deriveIconStateFromPipeline({
        status: "stuck",
        stages: [{ status: "running" }],
      })).toBe("halted")
    })

    it("returns 'idle' for completed pipeline", () => {
      expect(deriveIconStateFromPipeline({
        status: "completed",
        stages: [{ status: "completed" }],
      })).toBe("idle")
    })

    it("returns 'idle' for idle pipeline", () => {
      expect(deriveIconStateFromPipeline({
        status: "idle",
        stages: [],
      })).toBe("idle")
    })

    it("returns 'running' for running pipeline with no stages yet", () => {
      expect(deriveIconStateFromPipeline({
        status: "running",
        stages: [],
      })).toBe("running")
    })
  })

  describe("resolveIconPath()", () => {
    const extPath = "/ext"

    it("returns themed light/dark pair for idle state", () => {
      const result = resolveIconPath("idle", extPath)
      expect(result.light.path).toContain("icon-light.svg")
      expect(result.dark.path).toContain("icon-dark.svg")
    })

    it("returns light/dark pair for running state", () => {
      const result = resolveIconPath("running", extPath)
      expect(result.light.path).toContain("icon-running.svg")
      expect(result.dark.path).toContain("icon-running.svg")
    })

    it("returns light/dark pair for halted state", () => {
      const result = resolveIconPath("halted", extPath)
      expect(result.light.path).toContain("icon-halted.svg")
      expect(result.dark.path).toContain("icon-halted.svg")
    })

    it("returns themed light/dark pair for done state", () => {
      const result = resolveIconPath("done", extPath)
      expect(result.light.path).toContain("icon-done-light.svg")
      expect(result.dark.path).toContain("icon-done-dark.svg")
    })
  })
})

// ---------------------------------------------------------------------------
// Multi-panel integration tests
// ---------------------------------------------------------------------------

describe("Multi-panel integration", () => {
  let ext: any

  beforeEach(async () => {
    vi.clearAllMocks()
    registeredCommands.clear()
    mockSubscriptions.length = 0
    panelIdCounter = 0

    mockAtelierManagerInstance.reconnect.mockResolvedValue(false)
    mockAtelierManagerInstance.start.mockResolvedValue({ atelierUrl: "http://127.0.0.1:8888" })
    mockAtelierManagerInstance.atelierUrl = "http://127.0.0.1:8888"


    const mod = await import("../src/extension.js")
    mod.deactivate()

    const context = {
      extensionUri: { path: "/ext" },
      extensionPath: "/ext",
      subscriptions: mockSubscriptions,
      workspaceState: { get: vi.fn().mockReturnValue("info"), update: vi.fn() },
    }
    ext = await mod.activate(context as any)
  })

  afterEach(async () => {
    const mod = await import("../src/extension.js")
    mod.deactivate()
  })

  async function openChat() {
    const handler = registeredCommands.get("atelier.openChat")!
    await handler()
  }

  async function openChatInNewTab() {
    const handler = registeredCommands.get("atelier.openChatInNewTab")!
    await handler()
  }

  it("openChatInNewTab creates two independent panels", async () => {
    await openChatInNewTab()
    await openChatInNewTab()

    expect(ext._test.getPanels().size).toBe(2)
  })

  it("openChat reveals existing panel instead of creating a new one", async () => {
    await openChat()
    const panels = ext._test.getPanels()
    expect(panels.size).toBe(1)
    const firstPanel = [...panels][0]

    await openChat()
    expect(panels.size).toBe(1)
    expect(firstPanel.reveal).toHaveBeenCalled()
  })

  it("disposing one panel leaves the other intact and client alive", async () => {
    await openChatInNewTab()
    await openChatInNewTab()
    const panels = ext._test.getPanels()
    expect(panels.size).toBe(2)

    const [first] = [...panels]
    first.dispose()

    expect(panels.size).toBe(1)
    expect(ext._test.getClient()).not.toBeNull()
    expect(mockAtelierClient.disconnect).not.toHaveBeenCalled()
  })

  it("disposing the last panel tears down client and server", async () => {
    await openChat()
    const panels = ext._test.getPanels()
    const [only] = [...panels]
    only.dispose()

    expect(panels.size).toBe(0)
    expect(ext._test.getClient()).toBeNull()
    expect(mockAtelierClient.disconnect).toHaveBeenCalled()
    expect(mockAtelierManagerInstance.stop).toHaveBeenCalled()
  })

  it("deactivate disposes all panels, disconnects client, stops server", async () => {
    await openChatInNewTab()
    await openChatInNewTab()
    const panelArr = [...ext._test.getPanels()]

    const mod = await import("../src/extension.js")
    mod.deactivate()

    for (const p of panelArr) {
      expect(p.dispose).toHaveBeenCalled()
    }
    expect(mockAtelierClient.disconnect).toHaveBeenCalled()
    expect(mockAtelierManagerInstance.stop).toHaveBeenCalled()
    expect(ext._test.getClient()).toBeNull()
    expect(ext._test.getAtelierManager()).toBeNull()
  })

  it("client is created only once across multiple panels", async () => {
    const { createAtelierClient } = await import("../src/atelier-client.js")
    const { AtelierServerManager } = await import("../src/atelier-server-manager.js")

    await openChatInNewTab()
    await openChatInNewTab()

    expect(createAtelierClient).toHaveBeenCalledTimes(1)
    expect(AtelierServerManager).toHaveBeenCalledTimes(1)
  })

  it("registers atelier.setFavoriteModelVariant command", () => {
    expect(registeredCommands.has("atelier.setFavoriteModelVariant")).toBe(true)
  })

  it("setFavoriteModelVariant posts command message to active panel", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0]
    const handler = registeredCommands.get("atelier.setFavoriteModelVariant")!
    await handler()
    expect(panel.webview.postMessage).toHaveBeenCalledWith({ type: "favorites.command.upsertCurrent" })
  })

  it("setFavoriteModelVariant warns when no active panel", async () => {
    const vscodeModule = await import("vscode")
    const handler = registeredCommands.get("atelier.setFavoriteModelVariant")!
    await handler()
    expect(vscodeModule.window.showInformationMessage).toHaveBeenCalledWith("Atelier: Open a chat panel first to favorite the current model/variant")
  })
})

// ---------------------------------------------------------------------------
// Tab icon state integration
// ---------------------------------------------------------------------------

describe("Tab icon state", () => {
  let ext: any

  beforeEach(async () => {
    vi.clearAllMocks()
    registeredCommands.clear()
    mockSubscriptions.length = 0
    panelIdCounter = 0

    mockAtelierManagerInstance.reconnect.mockResolvedValue(false)
    mockAtelierManagerInstance.start.mockResolvedValue({ atelierUrl: "http://127.0.0.1:8888" })
    mockAtelierManagerInstance.atelierUrl = "http://127.0.0.1:8888"

    const mod = await import("../src/extension.js")
    mod.deactivate()

    const context = {
      extensionUri: { path: "/ext" },
      extensionPath: "/ext",
      subscriptions: mockSubscriptions,
      workspaceState: { get: vi.fn().mockReturnValue("info"), update: vi.fn() },
    }
    ext = await mod.activate(context as any)
  })

  afterEach(async () => {
    const mod = await import("../src/extension.js")
    mod.deactivate()
  })

  async function openChat() {
    const handler = registeredCommands.get("atelier.openChat")!
    await handler()
  }

  async function openChatInNewTab() {
    const handler = registeredCommands.get("atelier.openChatInNewTab")!
    await handler()
  }

  /** Get the postToWebview callback captured by the wireClientToWebview mock for call N (0-indexed). */
  async function getCapturedPostToWebview(callIndex: number) {
    const { wireClientToWebview } = await import("../src/extension-wiring.js")
    return (wireClientToWebview as any).mock.calls[callIndex][1] as (msg: any) => void
  }

  it("sets idle icon on panel creation", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    expect(panel.iconPath).toBeDefined()
    expect(panel.iconPath.light.path).toContain("icon-light.svg")
    expect(panel.iconPath.dark.path).toContain("icon-dark.svg")
  })

  it("updates to running icon when pipeline starts", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    // Load a running pipeline to set activePipelineId
    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "test", status: "running", stages: [], currentStage: "brainstorm", createdAt: 0, updatedAt: 0 },
    })

    // Inject stage_started event
    postToWebview({
      type: "event",
      event: { type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm" },
    })

    expect(panel.iconPath.light.path).toContain("icon-running.svg")
  })

  it("updates to halted icon on stage_interrupted", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "test", status: "running", stages: [], currentStage: "brainstorm", createdAt: 0, updatedAt: 0 },
    })
    postToWebview({
      type: "event",
      event: { type: "stage_interrupted", pipelineId: "p1", stageId: "s1", sessionId: "ses1" },
    })

    expect(panel.iconPath.light.path).toContain("icon-halted.svg")
  })

  it("updates to halted icon on stuck_escalation", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "test", status: "running", stages: [], currentStage: "brainstorm", createdAt: 0, updatedAt: 0 },
    })
    postToWebview({
      type: "event",
      event: { type: "stuck_escalation", pipelineId: "p1", stageId: "s1", stage: "review_spec", sessionId: "ses1" },
    })

    expect(panel.iconPath.light.path).toContain("icon-halted.svg")
  })

  it("returns to running on stage_resumed after interrupted", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "test", status: "running", stages: [], currentStage: "brainstorm", createdAt: 0, updatedAt: 0 },
    })
    postToWebview({
      type: "event",
      event: { type: "stage_interrupted", pipelineId: "p1", stageId: "s1", sessionId: "ses1" },
    })
    expect(panel.iconPath.light.path).toContain("icon-halted.svg")

    postToWebview({
      type: "event",
      event: { type: "stage_resumed", pipelineId: "p1", stageId: "s1", sessionId: "ses1" },
    })
    expect(panel.iconPath.light.path).toContain("icon-running.svg")
  })

  it("returns to idle on pipeline_completed", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "test", status: "running", stages: [], currentStage: "brainstorm", createdAt: 0, updatedAt: 0 },
    })
    postToWebview({
      type: "event",
      event: { type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm" },
    })
    expect(panel.iconPath.light.path).toContain("icon-running.svg")

    postToWebview({
      type: "event",
      event: { type: "pipeline_completed", pipelineId: "p1" },
    })
    expect(panel.iconPath.light.path).toContain("icon-light.svg")
    expect(panel.iconPath.dark.path).toContain("icon-dark.svg")
  })

  it("resets to idle when switching to regular session", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "test", status: "running", stages: [], currentStage: "brainstorm", createdAt: 0, updatedAt: 0 },
    })
    postToWebview({
      type: "event",
      event: { type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm" },
    })
    expect(panel.iconPath.light.path).toContain("icon-running.svg")

    // Switch to a regular session
    postToWebview({ type: "activeSession", sessionId: "ses-regular" })
    expect(panel.iconPath.light.path).toContain("icon-light.svg")
  })

  it("derives halted from loaded pipeline with stuck status", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    postToWebview({
      type: "pipeline",
      pipeline: {
        id: "p1", prompt: "test", status: "stuck", currentStage: "review_spec", createdAt: 0, updatedAt: 0,
        stages: [
          { id: "s1", stage: "review_spec", status: "running", startedAt: 0 },
        ],
      },
    })

    expect(panel.iconPath.light.path).toContain("icon-halted.svg")
  })

  it("derives halted from loaded pipeline with interrupted stage", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    postToWebview({
      type: "pipeline",
      pipeline: {
        id: "p1", prompt: "test", status: "running", currentStage: "brainstorm", createdAt: 0, updatedAt: 0,
        stages: [
          { id: "s1", stage: "brainstorm", status: "running", interrupted: true, startedAt: 0 },
        ],
      },
    })

    expect(panel.iconPath.light.path).toContain("icon-halted.svg")
  })

  it("tracks icon state independently per panel", async () => {
    await openChatInNewTab()
    await openChatInNewTab()

    const panelArr = [...ext._test.getPanels()] as any[]
    expect(panelArr.length).toBe(2)

    const postToWebview0 = await getCapturedPostToWebview(0)
    const postToWebview1 = await getCapturedPostToWebview(1)

    // Both start idle
    expect(panelArr[0].iconPath.light.path).toContain("icon-light.svg")
    expect(panelArr[1].iconPath.light.path).toContain("icon-light.svg")

    // Load pipeline in panel 0 only
    postToWebview0({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "test", status: "running", stages: [], currentStage: "brainstorm", createdAt: 0, updatedAt: 0 },
    })
    postToWebview0({
      type: "event",
      event: { type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm" },
    })

    // Panel 0 is running, panel 1 still idle
    expect(panelArr[0].iconPath.light.path).toContain("icon-running.svg")
    expect(panelArr[1].iconPath.light.path).toContain("icon-light.svg")
  })

  it("transitions to done icon when pipeline stage session goes idle", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "test", status: "running", stages: [], currentStage: "brainstorm", createdAt: 0, updatedAt: 0 },
    })
    postToWebview({
      type: "event",
      event: { type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "implement", sessionId: "ses1" },
    })
    expect(panel.iconPath.light.path).toContain("icon-running.svg")

    // Agent goes idle within the pipeline stage
    postToWebview({
      type: "event",
      event: { type: "session.idle", sessionId: "ses1", usage: { inputTokens: 0, outputTokens: 0 } },
    })
    expect(panel.iconPath.light.path).toContain("icon-done-light.svg")
    expect(panel.iconPath.dark.path).toContain("icon-done-dark.svg")
  })

  it("transitions back to running when pipeline stage session becomes busy again", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "test", status: "running", stages: [], currentStage: "brainstorm", createdAt: 0, updatedAt: 0 },
    })
    postToWebview({
      type: "event",
      event: { type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "implement", sessionId: "ses1" },
    })
    // Agent goes idle
    postToWebview({
      type: "event",
      event: { type: "session.idle", sessionId: "ses1", usage: { inputTokens: 0, outputTokens: 0 } },
    })
    expect(panel.iconPath.light.path).toContain("icon-done-light.svg")

    // Agent becomes busy again (user replied)
    postToWebview({
      type: "event",
      event: { type: "session.busy", sessionId: "ses1" },
    })
    expect(panel.iconPath.light.path).toContain("icon-running.svg")
  })

  it("ignores session.idle for non-stage sessions during pipeline", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "test", status: "running", stages: [], currentStage: "brainstorm", createdAt: 0, updatedAt: 0 },
    })
    postToWebview({
      type: "event",
      event: { type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "implement", sessionId: "ses1" },
    })
    expect(panel.iconPath.light.path).toContain("icon-running.svg")

    // Idle event from a different session — should not change icon
    postToWebview({
      type: "event",
      event: { type: "session.idle", sessionId: "ses-other", usage: { inputTokens: 0, outputTokens: 0 } },
    })
    expect(panel.iconPath.light.path).toContain("icon-running.svg")
  })

  it("ignores events for non-active pipeline", async () => {
    await openChat()
    const panel = [...ext._test.getPanels()][0] as any
    const postToWebview = await getCapturedPostToWebview(0)

    // Load pipeline p1
    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "test", status: "running", stages: [], currentStage: "brainstorm", createdAt: 0, updatedAt: 0 },
    })
    postToWebview({
      type: "event",
      event: { type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm" },
    })
    expect(panel.iconPath.light.path).toContain("icon-running.svg")

    // Event for a different pipeline — should not change icon
    postToWebview({
      type: "event",
      event: { type: "pipeline_completed", pipelineId: "p-other" },
    })
    expect(panel.iconPath.light.path).toContain("icon-running.svg")
  })
})

// ---------------------------------------------------------------------------
// Auto-install flow
// ---------------------------------------------------------------------------

describe("Auto-install flow", () => {
  let vscodeModule: any

  beforeEach(async () => {
    vi.clearAllMocks()
    registeredCommands.clear()
    mockSubscriptions.length = 0
    panelIdCounter = 0
    mockAtelierManagerInstance.reconnect.mockResolvedValue(false)
    mockAtelierManagerInstance.start.mockResolvedValue({ atelierUrl: "http://127.0.0.1:8888" })
    mockAtelierManagerInstance.atelierUrl = "http://127.0.0.1:8888"


    vscodeModule = await import("vscode")

    const mod = await import("../src/extension.js")
    mod.deactivate()
    const context = {
      extensionUri: { path: "/ext" },
      extensionPath: "/ext",
      subscriptions: mockSubscriptions,
      workspaceState: { get: vi.fn().mockReturnValue("info"), update: vi.fn() },
    }
    await mod.activate(context as any)
    // activate() eagerly calls ensureClient() in the background — wait for it to settle
    await new Promise((r) => setTimeout(r, 0))
    // Reset module state so tests control the startup flow
    mod.deactivate()
    vi.clearAllMocks()
    mockAtelierManagerInstance.start.mockReset()
    mockAtelierManagerInstance.reconnect.mockResolvedValue(false)
    mockAtelierManagerInstance.start.mockResolvedValue({ atelierUrl: "http://127.0.0.1:8888" })
    mockAtelierManagerInstance.atelierUrl = "http://127.0.0.1:8888"
  })

  afterEach(async () => {
    const mod = await import("../src/extension.js")
    mod.deactivate()
  })

  it("shows install prompt when AtelierServerManager throws binary not found", async () => {
    mockAtelierManagerInstance.start.mockRejectedValueOnce(
      new Error("OpenCode binary not found at expected PATH"),
    )

    const handler = registeredCommands.get("atelier.openChat")!
    await handler()

    expect(vscodeModule.window.showInformationMessage).toHaveBeenCalledWith(
      "OpenCode binary not found. Install it now?",
      "Install",
      "Cancel",
    )
  })

  it("retries server start after successful install", async () => {
    mockAtelierManagerInstance.start
      .mockRejectedValueOnce(new Error("OpenCode binary not found at expected PATH"))
      .mockResolvedValueOnce({ atelierUrl: "http://127.0.0.1:8888" })
    vscodeModule.window.showInformationMessage.mockResolvedValueOnce("Install")

    const handler = registeredCommands.get("atelier.openChat")!
    await handler()

    expect(mockAtelierManagerInstance.start).toHaveBeenCalledTimes(2)
    expect(mockInstallOpencode).toHaveBeenCalled()
  })

  it("does not retry when user cancels install", async () => {
    mockAtelierManagerInstance.start.mockRejectedValueOnce(
      new Error("OpenCode binary not found at expected PATH"),
    )
    vscodeModule.window.showInformationMessage.mockResolvedValueOnce("Cancel")

    const handler = registeredCommands.get("atelier.openChat")!
    await handler()

    expect(mockAtelierManagerInstance.start).toHaveBeenCalledTimes(1)
    expect(mockInstallOpencode).not.toHaveBeenCalled()
  })

  it("shows error for non-binary failures without install prompt", async () => {
    mockAtelierManagerInstance.start.mockRejectedValueOnce(
      new Error("Port 9999 is already in use"),
    )

    const handler = registeredCommands.get("atelier.openChat")!
    await handler()

    expect(vscodeModule.window.showInformationMessage).not.toHaveBeenCalled()
    expect(vscodeModule.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("see Output panel"),
    )
  })
})

// ---------------------------------------------------------------------------
// Stuck escalation notification
// ---------------------------------------------------------------------------

describe("Stuck escalation notification", () => {
  let vscodeModule: any

  beforeEach(async () => {
    vi.clearAllMocks()
    registeredCommands.clear()
    mockSubscriptions.length = 0
    panelIdCounter = 0
    mockAtelierManagerInstance.state = "running"
    mockAtelierManagerInstance.atelierUrl = "http://127.0.0.1:8888"

    vscodeModule = await import("vscode")

    const mod = await import("../src/extension.js")
    mod.deactivate()
    const context = {
      extensionUri: { path: "/ext" },
      extensionPath: "/ext",
      subscriptions: mockSubscriptions,
      workspaceState: { get: vi.fn().mockReturnValue("info"), update: vi.fn() },
    }
    await mod.activate(context as any)
  })

  afterEach(async () => {
    const mod = await import("../src/extension.js")
    mod.deactivate()
  })

  it("shows information message on stuck_escalation event", async () => {
    vscodeModule.window.showInformationMessage.mockResolvedValueOnce(undefined)

    // Trigger panel creation so client is initialized
    const handler = registeredCommands.get("atelier.openChat")!
    await handler()

    // Get the event handler registered via client.onEvent
    const onEventCall = mockAtelierClient.onEvent.mock.calls[0]
    expect(onEventCall).toBeTruthy()
    const eventHandler = onEventCall[0]

    // Simulate stuck_escalation event
    eventHandler({ type: "stuck_escalation", pipelineId: "p1", stageId: "s1", stage: "review_spec" })

    expect(vscodeModule.window.showInformationMessage).toHaveBeenCalledWith(
      "Pipeline stuck at review_spec — reviewer needs your input",
      "View Details",
      "Retry with Fixer",
      "Abort Pipeline",
    )
  })
})

// ---------------------------------------------------------------------------
// Auto-reveal on session.created
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WebviewPanelSerializer
// ---------------------------------------------------------------------------

describe("WebviewPanelSerializer", () => {
  let ext: any
  let vscodeModule: any
  let serializer: any

  beforeEach(async () => {
    vi.clearAllMocks()
    registeredCommands.clear()
    mockSubscriptions.length = 0
    panelIdCounter = 0
    mockAtelierManagerInstance.state = "running"
    mockAtelierManagerInstance.atelierUrl = "http://127.0.0.1:8888"


    vscodeModule = await import("vscode")

    const mod = await import("../src/extension.js")
    mod.deactivate()

    const context = {
      extensionUri: { path: "/ext" },
      extensionPath: "/ext",
      subscriptions: mockSubscriptions,
      workspaceState: { get: vi.fn().mockReturnValue("info"), update: vi.fn() },
    }
    ext = await mod.activate(context as any)

    const calls = (vscodeModule.window.registerWebviewPanelSerializer as any).mock.calls
    serializer = calls[calls.length - 1][1]
  })

  afterEach(async () => {
    const mod = await import("../src/extension.js")
    mod.deactivate()
  })

  it("registers a serializer for atelierChat viewType on activate", async () => {
    expect(vscodeModule.window.registerWebviewPanelSerializer).toHaveBeenCalledWith(
      "atelierChat",
      expect.objectContaining({
        deserializeWebviewPanel: expect.any(Function),
      }),
    )
  })

  it("deserializeWebviewPanel wires up a restored panel", async () => {
    const restoredPanel = createMockPanel()
    await serializer.deserializeWebviewPanel(restoredPanel, undefined)

    expect(ext._test.getPanels().has(restoredPanel)).toBe(true)
    expect(restoredPanel.webview.html).toBeTruthy()
  })

  it("deserializeWebviewPanel disposes panel on backend failure", async () => {
    const mod = await import("../src/extension.js")
    mod.deactivate()

    mockAtelierManagerInstance.reconnect.mockResolvedValue(false)
    mockAtelierManagerInstance.start.mockRejectedValueOnce(new Error("Port conflict"))

    const context = {
      extensionUri: { path: "/ext" },
      extensionPath: "/ext",
      subscriptions: mockSubscriptions,
      workspaceState: { get: vi.fn().mockReturnValue("info"), update: vi.fn() },
    }
    ext = await mod.activate(context as any)

    const calls = (vscodeModule.window.registerWebviewPanelSerializer as any).mock.calls
    serializer = calls[calls.length - 1][1]

    const restoredPanel = createMockPanel()
    await serializer.deserializeWebviewPanel(restoredPanel, undefined)

    expect(restoredPanel.dispose).toHaveBeenCalled()
    expect(ext._test.getPanels().has(restoredPanel)).toBe(false)
  })

  it("pipeline message activates pipeline and updates tab title", async () => {
    const restoredPanel = createMockPanel()
    await serializer.deserializeWebviewPanel(restoredPanel, { activeSessionId: "s1" })

    const { wireClientToWebview } = await import("../src/extension-wiring.js")
    const postToWebview = (wireClientToWebview as any).mock.calls[(wireClientToWebview as any).mock.calls.length - 1][1]

    postToWebview({ type: "sessions", sessions: [{ id: "s1", title: "Saved chat" }] })
    expect(restoredPanel.title).toBe("Saved chat")

    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "Pipeline title", stages: [], status: "running" },
    })
    expect(restoredPanel.title).toBe("Pipeline title")
  })

  it("updates panel title from active pipeline stage session slug", async () => {
    const restoredPanel = createMockPanel()
    await serializer.deserializeWebviewPanel(restoredPanel, { activePipelineId: "p1" })

    const { wireClientToWebview } = await import("../src/extension-wiring.js")
    const postToWebview = (wireClientToWebview as any).mock.calls[(wireClientToWebview as any).mock.calls.length - 1][1]

    postToWebview({
      type: "pipeline",
      pipeline: { id: "p1", prompt: "Pipeline title", stages: [], status: "running" },
    })
    expect(restoredPanel.title).toBe("Pipeline title")

    // Pipeline slug title takes priority over stage session title
    postToWebview({
      type: "event",
      event: { type: "pipeline_title_updated", pipelineId: "p1", title: "implement login flow" },
    } as any)
    expect(restoredPanel.title).toBe("implement login flow")

    // Stage session title does NOT override the pipeline slug
    postToWebview({
      type: "event",
      event: { type: "stage_started", pipelineId: "p1", sessionId: "stage-s1" },
    } as any)
    postToWebview({
      type: "event",
      event: { type: "session.updated", properties: { info: { id: "stage-s1", title: "🔧 Bugfix" } } },
    } as any)

    expect(restoredPanel.title).toBe("implement login flow")
  })
})
