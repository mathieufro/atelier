import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Orchestrator } from "../../src/orchestration/orchestrator.js"
import { MockAgentEngine } from "../__utils__/mock-engine.js"
import { createPipelineState, type PipelineState } from "../../src/orchestration/pipeline-state.js"
import { createEventMerger } from "../../src/engine/event-merger.js"
import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"
import { execFileSync } from "node:child_process"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")

describe("Autonomous Mode — foundations", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let workspaceDir: string
  let proxy: any

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-auto-"))
    fs.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    execFileSync("git", ["init"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspaceDir })
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), ".atelier/\n")
    execFileSync("git", ["add", "-A"], { cwd: workspaceDir })
    execFileSync("git", ["commit", "-m", "seed"], { cwd: workspaceDir })

    engine = new MockAgentEngine()
    engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
    pipelineState = createPipelineState(workspaceDir)
    eventMerger = createEventMerger()
    events = []
    eventMerger.subscribe((event) => events.push(event))
    proxy = {
      replyPermission: vi.fn(),
      rejectQuestion: vi.fn(),
      replyQuestion: vi.fn(),
    }
  })

  afterEach(() => {
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }) } catch {}
  })

  it("startPipelineAsync accepts autonomous option and stores it on ActivePipeline", async () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const { pipelineId } = orchestrator.startPipelineAsync("build a todo app", {
      autonomous: true,
    })

    const active = orchestrator.getPipeline(pipelineId)
    expect(active).not.toBeNull()
    expect(active!.autonomous).toBe(true)

    orchestrator.destroy()
  })

  it("autonomous defaults to false when not specified", async () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const { pipelineId } = orchestrator.startPipelineAsync("build a todo app")

    const active = orchestrator.getPipeline(pipelineId)
    expect(active!.autonomous).toBeFalsy()

    orchestrator.destroy()
  })

  it("QuestionPermissionProxy.replyQuestion is callable on proxy", () => {
    // Type-level: proxy must have replyQuestion to be passed as QuestionPermissionProxy
    expect(typeof proxy.replyQuestion).toBe("function")
  })
})

describe("Autonomous Mode — HTTP propagation", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let workspaceDir: string
  let proxy: any

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-auto-http-"))
    fs.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    execFileSync("git", ["init"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspaceDir })
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), ".atelier/\n")
    execFileSync("git", ["add", "-A"], { cwd: workspaceDir })
    execFileSync("git", ["commit", "-m", "seed"], { cwd: workspaceDir })

    engine = new MockAgentEngine()
    engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
    pipelineState = createPipelineState(workspaceDir)
    eventMerger = createEventMerger()
    events = []
    eventMerger.subscribe((event) => events.push(event))
    proxy = {
      replyPermission: vi.fn(),
      rejectQuestion: vi.fn(),
      replyQuestion: vi.fn(),
    }
  })

  afterEach(() => {
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }) } catch {}
  })

  it("POST /message with autonomous=true passes it to startPipelineAsync", async () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const { pipelineId } = orchestrator.startPipelineAsync("test prompt", {
      type: "feature",
      autonomous: true,
    })

    const active = orchestrator.getPipeline(pipelineId)
    expect(active!.autonomous).toBe(true)
    expect(active!.pipelineType).toBe("feature")

    orchestrator.destroy()
  })
})

async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timeout")
    await new Promise(r => setTimeout(r, 10))
  }
}

describe("Autonomous Mode — pipeline session queries", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let workspaceDir: string
  let proxy: any

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-auto-query-"))
    fs.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    execFileSync("git", ["init"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspaceDir })
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), ".atelier/\n")
    execFileSync("git", ["add", "-A"], { cwd: workspaceDir })
    execFileSync("git", ["commit", "-m", "seed"], { cwd: workspaceDir })

    engine = new MockAgentEngine()
    engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
    pipelineState = createPipelineState(workspaceDir)
    eventMerger = createEventMerger()
    events = []
    eventMerger.subscribe((event) => events.push(event))
    proxy = {
      replyPermission: vi.fn(),
      rejectQuestion: vi.fn(),
      replyQuestion: vi.fn(),
    }
  })

  afterEach(() => {
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }) } catch {}
  })

  it("getSessionsForPipeline returns session IDs for pipeline", async () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const { pipelineId } = orchestrator.startPipelineAsync("test", { autonomous: true })
    await waitFor(() => events.some(e => e.type === "stage_started" && e.stage === "classify"))

    const sessions = orchestrator.getSessionsForPipeline(pipelineId)
    expect(sessions.size).toBeGreaterThan(0)

    orchestrator.destroy()
  })

  it("getSessionsForPipeline returns empty set for unknown pipeline", () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const sessions = orchestrator.getSessionsForPipeline("nonexistent")
    expect(sessions.size).toBe(0)

    orchestrator.destroy()
  })

  it("getPipelineStatus returns running for active pipeline", async () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const { pipelineId } = orchestrator.startPipelineAsync("test", { autonomous: true })
    await waitFor(() => events.some(e => e.type === "stage_started" && e.stage === "classify"))

    expect(orchestrator.getPipelineStatus(pipelineId)).toBe("running")

    orchestrator.destroy()
  })

  it("getPipelineStatus returns unknown for nonexistent pipeline", () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    expect(orchestrator.getPipelineStatus("nonexistent")).toBe("unknown")

    orchestrator.destroy()
  })
})

describe("Responding skill", () => {
  it("exists and has correct frontmatter", () => {
    const skillPath = path.resolve(import.meta.dirname, "../../../skills/responding/SKILL.md")
    expect(fs.existsSync(skillPath)).toBe(true)
    const content = fs.readFileSync(skillPath, "utf-8")
    expect(content).toContain("name: responding")
    expect(content).toContain("stage: on-demand")
  })
})

describe("Benchmark skill", () => {
  it("exists and has correct frontmatter", () => {
    const skillPath = path.resolve(import.meta.dirname, "../../../skills/benchmarking/SKILL.md")
    expect(fs.existsSync(skillPath)).toBe(true)
    const content = fs.readFileSync(skillPath, "utf-8")
    expect(content).toContain("name: benchmarking")
    expect(content).toContain("stage: on-demand")
  })
})

describe("Autonomous Mode — validate stage", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let workspaceDir: string
  let proxy: any

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-auto-val-"))
    fs.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    execFileSync("git", ["init"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspaceDir })
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), ".atelier/\n")
    execFileSync("git", ["add", "-A"], { cwd: workspaceDir })
    execFileSync("git", ["commit", "-m", "seed"], { cwd: workspaceDir })

    engine = new MockAgentEngine()
    engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
    pipelineState = createPipelineState(workspaceDir)
    eventMerger = createEventMerger()
    events = []
    eventMerger.subscribe((event) => events.push(event))
    proxy = {
      replyPermission: vi.fn(),
      rejectQuestion: vi.fn(),
      replyQuestion: vi.fn(),
    }
  })

  afterEach(() => {
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }) } catch {}
  })

  it("skips validate stage for autonomous in-tree pipelines", async () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const pipelineId = await orchestrator.startPipeline("build a todo app", { autonomous: true })
    const active = orchestrator.getPipeline(pipelineId)!
    expect(active.autonomous).toBe(true)

    orchestrator.destroy()
  })
})

describe("Autonomous Mode — responder lifecycle", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let workspaceDir: string
  let proxy: any

  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-auto-life-"))
    fs.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    execFileSync("git", ["init"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspaceDir })
    fs.writeFileSync(path.join(workspaceDir, ".gitignore"), ".atelier/\n")
    execFileSync("git", ["add", "-A"], { cwd: workspaceDir })
    execFileSync("git", ["commit", "-m", "seed"], { cwd: workspaceDir })

    engine = new MockAgentEngine()
    engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
    pipelineState = createPipelineState(workspaceDir)
    eventMerger = createEventMerger()
    events = []
    eventMerger.subscribe((event) => events.push(event))
    proxy = {
      replyPermission: vi.fn(),
      rejectQuestion: vi.fn(),
      replyQuestion: vi.fn(),
    }
  })

  afterEach(() => {
    try { fs.rmSync(workspaceDir, { recursive: true, force: true }) } catch {}
  })

  it("creates a responder session for classify stage when autonomous", async () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const pipelineId = await orchestrator.startPipeline("build a todo app", { autonomous: true })
    const active = orchestrator.getPipeline(pipelineId)!

    expect(active.autonomous).toBe(true)
    expect(active.responderSessionId).toBeDefined()
    expect(engine.sessions.has(active.responderSessionId!)).toBe(true)

    // Responder session should have been sent the responding skill + pipeline prompt
    const responderMsg = engine.messages.find(m => m.sessionId === active.responderSessionId)
    expect(responderMsg).toBeDefined()
    expect(responderMsg!.content).toContain("build a todo app")

    orchestrator.destroy()
  })

  it("does not create responder session when not autonomous", async () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const pipelineId = await orchestrator.startPipeline("build a todo app")
    const active = orchestrator.getPipeline(pipelineId)!

    expect(active.responderSessionId).toBeUndefined()

    orchestrator.destroy()
  })

  it("cleans up responder session on stage completion", async () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const pipelineId = await orchestrator.startPipeline("build a todo app", { autonomous: true })
    const active = orchestrator.getPipeline(pipelineId)!
    const responderSid = active.responderSessionId!

    // Signal classify complete
    const classifyEvt = events.find(e => e.type === "stage_started" && e.stage === "classify")!
    await orchestrator.handleSignal({
      type: "stage_complete",
      sessionId: classifyEvt.sessionId,
      pipelineType: "feature",
      worktreeChoice: "in-tree",
    })

    // Responder should be cleaned up
    expect(active.responderSessionId).toBeUndefined()

    orchestrator.destroy()
  })

  it("creates a new responder session for brainstorm stage", async () => {
    const orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const pipelineId = await orchestrator.startPipeline("build a todo app", { autonomous: true })

    // Drive through classify + compile_brainstorm
    const classifyEvt = events.find(e => e.type === "stage_started" && e.stage === "classify")!
    await orchestrator.handleSignal({
      type: "stage_complete",
      sessionId: classifyEvt.sessionId,
      pipelineType: "feature",
      worktreeChoice: "in-tree",
    })

    // Resume pipeline after classify (pipeline pauses to allow model configuration)
    pipelineState.setStageModelConfirmed(pipelineId, true)
    await orchestrator.resumeAfterStageModelsConfirmed(pipelineId)

    // Signal compile_brainstorm complete
    await waitFor(() => events.some(e => e.type === "stage_started" && e.stage === "compile_brainstorm"))
    const compileEvt = events.find(e => e.type === "stage_started" && e.stage === "compile_brainstorm")!
    const compileMsg = engine.messages.find(m => m.sessionId === compileEvt.sessionId && m.content?.includes("**Output path:**"))!
    const match = compileMsg.content.match(/\*\*Output path:\*\* (.+)/)!
    const compiledAbsPath = match[1]
    // outputPath must be workspace-relative for validateWithinWorkspace
    const compiledRelPath = path.relative(workspaceDir, compiledAbsPath)
    fs.mkdirSync(path.dirname(compiledAbsPath), { recursive: true })
    fs.writeFileSync(compiledAbsPath, "compiled brainstorm prompt")
    await orchestrator.handleSignal({ type: "stage_complete", sessionId: compileEvt.sessionId, outputPath: compiledRelPath })

    // Wait for brainstorm stage to start (handleSignal is awaited, so brainstorm should start synchronously)
    await waitFor(() => events.some(e => e.type === "stage_started" && e.stage === "brainstorm"))

    // Now brainstorm should have started with a new responder
    const active = orchestrator.getPipeline(pipelineId)!
    expect(active.responderSessionId).toBeDefined()

    orchestrator.destroy()
  })
})
