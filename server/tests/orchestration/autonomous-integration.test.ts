import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Orchestrator } from "../../src/orchestration/orchestrator.js"
import { MockAgentEngine } from "../__utils__/mock-engine.js"
import { createPipelineState, type PipelineState } from "../../src/orchestration/pipeline-state.js"
import { createEventMerger } from "../../src/engine/event-merger.js"
import * as path from "node:path"
import * as os from "node:os"
import * as fsSync from "node:fs"
import { execFileSync } from "node:child_process"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")

async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timeout")
    await new Promise(r => setTimeout(r, 10))
  }
}

describe("Autonomous Pipeline — integration", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let workspaceDir: string
  let proxy: any
  let orchestrator: Orchestrator

  beforeEach(() => {
    workspaceDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atelier-auto-integ-"))
    fsSync.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    execFileSync("git", ["init"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspaceDir })
    fsSync.writeFileSync(path.join(workspaceDir, ".gitignore"), ".atelier/\n")
    execFileSync("git", ["add", "-A"], { cwd: workspaceDir })
    execFileSync("git", ["commit", "-m", "seed"], { cwd: workspaceDir })

    engine = new MockAgentEngine()
    engine.nextOutput = { text: "feature pipeline, in-tree", tokens: { input: 100, output: 50 } }
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
    orchestrator?.destroy()
    try { fsSync.rmSync(workspaceDir, { recursive: true, force: true }) } catch {}
  })

  it("autonomous pipeline creates responder session with responderPipelineId", async () => {
    orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const pipelineId = await orchestrator.startPipeline("build a todo app", { autonomous: true })
    const active = orchestrator.getPipeline(pipelineId)!

    // Verify autonomous pipeline has responder
    expect(active.autonomous).toBe(true)
    expect(active.responderSessionId).toBeDefined()

    // The responder session should have been sent an activation message
    const responderMsgs = engine.messages.filter(m => m.sessionId === active.responderSessionId)
    expect(responderMsgs.length).toBeGreaterThanOrEqual(1)
    // Activation message references the pipeline ID and tells it to poll
    expect(responderMsgs[0].content).toContain(pipelineId)
    expect(responderMsgs[0].content).toContain("Start polling now")

    // The responder session config should have responderPipelineId set
    const sessionConfig = engine.sessionConfigs.get(active.responderSessionId!)
    expect(sessionConfig?.responderPipelineId).toBe(pipelineId)
  })

  it("responder session is cleaned up when classify stage completes", async () => {
    orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const pipelineId = await orchestrator.startPipeline("build a todo app", { autonomous: true })
    const active = orchestrator.getPipeline(pipelineId)!
    const responderId = active.responderSessionId!

    // Signal classify complete
    const classifyEvt = events.find(e => e.type === "stage_started" && e.stage === "classify")!
    await orchestrator.handleSignal({
      type: "stage_complete",
      sessionId: classifyEvt.sessionId,
      pipelineType: "feature",
      worktreeChoice: "in-tree",
    })

    // Responder cleaned up (current stage advanced, so the old responder is gone)
    // The new stage (compile_brainstorm) is not interactive, so no new responder
    // But since cleanup only happens when currentStageId matches, let's check the responderId was interrupted
    expect(engine.interruptedSessions).toContain(responderId)
  })

  it("responder session is not registered as pipeline-owned (no recursive question loop)", async () => {
    orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const pipelineId = await orchestrator.startPipeline("build a todo app", { autonomous: true })
    const active = orchestrator.getPipeline(pipelineId)!
    const responderId = active.responderSessionId!

    // Responder session must NOT be in the session index — otherwise
    // if the responder model calls AskUserQuestion, the question callback
    // would try to auto-answer the responder's own question (infinite loop).
    expect(orchestrator.isSessionOwnedByPipeline(responderId)).toBe(false)
  })

  it("abort interrupts both work agent and responder", async () => {
    orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const pipelineId = await orchestrator.startPipeline("build a todo app", { autonomous: true })
    const active = orchestrator.getPipeline(pipelineId)!
    const responderId = active.responderSessionId!

    const classifyEvt = events.find(e => e.type === "stage_started" && e.stage === "classify")!

    await orchestrator.abortStageSession(classifyEvt.sessionId)

    expect(engine.interruptedSessions).toContain(classifyEvt.sessionId)
    expect(engine.interruptedSessions).toContain(responderId)
  })

  it("getSessionsForPipeline returns work sessions for poll endpoint", async () => {
    orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      proxy,
    })

    const pipelineId = await orchestrator.startPipeline("build a todo app", { autonomous: true })
    const sessions = orchestrator.getSessionsForPipeline(pipelineId)
    expect(sessions.size).toBeGreaterThan(0)

    // Classify session should be in the set
    const classifyEvt = events.find(e => e.type === "stage_started" && e.stage === "classify")!
    expect(sessions.has(classifyEvt.sessionId)).toBe(true)
  })
})
