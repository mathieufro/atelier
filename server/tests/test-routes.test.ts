import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createApp, type AppOptions } from "../src/app.js"
import { createEventMerger } from "../src/engine/event-merger.js"
import { BackendRegistry } from "../src/engine/backend-registry.js"
import { SessionMetadataStore } from "../src/engine/session-metadata-store.js"
import type { BackendProxy } from "../src/engine/backend-proxy.js"
import type { AgentEngine } from "@atelier/core/agent-engine"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"


let tmpDirs: string[] = []

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "test-routes-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

function createMockOrchestrator(overrides?: Partial<Record<string, any>>) {
  return {
    hasActivePipeline: vi.fn(() => false),
    hasPipeline: vi.fn(() => false),
    getActiveStageName: vi.fn(() => null),
    getActiveStageSessionId: vi.fn(() => null),
    isStageInterrupted: vi.fn(() => false),
    isStageInterruptedForSession: vi.fn(() => false),
    isSessionOwnedByPipeline: vi.fn(() => false),
    findPipelineIdBySession: vi.fn(() => null),
    startPipelineAsync: vi.fn(() => ({ pipelineId: "p-new", completion: Promise.resolve() })),
    abortStageSession: vi.fn(async () => {}),
    resumeStageSession: vi.fn(async () => {}),
    clearInterruptAndRoute: vi.fn(async () => {}),
    handleSignal: vi.fn(async () => {}),
    handleStuckRetry: vi.fn(async () => {}),
    failPipeline: vi.fn(),
    getActivePipelineIds: vi.fn(() => []),
    handleAutoPermission: vi.fn(async () => {}),
    ...overrides,
  }
}

function createMockProxy(): BackendProxy {
  return {
    listSessions: vi.fn(async () => []),
    getSession: vi.fn(async (id: string) => ({ id })),
    deleteSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    getMessages: vi.fn(async () => ({ messages: [], start: 0, end: 0, total: 0 })),
    sendMessage: vi.fn(async () => {}),
    getConfig: vi.fn(async () => ({ models: [{ providerID: "anthropic", id: "haiku", name: "Haiku" }], workspacePath: "/tmp" })),
    replyPermission: vi.fn(async () => {}),
    replyQuestion: vi.fn(async () => {}),
    rejectQuestion: vi.fn(async () => {}),
    listPendingPermissions: vi.fn(async () => []),
    listPendingQuestions: vi.fn(async () => []),
    updateSessionTitle: vi.fn(async () => {}),
  }
}

function createMockEngine(): AgentEngine {
  return {
    createSession: vi.fn(async () => ({ id: "s-new" })),
    sendMessage: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
    getSessionOutput: vi.fn(async () => ({ text: "", tokens: { input: 0, output: 0 } })),
    interruptSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    updateSessionTitle: vi.fn(async () => {}),
  }
}

function createTestAppOptions(overrides?: Partial<AppOptions>): AppOptions {
  const tmpDir = createTmpDir()
  const registry = new BackendRegistry()
  const proxy = createMockProxy()
  const engine = createMockEngine()
  registry.registerProxy("opencode", proxy)
  registry.registerEngine("opencode", engine)
  const metadataStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))
  registry.setMetadataStore(metadataStore)

  return {
    registry,
    metadataStore,
    workspacePath: "/tmp",
    eventMerger: createEventMerger(),
    getOrchestrator: () => null,
    getStatus: () => "ready",
    ...overrides,
  }
}

function getProxy(opts: AppOptions): BackendProxy {
  return opts.registry.getProxyIfReady("opencode")!
}

describe("Test routes", () => {
  let proxy: BackendProxy
  let merger: ReturnType<typeof createEventMerger>
  let app: any
  let opts: AppOptions

  beforeEach(() => {
    opts = createTestAppOptions()
    proxy = getProxy(opts)
    merger = opts.eventMerger
    app = createApp(opts)
  })

  // POST /test/command
  it("POST /test/command emits test_command SSE event for allowed command", async () => {
    const events: any[] = []
    merger.subscribe((e) => events.push(e))

    const res = await app.request("/test/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "atelier.openChat" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe("test_command")
    expect(events[0].command).toBe("atelier.openChat")
  })

  it("POST /test/command accepts atelier.openChatInNewTab", async () => {
    const events: any[] = []
    merger.subscribe((e) => events.push(e))

    const res = await app.request("/test/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "atelier.openChatInNewTab" }),
    })
    expect(res.status).toBe(200)
    expect(events[0].command).toBe("atelier.openChatInNewTab")
  })

  it("POST /test/command rejects disallowed commands with 400", async () => {
    const res = await app.request("/test/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "workbench.action.terminal.new" }),
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain("command")
  })

  it("POST /test/command rejects empty command with 400", async () => {
    const res = await app.request("/test/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "" }),
    })
    expect(res.status).toBe(400)
  })

  // POST /test/send-message
  it("POST /test/send-message sends to session directly via proxy", async () => {
    const res = await app.request("/test/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", content: "hello brainstorm" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ ok: true })
    // sendMessage is fire-and-forget via getProxyForSession — give it a tick
    await new Promise(r => setTimeout(r, 10))
    expect(proxy.sendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({ content: "hello brainstorm" }))
  })

  it("POST /test/send-message passes model and attachments", async () => {
    const res = await app.request("/test/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "s1",
        content: "test",
        model: { providerID: "anthropic", modelID: "haiku" },
        attachments: [{ mime: "text/plain", url: "file:///a.txt" }],
      }),
    })
    expect(res.status).toBe(200)
    await new Promise(r => setTimeout(r, 10))
    expect(proxy.sendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({
      content: "test",
      model: { providerID: "anthropic", modelID: "haiku" },
      attachments: [{ mime: "text/plain", url: "file:///a.txt" }],
    }))
  })

  it("POST /test/send-message rejects missing sessionId with 400", async () => {
    const res = await app.request("/test/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /test/send-message rejects missing content with 400", async () => {
    const res = await app.request("/test/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1" }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /test/send-message returns 200 immediately (fire-and-forget)", async () => {
    ;(proxy.sendMessage as any).mockRejectedValueOnce(new Error("session not found"))
    const res = await app.request("/test/send-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", content: "hello" }),
    })
    // Fire-and-forget: returns 200 immediately, errors are logged async
    expect(res.status).toBe(200)
  })

  describe("/test/send-message interrupt handling", () => {
    it("uses clearInterruptAndRoute for interrupted active pipeline session", async () => {
      const orch = createMockOrchestrator({
        isSessionOwnedByPipeline: vi.fn(() => true),
        findPipelineIdBySession: vi.fn(() => "p1"),
        getActiveStageSessionId: vi.fn((_id: string) => "s1"),
        isStageInterrupted: vi.fn((_id: string) => true),
      })
      app = createApp({ ...opts, getOrchestrator: () => orch as any })

      const res = await app.request("/test/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", content: "correct course" }),
      })
      expect(res.status).toBe(200)
      expect(orch.clearInterruptAndRoute).toHaveBeenCalledWith("s1", "correct course", { model: undefined, variant: undefined })
      expect(proxy.sendMessage).not.toHaveBeenCalled()
    })

    it("uses sendMessage for non-interrupted pipeline session", async () => {
      const orch = createMockOrchestrator({
        isSessionOwnedByPipeline: vi.fn(() => true),
        findPipelineIdBySession: vi.fn(() => "p1"),
        getActiveStageSessionId: vi.fn((_id: string) => "s1"),
        isStageInterrupted: vi.fn((_id: string) => false),
      })
      app = createApp({ ...opts, getOrchestrator: () => orch as any })

      const res = await app.request("/test/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", content: "hello" }),
      })
      expect(res.status).toBe(200)
      await new Promise(r => setTimeout(r, 10))
      expect(proxy.sendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({ content: "hello" }))
      expect(orch.clearInterruptAndRoute).not.toHaveBeenCalled()
    })

    it("uses sendMessage for non-pipeline session", async () => {
      const orch = createMockOrchestrator({
        isSessionOwnedByPipeline: vi.fn(() => false),
      })
      app = createApp({ ...opts, getOrchestrator: () => orch as any })

      const res = await app.request("/test/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", content: "hello" }),
      })
      expect(res.status).toBe(200)
      await new Promise(r => setTimeout(r, 10))
      expect(proxy.sendMessage).toHaveBeenCalled()
      expect(orch.clearInterruptAndRoute).not.toHaveBeenCalled()
    })

    it("uses sendMessage when session is pipeline-owned but not active stage", async () => {
      const orch = createMockOrchestrator({
        isSessionOwnedByPipeline: vi.fn(() => true),
        findPipelineIdBySession: vi.fn(() => "p1"),
        getActiveStageSessionId: vi.fn((_id: string) => "s2"), // different session is active
        isStageInterrupted: vi.fn((_id: string) => true),
      })
      app = createApp({ ...opts, getOrchestrator: () => orch as any })

      const res = await app.request("/test/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "s1", content: "hello" }),
      })
      expect(res.status).toBe(200)
      await new Promise(r => setTimeout(r, 10))
      expect(proxy.sendMessage).toHaveBeenCalled()
      expect(orch.clearInterruptAndRoute).not.toHaveBeenCalled()
    })
  })

  describe("/pipeline/signal", () => {
    it("passes verdict to orchestrator", async () => {
      const mockOrch = createMockOrchestrator()
      const appWithOrch = createApp({ ...opts, getOrchestrator: () => mockOrch as any })
      const res = await appWithOrch.request("/pipeline/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "stage_complete",
          sessionId: "s1",
          outputPath: "review.md",
          verdict: "has_issues",
        }),
      })
      expect(res.status).toBe(200)
      expect(mockOrch.handleSignal).toHaveBeenCalledWith({
        type: "stage_complete",
        sessionId: "s1",
        outputPath: "review.md",
        verdict: "has_issues",
        action: undefined,
      })
    })

    it("passes action field through to orchestrator", async () => {
      const mockOrch = createMockOrchestrator()
      const appWithOrch = createApp({ ...opts, getOrchestrator: () => mockOrch as any })
      const res = await appWithOrch.request("/pipeline/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "stage_complete",
          sessionId: "s1",
          action: "implement",
        }),
      })
      expect(res.status).toBe(200)
      expect(mockOrch.handleSignal).toHaveBeenCalledWith(expect.objectContaining({ action: "implement" }))
    })

    it("rejects invalid verdict", async () => {
      const mockOrch = createMockOrchestrator()
      const appWithOrch = createApp({ ...opts, getOrchestrator: () => mockOrch as any })
      const res = await appWithOrch.request("/pipeline/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "stage_complete",
          sessionId: "s1",
          verdict: "invalid_verdict",
        }),
      })
      expect(res.status).toBe(400)
    })

    it("rejects stage_blocked", async () => {
      const mockOrch = createMockOrchestrator()
      const appWithOrch = createApp({ ...opts, getOrchestrator: () => mockOrch as any })
      const res = await appWithOrch.request("/pipeline/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "stage_blocked",
          sessionId: "s1",
          reason: "cannot proceed",
        }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe("/pipeline/retry-stuck", () => {
    it("calls orchestrator handleStuckRetry with mapped action (fixer → fix)", async () => {
      const mockOrch = createMockOrchestrator()
      const appWithOrch = createApp({ ...opts, getOrchestrator: () => mockOrch as any })
      const res = await appWithOrch.request("/pipeline/retry-stuck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipelineId: "p1",
          stageId: "s1",
          action: "fixer",
        }),
      })
      expect(res.status).toBe(200)
      expect(mockOrch.handleStuckRetry).toHaveBeenCalledWith("p1", "s1", "fix")
    })

    it("calls orchestrator handleStuckRetry with resume action", async () => {
      const mockOrch = createMockOrchestrator()
      const appWithOrch = createApp({ ...opts, getOrchestrator: () => mockOrch as any })
      const res = await appWithOrch.request("/pipeline/retry-stuck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipelineId: "p1",
          stageId: "s1",
          action: "resume",
        }),
      })
      expect(res.status).toBe(200)
      expect(mockOrch.handleStuckRetry).toHaveBeenCalledWith("p1", "s1", "resume")
    })

    it("rejects invalid action", async () => {
      const mockOrch = createMockOrchestrator({
        handleStuckRetry: vi.fn(async () => {}),
      })
      const appWithOrch = createApp({ ...opts, getOrchestrator: () => mockOrch as any })
      const res = await appWithOrch.request("/pipeline/retry-stuck", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipelineId: "p1",
          stageId: "s1",
          action: "invalid",
        }),
      })
      expect(res.status).toBe(400)
    })
  })

  describe("/message model validation", () => {
    it("emits send_error on unknown model for an existing session", async () => {
      const events: any[] = []
      merger.subscribe((e) => events.push(e))

      const res = await app.request("/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "s1",
          content: "hello",
          mode: "build",
          model: { providerID: "anthropic", modelID: "does-not-exist" },
        }),
      })

      expect(res.status).toBe(400)
      expect(proxy.sendMessage).not.toHaveBeenCalled()
      const sendError = events.find((e) => e.type === "send_error" && e.sessionId === "s1")
      expect(sendError).toBeTruthy()
      expect(sendError.error).toContain("Unknown model 'anthropic:does-not-exist'")
    })
  })
})
