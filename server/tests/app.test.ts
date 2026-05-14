import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
// Polyfill vi.mocked for Bun compatibility — it's a no-op identity cast in vitest
if (!vi.mocked) (vi as any).mocked = <T>(fn: T): T => fn
import { createApp, pickDefaultBackend, type AppOptions } from "../src/app.js"
import { createEventMerger } from "../src/engine/event-merger.js"
import { createPipelineState } from "../src/orchestration/pipeline-state.js"
import { FavoritesStore } from "../src/engine/favorites-store.js"
import { BackendRegistry } from "../src/engine/backend-registry.js"
import { SessionMetadataStore } from "../src/engine/session-metadata-store.js"
import type { BackendProxy } from "../src/engine/backend-proxy.js"
import type { AgentEngine } from "@atelier/core/agent-engine"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// --- Test helpers ---

function createMockProxy(): BackendProxy {
  return {
    listSessions: vi.fn(async () => [{ id: "s1", title: "Chat 1" }]),
    getSession: vi.fn(async (id: string) => ({ id })),
    deleteSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    getMessages: vi.fn(async () => ({ messages: [], start: 0, end: 0, total: 0 })),
    sendMessage: vi.fn(async () => {}),
    getConfig: vi.fn(async () => ({ models: [], workspacePath: "/tmp" })),
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
    forkSession: vi.fn(async () => ({ id: "s-forked" })),
  }
}

let tmpDirs: string[] = []

function createTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-test-"))
  tmpDirs.push(dir)
  return dir
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

/** Get the mock proxy registered as "opencode" in the registry */
function getProxy(opts: AppOptions): BackendProxy {
  return opts.registry.getProxyIfReady("opencode")!
}

/** Get the mock engine registered as "opencode" in the registry */
function getEngine(opts: AppOptions): AgentEngine {
  return opts.registry.getEngineIfReady("opencode")!
}

function createTmpFavoritesStore() {
  const tmpDir = createTmpDir()
  const favPath = path.join(tmpDir, "favorites.json")
  return new FavoritesStore(favPath)
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

// --- Existing tests updated for BackendRegistry ---

describe("Proxy Endpoints", () => {
  let app: any
  let opts: AppOptions

  beforeEach(() => {
    opts = createTestAppOptions()
    app = createApp(opts)
  })

  it("GET /sessions returns sessions from metadata store", async () => {
    opts.metadataStore.create({
      id: "s1", title: "Chat 1", backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o" },
      workspacePath: "/tmp", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })
    const res = await app.request("/sessions")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].id).toBe("s1")
  })

  it("POST /session creates a session via engine", async () => {
    const res = await app.request("/session", { method: "POST" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe("s-new")
    expect(getEngine(opts).createSession).toHaveBeenCalled()
  })

  it("pickDefaultBackend falls back to claude-code when opencode is unavailable", () => {
    const registry = new BackendRegistry()
    registry.registerProxy("claude-code", createMockProxy())
    registry.registerEngine("claude-code", createMockEngine())

    expect(pickDefaultBackend(registry)).toBe("claude-code")
  })

  it("POST /session falls back to claude-code when opencode is unavailable", async () => {
    const tmpDir = createTmpDir()
    const registry = new BackendRegistry()
    const claudeProxy = createMockProxy()
    const claudeEngine = createMockEngine()
    registry.registerProxy("claude-code", claudeProxy)
    registry.registerEngine("claude-code", claudeEngine)
    const metadataStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))
    registry.setMetadataStore(metadataStore)

    const app = createApp({
      registry,
      metadataStore,
      workspacePath: "/tmp",
      eventMerger: createEventMerger(),
      getOrchestrator: () => null,
      getStatus: () => "ready",
    })

    const res = await app.request("/session", { method: "POST" })

    expect(res.status).toBe(200)
    expect(claudeEngine.createSession).toHaveBeenCalled()
  })

  it("POST /message creates a new claude-code session when opencode is unavailable", async () => {
    const tmpDir = createTmpDir()
    const registry = new BackendRegistry()
    const claudeProxy = createMockProxy()
    const claudeEngine = createMockEngine()
    registry.registerProxy("claude-code", claudeProxy)
    registry.registerEngine("claude-code", claudeEngine)
    const metadataStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))
    registry.setMetadataStore(metadataStore)

    const app = createApp({
      registry,
      metadataStore,
      workspacePath: "/tmp",
      eventMerger: createEventMerger(),
      getOrchestrator: () => null,
      getStatus: () => "ready",
    })

    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello", mode: "build" }),
    })

    expect(res.status).toBe(200)
    expect(claudeEngine.createSession).toHaveBeenCalled()
    expect(claudeProxy.sendMessage).toHaveBeenCalled()
  })

  it("POST /skill falls back to claude-code when opencode is unavailable", async () => {
    const tmpDir = createTmpDir()
    const skillsDir = createTmpDir()
    fs.mkdirSync(path.join(skillsDir, "test-skill"), { recursive: true })
    fs.writeFileSync(
      path.join(skillsDir, "test-skill", "SKILL.md"),
      [
        "---",
        "name: test-skill",
        "description: Test skill",
        "stage: bugfix",
        "---",
        "You are a test skill.",
      ].join("\n"),
      "utf-8",
    )

    const registry = new BackendRegistry()
    const claudeProxy = createMockProxy()
    const claudeEngine = createMockEngine()
    registry.registerProxy("claude-code", claudeProxy)
    registry.registerEngine("claude-code", claudeEngine)
    const metadataStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))
    registry.setMetadataStore(metadataStore)

    const app = createApp({
      registry,
      metadataStore,
      workspacePath: "/tmp",
      eventMerger: createEventMerger(),
      getOrchestrator: () => null,
      getStatus: () => "ready",
      skillsDir,
    })

    const res = await app.request("/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillName: "test-skill", content: "hello" }),
    })

    expect(res.status).toBe(200)
    expect(claudeEngine.createSession).toHaveBeenCalled()
    expect(claudeProxy.sendMessage).toHaveBeenCalled()
  })

  it("GET /config returns proxied config from all backends", async () => {
    vi.mocked(getProxy(opts).getConfig).mockResolvedValueOnce({
      models: [{ id: "gpt-4o", name: "GPT-4o", providerID: "openai" }],
      workspacePath: "/tmp",
    })
    const res = await app.request("/config")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.workspacePath).toBe("/tmp")
  })

  it("GET /health returns server status and backend statuses", async () => {
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ready")
    expect(body.backends).toBeDefined()
    expect(body.backends["opencode"]).toBe("ready")
  })

  it("DELETE /session/:id with pipeline-owned session returns 409", async () => {
    const orchestrator = {
      getActivePipelineId: () => "p1",
      isSessionOwnedByPipeline: (id: string) => id === "protected-sess",
    }
    const appWithOrch = createApp(createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    }))
    const res = await appWithOrch.request("/session/protected-sess", { method: "DELETE" })
    expect(res.status).toBe(409)
  })

  it("returns 200 with empty models when backend proxy is unavailable", async () => {
    vi.mocked(getProxy(opts).getConfig).mockRejectedValueOnce(new Error("ECONNREFUSED"))
    const res = await app.request("/config")
    // /config now catches per-backend errors and returns a merged result
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.models).toEqual([])
  })

  it("returns 503 when orchestrator is not ready", async () => {
    const appNotReady = createApp(createTestAppOptions({
      getStatus: () => "starting",
    }))
    const res = await appNotReady.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Build auth", mode: "feature" }),
    })
    expect(res.status).toBe(503)
  })

  it("PUT /favorites upserts and emits canonical order", async () => {
    const favStore = createTmpFavoritesStore()
    const appWithFav = createApp(createTestAppOptions({ favoritesStore: favStore }))
    const res = await appWithFav.request("/favorites", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerID: "anthropic", modelID: "sonnet", variant: "thinking" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.favorites[0].favoriteKey).toBe("anthropic::sonnet::thinking")
  })

  it("PUT /favorites normalizes empty variant to undefined", async () => {
    const favStore = createTmpFavoritesStore()
    const appWithFav = createApp(createTestAppOptions({ favoritesStore: favStore }))
    const res = await appWithFav.request("/favorites", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerID: "anthropic", modelID: "sonnet", variant: "   " }),
    })
    expect(res.status).toBe(200)
    const list = await favStore.listFavorites()
    expect(list[0].variant).toBeUndefined()
  })

  it("POST /favorites/reorder rejects unknown and duplicate keys", async () => {
    const favStore = createTmpFavoritesStore()
    const appWithFav = createApp(createTestAppOptions({ favoritesStore: favStore }))
    const res = await appWithFav.request("/favorites/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favoriteKeys: ["anthropic::sonnet::__none__", "anthropic::sonnet::__none__"] }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /favorites/reorder rejects unknown keys", async () => {
    const favStore = createTmpFavoritesStore()
    await favStore.upsertFavorite({ providerID: "anthropic", modelID: "sonnet" })
    const appWithFav = createApp(createTestAppOptions({ favoritesStore: favStore }))
    const res = await appWithFav.request("/favorites/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favoriteKeys: ["unknown::model::__none__"] }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /message keeps existing model/variant validation semantics", async () => {
    vi.mocked(getProxy(opts).getConfig).mockResolvedValue({
      models: [{ id: "gpt-4.1", providerID: "openai", name: "GPT 4.1" }],
      workspacePath: "/tmp",
    })
    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "hi",
        mode: "build",
        model: { providerID: "x", modelID: "missing" },
      }),
    })
    expect(res.status).toBe(400)
  })
})

describe("POST /message routing", () => {
  it("feature mode + no pipeline → creates pipeline", async () => {
    let pipelineStarted = false
    const orchestrator = {
      hasActivePipeline: () => false,
      startPipelineAsync: (content: string, opts?: any) => {
        pipelineStarted = true
        return { pipelineId: "p1", completion: Promise.resolve() }
      },
      getActivePipelineId: () => "p1",
      isSessionOwnedByPipeline: () => false,
    }
    const app = createApp(createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    }))
    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Build auth", mode: "feature" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.pipelineId).toBe("p1")
    expect(pipelineStarted).toBe(true)
  })

  it("build mode + no pipeline → forwards to backend proxy", async () => {
    const opts = createTestAppOptions()
    const app = createApp(opts)
    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello", mode: "build", sessionId: "s1" }),
    })
    expect(res.status).toBe(200)
    expect(getProxy(opts).sendMessage).toHaveBeenCalled()
  })

  it("build mode succeeds even when pipeline is active", async () => {
    const orchestrator = {
      hasActivePipeline: () => true,
      isSessionOwnedByPipeline: () => false,
    }
    const app = createApp(createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    }))
    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello", mode: "build", sessionId: "s1" }),
    })
    expect(res.status).toBe(200)
  })

  it("feature mode with pipelineId routes to that specific pipeline", async () => {
    const opts = createTestAppOptions()
    let routedToSession: string | null = null
    const orchestrator = {
      hasActivePipeline: () => true,
      hasPipeline: (id: string) => id === "p1",
      getActiveStageName: (_id: string) => "brainstorm",
      getActiveStageSessionId: (_id: string) => "brainstorm-sess",
      isStageInterrupted: (_id: string) => false,
      isSessionOwnedByPipeline: () => false,
      routeStageMessage: async (sessionId: string) => { routedToSession = sessionId },
    }
    const app = createApp({ ...opts, getOrchestrator: () => orchestrator as any })
    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Add OAuth support", mode: "feature", pipelineId: "p1" }),
    })
    expect(res.status).toBe(200)
    // routeStageMessage is fire-and-forget — give it a tick
    await new Promise(r => setTimeout(r, 10))
    expect(routedToSession).toBe("brainstorm-sess")
  })

  it("routes message to stage session when pipeline is idle on disk (rehydration)", async () => {
    let routedToSession: string | null = null
    let rehydratedId: string | null = null
    const orchestrator = {
      hasActivePipeline: () => false,
      hasPipeline: () => false,
      isSessionOwnedByPipeline: () => false,
      rehydrateFromDisk: async (id: string) => { rehydratedId = id; return true },
      getActiveStageSessionId: () => "brainstorm-sess-123",
      isStageInterrupted: () => false,
      routeStageMessage: async (sessionId: string) => { routedToSession = sessionId },
    }
    const opts = createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    })
    const app = createApp(opts)

    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Go with approach B", mode: "feature", pipelineId: "p-idle" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.pipelineId).toBe("p-idle")
    expect(rehydratedId).toBe("p-idle")
    // routeStageMessage is fire-and-forget — give it a tick
    await new Promise(r => setTimeout(r, 10))
    expect(routedToSession).toBe("brainstorm-sess-123")
  })

  it("feature mode + interrupted stage routes and clears interrupt", async () => {
    let interruptCleared = false
    const orchestrator = {
      hasActivePipeline: () => true,
      hasPipeline: (id: string) => id === "p1",
      getActiveStageName: (_id: string) => "implement",
      getActiveStageSessionId: (_id: string) => "stage-sess",
      isStageInterrupted: (_id: string) => true,
      clearInterruptAndRoute: async (sessionId: string, content: string) => {
        interruptCleared = true
      },
      isSessionOwnedByPipeline: () => false,
    }
    const app = createApp(createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    }))
    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Fix that bug instead", mode: "feature", pipelineId: "p1" }),
    })
    expect(res.status).toBe(200)
    expect(interruptCleared).toBe(true)
  })

  it("feature mode without pipelineId starts a new pipeline", async () => {
    const orchestrator = {
      hasActivePipeline: () => true,
      startPipelineAsync: () => ({ pipelineId: "p-new", completion: Promise.resolve() }),
      isSessionOwnedByPipeline: () => false,
    }
    const app = createApp(createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    }))
    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Stop", mode: "feature" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.pipelineId).toBe("p-new")
  })

  it("passes autonomous flag to orchestrator.startPipelineAsync", async () => {
    const startSpy = vi.fn().mockReturnValue({ pipelineId: "pipe-1", completion: Promise.resolve() })
    const orchestrator = {
      hasActivePipeline: () => false,
      startPipelineAsync: startSpy,
      isSessionOwnedByPipeline: () => false,
    }
    const app = createApp(createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    }))
    await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "build a todo app",
        mode: "feature",
        autonomous: true,
      }),
    })

    expect(startSpy).toHaveBeenCalledWith("build a todo app", expect.objectContaining({
      autonomous: true,
    }))
  })
})

describe("pending interaction lifecycle", () => {
  it("clears pending interaction ids on permission/question/reject replies", async () => {
    const replied: Array<{ sessionId: string; requestId: string }> = []
    const orchestrator = {
      hasActivePipeline: () => false,
      hasPipeline: () => false,
      getActiveStageName: () => null,
      getActiveStageSessionId: () => null,
      isStageInterrupted: () => false,
      isStageInterruptedForSession: () => false,
      isSessionOwnedByPipeline: () => false,
      findPipelineIdBySession: () => null,
      startPipelineAsync: () => ({ pipelineId: "p1", completion: Promise.resolve() }),
      abortStageSession: async () => {},
      resumeStageSession: async () => {},
      clearInterruptAndRoute: async () => {},
      handleSignal: async () => {},
      handleStuckRetry: async () => {},
      failPipeline: () => {},
      getActivePipelineIds: () => [],
      handleAutoPermission: async () => {},
      handleInteractionReplied: (sessionId: string, requestId: string) => replied.push({ sessionId, requestId }),
    }

    const app = createApp(createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    }))

    const payload = { requestId: "req-1" }
    const permissionRes = await app.request("/session/s1/permission", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, reply: "once" }),
    })
    expect(permissionRes.status).toBe(200)

    const questionRes = await app.request("/session/s1/question", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, answers: [["yes"]] }),
    })
    expect(questionRes.status).toBe(200)

    const rejectRes = await app.request("/session/s1/question/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    expect(rejectRes.status).toBe(200)

    expect(replied).toEqual([
      { sessionId: "s1", requestId: "req-1" },
      { sessionId: "s1", requestId: "req-1" },
      { sessionId: "s1", requestId: "req-1" },
    ])
  })
})

describe("Unified SSE", () => {
  it("GET /events returns SSE stream", async () => {
    const app = createApp(createTestAppOptions())
    const res = await app.request("/events", {
      headers: { Accept: "text/event-stream" },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/event-stream")
  })
})

describe("Abort and Resume", () => {
  it("POST /session/:id/abort for pipeline session sets interrupted", async () => {
    let interrupted = false
    const orchestrator = {
      getActivePipelineId: () => "p1",
      isSessionOwnedByPipeline: (id: string) => id === "stage-sess",
      abortStageSession: async (id: string) => { interrupted = true },
    }
    const app = createApp(createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    }))
    const res = await app.request("/session/stage-sess/abort", { method: "POST" })
    expect(res.status).toBe(200)
    expect(interrupted).toBe(true)
  })

  it("POST /session/:id/resume clears interrupted", async () => {
    let resumed = false
    const orchestrator = {
      isSessionOwnedByPipeline: (id: string) => id === "stage-sess",
      isStageInterruptedForSession: () => true,
      resumeStageSession: async (id: string) => { resumed = true },
    }
    const app = createApp(createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    }))
    const res = await app.request("/session/stage-sess/resume", { method: "POST" })
    expect(res.status).toBe(200)
    expect(resumed).toBe(true)
  })

  it("POST /session/:id/resume when not interrupted returns 409", async () => {
    const orchestrator = {
      isSessionOwnedByPipeline: (id: string) => id === "stage-sess",
      isStageInterruptedForSession: () => false,
    }
    const app = createApp(createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    }))
    const res = await app.request("/session/stage-sess/resume", { method: "POST" })
    expect(res.status).toBe(409)
  })
})

describe("Pipeline endpoints", () => {
  it("POST /pipeline/signal dispatches to orchestrator signal handler", async () => {
    let signalReceived: any = null
    const orchestrator = {
      getActivePipelineId: () => "p1",
      handleSignal: async (signal: any) => { signalReceived = signal },
      isSessionOwnedByPipeline: () => false,
    }
    const app = createApp(createTestAppOptions({
      getOrchestrator: () => orchestrator as any,
    }))
    const res = await app.request("/pipeline/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stage_complete", sessionId: "s1", outputPath: "spec.md" }),
    })
    expect(res.status).toBe(200)
    expect(signalReceived).not.toBeNull()
    expect(signalReceived.type).toBe("stage_complete")
  })

})

describe("REST response headers", () => {
  it("includes X-Atelier-Seq header on session list", async () => {
    const opts = createTestAppOptions()
    const app = createApp(opts)
    opts.eventMerger.emit({ type: "pipeline_completed", pipelineId: "p1" })
    const res = await app.request("/sessions")
    expect(res.headers.get("X-Atelier-Seq")).toBe("1")
  })
})

describe("/log-events SSE endpoint", () => {
  it("returns 200 with text/event-stream content type", async () => {
    const app = createApp(createTestAppOptions({
      onLogSubscribe: () => () => {},
    }))
    const res = await app.request("/log-events")
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/event-stream")
  })

  it("accepts level query parameter", async () => {
    const app = createApp(createTestAppOptions({
      onLogSubscribe: () => () => {},
    }))
    const res = await app.request("/log-events?level=error")
    expect(res.status).toBe(200)
  })

  it("rejects invalid level parameter with 400", async () => {
    const app = createApp(createTestAppOptions({
      onLogSubscribe: () => () => {},
    }))
    const res = await app.request("/log-events?level=invalid")
    expect(res.status).toBe(400)
  })
})

// --- New BackendRegistry-specific tests ---

describe("App with BackendRegistry", () => {
  it("POST /session resolves backend from model", async () => {
    const opts = createTestAppOptions()
    // Register a second backend (claude-code)
    const ccProxy = createMockProxy()
    const ccEngine = createMockEngine()
    vi.mocked(ccEngine.createSession).mockResolvedValue({ id: "cc-sess-1" })
    opts.registry.registerProxy("claude-code", ccProxy)
    opts.registry.registerEngine("claude-code", ccEngine)

    const app = createApp(opts)
    const res = await app.request("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe("cc-sess-1")
    expect(ccEngine.createSession).toHaveBeenCalled()
    // OpenCode engine should NOT have been called
    expect(getEngine(opts).createSession).not.toHaveBeenCalled()
  })

  it("GET /sessions reads from metadata store", async () => {
    const opts = createTestAppOptions()
    opts.metadataStore.create({
      id: "s1", title: "Test", backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/tmp", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })
    const app = createApp(opts)
    const res = await app.request("/sessions")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data).toHaveLength(1)
    expect(data[0].id).toBe("s1")
  })

  it("GET /config merges models from all ready backends", async () => {
    const opts = createTestAppOptions()
    const ccProxy = createMockProxy()
    opts.registry.registerProxy("claude-code", ccProxy)
    opts.registry.registerEngine("claude-code", createMockEngine())

    vi.mocked(ccProxy.getConfig).mockResolvedValue({
      models: [{ id: "claude-sonnet-4-6", name: "Sonnet", providerID: "anthropic" }],
      workspacePath: "/ws",
    })
    vi.mocked(getProxy(opts).getConfig).mockResolvedValue({
      models: [{ id: "gpt-4o", name: "GPT-4o", providerID: "openai" }],
      workspacePath: "/ws",
    })

    const app = createApp(opts)
    const res = await app.request("/config")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.models).toHaveLength(2)
    expect(data.models.map((m: any) => m.providerID).sort()).toEqual(["anthropic", "openai"])
  })

  it("GET /health reports per-backend status", async () => {
    const opts = createTestAppOptions()
    opts.registry.registerProxy("claude-code", createMockProxy())
    opts.registry.registerEngine("claude-code", createMockEngine())

    const app = createApp(opts)
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.backends).toBeDefined()
    expect(data.backends["claude-code"]).toBe("ready")
    expect(data.backends["opencode"]).toBe("ready")
  })

  it("GET /health works before any backend is ready (lazy init)", async () => {
    const tmpDir = createTmpDir()
    const registry = new BackendRegistry()
    const metadataStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))
    registry.setMetadataStore(metadataStore)

    const app = createApp({
      registry,
      metadataStore,
      workspacePath: "/tmp",
      eventMerger: createEventMerger(),
      getOrchestrator: () => null,
      getStatus: () => "starting",
    })

    const res = await app.request("/health")
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe("starting")
    // No backends ready yet
    expect(Object.keys(data.backends)).toHaveLength(0)
  })
})

describe("Skill Endpoints", () => {
  const skillsDir = path.resolve(import.meta.dirname, "../../skills")

  it("GET /skills returns skill catalog from disk", async () => {
    const app = createApp(createTestAppOptions({ skillsDir }))
    const res = await app.request("/skills")
    expect(res.status).toBe(200)
    const skills = await res.json() as any[]
    expect(skills.length).toBeGreaterThanOrEqual(15)
    const names = skills.map((s: any) => s.name)
    expect(names).toContain("brainstorming-feature")
    expect(names).toContain("brainstorming-epic")
    expect(names).toContain("brainstorming-roadmap")
    expect(names).toContain("compiling-brainstorm")
    expect(names).toContain("compiling-plan")
    expect(names).not.toContain("brainstorming")
    expect(names).not.toContain("compiling")
    expect(names).toContain("bugfixing")
    for (const skill of skills) {
      expect(skill).toHaveProperty("name")
      expect(skill).toHaveProperty("description")
      expect(skill).toHaveProperty("stage")
    }
  })

  it("GET /skills returns sorted list", async () => {
    const app = createApp(createTestAppOptions({ skillsDir }))
    const res = await app.request("/skills")
    const skills = await res.json() as any[]
    const names = skills.map((s: any) => s.name)
    expect(names).toEqual([...names].sort())
  })

  it("GET /skills returns empty when skillsDir is not configured", async () => {
    const app = createApp(createTestAppOptions())
    const res = await app.request("/skills")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it("GET /skills caches results", async () => {
    const app = createApp(createTestAppOptions({ skillsDir }))
    const res1 = await app.request("/skills")
    const skills1 = await res1.json()
    const res2 = await app.request("/skills")
    const skills2 = await res2.json()
    expect(skills1).toEqual(skills2)
  })

  it("POST /skill returns 400 for missing skillName", async () => {
    const app = createApp(createTestAppOptions({ skillsDir }))
    const res = await app.request("/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /skill returns 400 for unknown skill", async () => {
    const app = createApp(createTestAppOptions({ skillsDir }))
    const res = await app.request("/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillName: "nonexistent-skill", content: "hello" }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /skill creates session and sends message with skill prepended to content", async () => {
    const opts = createTestAppOptions({ skillsDir })
    const app = createApp(opts)
    const res = await app.request("/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillName: "brainstorming-feature", content: "Build an API" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.sessionId).toBe("s-new")
    expect(getEngine(opts).createSession).toHaveBeenCalled()
    expect(getProxy(opts).sendMessage).toHaveBeenCalledWith(
      "s-new",
      expect.objectContaining({
        content: expect.stringContaining("Brainstorming"),
        system: undefined,
      }),
    )
    // Verify user content is appended after skill
    const call = getProxy(opts).sendMessage.mock.calls[0]!
    expect((call[1] as any).content).toContain("Build an API")
  })

  it("POST /skill sends to existing session when sessionId is provided", async () => {
    const opts = createTestAppOptions({ skillsDir })
    const app = createApp(opts)
    const res = await app.request("/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillName: "brainstorming-feature", content: "Build an API", sessionId: "existing-session" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.sessionId).toBe("existing-session")
    expect(getEngine(opts).createSession).not.toHaveBeenCalled()
    expect(getProxy(opts).sendMessage).toHaveBeenCalledWith(
      "existing-session",
      expect.objectContaining({
        content: expect.stringContaining("Brainstorming"),
        system: undefined,
      }),
    )
    const call = getProxy(opts).sendMessage.mock.calls[0]!
    expect((call[1] as any).content).toContain("Build an API")
  })

  it("POST /skill routes claude-code skill via slash command content", async () => {
    const opts = createTestAppOptions({ skillsDir })
    const ccProxy = createMockProxy()
    const ccEngine = createMockEngine()
    opts.registry.registerProxy("claude-code", ccProxy)
    opts.registry.registerEngine("claude-code", ccEngine)
    opts.metadataStore.create({
      id: "existing-claude",
      title: "Claude session",
      backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/tmp",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      parentId: null,
      status: "idle",
    })

    const app = createApp(opts)
    const res = await app.request("/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillName: "brainstorming-feature", content: "Build an API", sessionId: "existing-claude" }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.ok).toBe(true)
    expect(body.sessionId).toBe("existing-claude")
    expect(ccEngine.createSession).not.toHaveBeenCalled()
    expect(ccProxy.sendMessage).toHaveBeenCalledWith(
      "existing-claude",
      expect.objectContaining({
        content: "/brainstorming-feature\nBuild an API",
        system: undefined,
      }),
    )
  })

  it("POST /skill uses claude-code slash routing for new anthropic session", async () => {
    const opts = createTestAppOptions({ skillsDir })
    const ccProxy = createMockProxy()
    const ccEngine = createMockEngine()
    opts.registry.registerProxy("claude-code", ccProxy)
    opts.registry.registerEngine("claude-code", ccEngine)
    ;(ccProxy.getConfig as any).mockResolvedValue({
      models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", providerID: "anthropic" }],
      workspacePath: "/tmp",
    })

    const app = createApp(opts)
    const res = await app.request("/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        skillName: "brainstorming-feature",
        content: "Build an API",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.sessionId).toBe("s-new")
    expect(ccEngine.createSession).toHaveBeenCalled()
    expect(ccProxy.sendMessage).toHaveBeenCalledWith(
      "s-new",
      expect.objectContaining({
        content: "/brainstorming-feature\nBuild an API",
        system: undefined,
      }),
    )
  })

  it("POST /skill returns 503 when skillsDir is not configured", async () => {
    const app = createApp(createTestAppOptions())
    const res = await app.request("/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillName: "brainstorming-feature", content: "hello" }),
    })
    expect(res.status).toBe(503)
  })
})

describe("POST /session/:id/fork", () => {
  it("forks a session via engine and returns new session ID", async () => {
    const opts = createTestAppOptions()
    const engine = getEngine(opts)

    opts.metadataStore.create({
      id: "s-src",
      title: "Source",
      backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o-mini" },
      workspacePath: "/tmp",
      createdAt: 1000,
      lastActiveAt: 1000,
      parentId: null,
      status: "idle",
    })

    const app = createApp(opts)
    const res = await app.request("/session/s-src/fork", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "My fork" }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe("s-forked")
    expect(engine.forkSession).toHaveBeenCalledWith("s-src", { title: "My fork" })
  })

  it("returns 502 when engine throws", async () => {
    const opts = createTestAppOptions()
    const engine = getEngine(opts)
    ;(engine.forkSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Session not found"))

    opts.metadataStore.create({
      id: "s-missing",
      title: "Ghost",
      backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o-mini" },
      workspacePath: "/tmp",
      createdAt: 1000,
      lastActiveAt: 1000,
      parentId: null,
      status: "idle",
    })

    const app = createApp(opts)
    const res = await app.request("/session/s-missing/fork", { method: "POST" })

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toContain("not found")
  })

  it("emits session.created event after forking", async () => {
    const opts = createTestAppOptions()

    opts.metadataStore.create({
      id: "s-emit",
      title: "Source",
      backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o-mini" },
      workspacePath: "/tmp",
      createdAt: 1000,
      lastActiveAt: 1000,
      parentId: null,
      status: "idle",
    })

    // Pre-create fork metadata so merger.emit finds it
    opts.metadataStore.create({
      id: "s-forked",
      title: "Source (fork)",
      backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o-mini" },
      workspacePath: "/tmp",
      createdAt: 2000,
      lastActiveAt: 2000,
      parentId: null,
      status: "idle",
      forkedFrom: "s-emit",
    })

    const emitted: unknown[] = []
    opts.eventMerger.subscribe((e: unknown) => emitted.push(e))

    const app = createApp(opts)
    await app.request("/session/s-emit/fork", { method: "POST" })

    const sessionEvent = emitted.find((e: any) =>
      e.type === "session.created" &&
      e.properties?.info?.id === "s-forked"
    )
    expect(sessionEvent).toBeTruthy()
    expect((sessionEvent as any).properties.info.title).toBe("Source (fork)")
    expect((sessionEvent as any).properties.info.directory).toBe("/tmp")
  })

  it("works with no request body (title defaults)", async () => {
    const opts = createTestAppOptions()

    opts.metadataStore.create({
      id: "s-nobody",
      title: "Source",
      backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o-mini" },
      workspacePath: "/tmp",
      createdAt: 1000,
      lastActiveAt: 1000,
      parentId: null,
      status: "idle",
    })

    const app = createApp(opts)
    const res = await app.request("/session/s-nobody/fork", { method: "POST" })

    expect(res.status).toBe(200)
    const engine = getEngine(opts)
    expect(engine.forkSession).toHaveBeenCalledWith("s-nobody", { title: undefined })
  })
})

describe("POST /shutdown", () => {
  it("returns 200 and calls onShutdown callback", async () => {
    const onShutdown = vi.fn(async () => {})
    const opts = createTestAppOptions({ onShutdown })
    const app = createApp(opts)

    const res = await app.request("/shutdown", { method: "POST" })
    expect(res.status).toBe(200)
    expect(onShutdown).toHaveBeenCalledOnce()
  })

  it("returns 501 when onShutdown is not configured", async () => {
    const opts = createTestAppOptions()
    const app = createApp(opts)

    const res = await app.request("/shutdown", { method: "POST" })
    expect(res.status).toBe(501)
  })
})
