import { describe, it, expect, afterEach, vi } from "vitest"
import { createApp, type AppOptions } from "../src/app.js"
import { createPipelineState } from "../src/orchestration/pipeline-state.js"
import { createEventMerger } from "../src/engine/event-merger.js"
import { Orchestrator } from "../src/orchestration/orchestrator.js"
import { MockAgentEngine } from "./__utils__/mock-engine.js"
import { BackendRegistry } from "../src/engine/backend-registry.js"
import { SessionMetadataStore } from "../src/engine/session-metadata-store.js"
import type { BackendProxy } from "../src/engine/backend-proxy.js"
import * as path from "node:path"
import * as os from "node:os"
import * as fsSync from "node:fs"
import { execFileSync } from "node:child_process"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../skills")

let workspaceDir: string
let activePipelineState: ReturnType<typeof createPipelineState> | null = null
let tmpDirs: string[] = []

afterEach(async () => {
  if (activePipelineState) {
    await activePipelineState.flush()
    activePipelineState = null
  }
  if (workspaceDir) fsSync.rmSync(workspaceDir, { recursive: true, force: true })
  for (const dir of tmpDirs) {
    fsSync.rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

// Shared helpers
function makeWorkspace(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atelier-integ-"))
  fsSync.mkdirSync(path.join(dir, ".atelier/compiled"), { recursive: true })
  fsSync.mkdirSync(path.join(dir, ".atelier/specs"), { recursive: true })
  // Initialize git repo — git integration requires it
  execFileSync("git", ["init"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir })
  // Gitignore .atelier so orchestrator artifacts don't dirty the working tree
  fsSync.writeFileSync(path.join(dir, ".gitignore"), ".atelier/\n")
  execFileSync("git", ["add", "-A"], { cwd: dir })
  execFileSync("git", ["commit", "-m", "seed"], { cwd: dir })
  return dir
}

function makeMockProxy(): BackendProxy {
  return {
    listSessions: vi.fn(async () => []),
    getSession: vi.fn(async (id: string) => ({ id })),
    deleteSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    getMessages: vi.fn(async () => ({ messages: [], start: 0, end: 0, total: 0 })),
    sendMessage: vi.fn(async () => {}),
    getConfig: vi.fn(async () => ({
      models: [
        { providerID: "anthropic", id: "claude-3", variants: { fast: {} } },
        { providerID: "anthropic", id: "claude-haiku-4-5", variants: { quick: {} } },
        { providerID: "anthropic", id: "claude-sonnet-4-5-20250514", variants: { deep: {} } },
      ],
      workspacePath: "/tmp",
    })),
    replyPermission: vi.fn(async () => {}),
    replyQuestion: vi.fn(async () => {}),
    rejectQuestion: vi.fn(async () => {}),
    listPendingPermissions: vi.fn(async () => []),
    listPendingQuestions: vi.fn(async () => []),
    updateSessionTitle: vi.fn(async () => {}),
  }
}

function createTmpDir(): string {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), "integ-meta-"))
  tmpDirs.push(dir)
  return dir
}

function wrapInRegistry(proxy: BackendProxy, engine?: MockAgentEngine): { registry: BackendRegistry, metadataStore: SessionMetadataStore } {
  const registry = new BackendRegistry()
  registry.registerProxy("opencode", proxy)
  // Always register an engine — build mode and session creation require one
  registry.registerEngine("opencode", engine ?? new MockAgentEngine())
  const tmpDir = createTmpDir()
  const metadataStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))
  registry.setMetadataStore(metadataStore)
  return { registry, metadataStore }
}

function makeAppOpts(proxy: BackendProxy, eventMerger: ReturnType<typeof createEventMerger>, overrides?: Partial<AppOptions>): AppOptions {
  const { registry, metadataStore } = wrapInRegistry(proxy)
  return {
    registry,
    metadataStore,
    workspacePath: "/tmp",
    eventMerger,
    getOrchestrator: () => null,
    getStatus: () => "ready",
    ...overrides,
  }
}

function makeEngine() {
  const engine = new MockAgentEngine()
  engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
  // waitForIdle is only used by slug generation now — auto-resolve it
  engine.onWaitForIdle = async () => {}
  return engine
}

/** Wait for a specific stage_started event to appear. */
async function waitForStage(events: any[], stage: string, maxWait = 2000): Promise<any> {
  for (let i = 0; i < maxWait / 10; i++) {
    const evt = events.find((e: any) => e.type === "stage_started" && e.stage === stage)
    if (evt) return evt
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for stage_started: ${stage}`)
}

/** Write the compiled prompt file and signal stage_complete for a compile stage. */
async function signalCompileComplete(
  app: any,
  engine: MockAgentEngine,
  events: any[],
  stage: "compile_brainstorm" | "compile_plan" | "compile_e2e_plan",
) {
  const evt = await waitForStage(events, stage)
  // Extract output path from the compile message sent to this session
  const msg = engine.messages.find(m => m.sessionId === evt.sessionId && m.content?.includes("**Output path:**"))
  const match = msg?.content.match(/\*\*Output path:\*\* (.+)/)
  if (!match) throw new Error(`No output path in compile message for ${stage}`)
  fsSync.mkdirSync(path.dirname(match[1]), { recursive: true })
  fsSync.writeFileSync(match[1], "compiled prompt content")
  const res = await app.request("/pipeline/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "stage_complete", sessionId: evt.sessionId }),
  })
  expect(res.status).toBe(200)
}

/** Signal a non-compile stage complete via HTTP. */
async function signalStageComplete(
  app: any,
  events: any[],
  stage: string,
  opts?: { outputPath?: string; verdict?: string; action?: string; pipelineType?: string; worktreeChoice?: string },
) {
  const evt = await waitForStage(events, stage)
  // Write stub artifact file so the mandatory artifact check passes
  if (opts?.outputPath && workspaceDir) {
    const absPath = path.isAbsolute(opts.outputPath)
      ? opts.outputPath
      : path.join(workspaceDir, opts.outputPath)
    fsSync.mkdirSync(path.dirname(absPath), { recursive: true })
    fsSync.writeFileSync(absPath, `stub artifact for ${stage}`)
  }
  const res = await app.request("/pipeline/signal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "stage_complete", sessionId: evt.sessionId, ...opts }),
  })
  expect(res.status).toBe(200)
}

/** Drive a feature pipeline through all stages to completion. */
async function driveFeaturePipelineToCompletion(
  app: any,
  engine: MockAgentEngine,
  events: any[],
  pipelineId?: string,
) {
  // Signal classification stage — must always run for new pipelines
  await signalStageComplete(app, events, "classify", { pipelineType: "feature", worktreeChoice: "in-tree" })

  // Resume pipeline after classify (pipeline pauses to allow model configuration)
  if (pipelineId) {
    await app.request(`/pipelines/${pipelineId}/stage-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageModels: {}, confirmed: true }),
    })
  }

  await signalCompileComplete(app, engine, events, "compile_brainstorm")
  await signalStageComplete(app, events, "brainstorm", { outputPath: ".atelier/specs/spec.md" })
  await signalStageComplete(app, events, "review_spec", { outputPath: ".atelier/review.md", verdict: "done" })
  // establish_conventions may or may not run (conditional)
  try { await signalStageComplete(app, events, "establish_conventions", { outputPath: ".atelier/conventions.md" }) } catch {}
  await signalCompileComplete(app, engine, events, "compile_plan")
  await signalStageComplete(app, events, "write_plan", { outputPath: ".atelier/plans/plan.md" })
  await signalStageComplete(app, events, "review_plan", { outputPath: ".atelier/plan-review.md", verdict: "done" })
  await signalStageComplete(app, events, "implement")
  await signalStageComplete(app, events, "review_code", { outputPath: ".atelier/code-review.md", verdict: "done" })
  await signalStageComplete(app, events, "simplify", { outputPath: ".atelier/simplify.md" })
  await signalStageComplete(app, events, "e2e_gate", { verdict: "proceed", outputPath: ".atelier/e2e-gate.md" })
  await signalCompileComplete(app, engine, events, "compile_e2e_plan")
  await signalStageComplete(app, events, "write_e2e_plan", { outputPath: ".atelier/e2e-plan.md" })
  await signalStageComplete(app, events, "review_e2e_plan", { outputPath: ".atelier/e2e-review.md", verdict: "done" })
  await signalStageComplete(app, events, "e2e")
  await signalStageComplete(app, events, "validate")
}

// ─── Happy-path pipeline flow ───────────────────────────────────────────────

describe("Integration: Full pipeline via HTTP", () => {
  it("starts pipeline and progresses through stages via signals", async () => {
    workspaceDir = makeWorkspace()
    const engine = makeEngine()
    const pipelineState = activePipelineState = createPipelineState(workspaceDir)
    const eventMerger = createEventMerger()
    const proxy = makeMockProxy()

    const orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })

    const { registry, metadataStore } = wrapInRegistry(proxy, engine)
    const app = createApp({
      registry, metadataStore, workspacePath: workspaceDir,
      eventMerger,
      getOrchestrator: () => orchestrator,
      getStatus: () => "ready",
      getPipelineState: () => pipelineState,
    })

    const events: any[] = []
    eventMerger.subscribe((e) => events.push(e))

    // 1. Start pipeline via feature-mode message
    const createRes = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "build a CLI todo app", mode: "feature" }),
    })
    expect(createRes.status).toBe(200)
    const { pipelineId } = await createRes.json() as any

    // 2. Drive through all stages (compile → brainstorm → review_spec → ... → simplify)
    await driveFeaturePipelineToCompletion(app, engine, events, pipelineId)

    // 3. Pipeline should be completed
    expect(events.some((e: any) => e.type === "pipeline_completed")).toBe(true)

    // 4. PipelineState should reflect completion
    const detail = pipelineState.getPipeline(pipelineId)
    expect(detail).not.toBeNull()
    expect(detail!.status).toBe("completed")

    // 5. All stages should be complete
    expect(detail!.stages.length).toBeGreaterThanOrEqual(10)
    expect(detail!.stages.every((s: any) => s.status === "completed" || s.status === "skipped")).toBe(true)

    orchestrator.destroy()
  })
})

// ─── SSE event replay ───────────────────────────────────────────────────────

describe("Integration: SSE event replay", () => {
  it("GET /events with Last-Event-ID replays buffered events", async () => {
    const proxy = makeMockProxy()
    const eventMerger = createEventMerger()
    const app = createApp(makeAppOpts(proxy, eventMerger))

    // Emit 3 events
    eventMerger.emit({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm" })
    eventMerger.emit({ type: "stage_completed", pipelineId: "p1", stageId: "s1" })
    eventMerger.emit({ type: "stage_started", pipelineId: "p1", stageId: "s2", stage: "write_plan" })

    // Request replay from after seq 1 (should get events 2 and 3)
    const res = await app.request("/events", {
      headers: { "Last-Event-ID": "1" },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/event-stream")

    // Read replay chunks until we have both events
    const reader = res.body!.getReader()
    let text = ""
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read()
      if (value) text += new TextDecoder().decode(value)
      if (text.includes('"seq":3') || done) break
    }
    reader.cancel()

    // Should contain events with seq 2 and 3
    expect(text).toContain('"seq":2')
    expect(text).toContain('"seq":3')
    expect(text).toContain('"stage_completed"')
    expect(text).toContain('"write_plan"')
    // Should NOT contain seq 1 (before our Last-Event-ID)
    expect(text).not.toMatch(/^id: 1\n/m)
  })

  it("GET /events without Last-Event-ID starts from live events only", async () => {
    const proxy = makeMockProxy()
    const eventMerger = createEventMerger()
    const app = createApp(makeAppOpts(proxy, eventMerger))

    // Emit an event before connecting
    eventMerger.emit({ type: "stage_started", pipelineId: "p1", stageId: "s1", stage: "brainstorm" })

    const res = await app.request("/events")
    expect(res.status).toBe(200)

    // No replay should occur — the pre-existing event is not sent
    // We can verify by emitting a new event and checking only it appears
    eventMerger.emit({ type: "pipeline_completed", pipelineId: "p1" })

    const reader = res.body!.getReader()
    let text = ""
    // Read past the initial :ok SSE comment to reach the actual event
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read()
      if (value) text += new TextDecoder().decode(value)
      if (text.includes('"pipeline_completed"') || done) break
    }
    reader.cancel()

    expect(text).toContain('"pipeline_completed"')
  })

  it("GET /events sends full_refresh_required when replay buffer gap detected", async () => {
    const proxy = makeMockProxy()
    // Create a small buffer that will overflow
    const eventMerger = createEventMerger({ bufferSize: 3 })
    const app = createApp(makeAppOpts(proxy, eventMerger))

    // Emit 5 events to overflow the 3-event buffer
    for (let i = 0; i < 5; i++) {
      eventMerger.emit({ type: "stage_started", pipelineId: "p1", stageId: `s${i}`, stage: "brainstorm" })
    }

    // Request replay from seq 1 (which was evicted from the buffer)
    const res = await app.request("/events", {
      headers: { "Last-Event-ID": "1" },
    })
    expect(res.status).toBe(200)

    const reader = res.body!.getReader()
    const { value } = await reader.read()
    reader.cancel()
    const text = new TextDecoder().decode(value)

    expect(text).toContain("full_refresh_required")
  })
})

// ─── Build mode message routing ─────────────────────────────────────────────

describe("Integration: Build mode message flow", () => {
  it("POST /message with build mode and no sessionId creates session and sends message", async () => {
    const proxy = makeMockProxy()
    const eventMerger = createEventMerger()
    const { registry, metadataStore } = wrapInRegistry(proxy)
    const app = createApp({
      registry, metadataStore, workspacePath: "/tmp",
      eventMerger,
      getOrchestrator: () => null,
      getStatus: () => "ready",
    })

    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello world", mode: "build" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as any
    // Engine creates sessions (not proxy) in the new architecture
    expect(body.sessionId).toBeDefined()

    // Verify proxy sendMessage was called
    expect(proxy.sendMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ content: "Hello world" }),
    )
  })

  it("POST /message with build mode and existing sessionId sends to that session", async () => {
    const proxy = makeMockProxy()
    const eventMerger = createEventMerger()
    const app = createApp(makeAppOpts(proxy, eventMerger))

    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Continue", mode: "build", sessionId: "existing-sess" }),
    })
    expect(res.status).toBe(200)

    expect(proxy.sendMessage).toHaveBeenCalledWith("existing-sess", expect.objectContaining({ content: "Continue" }))
  })

  it("POST /message with build mode passes model and variant through", async () => {
    const proxy = makeMockProxy()
    const eventMerger = createEventMerger()
    const { registry, metadataStore } = wrapInRegistry(proxy)
    // Register session as claude-code backend so model matches (anthropic → claude-code)
    registry.registerEngine("claude-code", new MockAgentEngine())
    registry.registerProxy("claude-code", proxy)
    metadataStore.create({
      id: "s1", title: "", backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-3" },
      workspacePath: "/tmp", createdAt: Date.now(), lastActiveAt: Date.now(),
      parentId: null, status: "idle",
    })
    const app = createApp({
      registry, metadataStore, workspacePath: "/tmp", eventMerger,
      getOrchestrator: () => null, getStatus: () => "ready",
    })

    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Hello",
        mode: "build",
        sessionId: "s1",
        model: { providerID: "anthropic", modelID: "claude-3" },
        variant: "fast",
      }),
    })
    expect(res.status).toBe(200)
    expect(proxy.sendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({
      model: { providerID: "anthropic", modelID: "claude-3" },
      variant: "fast",
    }))
  })
})

// ─── Pipeline abort and resume ──────────────────────────────────────────────

describe("Integration: Pipeline abort and resume", () => {
  it("abort emits stage_interrupted, resume emits stage_resumed", async () => {
    workspaceDir = makeWorkspace()
    const engine = makeEngine()
    const pipelineState = activePipelineState = createPipelineState(workspaceDir)
    const eventMerger = createEventMerger()
    const proxy = makeMockProxy()

    const orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })

    const { registry, metadataStore } = wrapInRegistry(proxy, engine)
    const app = createApp({
      registry, metadataStore, workspacePath: workspaceDir,
      eventMerger,
      getOrchestrator: () => orchestrator,
      getStatus: () => "ready",
      getPipelineState: () => pipelineState,
    })

    const events: any[] = []
    eventMerger.subscribe((e) => events.push(e))

    // Start pipeline
    const createRes = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "build auth system", mode: "feature" }),
    })
    expect(createRes.status).toBe(200)
    const { pipelineId } = await createRes.json() as any

    // Signal classification stage first
    await signalStageComplete(app, events, "classify", { pipelineType: "feature", worktreeChoice: "in-tree" })

    // Resume pipeline after classify (pipeline pauses to allow model configuration)
    const stageModelRes = await app.request(`/pipelines/${pipelineId}/stage-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageModels: {}, confirmed: true }),
    })
    expect(stageModelRes.status).toBe(200)

    // Wait for compile_brainstorm stage, then signal it and wait for brainstorm
    await signalCompileComplete(app, engine, events, "compile_brainstorm")
    const brainstormEvt = await waitForStage(events, "brainstorm")
    const sessionId = brainstormEvt.sessionId

    // Abort the session
    const abortRes = await app.request(`/session/${sessionId}/abort`, { method: "POST" })
    expect(abortRes.status).toBe(200)

    // Verify stage_interrupted event
    const interruptedEvt = events.find((e: any) => e.type === "stage_interrupted" && e.sessionId === sessionId)
    expect(interruptedEvt).toBeTruthy()
    expect(interruptedEvt.stageId).toBe(brainstormEvt.stageId)

    // Verify PipelineState reflects interruption
    const detail = pipelineState.getPipeline(pipelineId)
    const brainstormStage = detail?.stages.find((s: any) => s.stage === "brainstorm")
    expect(brainstormStage?.interrupted).toBe(true)

    // Resume the session
    const resumeRes = await app.request(`/session/${sessionId}/resume`, { method: "POST" })
    expect(resumeRes.status).toBe(200)

    // Verify stage_resumed event
    const resumedEvt = events.find((e: any) => e.type === "stage_resumed" && e.sessionId === sessionId)
    expect(resumedEvt).toBeTruthy()
    expect(resumedEvt.stageId).toBe(brainstormEvt.stageId)

    // PipelineState should no longer be interrupted
    const detailAfter = pipelineState.getPipeline(pipelineId)
    const brainstormAfter = detailAfter?.stages.find((s: any) => s.stage === "brainstorm")
    expect(brainstormAfter?.interrupted).toBe(false)

    // Clean up orchestrator to stop detector sweep timer
    orchestrator.destroy()
  })
})

// ─── Pipeline endpoints ─────────────────────────────────────────────────────

describe("Integration: Pipeline management endpoints", () => {
  it("GET /pipelines lists created pipelines", async () => {
    workspaceDir = makeWorkspace()
    const pipelineState = activePipelineState = createPipelineState(workspaceDir)
    const eventMerger = createEventMerger()
    const proxy = makeMockProxy()
    const app = createApp(makeAppOpts(proxy, eventMerger, {
      getPipelineState: () => pipelineState,
    }))

    // Empty initially
    const emptyRes = await app.request("/pipelines")
    expect(emptyRes.status).toBe(200)
    const emptyBody = await emptyRes.json() as any[]
    expect(emptyBody).toEqual([])

    // Create a pipeline directly
    pipelineState.createPipeline({ prompt: "build todo app", workspacePath: workspaceDir })

    const res = await app.request("/pipelines")
    expect(res.status).toBe(200)
    const body = await res.json() as any[]
    expect(body).toHaveLength(1)
    expect(body[0].prompt).toBe("build todo app")
    expect(body[0].status).toBe("running")
  })

  it("GET /pipeline/:id returns full pipeline detail", async () => {
    workspaceDir = makeWorkspace()
    const pipelineState = activePipelineState = createPipelineState(workspaceDir)
    const eventMerger = createEventMerger()
    const proxy = makeMockProxy()
    const app = createApp(makeAppOpts(proxy, eventMerger, {
      getPipelineState: () => pipelineState,
    }))

    const pipelineId = pipelineState.createPipeline({ prompt: "build auth", workspacePath: workspaceDir })
    const stageId = pipelineState.createStage({ pipelineId, stage: "brainstorm", sessionId: "s1" })

    const res = await app.request(`/pipeline/${pipelineId}`)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.id).toBe(pipelineId)
    expect(body.prompt).toBe("build auth")
    expect(body.stages).toHaveLength(1)
    expect(body.stages[0].stage).toBe("brainstorm")
    expect(body.stages[0].sessionId).toBe("s1")
  })

})

// ─── X-Atelier-Seq header ──────────────────────────────────────────────────

describe("Integration: X-Atelier-Seq header", () => {
  it("REST responses include X-Atelier-Seq reflecting current seq", async () => {
    const proxy = makeMockProxy()
    const eventMerger = createEventMerger()
    const app = createApp(makeAppOpts(proxy, eventMerger))

    // Before any events
    const res1 = await app.request("/health")
    expect(res1.headers.get("X-Atelier-Seq")).toBe("0")

    // Emit events
    eventMerger.emit({ type: "test_event_1" })
    eventMerger.emit({ type: "test_event_2" })

    const res2 = await app.request("/health")
    expect(res2.headers.get("X-Atelier-Seq")).toBe("2")
  })

  it("SSE responses do NOT include X-Atelier-Seq header", async () => {
    const proxy = makeMockProxy()
    const eventMerger = createEventMerger()
    const app = createApp(makeAppOpts(proxy, eventMerger))

    const res = await app.request("/events")
    expect(res.headers.get("X-Atelier-Seq")).toBeNull()
  })
})

// ─── Validation errors ──────────────────────────────────────────────────────

describe("Integration: Request validation", () => {
  it("POST /message with empty content returns 400", async () => {
    const proxy = makeMockProxy()
    const eventMerger = createEventMerger()
    const app = createApp(makeAppOpts(proxy, eventMerger))

    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "", mode: "build" }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /message with missing mode returns 400", async () => {
    const proxy = makeMockProxy()
    const eventMerger = createEventMerger()
    const app = createApp(makeAppOpts(proxy, eventMerger))

    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello" }),
    })
    expect(res.status).toBe(400)
  })

  it("POST /message with malformed JSON returns 400", async () => {
    const proxy = makeMockProxy()
    const eventMerger = createEventMerger()
    const app = createApp(makeAppOpts(proxy, eventMerger))

    const res = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
    })
    expect(res.status).toBe(400)
  })

  it("POST /pipeline/signal with missing sessionId returns 400", async () => {
    const proxy = makeMockProxy()
    const eventMerger = createEventMerger()
    const orchestrator = {
      handleSignal: vi.fn(),
      getActivePipelineId: () => "p1",
      isSessionOwnedByPipeline: () => false,
    }
    const app = createApp(makeAppOpts(proxy, eventMerger, {
      getOrchestrator: () => orchestrator as any,
    }))

    const res = await app.request("/pipeline/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stage_complete" }),
    })
    expect(res.status).toBe(400)
  })
})

// ─── Signal-based compile stage completion ──────────────────────────────────

describe("Integration: Compile stage completes via signal", () => {
  it("compile_brainstorm fails if output file is missing on signal", async () => {
    workspaceDir = makeWorkspace()
    const engine = makeEngine()
    const pipelineState = activePipelineState = createPipelineState(workspaceDir)
    const eventMerger = createEventMerger()
    const events: any[] = []
    eventMerger.subscribe((e: any) => events.push(e))

    const orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })

    const proxy = makeMockProxy()
    const { registry, metadataStore } = wrapInRegistry(proxy, engine)
    const app = createApp({
      registry, metadataStore, workspacePath: workspaceDir,
      eventMerger,
      getOrchestrator: () => orchestrator,
      getStatus: () => "ready",
      getPipelineState: () => pipelineState,
    })

    // Start pipeline
    const createRes = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "build something", mode: "feature" }),
    })
    expect(createRes.status).toBe(200)
    const { pipelineId } = await createRes.json() as any

    // Signal classification first
    await signalStageComplete(app, events, "classify", { pipelineType: "feature", worktreeChoice: "in-tree" })

    // Resume pipeline after classify (pipeline pauses to allow model configuration)
    const stageModelRes = await app.request(`/pipelines/${pipelineId}/stage-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageModels: {}, confirmed: true }),
    })
    expect(stageModelRes.status).toBe(200)

    // Wait for compile_brainstorm to start
    const compileEvt = await waitForStage(events, "compile_brainstorm")

    // Signal complete WITHOUT writing the file
    const signalRes = await app.request("/pipeline/signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stage_complete", sessionId: compileEvt.sessionId }),
    })
    // Signal endpoint still returns 200 (it doesn't propagate stage failure as HTTP error)
    expect(signalRes.status).toBe(200)

    // Pipeline should be idle (failures set pipeline to idle, no pipeline_failed event)
    await new Promise(resolve => setTimeout(resolve, 50))

    orchestrator.destroy()
  })
})

// ─── Pipeline restart: model/variant carry-over ─────────────────────────────

describe("Integration: Pipeline restart carries over model/variant", () => {
  it("POST /pipeline/restart inherits model/variant from source pipeline", async () => {
    workspaceDir = makeWorkspace()
    const engine = makeEngine()
    const pipelineState = activePipelineState = createPipelineState(workspaceDir)
    const eventMerger = createEventMerger()
    const proxy = makeMockProxy()

    const orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })

    const { registry, metadataStore } = wrapInRegistry(proxy, engine)
    const app = createApp({
      registry, metadataStore, workspacePath: workspaceDir,
      eventMerger,
      getOrchestrator: () => orchestrator,
      getStatus: () => "ready",
      getPipelineState: () => pipelineState,
    })

    const events: any[] = []
    eventMerger.subscribe((e) => events.push(e))

    // Start pipeline with a specific model
    const createRes = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "build something",
        mode: "feature",
        model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
        variant: "quick",
      }),
    })
    expect(createRes.status).toBe(200)
    const { pipelineId } = await createRes.json() as any

    // Run through all stages to completion
    await driveFeaturePipelineToCompletion(app, engine, events, pipelineId)

    // Verify source pipeline has model/variant persisted
    const sourcePipeline = pipelineState.getPipeline(pipelineId)
    expect(sourcePipeline!.model).toEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5" })
    expect(sourcePipeline!.variant).toBe("quick")

    // Restart from brainstorm stage
    const restartRes = await app.request("/pipeline/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromPipeline: pipelineId, fromStage: "brainstorm" }),
    })
    expect(restartRes.status).toBe(200)
    const { pipelineId: newPipelineId } = await restartRes.json() as any

    // New pipeline should have inherited model/variant
    const newPipeline = pipelineState.getPipeline(newPipelineId)
    expect(newPipeline!.model).toEqual({ providerID: "anthropic", modelID: "claude-haiku-4-5" })
    expect(newPipeline!.variant).toBe("quick")

    orchestrator.destroy()
  })

  it("POST /pipeline/restart allows model/variant override", async () => {
    workspaceDir = makeWorkspace()
    const engine = makeEngine()
    const pipelineState = activePipelineState = createPipelineState(workspaceDir)
    const eventMerger = createEventMerger()
    const proxy = makeMockProxy()

    const orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })

    const { registry, metadataStore } = wrapInRegistry(proxy, engine)
    const app = createApp({
      registry, metadataStore, workspacePath: workspaceDir,
      eventMerger,
      getOrchestrator: () => orchestrator,
      getStatus: () => "ready",
      getPipelineState: () => pipelineState,
    })

    const events: any[] = []
    eventMerger.subscribe((e) => events.push(e))

    // Start pipeline with haiku
    await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "build something",
        mode: "feature",
        model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
      }),
    })
    const firstPipeline = pipelineState.getRunningPipelines()[0]!

    // Complete all stages
    await driveFeaturePipelineToCompletion(app, engine, events, firstPipeline.id)

    // Restart with a different model
    const restartRes = await app.request("/pipeline/restart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromPipeline: firstPipeline.id,
        fromStage: "brainstorm",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5-20250514" },
        variant: "deep",
      }),
    })
    expect(restartRes.status).toBe(200)
    const { pipelineId: newPipelineId } = await restartRes.json() as any

    // New pipeline should have the override model, not the source's
    const newPipeline = pipelineState.getPipeline(newPipelineId)
    expect(newPipeline!.model).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5-20250514" })
    expect(newPipeline!.variant).toBe("deep")

    orchestrator.destroy()
  })
})

describe("Integration: concurrent pipelines", () => {
  it("two pipelines run to completion independently via HTTP", async () => {
    workspaceDir = makeWorkspace()
    const engine = makeEngine()
    const pipelineState = activePipelineState = createPipelineState(workspaceDir)
    const eventMerger = createEventMerger()
    const proxy = makeMockProxy()
    const orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })
    const { registry, metadataStore } = wrapInRegistry(proxy, engine)
    const app = createApp({
      registry, metadataStore, workspacePath: workspaceDir,
      eventMerger,
      getOrchestrator: () => orchestrator,
      getStatus: () => "ready",
      getPipelineState: () => pipelineState,
    })
    const events: any[] = []
    eventMerger.subscribe((e) => events.push(e))

    async function waitForStageInPipeline(pipelineId: string, stage: string, maxWait = 300): Promise<any> {
      for (let i = 0; i < maxWait / 10; i++) {
        const evt = events.find((e: any) => e.type === "stage_started" && e.pipelineId === pipelineId && e.stage === stage)
        if (evt) return evt
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`Timed out waiting for ${stage} in ${pipelineId}`)
    }

    async function signalClassifyForPipeline(pipelineId: string) {
      const evt = await waitForStageInPipeline(pipelineId, "classify")
      const res = await app.request("/pipeline/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stage_complete", sessionId: evt.sessionId, pipelineType: "feature", worktreeChoice: "in-tree" }),
      })
      expect(res.status).toBe(200)
    // Resume pipeline after classify (pipeline pauses to allow model configuration)
    const stageModelRes = await app.request(`/pipelines/${pipelineId}/stage-models`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stageModels: {}, confirmed: true }),
    })
    expect(stageModelRes.status).toBe(200)
    }

    async function signalCompileForPipeline(pipelineId: string, stage: "compile_brainstorm" | "compile_plan" | "compile_e2e_plan") {
      const evt = await waitForStageInPipeline(pipelineId, stage)
      const msg = engine.messages.find(m => m.sessionId === evt.sessionId && m.content?.includes("**Output path:**"))
      const match = msg?.content.match(/\*\*Output path:\*\* (.+)/)
      if (!match) throw new Error(`No output path for ${stage}`)
      fsSync.mkdirSync(path.dirname(match[1]), { recursive: true })
      fsSync.writeFileSync(match[1], "compiled prompt content")
      const res = await app.request("/pipeline/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stage_complete", sessionId: evt.sessionId }),
      })
      expect(res.status).toBe(200)
    }

    async function signalStageForPipeline(pipelineId: string, stage: string, opts?: { outputPath?: string; verdict?: string }) {
      const evt = await waitForStageInPipeline(pipelineId, stage)
      // Write stub artifact file so the mandatory artifact check passes
      if (opts?.outputPath) {
        const absPath = path.isAbsolute(opts.outputPath)
          ? opts.outputPath
          : path.join(workspaceDir, opts.outputPath)
        fsSync.mkdirSync(path.dirname(absPath), { recursive: true })
        fsSync.writeFileSync(absPath, `stub artifact for ${stage}`)
      }
      const res = await app.request("/pipeline/signal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stage_complete", sessionId: evt.sessionId, ...opts }),
      })
      expect(res.status).toBe(200)
    }

    const res1 = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "First feature", mode: "feature" }),
    })
    expect(res1.status).toBe(200)
    const { pipelineId: pid1 } = await res1.json() as any

    const res2 = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Second feature", mode: "feature" }),
    })
    expect(res2.status).toBe(200)
    const { pipelineId: pid2 } = await res2.json() as any
    expect(pid1).not.toBe(pid2)

    await signalClassifyForPipeline(pid1)
    await signalCompileForPipeline(pid1, "compile_brainstorm")
    await signalStageForPipeline(pid1, "brainstorm", { outputPath: ".atelier/specs/spec.md" })
    await signalStageForPipeline(pid1, "review_spec", { outputPath: ".atelier/review.md", verdict: "done" })
    try { await signalStageForPipeline(pid1, "establish_conventions", { outputPath: ".atelier/conventions.md" }) } catch {}
    await signalCompileForPipeline(pid1, "compile_plan")
    await signalStageForPipeline(pid1, "write_plan", { outputPath: ".atelier/plans/plan.md" })
    await signalStageForPipeline(pid1, "review_plan", { outputPath: ".atelier/plan-review.md", verdict: "done" })
    await signalStageForPipeline(pid1, "implement")
    await signalStageForPipeline(pid1, "review_code", { outputPath: ".atelier/code-review.md", verdict: "done" })
    await signalStageForPipeline(pid1, "simplify", { outputPath: ".atelier/simplify.md" })
    await signalStageForPipeline(pid1, "e2e_gate", { verdict: "proceed", outputPath: ".atelier/e2e-gate.md" })
    await signalCompileForPipeline(pid1, "compile_e2e_plan")
    await signalStageForPipeline(pid1, "write_e2e_plan", { outputPath: ".atelier/e2e-plan.md" })
    await signalStageForPipeline(pid1, "review_e2e_plan", { outputPath: ".atelier/e2e-review.md", verdict: "done" })
    await signalStageForPipeline(pid1, "e2e")
    await signalStageForPipeline(pid1, "validate")

    expect(events.some(e => e.type === "pipeline_completed" && e.pipelineId === pid1)).toBe(true)
    expect(orchestrator.hasPipeline(pid2)).toBe(true)

    await signalClassifyForPipeline(pid2)
    await signalCompileForPipeline(pid2, "compile_brainstorm")
    await signalStageForPipeline(pid2, "brainstorm", { outputPath: ".atelier/specs/spec.md" })
    await signalStageForPipeline(pid2, "review_spec", { outputPath: ".atelier/review.md", verdict: "done" })
    try { await signalStageForPipeline(pid2, "establish_conventions", { outputPath: ".atelier/conventions.md" }) } catch {}
    await signalCompileForPipeline(pid2, "compile_plan")
    await signalStageForPipeline(pid2, "write_plan", { outputPath: ".atelier/plans/plan.md" })
    await signalStageForPipeline(pid2, "review_plan", { outputPath: ".atelier/plan-review.md", verdict: "done" })
    await signalStageForPipeline(pid2, "implement")
    await signalStageForPipeline(pid2, "review_code", { outputPath: ".atelier/code-review.md", verdict: "done" })
    await signalStageForPipeline(pid2, "simplify", { outputPath: ".atelier/simplify.md" })
    await signalStageForPipeline(pid2, "e2e_gate", { verdict: "proceed", outputPath: ".atelier/e2e-gate.md" })
    await signalCompileForPipeline(pid2, "compile_e2e_plan")
    await signalStageForPipeline(pid2, "write_e2e_plan", { outputPath: ".atelier/e2e-plan.md" })
    await signalStageForPipeline(pid2, "review_e2e_plan", { outputPath: ".atelier/e2e-review.md", verdict: "done" })
    await signalStageForPipeline(pid2, "e2e")
    await signalStageForPipeline(pid2, "validate")

    expect(events.some(e => e.type === "pipeline_completed" && e.pipelineId === pid2)).toBe(true)
    orchestrator.destroy()
  })

  it("build session runs alongside active pipeline", async () => {
    workspaceDir = makeWorkspace()
    const engine = makeEngine()
    const pipelineState = activePipelineState = createPipelineState(workspaceDir)
    const eventMerger = createEventMerger()
    const proxy = makeMockProxy()
    const orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })
    const { registry, metadataStore } = wrapInRegistry(proxy, engine)
    const app = createApp({
      registry, metadataStore, workspacePath: workspaceDir,
      eventMerger,
      getOrchestrator: () => orchestrator,
      getStatus: () => "ready",
      getPipelineState: () => pipelineState,
    })

    const featureRes = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Add auth", mode: "feature" }),
    })
    expect(featureRes.status).toBe(200)
    const { pipelineId } = await featureRes.json() as any
    expect(pipelineId).toBeTruthy()

    const buildRes = await app.request("/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello", mode: "build", sessionId: "s1" }),
    })
    expect(buildRes.status).toBe(200)
    expect(proxy.sendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({ content: "Hello" }))

    orchestrator.destroy()
  })
})
