import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { Orchestrator } from "../../src/orchestration/orchestrator.js"
import { MockAgentEngine } from "../__utils__/mock-engine.js"
import { createPipelineState, type PipelineState } from "../../src/orchestration/pipeline-state.js"
import { createEventMerger } from "../../src/engine/event-merger.js"
import { atelierStateDir } from "@atelier/core/state-dir"
import * as path from "node:path"
import * as os from "node:os"
import * as fsSync from "node:fs"
import { execFileSync } from "node:child_process"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")

async function signalCompile(orch: Orchestrator, engine: MockAgentEngine, evts: any[], stage: string): Promise<void> {
  const evt = evts.find(e => e.type === "stage_started" && e.stage === stage)
  if (!evt) throw new Error(`No ${stage} stage_started event found`)
  const msg = engine.messages.find(m => m.sessionId === evt.sessionId && m.content?.includes("**Output path:**"))
  const match = msg?.content.match(/\*\*Output path:\*\* (.+)/)
  if (!match) throw new Error(`No output path in compile message for ${stage}`)
  fsSync.mkdirSync(path.dirname(match[1]!), { recursive: true })
  fsSync.writeFileSync(match[1]!, "compiled prompt content")
  await orch.handleSignal({ type: "stage_complete", sessionId: evt.sessionId })
}

async function signalStage(orch: Orchestrator, evts: any[], stage: string, opts: { outputPath?: string; verdict?: string } | undefined, workspacePath: string): Promise<void> {
  const evt = evts.find(e => e.type === "stage_started" && e.stage === stage)
  if (!evt) throw new Error(`No ${stage} stage_started event found`)
  if (opts?.outputPath) {
    const absPath = path.isAbsolute(opts.outputPath) ? opts.outputPath : path.join(workspacePath, opts.outputPath)
    fsSync.mkdirSync(path.dirname(absPath), { recursive: true })
    fsSync.writeFileSync(absPath, `stub artifact for ${stage}`)
  }
  await orch.handleSignal({ type: "stage_complete", sessionId: evt.sessionId, ...opts })
}

async function signalClassify(orch: Orchestrator, evts: any[], pipelineState: PipelineState): Promise<void> {
  const evt = evts.findLast((e: any) => e.type === "stage_started" && e.stage === "classify")
  if (!evt) throw new Error("No classify stage_started event found")
  await orch.handleSignal({ type: "stage_complete", sessionId: evt.sessionId, pipelineType: "feature", worktreeChoice: "in-tree" })
  const pipelineId = evt.pipelineId ?? orch.getActivePipelineIds()[0]
  if (pipelineId) {
    pipelineState.setStageModelConfirmed(pipelineId, true)
    await orch.resumeAfterStageModelsConfirmed(pipelineId)
  }
}

async function driveToImplement(orch: Orchestrator, engine: MockAgentEngine, evts: any[], workspaceDir: string, pipelineState: PipelineState): Promise<string> {
  const pipelineId = await orch.startPipeline("build a todo app")
  await signalClassify(orch, evts, pipelineState)
  await signalCompile(orch, engine, evts, "compile_brainstorm")
  await signalStage(orch, evts, "brainstorm", { outputPath: ".atelier/specs/spec.md" }, workspaceDir)
  await signalStage(orch, evts, "review_spec", { outputPath: ".atelier/review-spec.md", verdict: "done" }, workspaceDir)
  if (evts.find(e => e.type === "stage_started" && e.stage === "establish_conventions")) {
    await signalStage(orch, evts, "establish_conventions", { outputPath: ".atelier/conventions.md" }, workspaceDir)
  }
  await signalCompile(orch, engine, evts, "compile_plan")
  await signalStage(orch, evts, "write_plan", { outputPath: ".atelier/plans/plan.md" }, workspaceDir)
  await signalStage(orch, evts, "review_plan", { outputPath: ".atelier/plan-review.md", verdict: "done" }, workspaceDir)
  return pipelineId
}

describe("Partial-restart end-to-end (orchestrator + state)", () => {
  let workspaceDir: string
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let orchestrator: Orchestrator

  beforeEach(() => {
    workspaceDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "partial-e2e-"))
    fsSync.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    execFileSync("git", ["init"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspaceDir })
    fsSync.writeFileSync(path.join(workspaceDir, ".gitignore"), ".atelier/\n")
    execFileSync("git", ["add", "-A"], { cwd: workspaceDir })
    execFileSync("git", ["commit", "-m", "seed"], { cwd: workspaceDir })

    engine = new MockAgentEngine()
    engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
    pipelineState = createPipelineState(workspaceDir)
    eventMerger = createEventMerger()
    events = []
    eventMerger.subscribe((event) => events.push(event))
    orchestrator = new Orchestrator({
      engine,
      pipelineState,
      eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    orchestrator.destroy()
    await pipelineState.flush()
    try { fsSync.rmSync(workspaceDir, { recursive: true, force: true }) } catch {}
    try { fsSync.rmSync(atelierStateDir(workspaceDir), { recursive: true, force: true }) } catch {}
  })

  it("partial → partial → done lifecycle: 3 implement entries, pipeline advances after final done", async () => {
    const pipelineId = await driveToImplement(orchestrator, engine, events, workspaceDir, pipelineState)
    const progressPath = ".atelier/progress.md"
    const absProgress = path.join(workspaceDir, progressPath)
    fsSync.writeFileSync(absProgress, "# Progress\n")

    // Iter 1 — partial
    const sess1 = events.findLast(e => e.type === "stage_started" && e.stage === "implement")!.sessionId
    await orchestrator.handleSignal({ type: "stage_complete", sessionId: sess1, verdict: "partial", outputPath: progressPath })

    // Iter 2 — partial. Restart created a new implement entry with a fresh sessionId.
    const sess2 = events.findLast(e => e.type === "stage_started" && e.stage === "implement")!.sessionId
    expect(sess2).not.toBe(sess1)
    await orchestrator.handleSignal({ type: "stage_complete", sessionId: sess2, verdict: "partial", outputPath: progressPath })

    // Iter 3 — done. The plan/spec advance the pipeline to e2e_gate next.
    const sess3 = events.findLast(e => e.type === "stage_started" && e.stage === "implement")!.sessionId
    expect(sess3).not.toBe(sess2)
    await orchestrator.handleSignal({ type: "stage_complete", sessionId: sess3, verdict: "done" })

    const final = pipelineState.getPipeline(pipelineId)!
    const implementEntries = final.stages.filter(s => s.stage === "implement")
    expect(implementEntries).toHaveLength(3)
    expect(implementEntries[0]!.verdict).toBe("partial")
    expect(implementEntries[1]!.verdict).toBe("partial")
    expect(implementEntries[1]!.restartedFromPartial).toBe(true)
    expect(implementEntries[2]!.restartedFromPartial).toBe(true)
    expect(implementEntries[2]!.status).toBe("completed")
    expect(implementEntries[2]!.verdict).toBeUndefined()

    // Two restart events with monotonic iteration counters.
    const restartEvents = events.filter(e => e.type === "stage_restarted_partial")
    expect(restartEvents).toHaveLength(2)
    expect(restartEvents[0]!.iteration).toBe(1)
    expect(restartEvents[1]!.iteration).toBe(2)

    // After the final done, the pipeline advanced past implement.
    expect(final.currentStage).not.toBe("implement")
  })
})
