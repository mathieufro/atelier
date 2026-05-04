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

async function signalCompile(
  orch: Orchestrator,
  engine: MockAgentEngine,
  evts: any[],
  stage: "compile_brainstorm" | "compile_plan" | "compile_e2e_plan",
): Promise<void> {
  const evt = evts.find(e => e.type === "stage_started" && e.stage === stage)
  if (!evt) throw new Error(`No ${stage} stage_started event found`)
  const msg = engine.messages.find(m => m.sessionId === evt.sessionId && m.content?.includes("**Output path:**"))
  const match = msg?.content.match(/\*\*Output path:\*\* (.+)/)
  if (!match) throw new Error(`No output path in compile message for ${stage}`)
  const outputPath = match[1]
  fsSync.mkdirSync(path.dirname(outputPath), { recursive: true })
  fsSync.writeFileSync(outputPath, "compiled prompt content")
  await orch.handleSignal({ type: "stage_complete", sessionId: evt.sessionId })
}

async function signalStage(
  orch: Orchestrator,
  evts: any[],
  stage: string,
  opts: { outputPath?: string; verdict?: string } | undefined,
  workspacePath: string,
): Promise<void> {
  const evt = evts.find(e => e.type === "stage_started" && e.stage === stage)
  if (!evt) throw new Error(`No ${stage} stage_started event found`)
  if (opts?.outputPath) {
    const absPath = path.isAbsolute(opts.outputPath) ? opts.outputPath : path.join(workspacePath, opts.outputPath)
    fsSync.mkdirSync(path.dirname(absPath), { recursive: true })
    fsSync.writeFileSync(absPath, `stub artifact for ${stage}`)
  }
  await orch.handleSignal({ type: "stage_complete", sessionId: evt.sessionId, ...opts })
}

async function signalClassify(
  orch: Orchestrator,
  evts: any[],
  pipelineState: PipelineState,
  pipelineType: string = "feature",
): Promise<void> {
  const evt = evts.findLast((e: any) => e.type === "stage_started" && e.stage === "classify")
  if (!evt) throw new Error("No classify stage_started event found")
  await orch.handleSignal({ type: "stage_complete", sessionId: evt.sessionId, pipelineType, worktreeChoice: "in-tree" })
  const pipelineId = evt.pipelineId ?? orch.getActivePipelineIds()[0]
  if (pipelineId) {
    pipelineState.setStageModelConfirmed(pipelineId, true)
    await orch.resumeAfterStageModelsConfirmed(pipelineId)
  }
}

async function driveToImplement(
  orch: Orchestrator,
  engine: MockAgentEngine,
  evts: any[],
  workspaceDir: string,
  pipelineState: PipelineState,
): Promise<string> {
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

describe("Orchestrator — verdict: partial restarts implement/e2e stages", () => {
  let workspaceDir: string
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let orchestrator: Orchestrator

  beforeEach(() => {
    workspaceDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "partial-restart-"))
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

  it("on verdict=partial for implement: completes current entry, appends new entry, does not advance topology", async () => {
    const pipelineId = await driveToImplement(orchestrator, engine, events, workspaceDir, pipelineState)
    const implementStarted = events.find(e => e.type === "stage_started" && e.stage === "implement")!
    const firstSessionId = implementStarted.sessionId
    const topologyBefore = pipelineState.getPipeline(pipelineId)!.currentStage
    const progressPath = path.join(workspaceDir, ".atelier/progress.md")
    fsSync.writeFileSync(progressPath, "# Progress\n- task 1: done\n")

    await orchestrator.handleSignal({
      type: "stage_complete",
      sessionId: firstSessionId,
      verdict: "partial",
      outputPath: ".atelier/progress.md",
    })

    const pipeline = pipelineState.getPipeline(pipelineId)!
    const implementStages = pipeline.stages.filter(s => s.stage === "implement")
    expect(implementStages).toHaveLength(2)
    expect(implementStages[0]!.status).toBe("completed")
    expect(implementStages[0]!.verdict).toBe("partial")
    expect(implementStages[0]!.outputPath).toBe(".atelier/progress.md")
    expect(implementStages[1]!.restartedFromPartial).toBe(true)
    expect(implementStages[1]!.status).not.toBe("completed")
    expect(implementStages[1]!.sessionId).not.toBe(firstSessionId)

    expect(engine.interruptedSessions).toContain(firstSessionId)
    expect(pipeline.currentStage).toBe("implement")
    expect(pipeline.currentStage).toBe(topologyBefore)
    expect(pipeline.status).toBe("running")
  })

  it("emits stage_restarted_partial event with iteration count", async () => {
    const pipelineId = await driveToImplement(orchestrator, engine, events, workspaceDir, pipelineState)
    const implementStarted = events.find(e => e.type === "stage_started" && e.stage === "implement")!
    const progressPath = path.join(workspaceDir, ".atelier/progress.md")
    fsSync.writeFileSync(progressPath, "# Progress\n")

    await orchestrator.handleSignal({
      type: "stage_complete",
      sessionId: implementStarted.sessionId,
      verdict: "partial",
      outputPath: ".atelier/progress.md",
    })

    const restartEvents = events.filter(e => e.type === "stage_restarted_partial")
    expect(restartEvents).toHaveLength(1)
    expect(restartEvents[0]!.pipelineId).toBe(pipelineId)
    expect(restartEvents[0]!.stage).toBe("implement")
    expect(restartEvents[0]!.iteration).toBe(1)
  })

  it("on verdict=partial for e2e stage: same restart behavior (appends new entry, sets restartedFromPartial)", async () => {
    const pipelineId = await driveToImplement(orchestrator, engine, events, workspaceDir, pipelineState)
    // Feature topology: implement → review_code → simplify → e2e_gate → compile_e2e_plan → write_e2e_plan → review_e2e_plan → e2e
    await signalStage(orchestrator, events, "implement", { verdict: "done" }, workspaceDir)
    await signalStage(orchestrator, events, "review_code", { outputPath: ".atelier/code-review.md", verdict: "done" }, workspaceDir)
    await signalStage(orchestrator, events, "simplify", { outputPath: ".atelier/simplify.md" }, workspaceDir)
    await signalStage(orchestrator, events, "e2e_gate", { verdict: "proceed", outputPath: ".atelier/e2e-gate.md" }, workspaceDir)
    await signalCompile(orchestrator, engine, events, "compile_e2e_plan")
    await signalStage(orchestrator, events, "write_e2e_plan", { outputPath: ".atelier/e2e-plan.md" }, workspaceDir)
    await signalStage(orchestrator, events, "review_e2e_plan", { outputPath: ".atelier/e2e-review.md", verdict: "done" }, workspaceDir)

    const e2eStarted = events.find(e => e.type === "stage_started" && e.stage === "e2e")!
    fsSync.writeFileSync(path.join(workspaceDir, ".atelier/progress.md"), "# Progress\n")

    await orchestrator.handleSignal({
      type: "stage_complete",
      sessionId: e2eStarted.sessionId,
      verdict: "partial",
      outputPath: ".atelier/progress.md",
    })

    const e2eStages = pipelineState.getPipeline(pipelineId)!.stages.filter(s => s.stage === "e2e")
    expect(e2eStages).toHaveLength(2)
    expect(e2eStages[0]!.verdict).toBe("partial")
    expect(e2eStages[1]!.restartedFromPartial).toBe(true)
    expect(engine.interruptedSessions).toContain(e2eStarted.sessionId)
  })

  it("on verdict=partial for out-of-scope stage (write_plan): falls through to normal completion", async () => {
    const pipelineId = await orchestrator.startPipeline("plan something")
    await signalClassify(orchestrator, events, pipelineState)
    await signalCompile(orchestrator, engine, events, "compile_brainstorm")
    await signalStage(orchestrator, events, "brainstorm", { outputPath: ".atelier/specs/spec.md" }, workspaceDir)
    await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review-spec.md", verdict: "done" }, workspaceDir)
    if (events.find(e => e.type === "stage_started" && e.stage === "establish_conventions")) {
      await signalStage(orchestrator, events, "establish_conventions", { outputPath: ".atelier/conventions.md" }, workspaceDir)
    }
    await signalCompile(orchestrator, engine, events, "compile_plan")

    const writePlanStarted = events.find(e => e.type === "stage_started" && e.stage === "write_plan")!
    fsSync.mkdirSync(path.join(workspaceDir, ".atelier/plans"), { recursive: true })
    fsSync.writeFileSync(path.join(workspaceDir, ".atelier/plans/plan.md"), "# Plan\n")

    await orchestrator.handleSignal({
      type: "stage_complete",
      sessionId: writePlanStarted.sessionId,
      verdict: "partial",
      outputPath: ".atelier/plans/plan.md",
    })

    // write_plan is NOT in PARTIAL_RESTART_STAGES — partial falls through to normal completion path.
    const writePlanStages = pipelineState.getPipeline(pipelineId)!.stages.filter(s => s.stage === "write_plan")
    expect(writePlanStages).toHaveLength(1)
    expect(writePlanStages[0]!.status).toBe("completed")
    // Pipeline advances to review_plan since this was treated as a regular completion.
    expect(events.some(e => e.type === "stage_started" && e.stage === "review_plan")).toBe(true)
  })

  it("on verdict=partial for fix_code stage: same restart behavior (appends new entry, sets restartedFromPartial)", async () => {
    const pipelineId = await driveToImplement(orchestrator, engine, events, workspaceDir, pipelineState)
    await signalStage(orchestrator, events, "implement", { verdict: "done" }, workspaceDir)
    // review_code with has_issues triggers a fix_code fixer stage
    await signalStage(orchestrator, events, "review_code", { outputPath: ".atelier/code-review.md", verdict: "has_issues" }, workspaceDir)

    const fixCodeStarted = events.find(e => e.type === "stage_started" && e.stage === "fix_code")!
    expect(fixCodeStarted).toBeTruthy()
    fsSync.writeFileSync(path.join(workspaceDir, ".atelier/progress.md"), "# Progress\n")

    await orchestrator.handleSignal({
      type: "stage_complete",
      sessionId: fixCodeStarted.sessionId,
      verdict: "partial",
      outputPath: ".atelier/progress.md",
    })

    const fixCodeStages = pipelineState.getPipeline(pipelineId)!.stages.filter(s => s.stage === "fix_code")
    expect(fixCodeStages).toHaveLength(2)
    expect(fixCodeStages[0]!.verdict).toBe("partial")
    expect(fixCodeStages[1]!.restartedFromPartial).toBe(true)
    expect(engine.interruptedSessions).toContain(fixCodeStarted.sessionId)
  })

  it("rejects verdict=partial when outputPath missing", async () => {
    await driveToImplement(orchestrator, engine, events, workspaceDir, pipelineState)
    const implementStarted = events.find(e => e.type === "stage_started" && e.stage === "implement")!
    await expect(
      orchestrator.handleSignal({
        type: "stage_complete",
        sessionId: implementStarted.sessionId,
        verdict: "partial",
      }),
    ).rejects.toThrow(/output/i)
  })
})
