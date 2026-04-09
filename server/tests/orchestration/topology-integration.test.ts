import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { Orchestrator } from "../../src/orchestration/orchestrator.js"
import { MockAgentEngine } from "../__utils__/mock-engine.js"
import { createPipelineState, type PipelineState } from "../../src/orchestration/pipeline-state.js"
import { createEventMerger } from "../../src/engine/event-merger.js"
import { resolveStartStage } from "../../src/orchestration/helpers.js"
import * as path from "node:path"
import * as os from "node:os"
import * as fsSync from "node:fs"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")

/** Signal a compile stage by writing its output file and calling handleSignal. */
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
  fsSync.mkdirSync(path.dirname(match[1]), { recursive: true })
  fsSync.writeFileSync(match[1], "compiled prompt content")
  await orch.handleSignal({ type: "stage_complete", sessionId: evt.sessionId })
}

/** Signal a non-compile stage complete. Writes a stub artifact file when outputPath is provided. */
async function signalStage(
  orch: Orchestrator,
  evts: any[],
  stage: string,
  opts?: { outputPath?: string; verdict?: string; action?: string },
  workspacePath?: string,
): Promise<void> {
  const evt = evts.find(e => e.type === "stage_started" && e.stage === stage)
  if (!evt) throw new Error(`No ${stage} stage_started event found`)
  // Write stub artifact file so the mandatory artifact check passes
  if (opts?.outputPath && workspacePath) {
    const absPath = path.isAbsolute(opts.outputPath)
      ? opts.outputPath
      : path.join(workspacePath, opts.outputPath)
    fsSync.mkdirSync(path.dirname(absPath), { recursive: true })
    fsSync.writeFileSync(absPath, `stub artifact for ${stage}`)
  }
  await orch.handleSignal({ type: "stage_complete", sessionId: evt.sessionId, ...opts })
}

/** Signal the classification stage complete with pipelineType and worktreeChoice in the signal.
 *  Also confirms stage models and resumes the pipeline (required for the new pause-after-classify behavior). */
async function signalClassify(
  orch: Orchestrator,
  _engine: MockAgentEngine,
  evts: any[],
  pipelineState: PipelineState,
): Promise<void> {
  const evt = evts.find(e => e.type === "stage_started" && e.stage === "classify")
  if (!evt) throw new Error("No classify stage_started event found")
  await orch.handleSignal({ type: "stage_complete", sessionId: evt.sessionId, pipelineType: "feature", worktreeChoice: "in-tree" })
  // Resume pipeline after classify (pipeline pauses to allow model configuration)
  const pipelineId = (await orch.getActivePipelineIds())[0]
  if (pipelineId) {
    pipelineState.setStageModelConfirmed(pipelineId, true)
    await orch.resumeAfterStageModelsConfirmed(pipelineId)
  }
}

describe("Feature pipeline with review + fix cycle", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let orchestrator: Orchestrator
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atelier-topo-test-"))
    fsSync.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    engine = new MockAgentEngine()
    engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
    pipelineState = createPipelineState(workspaceDir)
    eventMerger = createEventMerger()
    events = []
    eventMerger.subscribe(e => events.push(e))
    orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })
  })

  afterEach(async () => {
    orchestrator.destroy()
    await pipelineState.flush()
    fsSync.rmSync(workspaceDir, { recursive: true, force: true })
  })

  it("drives compile → brainstorm → review_spec (has_issues) → fix_spec → advance", async () => {
    await orchestrator.startPipeline("build auth")
    await signalClassify(orchestrator, engine, events, pipelineState)

    // 1. compile_brainstorm
    await signalCompile(orchestrator, engine, events, "compile_brainstorm")

    // 2. brainstorm
    await signalStage(orchestrator, events, "brainstorm", { outputPath: ".atelier/spec.md" }, workspaceDir)

    // 3. review_spec — returns has_issues
    const reviewEvt = events.find(e => e.type === "stage_started" && e.stage === "review_spec")
    expect(reviewEvt).toBeTruthy()
    await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review.md", verdict: "has_issues" }, workspaceDir)

    // 4. fix_spec inserted and started
    expect(events.some(e => e.type === "fix_stage_inserted")).toBe(true)
    const fixEvt = events.find(e => e.type === "stage_started" && e.stage === "fix_spec")
    expect(fixEvt).toBeTruthy()

    // 5. fix_spec completes → advances past review to next topology stage
    await signalStage(orchestrator, events, "fix_spec", { outputPath: ".atelier/fix-spec.md" }, workspaceDir)

    // Should have advanced to establish_conventions or compile_plan
    const nextEvt = events.find(e =>
      e.type === "stage_started" && (e.stage === "compile_plan" || e.stage === "establish_conventions")
    )
    expect(nextEvt).toBeTruthy()
  })

  it("review_spec (stuck) → escalation event emitted", async () => {
    await orchestrator.startPipeline("build auth")
    await signalClassify(orchestrator, engine, events, pipelineState)

    await signalCompile(orchestrator, engine, events, "compile_brainstorm")
    await signalStage(orchestrator, events, "brainstorm", { outputPath: ".atelier/spec.md" }, workspaceDir)
    await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review.md", verdict: "stuck" }, workspaceDir)

    const stuckEvt = events.find(e => e.type === "stuck_escalation")
    expect(stuckEvt).toBeTruthy()
    expect(stuckEvt.stage).toBe("review_spec")
  })

  it("review_spec (done) → advances to next stage without fixer", async () => {
    await orchestrator.startPipeline("build auth")
    await signalClassify(orchestrator, engine, events, pipelineState)

    await signalCompile(orchestrator, engine, events, "compile_brainstorm")
    await signalStage(orchestrator, events, "brainstorm", { outputPath: ".atelier/spec.md" }, workspaceDir)
    await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review.md", verdict: "done" }, workspaceDir)

    // No fix_spec should be started
    expect(events.find(e => e.type === "stage_started" && e.stage === "fix_spec")).toBeFalsy()

    // Should advance to establish_conventions or compile_plan
    const nextEvt = events.find(e =>
      e.type === "stage_started" && (e.stage === "compile_plan" || e.stage === "establish_conventions")
    )
    expect(nextEvt).toBeTruthy()
  })

  it("stuck stage accepts revised verdict (re-signaling)", async () => {
    await orchestrator.startPipeline("build auth")
    await signalClassify(orchestrator, engine, events, pipelineState)

    await signalCompile(orchestrator, engine, events, "compile_brainstorm")
    await signalStage(orchestrator, events, "brainstorm", { outputPath: ".atelier/spec.md" }, workspaceDir)

    // review_spec → stuck
    await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review.md", verdict: "stuck" }, workspaceDir)

    const stuckEvt = events.find(e => e.type === "stuck_escalation")
    expect(stuckEvt).toBeTruthy()

    // Re-signal with revised verdict (done) — should advance
    const reviewEvt = events.find(e => e.type === "stage_started" && e.stage === "review_spec")!
    fsSync.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    fsSync.writeFileSync(path.join(workspaceDir, ".atelier/review-revised.md"), "stub")
    await orchestrator.handleSignal({ type: "stage_complete", sessionId: reviewEvt.sessionId, outputPath: ".atelier/review-revised.md", verdict: "done" })

    // Should advance to next stage, no fixer inserted
    expect(events.find(e => e.type === "stage_started" && e.stage === "fix_spec")).toBeFalsy()
    const nextEvt = events.find(e =>
      e.type === "stage_started" && (e.stage === "compile_plan" || e.stage === "establish_conventions")
    )
    expect(nextEvt).toBeTruthy()
  })

  it("handleStuckRetry resume transitions stage back to running", async () => {
    await orchestrator.startPipeline("build auth")
    await signalClassify(orchestrator, engine, events, pipelineState)

    await signalCompile(orchestrator, engine, events, "compile_brainstorm")
    await signalStage(orchestrator, events, "brainstorm", { outputPath: ".atelier/spec.md" }, workspaceDir)

    // review_spec → stuck
    await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review.md", verdict: "stuck" }, workspaceDir)

    const stuckEvt = events.find(e => e.type === "stuck_escalation")
    expect(stuckEvt).toBeTruthy()

    // Resume the stuck stage
    await orchestrator.handleStuckRetry(stuckEvt.pipelineId, stuckEvt.stageId, "resume")

    // Stage should be running again
    const detail = pipelineState.getPipeline(stuckEvt.pipelineId)!
    const stage = detail.stages.find(s => s.id === stuckEvt.stageId)!
    expect(stage.status).toBe("running")
  })

  it("fix_spec completes → advances past review without re-running review", async () => {
    await orchestrator.startPipeline("build auth")
    await signalClassify(orchestrator, engine, events, pipelineState)

    await signalCompile(orchestrator, engine, events, "compile_brainstorm")
    await signalStage(orchestrator, events, "brainstorm", { outputPath: ".atelier/spec.md" }, workspaceDir)
    await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review.md", verdict: "has_issues" }, workspaceDir)

    // fix_spec inserted
    expect(events.some(e => e.type === "fix_stage_inserted")).toBe(true)

    // Complete fix_spec
    await signalStage(orchestrator, events, "fix_spec", { outputPath: ".atelier/fix-spec.md" }, workspaceDir)

    // Count how many times review_spec started — should be exactly 1
    const reviewStartCount = events.filter(e => e.type === "stage_started" && e.stage === "review_spec").length
    expect(reviewStartCount).toBe(1)

    // Should advance past review to next topology stage
    const nextEvt = events.find(e =>
      e.type === "stage_started" && (e.stage === "compile_plan" || e.stage === "establish_conventions")
    )
    expect(nextEvt).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// Phase 4: E2E stage integration tests
// ---------------------------------------------------------------------------

/** Drive pipeline through the first 10 stages (up to and including simplify). */
async function driveToSimplifyComplete(
  orch: Orchestrator,
  engine: MockAgentEngine,
  evts: any[],
  ws?: string,
): Promise<void> {
  await signalCompile(orch, engine, evts, "compile_brainstorm")
  await signalStage(orch, evts, "brainstorm", { outputPath: ".atelier/spec.md" }, ws)
  await signalStage(orch, evts, "review_spec", { verdict: "done", outputPath: ".atelier/spec-review.md" }, ws)
  // establish_conventions may be skipped (CLAUDE.md exists in workspace) — handle both cases
  const ecEvt = evts.find(e => e.type === "stage_started" && e.stage === "establish_conventions")
  if (ecEvt) {
    await signalStage(orch, evts, "establish_conventions", { outputPath: ".atelier/conventions.md" }, ws)
  }
  await signalCompile(orch, engine, evts, "compile_plan")
  await signalStage(orch, evts, "write_plan", { outputPath: ".atelier/plan.md" }, ws)
  await signalStage(orch, evts, "review_plan", { verdict: "done", outputPath: ".atelier/plan-review.md" }, ws)
  await signalStage(orch, evts, "implement")
  await signalStage(orch, evts, "review_code", { verdict: "done", outputPath: ".atelier/code-review.md" }, ws)
  await signalStage(orch, evts, "simplify", { outputPath: ".atelier/simplify.md" }, ws)
}

/** Drive pipeline through simplify + e2e_gate (proceed verdict). */
async function driveToE2eGateComplete(
  orch: Orchestrator,
  engine: MockAgentEngine,
  evts: any[],
  ws?: string,
): Promise<void> {
  await driveToSimplifyComplete(orch, engine, evts, ws)
  // e2e_gate should start after simplify
  await signalStage(orch, evts, "e2e_gate", { verdict: "proceed", outputPath: ".atelier/e2e-gate.md" }, ws)
}

describe("Phase 4: Full 15-stage traversal (Task 16)", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let orchestrator: Orchestrator
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atelier-e2e-topo-"))
    fsSync.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    engine = new MockAgentEngine()
    engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
    pipelineState = createPipelineState(workspaceDir)
    eventMerger = createEventMerger()
    events = []
    eventMerger.subscribe(e => events.push(e))
    orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })
  })

  afterEach(async () => {
    orchestrator.destroy()
    await pipelineState.flush()
    fsSync.rmSync(workspaceDir, { recursive: true, force: true })
  })

  it("drives all 15 stages to pipeline completion", async () => {
    await orchestrator.startPipeline("build auth e2e")
    await signalClassify(orchestrator, engine, events, pipelineState)

    // Stages 1-11 (through e2e_gate with proceed verdict)
    await driveToE2eGateComplete(orchestrator, engine, events, workspaceDir)

    // Stage 12: compile_e2e_plan
    const compileE2eEvt = events.find(e => e.type === "stage_started" && e.stage === "compile_e2e_plan")
    expect(compileE2eEvt).toBeTruthy()
    await signalCompile(orchestrator, engine, events, "compile_e2e_plan")

    // Stage 13: write_e2e_plan
    const writeE2eEvt = events.find(e => e.type === "stage_started" && e.stage === "write_e2e_plan")
    expect(writeE2eEvt).toBeTruthy()
    await signalStage(orchestrator, events, "write_e2e_plan", { outputPath: ".atelier/e2e-plan.md" }, workspaceDir)

    // Stage 14: review_e2e_plan
    const reviewE2eEvt = events.find(e => e.type === "stage_started" && e.stage === "review_e2e_plan")
    expect(reviewE2eEvt).toBeTruthy()
    await signalStage(orchestrator, events, "review_e2e_plan", { verdict: "done", outputPath: ".atelier/e2e-plan-review.md" }, workspaceDir)

    // Stage 15: e2e
    const e2eEvt = events.find(e => e.type === "stage_started" && e.stage === "e2e")
    expect(e2eEvt).toBeTruthy()
    await signalStage(orchestrator, events, "e2e")

    // Stage 16: validate (no longer skipped — runs as autonomous stage)
    const validateEvt = events.find(e => e.type === "stage_started" && e.stage === "validate")
    expect(validateEvt).toBeTruthy()
    await signalStage(orchestrator, events, "validate")

    // Pipeline should be completed
    const completedEvt = events.find(e => e.type === "pipeline_completed")
    expect(completedEvt).toBeTruthy()
  })
})

describe("Phase 4: review_e2e_plan → fix cycle (Task 17)", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let orchestrator: Orchestrator
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atelier-e2e-fix-"))
    fsSync.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    engine = new MockAgentEngine()
    engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
    pipelineState = createPipelineState(workspaceDir)
    eventMerger = createEventMerger()
    events = []
    eventMerger.subscribe(e => events.push(e))
    orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })
  })

  afterEach(async () => {
    orchestrator.destroy()
    await pipelineState.flush()
    fsSync.rmSync(workspaceDir, { recursive: true, force: true })
  })

  it("review_e2e_plan (has_issues) → fix_e2e_plan → advances to e2e", async () => {
    await orchestrator.startPipeline("build auth e2e fix")
    await signalClassify(orchestrator, engine, events, pipelineState)

    await driveToE2eGateComplete(orchestrator, engine, events, workspaceDir)
    await signalCompile(orchestrator, engine, events, "compile_e2e_plan")
    await signalStage(orchestrator, events, "write_e2e_plan", { outputPath: ".atelier/e2e-plan.md" }, workspaceDir)

    // review_e2e_plan returns has_issues
    await signalStage(orchestrator, events, "review_e2e_plan", { verdict: "has_issues", outputPath: ".atelier/e2e-plan-review.md" }, workspaceDir)

    // fix_e2e_plan inserted and started
    expect(events.some(e => e.type === "fix_stage_inserted" && e.fixStage === "fix_e2e_plan")).toBe(true)
    const fixEvt = events.find(e => e.type === "stage_started" && e.stage === "fix_e2e_plan")
    expect(fixEvt).toBeTruthy()

    // fix_e2e_plan completes → advances past review to e2e
    // (reviewBehavior: "fixing" advances past, same as fix_plan/fix_code)
    await signalStage(orchestrator, events, "fix_e2e_plan", { outputPath: ".atelier/fix-e2e-plan.md" }, workspaceDir)

    // review_e2e_plan should have started exactly once
    const reviewCount = events.filter(e => e.type === "stage_started" && e.stage === "review_e2e_plan").length
    expect(reviewCount).toBe(1)

    // Should advance to e2e
    const e2eEvt = events.find(e => e.type === "stage_started" && e.stage === "e2e")
    expect(e2eEvt).toBeTruthy()
  })

  it("review_e2e_plan (stuck) → stuck_escalation emitted", async () => {
    await orchestrator.startPipeline("build auth e2e stuck")
    await signalClassify(orchestrator, engine, events, pipelineState)

    await driveToE2eGateComplete(orchestrator, engine, events, workspaceDir)
    await signalCompile(orchestrator, engine, events, "compile_e2e_plan")
    await signalStage(orchestrator, events, "write_e2e_plan", { outputPath: ".atelier/e2e-plan.md" }, workspaceDir)

    // review_e2e_plan returns stuck
    await signalStage(orchestrator, events, "review_e2e_plan", { verdict: "stuck", outputPath: ".atelier/e2e-plan-review.md" }, workspaceDir)

    const stuckEvt = events.find(e => e.type === "stuck_escalation")
    expect(stuckEvt).toBeTruthy()
    expect(stuckEvt.stage).toBe("review_e2e_plan")
  })
})

describe("E2E gate skip verdict", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let orchestrator: Orchestrator
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atelier-e2e-gate-"))
    fsSync.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    engine = new MockAgentEngine()
    engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
    pipelineState = createPipelineState(workspaceDir)
    eventMerger = createEventMerger()
    events = []
    eventMerger.subscribe(e => events.push(e))
    orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
    })
  })

  afterEach(async () => {
    orchestrator.destroy()
    await pipelineState.flush()
    fsSync.rmSync(workspaceDir, { recursive: true, force: true })
  })

  it("e2e_gate (skip) → pipeline completes without E2E stages", async () => {
    await orchestrator.startPipeline("build research algo")
    await signalClassify(orchestrator, engine, events, pipelineState)

    await driveToSimplifyComplete(orchestrator, engine, events, workspaceDir)

    // e2e_gate signals skip
    await signalStage(orchestrator, events, "e2e_gate", { verdict: "skip", outputPath: ".atelier/e2e-gate.md" }, workspaceDir)

    // validate should start (it's not an E2E stage — not skipped by e2e_gate)
    const validateEvt = events.find(e => e.type === "stage_started" && e.stage === "validate")
    expect(validateEvt).toBeTruthy()
    await signalStage(orchestrator, events, "validate")

    // Pipeline should be completed
    const completedEvt = events.find(e => e.type === "pipeline_completed")
    expect(completedEvt).toBeTruthy()

    // No E2E stages should have started
    expect(events.find(e => e.type === "stage_started" && e.stage === "compile_e2e_plan")).toBeFalsy()
    expect(events.find(e => e.type === "stage_started" && e.stage === "write_e2e_plan")).toBeFalsy()
    expect(events.find(e => e.type === "stage_started" && e.stage === "e2e")).toBeFalsy()
  })

  it("e2e_gate (proceed) → advances to compile_e2e_plan", async () => {
    await orchestrator.startPipeline("build web app")
    await signalClassify(orchestrator, engine, events, pipelineState)

    await driveToSimplifyComplete(orchestrator, engine, events, workspaceDir)

    // e2e_gate signals proceed
    await signalStage(orchestrator, events, "e2e_gate", { verdict: "proceed", outputPath: ".atelier/e2e-gate.md" }, workspaceDir)

    // compile_e2e_plan should start
    const compileEvt = events.find(e => e.type === "stage_started" && e.stage === "compile_e2e_plan")
    expect(compileEvt).toBeTruthy()
  })
})

describe("Phase 4: Crash recovery from E2E stages (Task 18)", () => {
  it("resolveStartStage('write_e2e_plan') returns 'compile_e2e_plan'", () => {
    expect(resolveStartStage("write_e2e_plan")).toBe("compile_e2e_plan")
  })

  it("resolveStartStage('review_e2e_plan') returns 'review_e2e_plan' (no compile needed)", () => {
    expect(resolveStartStage("review_e2e_plan")).toBe("review_e2e_plan")
  })

  it("resolveStartStage('e2e') returns 'e2e' (no compile needed)", () => {
    expect(resolveStartStage("e2e")).toBe("e2e")
  })
})

