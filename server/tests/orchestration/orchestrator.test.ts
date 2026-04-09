import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Orchestrator } from "../../src/orchestration/orchestrator.js"
import { MockAgentEngine } from "../__utils__/mock-engine.js"
import { BackendRegistry } from "../../src/engine/backend-registry.js"
import { createPipelineState, type PipelineState } from "../../src/orchestration/pipeline-state.js"
import { createEventMerger } from "../../src/engine/event-merger.js"
import { writeSettings } from "@atelier/core/settings"
import { atelierStateDir } from "@atelier/core/state-dir"
import type { PipelineEvent } from "@atelier/core"
import * as path from "node:path"
import * as os from "node:os"
import * as fsSync from "node:fs"
import { execFileSync } from "node:child_process"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../../skills")

/** Flush microtasks after vi.advanceTimersByTime — uses process.nextTick (not faked). */
async function tickFlush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise(r => process.nextTick(r))
}

/** Poll until fn() returns true (real-timer friendly). */
async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timeout")
    await new Promise(r => setTimeout(r, 10))
  }
}

/** Signal a compile stage complete by writing the output file and calling handleSignal. */
async function signalCompile(
  orch: Orchestrator,
  engine: MockAgentEngine,
  evts: any[],
  stage: "compile_brainstorm" | "compile_plan" | "compile_e2e_plan",
): Promise<void> {
  const evt = evts.find(e => e.type === "stage_started" && e.stage === stage)
  if (!evt) throw new Error(`No ${stage} stage_started event found`)

  // Extract output path from the compile message sent to this session
  const msg = engine.messages.find(m => m.sessionId === evt.sessionId && m.content?.includes("**Output path:**"))
  const match = msg?.content.match(/\*\*Output path:\*\* (.+)/)
  if (!match) throw new Error(`No output path in compile message for ${stage}`)

  const outputPath = match[1]
  fsSync.mkdirSync(path.dirname(outputPath), { recursive: true })
  fsSync.writeFileSync(outputPath, "compiled prompt content")

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
  engine: MockAgentEngine,
  evts: any[],
  pipelineState?: PipelineState,
  opts?: { pipelineType?: string; worktreeChoice?: string },
): Promise<void> {
  const evt = evts.findLast(e => e.type === "stage_started" && e.stage === "classify")
  if (!evt) throw new Error("No classify stage_started event found")
  const pipelineType = opts?.pipelineType ?? "feature"
  const worktreeChoice = opts?.worktreeChoice ?? "in-tree"
  await orch.handleSignal({ type: "stage_complete", sessionId: evt.sessionId, pipelineType, worktreeChoice })
  // Resume pipeline after classify (pipeline pauses to allow model configuration)
  if (pipelineState) {
    // Use pipelineId from the event itself to handle concurrent pipelines correctly
    const pipelineId = (evt as any).pipelineId ?? (await orch.getActivePipelineIds())[0]
    if (pipelineId) {
      pipelineState.setStageModelConfirmed(pipelineId, true)
      await orch.resumeAfterStageModelsConfirmed(pipelineId)
    }
  }
}

/** Drive a feature pipeline from start to a target stage. Returns pipelineId + target's sessionId. */
async function driveToStage(
  orch: Orchestrator,
  engine: MockAgentEngine,
  evts: any[],
  target: "brainstorm" | "review_spec" | "write_plan" | "review_plan" | "implement",
  workspacePath?: string,
  pipelineState?: PipelineState,
): Promise<{ pipelineId: string; sessionId: string }> {
  const pipelineId = await orch.startPipeline("build a todo app")
  const ws = workspacePath

  await signalClassify(orch, engine, evts, pipelineState!)
  await signalCompile(orch, engine, evts, "compile_brainstorm")
  if (target === "brainstorm") {
    return { pipelineId, sessionId: evts.find(e => e.type === "stage_started" && e.stage === "brainstorm")!.sessionId }
  }

  await signalStage(orch, evts, "brainstorm", { outputPath: ".atelier/specs/spec.md" }, ws)
  if (target === "review_spec") {
    return { pipelineId, sessionId: evts.find(e => e.type === "stage_started" && e.stage === "review_spec")!.sessionId }
  }

  await signalStage(orch, evts, "review_spec", { outputPath: ".atelier/review-spec.md", verdict: "done" }, ws)

  // establish_conventions (conditional — may or may not run with mock engine)
  if (evts.find(e => e.type === "stage_started" && e.stage === "establish_conventions")) {
    await signalStage(orch, evts, "establish_conventions", { outputPath: ".atelier/conventions.md" }, ws)
  }

  await signalCompile(orch, engine, evts, "compile_plan")
  if (target === "write_plan") {
    return { pipelineId, sessionId: evts.find(e => e.type === "stage_started" && e.stage === "write_plan")!.sessionId }
  }

  await signalStage(orch, evts, "write_plan", { outputPath: ".atelier/plans/plan.md" }, ws)
  if (target === "review_plan") {
    return { pipelineId, sessionId: evts.find(e => e.type === "stage_started" && e.stage === "review_plan")!.sessionId }
  }

  await signalStage(orch, evts, "review_plan", { outputPath: ".atelier/plan-review.md", verdict: "done" }, ws)
  if (target === "implement") {
    return { pipelineId, sessionId: evts.find(e => e.type === "stage_started" && e.stage === "implement")!.sessionId }
  }

  throw new Error(`Unknown target stage: ${target}`)
}

/** Drive through e2e_gate + E2E stages (e2e_gate → compile_e2e_plan → write_e2e_plan → review_e2e_plan → e2e) to pipeline completion. */
async function driveE2eStages(orch: Orchestrator, engine: MockAgentEngine, evts: any[], workspacePath?: string): Promise<void> {
  await signalStage(orch, evts, "e2e_gate", { verdict: "proceed", outputPath: ".atelier/e2e-gate.md" }, workspacePath)
  await signalCompile(orch, engine, evts, "compile_e2e_plan")
  await signalStage(orch, evts, "write_e2e_plan", { outputPath: ".atelier/e2e-plan.md" }, workspacePath)
  await signalStage(orch, evts, "review_e2e_plan", { verdict: "done", outputPath: ".atelier/e2e-review.md" }, workspacePath)
  await signalStage(orch, evts, "e2e")
  await signalStage(orch, evts, "validate")
}

describe("Orchestrator", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let orchestrator: Orchestrator
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atelier-test-"))
    fsSync.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })

    // Initialize git repo — git integration requires it
    execFileSync("git", ["init"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspaceDir })
    execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: workspaceDir })
    // Gitignore .atelier so orchestrator artifacts don't dirty the working tree
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
    // Clean up per-workspace state dir (~/.atelier/<hash>) created by settings writes
    try { fsSync.rmSync(atelierStateDir(workspaceDir), { recursive: true, force: true }) } catch {}
  })

  describe("session monitor scaffolding", () => {
    it("installs a session monitor and routes normalized events through it", () => {
      const monitor = (orchestrator as any).monitor
      expect(monitor).toBeDefined()
      expect(typeof monitor.recordNormalizedEvent).toBe("function")

      const spy = vi.spyOn(monitor, "recordNormalizedEvent")
      orchestrator.handleSessionBusy("sess-detector")
      expect(spy).toHaveBeenCalled()
    })
  })

  describe("SSE to normalized event mapping", () => {
    it("records normalized events and pending interaction asks at ingest hooks", () => {
      const monitor = (orchestrator as any).monitor
      const spy = vi.spyOn(monitor, "recordNormalizedEvent")

      orchestrator.handleNormalizedEvent({ kind: "busy_edge", sessionId: "sess-map" })
      orchestrator.handleInteractionAsked("sess-map", "req-1")
      orchestrator.handleInteractionAsked("sess-map", "req-1")

      expect(spy).toHaveBeenCalledWith({ kind: "busy_edge", sessionId: "sess-map" })
      expect((orchestrator as any).pendingInteractionIds.get("sess-map").size).toBe(1)
    })
  })

  describe("stage assignment contract", () => {
    it("stores assignedOutputPath at stage registration for artifact stages", async () => {
      const { pipelineId } = await driveToStage(orchestrator, engine, events, "write_plan", workspaceDir, pipelineState)
      const writePlanStarted = events.find((e) => e.type === "stage_started" && e.stage === "write_plan")
      expect(writePlanStarted).toBeTruthy()
      const detail = pipelineState.getPipeline(pipelineId)!
      const stage = detail.stages.find((s) => s.id === (writePlanStarted as any).stageId)
      expect(stage?.assignedOutputPath).toBeTruthy()
      expect(stage?.outputPath ?? null).toBeNull()
    })

    it("compile stage still requires compiled prompt file existence before advancing", async () => {
      await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      const compileStarted = events.find((e) => e.type === "stage_started" && e.stage === "compile_brainstorm")!
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: (compileStarted as any).sessionId })
      // Pipeline goes idle with error — no stage_started for brainstorm
      expect(events.some((e) => e.type === "stage_started" && e.stage === "brainstorm")).toBe(false)
    })
  })

  describe("pending interaction lifecycle", () => {
    it("adds ask ids, clears on reply, and sweeps detector when count reaches zero", () => {
      const monitor = (orchestrator as any).monitor
      const sweepSpy = vi.spyOn(monitor, "sweep")

      orchestrator.handleInteractionAsked("sess-pending", "req-1")
      orchestrator.handleInteractionAsked("sess-pending", "req-2")
      expect((orchestrator as any).pendingInteractionIds.get("sess-pending").size).toBe(2)

      orchestrator.handleInteractionReplied("sess-pending", "req-1")
      expect(sweepSpy).not.toHaveBeenCalled()
      orchestrator.handleInteractionReplied("sess-pending", "req-2")
      expect((orchestrator as any).pendingInteractionIds.has("sess-pending")).toBe(false)
      expect(sweepSpy).toHaveBeenCalled()
    })
  })

  describe("idle detector behavior", () => {
    it("escalates to stuck after quiet window + corroboration", async () => {
      const localEngine = new MockAgentEngine()
      localEngine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
      const localState = createPipelineState(workspaceDir)
      const localMerger = createEventMerger()
      const localEvents: any[] = []
      localMerger.subscribe((event) => localEvents.push(event))
      const localOrchestrator = new Orchestrator({
        engine: localEngine,
        pipelineState: localState,
        eventMerger: localMerger,
        skillsDir: SKILLS_DIR,
        workspacePath: workspaceDir,
        sweepIntervalMs: 50,
        detectorServerDefaults: {
          quietWindowMs: 50,
          quietCorroborationMs: 50,
        },
      })

      const { sessionId } = await driveToStage(localOrchestrator, localEngine, localEvents, "write_plan", workspaceDir, localState)
      localOrchestrator.handleSessionIdle(sessionId)

      // Should escalate to stuck after quiet window + corroboration (direct, no nudge)
      await waitFor(() => localEvents.some((e) => e.type === "stuck_escalation"))
      expect(localEvents.some((e) => e.type === "stuck_escalation")).toBe(true)
      localOrchestrator.destroy()
    })

    it("suppresses escalation while a stage is interrupted", async () => {
      const localEngine = new MockAgentEngine()
      localEngine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
      const localState = createPipelineState(workspaceDir)
      const localMerger = createEventMerger()
      const localEvents: any[] = []
      localMerger.subscribe((event) => localEvents.push(event))
      const localOrchestrator = new Orchestrator({
        engine: localEngine,
        pipelineState: localState,
        eventMerger: localMerger,
        skillsDir: SKILLS_DIR,
        workspacePath: workspaceDir,
      })

      const { sessionId } = await driveToStage(localOrchestrator, localEngine, localEvents, "write_plan", workspaceDir, localState)
      vi.useFakeTimers()
      await localOrchestrator.abortStageSession(sessionId)

      vi.advanceTimersByTime(200_000)
      expect(localEvents.some((e) => e.type === "stuck_escalation")).toBe(false)

      localOrchestrator.destroy()
      vi.useRealTimers()
    })
  })

  describe("idle detection observability", () => {
    it("tracks transition metrics from detector decisions", async () => {
      const localEngine = new MockAgentEngine()
      localEngine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
      const localState = createPipelineState(workspaceDir)
      const localMerger = createEventMerger()
      const localEvents: any[] = []
      localMerger.subscribe((event) => localEvents.push(event))
      const localOrchestrator = new Orchestrator({
        engine: localEngine,
        pipelineState: localState,
        eventMerger: localMerger,
        skillsDir: SKILLS_DIR,
        workspacePath: workspaceDir,
        sweepIntervalMs: 50,
        detectorServerDefaults: {
          quietWindowMs: 50,
          quietCorroborationMs: 50,
        },
      })

      const { sessionId } = await driveToStage(localOrchestrator, localEngine, localEvents, "write_plan", workspaceDir, localState)
      localOrchestrator.handleSessionIdle(sessionId)

      // Wait for escalation and transition metrics to be recorded
      await waitFor(() => {
        const m = localOrchestrator.getIdleMetricsForTests()
        return (m.transitions["WORKING->QUIET_PENDING:write_plan"] ?? 0) >= 1
          && (m.transitions["QUIET_PENDING->IDLE_DETECTED:write_plan"] ?? 0) >= 1
      })

      const metrics = localOrchestrator.getIdleMetricsForTests()
      expect(metrics.transitions["WORKING->QUIET_PENDING:write_plan"]).toBeGreaterThanOrEqual(1)
      expect(metrics.transitions["QUIET_PENDING->IDLE_DETECTED:write_plan"]).toBeGreaterThanOrEqual(1)
      expect(metrics.detectionLatencyMs.idle_candidate?.length ?? 0).toBeGreaterThan(0)

      localOrchestrator.destroy()
    })
  })

  describe("done-unsignaled exhaustion semantics", () => {
    it("emits stuck escalation with done_unsignaled_timeout for autonomous stage", async () => {
      const localEngine = new MockAgentEngine()
      localEngine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
      const localState = createPipelineState(workspaceDir)
      const localMerger = createEventMerger()
      const localEvents: PipelineEvent[] = []
      localMerger.subscribe((event) => localEvents.push(event))
      const localOrchestrator = new Orchestrator({
        engine: localEngine,
        pipelineState: localState,
        eventMerger: localMerger,
        skillsDir: SKILLS_DIR,
        workspacePath: workspaceDir,
        sweepIntervalMs: 50,
        detectorServerDefaults: {
          quietWindowMs: 50,
          quietCorroborationMs: 50,
          doneUnsignaledWindowMs: 50,
        },
      })

      const { pipelineId, sessionId } = await driveToStage(localOrchestrator, localEngine, localEvents as any[], "write_plan", workspaceDir, localState)
      const stageStarted = localEvents.find((event) => event.type === "stage_started" && (event as any).stage === "write_plan") as any
      const detailBefore = localState.getPipeline(pipelineId)
      const stageBefore = detailBefore?.stages.find((stage) => stage.id === stageStarted.stageId)
      expect(stageBefore?.assignedOutputPath).toBeTruthy()

      const assignedPath = path.join(workspaceDir, stageBefore!.assignedOutputPath!)
      fsSync.mkdirSync(path.dirname(assignedPath), { recursive: true })
      fsSync.writeFileSync(assignedPath, "# plan")

      // done_unsignaled path: artifact present → escalates directly to stuck
      await waitFor(() => localEvents.some((event) => event.type === "stuck_escalation"))

      const stuckEscalations = localEvents.filter((event) => event.type === "stuck_escalation") as any[]
      expect(stuckEscalations).toHaveLength(1)
      expect(stuckEscalations[0]?.reason).toBe("done_unsignaled_timeout")

      const detailAfter = localState.getPipeline(pipelineId)
      const stageAfter = detailAfter?.stages.find((stage) => stage.id === stageStarted.stageId)
      expect(stageAfter?.status).toBe("stuck")
      expect(stageAfter?.error).toBe("done_unsignaled_timeout")

      localOrchestrator.destroy()
    })

    it("skips stuck escalation for interactive stages", async () => {
      const localEngine = new MockAgentEngine()
      localEngine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
      const localState = createPipelineState(workspaceDir)
      const localMerger = createEventMerger()
      const localEvents: PipelineEvent[] = []
      localMerger.subscribe((event) => localEvents.push(event))
      const localOrchestrator = new Orchestrator({
        engine: localEngine,
        pipelineState: localState,
        eventMerger: localMerger,
        skillsDir: SKILLS_DIR,
        workspacePath: workspaceDir,
      })

      await driveToStage(localOrchestrator, localEngine, localEvents as any[], "brainstorm", workspaceDir, localState)

      vi.useFakeTimers()

      // Advance well past all idle windows — nothing should fire for interactive stage
      vi.advanceTimersByTime(300_000)
      await tickFlush()

      expect(localEvents.filter((event) => event.type === "stuck_escalation")).toHaveLength(0)

      localOrchestrator.destroy()
      vi.useRealTimers()
    })
  })

  describe("startPipeline", () => {
    it("creates a pipeline and starts classify", async () => {
      const pipelineId = await orchestrator.startPipeline("build a todo app")

      expect(pipelineId).toBeTruthy()
      const pipeline = pipelineState.getPipeline(pipelineId)
      expect(pipeline).toBeTruthy()
      expect(pipeline!.status).toBe("running")
      expect(pipeline!.prompt).toBe("build a todo app")
      expect(pipeline!.workspacePath).toBe(workspaceDir)

      // Should have created at least one session (classify)
      expect(engine.sessions.size).toBeGreaterThanOrEqual(1)
      // Should have emitted stage_started for classify (first stage before topology)
      expect(events.some(e => e.type === "stage_started" && e.stage === "classify")).toBe(true)
    })

    it("creates bare progress.md in pipeline directory", async () => {
      await orchestrator.startPipeline("build a todo app")

      // Find the pipeline directory
      const pipelinesDir = path.join(workspaceDir, ".atelier/pipelines")
      const dirs = fsSync.readdirSync(pipelinesDir)
      expect(dirs.length).toBe(1)

      const progressPath = path.join(pipelinesDir, dirs[0], "progress.md")
      expect(fsSync.existsSync(progressPath)).toBe(true)

      const content = fsSync.readFileSync(progressPath, "utf-8")
      expect(content).toContain("# Progress")
      expect(content).toContain("## Summary")
      expect(content).toContain("## Tasks")
      expect(content).toContain("## Iteration Log")
      expect(content).not.toContain("## Pipeline")
    })
    it("stores sourceSessionId on pipeline state when provided", async () => {
      const { pipelineId, completion } = orchestrator.startPipelineAsync("fork me", {
        type: "feature",
        sourceSessionId: "build-sess-xyz",
      })
      await waitFor(() => events.some(e => e.type === "stage_started" && e.stage === "classify"))

      const pipeline = pipelineState.getPipeline(pipelineId)
      expect(pipeline!.sourceSessionId).toBe("build-sess-xyz")

      orchestrator.failPipeline(pipelineId, "cleanup")
      await completion.catch(() => {})
    })

    it("defaults sourceSessionId to null when not provided", async () => {
      const { pipelineId, completion } = orchestrator.startPipelineAsync("no fork", {
        type: "feature",
      })
      await waitFor(() => events.some(e => e.type === "stage_started" && e.stage === "classify"))

      const pipeline = pipelineState.getPipeline(pipelineId)
      expect(pipeline!.sourceSessionId).toBeNull()

      orchestrator.failPipeline(pipelineId, "cleanup")
      await completion.catch(() => {})
    })
  })

  describe("handleSignal", () => {
    it("advances brainstorm to review_spec on stage_complete signal", async () => {
      const pipelineId = await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      const brainstormStarted = events.find(
        e => e.type === "stage_started" && e.stage === "brainstorm"
      )
      expect(brainstormStarted).toBeTruthy()

      fsSync.mkdirSync(path.join(workspaceDir, ".atelier/specs"), { recursive: true })
      fsSync.writeFileSync(path.join(workspaceDir, ".atelier/specs/2026-02-25-todo.md"), "stub")
      await orchestrator.handleSignal({
        type: "stage_complete",
        sessionId: (brainstormStarted as any).sessionId,
        outputPath: ".atelier/specs/2026-02-25-todo.md",
      })

      // Should now have review_spec stage_started (new topology)
      expect(events.some(e => e.type === "stage_started" && e.stage === "review_spec")).toBe(true)
    })

    it("rejects unknown signal types including stage_blocked", async () => {
      const pipelineId = await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      const compileEvt = events.find(e => e.type === "stage_started" && e.stage === "compile_brainstorm")!
      await expect(
        orchestrator.handleSignal({ type: "stage_blocked", sessionId: compileEvt.sessionId })
      ).rejects.toThrow(/Unknown signal type/)
    })
  })

  describe("full pipeline flow", () => {
    it("runs full feature topology to completion", async () => {
      const { pipelineId, sessionId: implementSessionId } = await driveToStage(orchestrator, engine, events, "implement", workspaceDir, pipelineState)

      let pipeline = pipelineState.getPipeline(pipelineId)
      expect(pipeline!.status).toBe("running")
      expect(pipeline!.currentStage).toBe("implement")

      // implement → signal complete
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: implementSessionId })

      // review_code starts
      await signalStage(orchestrator, events, "review_code", { outputPath: ".atelier/code-review.md", verdict: "done" }, workspaceDir)

      // simplify starts
      await signalStage(orchestrator, events, "simplify", { outputPath: ".atelier/simplify.md" }, workspaceDir)

      // E2E stages
      await driveE2eStages(orchestrator, engine, events, workspaceDir)

      // Pipeline complete
      expect(events.some(e => e.type === "pipeline_completed")).toBe(true)
      pipeline = pipelineState.getPipeline(pipelineId)
      expect(pipeline!.status).toBe("completed")
      expect(pipeline!.completedAt).toBeTruthy()

      // Verify key stages appeared in order
      const allStageStarts = events.filter(e => e.type === "stage_started").map(e => (e as any).stage)
      expect(allStageStarts).toContain("compile_brainstorm")
      expect(allStageStarts).toContain("brainstorm")
      expect(allStageStarts).toContain("review_spec")
      expect(allStageStarts).toContain("compile_plan")
      expect(allStageStarts).toContain("write_plan")
      expect(allStageStarts).toContain("implement")
      expect(allStageStarts).toContain("review_code")
      expect(allStageStarts).toContain("simplify")
      expect(allStageStarts).toContain("e2e_gate")
      expect(allStageStarts).toContain("compile_e2e_plan")
      expect(allStageStarts).toContain("write_e2e_plan")
      expect(allStageStarts).toContain("review_e2e_plan")
      expect(allStageStarts).toContain("e2e")
    })
  })

  describe("session titles", () => {
    it("sets descriptive titles on pipeline sessions", async () => {
      await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      // Should have set titles on the sessions
      expect(engine.titles.size).toBeGreaterThan(0)
      const titles = Array.from(engine.titles.values())
      expect(titles.some(t => t.includes("Compile"))).toBe(true)
      expect(titles.some(t => t.includes("Brainstorm"))).toBe(true)
      const uniqueTitles = new Set(titles)
      expect(uniqueTitles.size).toBeGreaterThanOrEqual(2)
    })

    it("defers session interrupt until idle after stage completion", async () => {
      await orchestrator.startPipeline("test prompt")
      await signalClassify(orchestrator, engine, events, pipelineState)
      const spy = vi.spyOn(engine, "interruptSession")
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")
      const brainstormEvt = events.find(e => e.type === "stage_started" && e.stage === "brainstorm")
      const compileEvt = events.find(e => e.type === "stage_started" && e.stage === "compile_brainstorm")
      await signalStage(orchestrator, events, "brainstorm", { outputPath: ".atelier/spec.md" }, workspaceDir)
      // Interrupt is deferred — not called synchronously on signal
      const callsBeforeIdle = spy.mock.calls.length
      // Simulate the session going idle (agent finished its turn after signal tool returned)
      orchestrator.handleSessionIdle(compileEvt!.sessionId)
      orchestrator.handleSessionIdle(brainstormEvt!.sessionId)
      // Give fire-and-forget promises a tick to resolve
      await new Promise(r => setTimeout(r, 10))
      expect(spy.mock.calls.length).toBeGreaterThan(callsBeforeIdle)
      spy.mockRestore()
    })

    it("interrupts remaining sessions on pipeline deactivation", async () => {
      const pipelineId = await orchestrator.startPipeline("test prompt")
      await signalClassify(orchestrator, engine, events, pipelineState)
      const spy = vi.spyOn(engine, "interruptSession")
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")
      // Fail the pipeline — this triggers deactivate() which should interrupt all sessions
      spy.mockClear()
      await orchestrator.failPipeline(pipelineId, "test failure")
      // Give fire-and-forget promises a tick to resolve
      await new Promise(r => setTimeout(r, 10))
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  describe("invalid state transitions", () => {
    it("ignores signal for an already-completed stage", async () => {
      const pipelineId = await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      const brainstormEvt = events.find(
        e => e.type === "stage_started" && e.stage === "brainstorm"
      )
      expect(brainstormEvt).toBeTruthy()
      const sessionId = (brainstormEvt as any).sessionId

      // Complete brainstorm
      fsSync.mkdirSync(path.join(workspaceDir, ".atelier/specs"), { recursive: true })
      fsSync.writeFileSync(path.join(workspaceDir, ".atelier/specs/2026-02-25-todo.md"), "stub")
      await orchestrator.handleSignal({
        type: "stage_complete",
        sessionId,
        outputPath: ".atelier/specs/2026-02-25-todo.md",
      })

      const eventsBeforeRepeat = events.length

      // Signal the same session again — should be silently ignored (stage is no longer running)
      await orchestrator.handleSignal({
        type: "stage_complete",
        sessionId,
        outputPath: ".atelier/specs/2026-02-25-todo.md",
      })

      // No new events should have been emitted
      expect(events.length).toBe(eventsBeforeRepeat)
    })

    it("throws when signaling after pipeline completion", async () => {
      const { pipelineId, sessionId: implementSessionId } = await driveToStage(orchestrator, engine, events, "implement", workspaceDir, pipelineState)

      // Complete implement → review_code → simplify → E2E stages → pipeline completed
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: implementSessionId })
      await signalStage(orchestrator, events, "review_code", { outputPath: ".atelier/code-review.md", verdict: "done" }, workspaceDir)
      await signalStage(orchestrator, events, "simplify", { outputPath: ".atelier/simplify.md" }, workspaceDir)
      await driveE2eStages(orchestrator, engine, events, workspaceDir)

      expect(events.some(e => e.type === "pipeline_completed")).toBe(true)

      // Now signal with some session — pipeline is done, active is null → silently ignored
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: "any-session" })
      // Should not throw or emit any new events
    })
  })



  describe("failPipeline", () => {
    it("sets pipeline and stage to idle when there is an active pipeline", async () => {
      const pipelineId = await orchestrator.startPipeline("build a todo app")

      // Pipeline is active at compile_brainstorm stage
      expect(orchestrator.hasPipeline(pipelineId)).toBe(true)

      orchestrator.failPipeline(pipelineId, "Server connection lost")

      const pipeline = pipelineState.getPipeline(pipelineId)
      expect(pipeline!.status).toBe("stuck")
      expect(orchestrator.hasPipeline(pipelineId)).toBe(false)
    })

    it("is a no-op when there is no active pipeline", () => {
      const eventsBefore = events.length

      // No pipeline started — failPipeline should do nothing
      orchestrator.failPipeline("nonexistent-id", "Some error")

      expect(events.length).toBe(eventsBefore)
      expect(orchestrator.hasActivePipeline()).toBe(false)
    })
  })

  describe("pipeline resume (fromPipeline/fromStage)", () => {
    it("resumes from write_plan, skipping compile_brainstorm and brainstorm", async () => {
      // Drive to write_plan, then fail it
      const { pipelineId: pipelineId1 } = await driveToStage(orchestrator, engine, events, "write_plan", workspaceDir, pipelineState)
      orchestrator.failPipeline(pipelineId1, "Agent got stuck")
      expect(pipelineState.getPipeline(pipelineId1)!.status).toBe("stuck")

      // Now resume from write_plan
      events.length = 0 // clear events for cleaner assertions
      const pipelineId2 = await orchestrator.startPipeline("build a todo app", {
        fromPipelineId: pipelineId1,
        fromStage: "write_plan",
      })

      // Should have skipped compile_brainstorm and brainstorm
      const detail = pipelineState.getPipeline(pipelineId2)!
      const skippedStages = detail.stages.filter(s => s.status === "skipped")
      expect(skippedStages.some(s => s.stage === "compile_brainstorm")).toBe(true)
      expect(skippedStages.some(s => s.stage === "brainstorm")).toBe(true)

      // Should have started from compile_plan (not compile_brainstorm)
      const stageStarts = events.filter(e => e.type === "stage_started").map(e => (e as any).stage)
      expect(stageStarts[0]).toBe("compile_plan")
      expect(stageStarts).not.toContain("compile_brainstorm")
      expect(stageStarts).not.toContain("brainstorm")
    })

    it("resumes from implement directly without re-compiling", async () => {
      // Drive to implement, then fail it
      const { pipelineId: pipelineId1 } = await driveToStage(orchestrator, engine, events, "implement", workspaceDir, pipelineState)
      orchestrator.failPipeline(pipelineId1, "Stuck")
      expect(pipelineState.getPipeline(pipelineId1)!.status).toBe("stuck")

      // Resume from implement
      events.length = 0
      const pipelineId2 = await orchestrator.startPipeline("build a todo app", {
        fromPipelineId: pipelineId1,
        fromStage: "implement",
      })

      // Should have skipped all stages before implement
      const detail = pipelineState.getPipeline(pipelineId2)!
      const skippedStages = detail.stages.filter(s => s.status === "skipped").map(s => s.stage)
      expect(skippedStages).toContain("compile_brainstorm")
      expect(skippedStages).toContain("brainstorm")
      expect(skippedStages).toContain("compile_plan")
      expect(skippedStages).toContain("write_plan")

      // Should start directly at implement
      const stageStarts = events.filter(e => e.type === "stage_started").map(e => (e as any).stage)
      expect(stageStarts[0]).toBe("implement")
      expect(stageStarts.length).toBe(1) // only implement, since it needs a signal to complete
    })
  })

  describe("idle detection behavior", () => {
    /** Advance pipeline to write_plan or implement and return the active session info */
    async function advanceTo(target: "write_plan" | "implement") {
      return driveToStage(orchestrator, engine, events, target, workspaceDir, pipelineState)
    }

    it("handleSessionIdle records idle_edge for the detector", async () => {
      const { pipelineId, sessionId } = await advanceTo("write_plan")

      orchestrator.handleSessionIdle(sessionId)
      await new Promise(r => setTimeout(r, 0))

      const pipeline = pipelineState.getPipeline(pipelineId)
      expect(pipeline!.status).toBe("running")
    })

    it("handleSessionIdle is safe after pipeline deactivation", async () => {
      const { pipelineId, sessionId } = await advanceTo("write_plan")

      orchestrator.failPipeline(pipelineId, "External failure")

      // Calling handleSessionIdle should be a no-op (no crash)
      orchestrator.handleSessionIdle(sessionId)
      await new Promise(r => setTimeout(r, 0))
    })
  })

  describe("new gateway methods", () => {
    it("isSessionOwnedByPipeline returns true for pipeline sessions", async () => {
      await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      const brainstormEvt = events.find(e => e.type === "stage_started" && e.stage === "brainstorm")
      const sessionId = (brainstormEvt as any).sessionId

      expect(orchestrator.isSessionOwnedByPipeline(sessionId)).toBe(true)
      expect(orchestrator.isSessionOwnedByPipeline("random-session")).toBe(false)
    })

    it("getActiveStageName returns current stage", async () => {
      const pipelineId = await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      expect(orchestrator.getActiveStageName(pipelineId)).toBe("brainstorm")
    })

    it("getActiveStageSessionId returns current stage session", async () => {
      const pipelineId = await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      const brainstormEvt = events.find(e => e.type === "stage_started" && e.stage === "brainstorm")
      const sessionId = (brainstormEvt as any).sessionId

      expect(orchestrator.getActiveStageSessionId(pipelineId)).toBe(sessionId)
    })

    it("abortStageSession sets interrupted and emits stage_interrupted", async () => {
      const pipelineId = await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      const brainstormEvt = events.find(e => e.type === "stage_started" && e.stage === "brainstorm")
      const sessionId = (brainstormEvt as any).sessionId

      await orchestrator.abortStageSession(sessionId)

      expect(orchestrator.isStageInterrupted(pipelineId)).toBe(true)
      expect(events.some(e => e.type === "stage_interrupted")).toBe(true)
    })

    it("resumeStageSession clears interrupted and emits stage_resumed", async () => {
      const pipelineId = await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      const brainstormEvt = events.find(e => e.type === "stage_started" && e.stage === "brainstorm")
      const sessionId = (brainstormEvt as any).sessionId

      await orchestrator.abortStageSession(sessionId)
      expect(orchestrator.isStageInterrupted(pipelineId)).toBe(true)

      await orchestrator.resumeStageSession(sessionId)
      expect(orchestrator.isStageInterrupted(pipelineId)).toBe(false)
      expect(events.some(e => e.type === "stage_resumed")).toBe(true)
    })

  })

  describe("edge cases", () => {
    it("silently ignores signal for unknown session ID", async () => {
      // No active pipeline — should return silently (not throw)
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: "unknown" })
      // No events emitted
      expect(events.length).toBe(0)
    })

    it("rejects unknown signal types", async () => {
      await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      // Use the compile_brainstorm session (already running)
      const compileEvt = events.find(e => e.type === "stage_started" && e.stage === "compile_brainstorm")
      expect(compileEvt).toBeTruthy()

      await expect(
        orchestrator.handleSignal({
          type: "stage_comlete", // typo
          sessionId: (compileEvt as any).sessionId,
        })
      ).rejects.toThrow(/Unknown signal type/)
    })

    it("handles engine error during stage execution", async () => {
      // Make sendMessage throw on the compile stage call (second sendMessage — first is slug generation)
      let sendCount = 0
      const origSend = engine.sendMessage.bind(engine)
      engine.sendMessage = async (sid: string, msg: any) => {
        sendCount++
        if (sendCount > 1) throw new Error("Provider auth failed")
        return origSend(sid, msg)
      }

      const pipelineId = await orchestrator.startPipeline("build a todo app")

      // Pipeline should go stuck (escalated) with error
      const pipeline = pipelineState.getPipeline(pipelineId)
      expect(pipeline!.status).toBe("stuck")
    })

    it("handles skill loading failure gracefully", async () => {
      // Use a nonexistent skills directory
      const badOrchestrator = new Orchestrator({
        engine,
        pipelineState: createPipelineState(workspaceDir),
        eventMerger: createEventMerger(),
        skillsDir: "/nonexistent/skills",
        workspacePath: workspaceDir,
      })
      const badEvents: any[] = []

      // Use a fresh event merger and subscribe
      const freshMerger = (badOrchestrator as any).config.eventMerger
      freshMerger.subscribe((e: any) => badEvents.push(e))

      await badOrchestrator.startPipeline("test")
      // compile_brainstorm loads skills — pipeline goes idle on failure (no stage_failed/pipeline_failed events)
    })
  })

  describe("logging", () => {
    it("emits pipeline_created on startPipeline", async () => {
      const logEvents: any[] = []
      const capture = (_la: string, _c: string, action: string, ctx?: any) => logEvents.push({ action, ...ctx })
      const logSpy = {
        log: vi.fn((_l: string, ...args: any[]) => capture(args[0], args[1], args[2], args[3])),
        info: vi.fn(capture),
        debug: vi.fn(capture),
        error: vi.fn(capture),
        trace: vi.fn(capture),
        child: vi.fn(function(this: any) { return this }),
      } as any

      const loggedOrchestrator = new Orchestrator({
        engine,
        pipelineState,
        eventMerger,
        skillsDir: SKILLS_DIR,
        workspacePath: workspaceDir,
        logger: logSpy,
      })

      await loggedOrchestrator.startPipeline("build a todo app")

      const pipelineCreated = logEvents.find(e => e.action === "pipeline_created")
      expect(pipelineCreated).toBeTruthy()
      expect(pipelineCreated.data?.prompt).toBe("build a todo app")

      loggedOrchestrator.destroy()
    })

    it("emits stage_started and stage_completed for compile stages", async () => {
      const logEvents: any[] = []
      const capture = (_la: string, _c: string, action: string, ctx?: any) => logEvents.push({ action, ...ctx })
      const logSpy = {
        log: vi.fn((_l: string, ...args: any[]) => capture(args[0], args[1], args[2], args[3])),
        info: vi.fn(capture),
        debug: vi.fn(capture),
        error: vi.fn(capture),
        trace: vi.fn(capture),
        child: vi.fn(function(this: any) { return this }),
      } as any

      const loggedOrchestrator = new Orchestrator({
        engine,
        pipelineState,
        eventMerger,
        skillsDir: SKILLS_DIR,
        workspacePath: workspaceDir,
        logger: logSpy,
      })

      await loggedOrchestrator.startPipeline("build a todo app")
      await signalClassify(loggedOrchestrator, engine, events, pipelineState)
      await signalCompile(loggedOrchestrator, engine, events, "compile_brainstorm")

      expect(logEvents.some(e => e.action === "stage_started")).toBe(true)
      expect(logEvents.some(e => e.action === "stage_completed")).toBe(true)

      loggedOrchestrator.destroy()
    })

    it("works without logger (backward compatible)", async () => {
      // orchestrator from beforeEach has no logger — should not throw
      const pipelineId = await orchestrator.startPipeline("build a todo app")
      expect(pipelineId).toBeTruthy()
    })
  })

  describe("auto-intervention", () => {
    it("handleAutoPermission exists on orchestrator for autonomous mode", () => {
      expect(typeof (orchestrator as any).handleAutoPermission).toBe("function")
    })

    it("questions from autonomous stages are not auto-rejected", async () => {
      const mockProxy = {
        replyPermission: vi.fn(async () => {}),
        rejectQuestion: vi.fn(async () => {}),
      }
      const proxyOrchestrator = new Orchestrator({
        engine, pipelineState, eventMerger,
        skillsDir: SKILLS_DIR, workspacePath: workspaceDir,
        proxy: mockProxy,
      })

      await driveToStage(proxyOrchestrator, engine, events, "write_plan", workspaceDir, pipelineState)

      // No questions were auto-rejected during the entire pipeline drive
      expect(mockProxy.rejectQuestion).not.toHaveBeenCalled()
      proxyOrchestrator.destroy()
    })

    it("handleAutoPermission auto-approves for pipeline session", async () => {
      const mockProxy = {
        replyPermission: vi.fn(async () => {}),
        rejectQuestion: vi.fn(async () => {}),
      }
      const proxyOrchestrator = new Orchestrator({
        engine, pipelineState, eventMerger,
        skillsDir: SKILLS_DIR, workspacePath: workspaceDir,
        proxy: mockProxy,
      })

      await proxyOrchestrator.startPipeline("build a todo app")
      await signalClassify(proxyOrchestrator, engine, events, pipelineState)
      await signalCompile(proxyOrchestrator, engine, events, "compile_brainstorm")

      const brainstormEvt = events.find(e => e.type === "stage_started" && e.stage === "brainstorm")
      const sessionId = (brainstormEvt as any).sessionId
      proxyOrchestrator.handleInteractionAsked(sessionId, "perm-789")
      expect((proxyOrchestrator as any).pendingInteractionIds.get(sessionId)?.has("perm-789")).toBe(true)

      await proxyOrchestrator.handleAutoPermission(sessionId, "perm-789")

      expect(mockProxy.replyPermission).toHaveBeenCalledWith(sessionId, "perm-789", "always")
      expect((proxyOrchestrator as any).pendingInteractionIds.has(sessionId)).toBe(false)

      proxyOrchestrator.destroy()
    })
  })

  describe("Topology-aware advancement", () => {
    it("advances through feature topology beyond the original 5 stages", async () => {
      await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)

      // Complete compile_brainstorm
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      // Complete brainstorm
      await signalStage(orchestrator, events, "brainstorm", { outputPath: ".atelier/spec.md" }, workspaceDir)

      // Next stage should be review_spec (new in Phase 3a)
      const reviewSpecEvt = events.find(e => e.type === "stage_started" && e.stage === "review_spec")
      expect(reviewSpecEvt).toBeTruthy()
    })
  })

  describe("Verdict handling", () => {
    async function driveToReviewSpec(): Promise<string> {
      const pipelineId = await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")
      await signalStage(orchestrator, events, "brainstorm", { outputPath: ".atelier/spec.md" }, workspaceDir)
      return pipelineId
    }

    it("verdict done advances to next topology stage", async () => {
      await driveToReviewSpec()
      await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review.md", verdict: "done" }, workspaceDir)

      // Should advance past review_spec (establish_conventions is conditional — may skip to compile_plan)
      const nextEvt = events.find(e =>
        e.type === "stage_started" && (e.stage === "establish_conventions" || e.stage === "compile_plan"),
      )
      expect(nextEvt).toBeTruthy()
    })

    it("verdict has_issues inserts fixer stage", async () => {
      await driveToReviewSpec()
      await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review.md", verdict: "has_issues" }, workspaceDir)

      // Should emit fix_stage_inserted and start fix_spec
      const insertEvt = events.find(e => e.type === "fix_stage_inserted") as any
      expect(insertEvt).toBeTruthy()
      expect(insertEvt.fixStage).toBe("fix_spec")

      const fixEvt = events.find(e => e.type === "stage_started" && e.stage === "fix_spec")
      expect(fixEvt).toBeTruthy()
    })

    it("verdict stuck pauses pipeline and emits stuck_escalation", async () => {
      const pipelineId = await driveToReviewSpec()
      await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review.md", verdict: "stuck" }, workspaceDir)

      const stuckEvt = events.find(e => e.type === "stuck_escalation") as any
      expect(stuckEvt).toBeTruthy()
      expect(stuckEvt.stage).toBe("review_spec")

      // Pipeline should still be active but stage is stuck
      const detail = pipelineState.getPipeline(pipelineId)
      const reviewStage = detail!.stages.find(s => s.stage === "review_spec")!
      expect(reviewStage.status).toBe("stuck")
    })

    it("missing verdict on review stage defaults to has_issues", async () => {
      await driveToReviewSpec()
      // No verdict field
      await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review.md" }, workspaceDir)

      // Should insert fixer stage (treated as has_issues)
      const fixEvt = events.find(e =>
        e.type === "fix_stage_inserted",
      )
      expect(fixEvt).toBeTruthy()
    })
  })

   describe("Artifact step numbering", () => {
     it("assigns sequential step numbers to compile artifacts", async () => {
       await orchestrator.startPipeline("build auth")
       await signalClassify(orchestrator, engine, events, pipelineState)

       // compile_brainstorm → step 02 (classify takes step 01)
       await signalCompile(orchestrator, engine, events, "compile_brainstorm")

       // Check that the compile message referenced a numbered output path
       const compileMsg = engine.messages.find(m => m.content?.includes("**Output path:**"))
       expect(compileMsg?.content).toMatch(/02-.*compiled-brainstorm\.md/)
     })

     it("increments step numbers across stages", async () => {
       await orchestrator.startPipeline("build auth")
       await signalClassify(orchestrator, engine, events, pipelineState)

       // Step 01: compile_brainstorm
       await signalCompile(orchestrator, engine, events, "compile_brainstorm")
       // Step 02: brainstorm (interactive, no numbered output from orchestrator)
       await signalStage(orchestrator, events, "brainstorm", { outputPath: ".atelier/spec.md" }, workspaceDir)
       // Step 03: review_spec
       await signalStage(orchestrator, events, "review_spec", { outputPath: ".atelier/review.md", verdict: "done" }, workspaceDir)

       // If establish_conventions ran, it consumed a step too
       if (events.find(e => e.type === "stage_started" && e.stage === "establish_conventions")) {
         await signalStage(orchestrator, events, "establish_conventions", { outputPath: ".atelier/conventions.md" }, workspaceDir)
       }

       // compile_plan should have a higher step number
       const compilePlanMsgs = engine.messages.filter(m => m.content?.includes("**Output path:**"))
       const compilePlanMsg = compilePlanMsgs[compilePlanMsgs.length - 1]
       // Step number should be > 01
       const match = compilePlanMsg?.content.match(/(\d+)-.*compiled-plan\.md/)
       expect(match).toBeTruthy()
       expect(parseInt(match![1])).toBeGreaterThan(1)
     })
   })

  describe("concurrent pipelines", () => {
    it("can start two pipelines concurrently", async () => {
      const pid1 = await orchestrator.startPipeline("First feature")
      const pid2 = await orchestrator.startPipeline("Second feature")
      expect(pid1).not.toBe(pid2)
      expect(orchestrator.hasPipeline(pid1)).toBe(true)
      expect(orchestrator.hasPipeline(pid2)).toBe(true)
    })

    it("signal routes to correct pipeline by session", async () => {
      const pid1 = await orchestrator.startPipeline("First feature")
      await signalClassify(orchestrator, engine, events, pipelineState)
      const pid2 = await orchestrator.startPipeline("Second feature")
      await signalClassify(orchestrator, engine, events, pipelineState)

      // Wait for both to reach compile_brainstorm — each has its own session
      const starts = events.filter(e => e.type === "stage_started" && e.stage === "compile_brainstorm")
      expect(starts).toHaveLength(2)
      const sess1 = starts.find((e: any) => e.pipelineId === pid1)!.sessionId
      const sess2 = starts.find((e: any) => e.pipelineId === pid2)!.sessionId
      expect(sess1).not.toBe(sess2)

      // Signal pipeline 1's compile session — only pipeline 1 should advance
      const msg1 = engine.messages.find(m => m.sessionId === sess1 && m.content?.includes("**Output path:**"))
      const match1 = msg1?.content.match(/\*\*Output path:\*\* (.+)/)!
      fsSync.mkdirSync(path.dirname(match1[1]), { recursive: true })
      fsSync.writeFileSync(match1[1], "compiled prompt content")
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: sess1 })

      // Pipeline 1 should have advanced to brainstorm
      expect(events.some(e => e.type === "stage_started" && e.stage === "brainstorm" && e.pipelineId === pid1)).toBe(true)
      // Pipeline 2 should still be on compile_brainstorm
      expect(events.some(e => e.type === "stage_started" && e.stage === "brainstorm" && e.pipelineId === pid2)).toBe(false)
    })

    it("completing one pipeline does not affect another", async () => {
      const pid1 = await orchestrator.startPipeline("First")
      await signalClassify(orchestrator, engine, events, pipelineState)
      const pid2 = await orchestrator.startPipeline("Second")
      await signalClassify(orchestrator, engine, events, pipelineState)

      // Verify both exist
      expect(orchestrator.hasPipeline(pid1)).toBe(true)
      expect(orchestrator.hasPipeline(pid2)).toBe(true)

      // Drive pipeline 1 forward by signaling compile
      const pid1Events = () => events.filter(e => e.pipelineId === pid1)
      const compileEvt = pid1Events().find(e => e.type === "stage_started" && e.stage === "compile_brainstorm")
      if (compileEvt) {
        const msg = engine.messages.find(m => m.sessionId === compileEvt.sessionId && m.content?.includes("**Output path:**"))
        const match = msg?.content.match(/\*\*Output path:\*\* (.+)/)
        if (match) {
          fsSync.mkdirSync(path.dirname(match[1]), { recursive: true })
          fsSync.writeFileSync(match[1], "compiled prompt content")
          await orchestrator.handleSignal({ type: "stage_complete", sessionId: compileEvt.sessionId })
        }
      }

      // Pipeline 1 should have advanced, pipeline 2 should still be on compile_brainstorm
      expect(orchestrator.hasPipeline(pid1)).toBe(true)
      expect(orchestrator.hasPipeline(pid2)).toBe(true)
    })

    it("failing one pipeline does not affect another", async () => {
      const pid1 = await orchestrator.startPipeline("First")
      const pid2 = await orchestrator.startPipeline("Second")
      expect(orchestrator.hasPipeline(pid1)).toBe(true)
      expect(orchestrator.hasPipeline(pid2)).toBe(true)

      orchestrator.failPipeline(pid1, "test error")
      expect(orchestrator.hasPipeline(pid1)).toBe(false)
      expect(orchestrator.hasPipeline(pid2)).toBe(true)
    })

    it("isSessionOwnedByPipeline checks across all pipelines", async () => {
      const pid1 = await orchestrator.startPipeline("First")
      await signalClassify(orchestrator, engine, events, pipelineState)
      const pid2 = await orchestrator.startPipeline("Second")
      await signalClassify(orchestrator, engine, events, pipelineState)

      // Both pipelines should have stage_started events with session IDs
      const starts = events.filter(e => e.type === "stage_started" && e.stage === "compile_brainstorm")
      expect(starts).toHaveLength(2)
      const sess1 = starts.find((e: any) => e.pipelineId === pid1)!.sessionId
      const sess2 = starts.find((e: any) => e.pipelineId === pid2)!.sessionId

      // Both sessions should be recognized as pipeline-owned
      expect(orchestrator.isSessionOwnedByPipeline(sess1)).toBe(true)
      expect(orchestrator.isSessionOwnedByPipeline(sess2)).toBe(true)
      // A random session should not be
      expect(orchestrator.isSessionOwnedByPipeline("random-sess")).toBe(false)
    })
  })

  describe("Orchestrator with BackendRegistry", () => {
    it("resolves backend from model at pipeline creation", async () => {
      const registry = new BackendRegistry()
      const ccEngine = new MockAgentEngine()
      ccEngine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
      const ocEngine = new MockAgentEngine()
      ocEngine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
      registry.registerEngine("claude-code", ccEngine)
      registry.registerEngine("opencode", ocEngine)

      const registryOrch = new Orchestrator({
        engine: ocEngine,
        registry,
        pipelineState,
        eventMerger,
        skillsDir: SKILLS_DIR,
        workspacePath: workspaceDir,
      })

      try {
        const pipelineId = await registryOrch.startPipeline("test", {
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        })
        const pipeline = registryOrch.getPipeline(pipelineId)
        expect(pipeline).toBeTruthy()
        expect(pipeline!.backendId).toBe("claude-code")
      } finally {
        registryOrch.destroy()
      }
    })

    it("stage runner uses correct engine for session creation", async () => {
      const registry = new BackendRegistry()
      const ccEngine = new MockAgentEngine()
      ccEngine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
      const ocEngine = new MockAgentEngine()
      ocEngine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
      registry.registerEngine("claude-code", ccEngine)
      registry.registerEngine("opencode", ocEngine)

      const ccSpy = vi.spyOn(ccEngine, "createSession")
      const ocSpy = vi.spyOn(ocEngine, "createSession")

      const registryOrch = new Orchestrator({
        engine: ocEngine,
        registry,
        pipelineState,
        eventMerger,
        skillsDir: SKILLS_DIR,
        workspacePath: workspaceDir,
      })

      try {
        await registryOrch.startPipeline("test", {
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        })
        // Claude-code engine should have been used for session creation
        expect(ccSpy).toHaveBeenCalled()
        // OpenCode engine should NOT have been called for session creation
        expect(ocSpy).not.toHaveBeenCalled()
      } finally {
        registryOrch.destroy()
      }
    })

    it("defaults to opencode when no model is provided", async () => {
      const registry = new BackendRegistry()
      const ccEngine = new MockAgentEngine()
      ccEngine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
      const ocEngine = new MockAgentEngine()
      ocEngine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }
      registry.registerEngine("claude-code", ccEngine)
      registry.registerEngine("opencode", ocEngine)

      const ocSpy = vi.spyOn(ocEngine, "createSession")

      const registryOrch = new Orchestrator({
        engine: ocEngine,
        registry,
        pipelineState,
        eventMerger,
        skillsDir: SKILLS_DIR,
        workspacePath: workspaceDir,
      })

      try {
        const pipelineId = await registryOrch.startPipeline("test")
        const pipeline = registryOrch.getPipeline(pipelineId)
        expect(pipeline!.backendId).toBe("opencode")
        expect(ocSpy).toHaveBeenCalled()
      } finally {
        registryOrch.destroy()
      }
    })
  })

  // ─── Git integration tests ──────────────────────────────────────────────

  describe("git integration", () => {
    beforeEach(() => {
      // Enable git integration via settings file (default is disabled)
      writeSettings(atelierStateDir(workspaceDir), { gitEnabled: true })
    })

    it("skips all git operations when gitEnabled is false", async () => {
      // Override: disable git
      writeSettings(atelierStateDir(workspaceDir), { gitEnabled: false })

      const pipelineId = await orchestrator.startPipeline("build something")
      const branchEvt = events.find((e: any) => e.type === "git_branch_created")
      expect(branchEvt).toBeUndefined()

      // Pipeline should still have started successfully (not failed)
      const pipeline = pipelineState.getPipeline(pipelineId)!
      expect(pipeline.status).not.toBe("stuck")
      expect(pipeline.gitBranch).toBeFalsy()

      // Should remain on the original branch (not on atelier/*)
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspaceDir, encoding: "utf-8" }).trim()
      expect(branch).not.toMatch(/^atelier\//)
    })

    it("skips commit when gitEnabled is false", async () => {
      // Start with git enabled so we get through pipeline start
      const { pipelineId, sessionId } = await driveToStage(orchestrator, engine, events, "implement", workspaceDir, pipelineState)

      // Now disable git before the implement stage completes
      writeSettings(atelierStateDir(workspaceDir), { gitEnabled: false })

      // Simulate implement writing a file
      fsSync.writeFileSync(path.join(workspaceDir, "app.ts"), "console.log('hello')")
      await orchestrator.handleSignal({ type: "stage_complete", sessionId })

      // No git_committed event should appear
      const commitEvt = events.find((e: any) => e.type === "git_committed")
      expect(commitEvt).toBeUndefined()
    })

    it("creates a feature branch at pipeline start", async () => {
      const pipelineId = await orchestrator.startPipeline("build a weather app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      const branchEvt = events.find((e: any) => e.type === "git_branch_created")
      expect(branchEvt).toBeDefined()
      expect(branchEvt.branch).toMatch(/^atelier\//)

      // Verify pipeline state has git metadata
      const pipeline = pipelineState.getPipeline(pipelineId)!
      expect(pipeline.gitBranch).toMatch(/^atelier\//)
      expect(pipeline.gitBaseBranch).toBeTruthy()
      expect(pipeline.gitBaseCommit).toBeTruthy()

      // Verify we're on the feature branch
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: workspaceDir, encoding: "utf-8" }).trim()
      expect(branch).toMatch(/^atelier\//)
    })

    it("proceeds with dirty working tree (logs warning, does not block)", async () => {
      fsSync.writeFileSync(path.join(workspaceDir, "dirty.txt"), "dirty")
      const pipelineId = await orchestrator.startPipeline("build something")
      await signalClassify(orchestrator, engine, events, pipelineState)
      const pipeline = pipelineState.getPipeline(pipelineId)!
      // Pipeline should NOT be stuck — dirty tree is just a warning
      expect(pipeline.status).not.toBe("stuck")
      expect(pipeline.gitBranch).toMatch(/^atelier\//)
    })

    it("handles greenfield workspace (no git repo)", async () => {
      // Remove .git to simulate non-git workspace
      fsSync.rmSync(path.join(workspaceDir, ".git"), { recursive: true, force: true })
      fsSync.unlinkSync(path.join(workspaceDir, ".gitignore"))
      const pipelineId = await orchestrator.startPipeline("build something new")
      await signalClassify(orchestrator, engine, events, pipelineState)
      const branchEvt = events.find((e: any) => e.type === "git_branch_created")
      expect(branchEvt).toBeDefined()
    })

    it("commits after implement stage completes", async () => {
      const { pipelineId, sessionId } = await driveToStage(orchestrator, engine, events, "implement", workspaceDir, pipelineState)

      // Simulate implement writing a file
      fsSync.writeFileSync(path.join(workspaceDir, "app.ts"), "console.log('hello')")

      await orchestrator.handleSignal({ type: "stage_complete", sessionId })

      // Verify git_committed event
      const commitEvt = events.find((e: any) => e.type === "git_committed")
      expect(commitEvt).toBeDefined()
      expect(commitEvt.stage).toBe("implement")
      expect(commitEvt.sha).toMatch(/^[0-9a-f]{40}$/)

      // Verify commit message format
      const log = execFileSync("git", ["log", "--oneline", "-1"], { cwd: workspaceDir, encoding: "utf-8" }).trim()
      expect(log).toContain("atelier(implement)")
    })

    it("skips commit when no changes after stage", async () => {
      const { pipelineId, sessionId } = await driveToStage(orchestrator, engine, events, "implement", workspaceDir, pipelineState)
      // Don't write any files — nothing to commit
      await orchestrator.handleSignal({ type: "stage_complete", sessionId })

      const commitEvt = events.find((e: any) => e.type === "git_committed")
      expect(commitEvt).toBeUndefined()

      // Pipeline should still advance (no-op commit is not an error)
      const pipeline = pipelineState.getPipeline(pipelineId)!
      expect(pipeline.status).not.toBe("stuck")
    })

    it("stores commitSha on stage data after commit", async () => {
      const { pipelineId, sessionId } = await driveToStage(orchestrator, engine, events, "implement", workspaceDir, pipelineState)
      fsSync.writeFileSync(path.join(workspaceDir, "app.ts"), "content")
      await orchestrator.handleSignal({ type: "stage_complete", sessionId })

      const pipeline = pipelineState.getPipeline(pipelineId)!
      const implementStage = pipeline.stages.find((s: any) => s.stage === "implement")!
      expect(implementStage.commitSha).toMatch(/^[0-9a-f]{40}$/)
    })

    it("inserts fix_hooks stage on hook failure", async () => {
      // Install a failing pre-commit hook
      const hookDir = path.join(workspaceDir, ".git", "hooks")
      fsSync.mkdirSync(hookDir, { recursive: true })
      fsSync.writeFileSync(
        path.join(hookDir, "pre-commit"),
        "#!/bin/sh\necho 'lint error' >&2\nexit 1",
        { mode: 0o755 },
      )

      const { pipelineId, sessionId } = await driveToStage(orchestrator, engine, events, "implement", workspaceDir, pipelineState)
      fsSync.writeFileSync(path.join(workspaceDir, "app.ts"), "bad code")

      await orchestrator.handleSignal({ type: "stage_complete", sessionId })

      // Should have git_hook_failed event
      const hookEvt = events.find((e: any) => e.type === "git_hook_failed")
      expect(hookEvt).toBeDefined()

      // Should have a fix_hooks stage started
      const fixHooksEvt = events.find((e: any) => e.type === "stage_started" && e.stage === "fix_hooks")
      expect(fixHooksEvt).toBeDefined()
    })

    it("retries commit after fix_hooks completes successfully", async () => {
      // Install a hook that fails once then succeeds (using a marker file)
      const hookDir = path.join(workspaceDir, ".git", "hooks")
      fsSync.mkdirSync(hookDir, { recursive: true })
      const marker = path.join(workspaceDir, ".hook-marker")
      fsSync.writeFileSync(
        path.join(hookDir, "pre-commit"),
        `#!/bin/sh
if [ ! -f "${marker}" ]; then
  echo 'lint error' >&2
  exit 1
fi
exit 0`,
        { mode: 0o755 },
      )

      const { pipelineId, sessionId } = await driveToStage(orchestrator, engine, events, "implement", workspaceDir, pipelineState)
      fsSync.writeFileSync(path.join(workspaceDir, "app.ts"), "bad code")

      await orchestrator.handleSignal({ type: "stage_complete", sessionId })

      // fix_hooks stage started
      const fixHooksEvt = events.find((e: any) => e.type === "stage_started" && e.stage === "fix_hooks")
      expect(fixHooksEvt).toBeDefined()

      // Simulate the fix_hooks agent fixing the issue
      fsSync.writeFileSync(marker, "done")

      // Signal fix_hooks complete
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: fixHooksEvt.sessionId })

      // Should now have a git_committed event
      const commitEvt = events.find((e: any) => e.type === "git_committed")
      expect(commitEvt).toBeDefined()
    })

    it("escalates to stuck after 3 failed fix_hooks attempts", async () => {
      // Install a permanently-failing pre-commit hook
      const hookDir = path.join(workspaceDir, ".git", "hooks")
      fsSync.mkdirSync(hookDir, { recursive: true })
      fsSync.writeFileSync(
        path.join(hookDir, "pre-commit"),
        "#!/bin/sh\necho 'lint error: permanent failure' >&2\nexit 1",
        { mode: 0o755 },
      )

      const { pipelineId, sessionId } = await driveToStage(orchestrator, engine, events, "implement", workspaceDir, pipelineState)
      fsSync.writeFileSync(path.join(workspaceDir, "app.ts"), "bad code")

      // First commit attempt fails → fix_hooks #1 inserted
      await orchestrator.handleSignal({ type: "stage_complete", sessionId })
      let fixHooksEvts = events.filter((e: any) => e.type === "stage_started" && e.stage === "fix_hooks")
      expect(fixHooksEvts).toHaveLength(1)

      // fix_hooks #1 completes but commit still fails → fix_hooks #2 inserted
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: fixHooksEvts[0].sessionId })
      fixHooksEvts = events.filter((e: any) => e.type === "stage_started" && e.stage === "fix_hooks")
      expect(fixHooksEvts).toHaveLength(2)

      // fix_hooks #2 completes but commit still fails → fix_hooks #3 inserted
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: fixHooksEvts[1].sessionId })
      fixHooksEvts = events.filter((e: any) => e.type === "stage_started" && e.stage === "fix_hooks")
      expect(fixHooksEvts).toHaveLength(3)

      // fix_hooks #3 completes but commit still fails → exhaustion → stuck
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: fixHooksEvts[2].sessionId })

      // Should NOT have a 4th fix_hooks
      fixHooksEvts = events.filter((e: any) => e.type === "stage_started" && e.stage === "fix_hooks")
      expect(fixHooksEvts).toHaveLength(3)

      // Should have a stuck_escalation event
      const stuckEvt = events.find((e: any) => e.type === "stuck_escalation")
      expect(stuckEvt).toBeDefined()
      expect(stuckEvt.reason).toContain("Pre-commit hooks failed after 3 fix attempts")
    })

    it("full happy path: branch → implement commit → simplify commit → completion", async () => {
      // Drive to implement
      const { pipelineId } = await driveToStage(orchestrator, engine, events, "implement", workspaceDir, pipelineState)

      // Verify branch was created
      const branchEvt = events.find((e: any) => e.type === "git_branch_created")
      expect(branchEvt).toBeDefined()

      // Implement writes code
      fsSync.writeFileSync(path.join(workspaceDir, "index.ts"), "export const main = () => {}")
      const implementEvt = events.find((e: any) => e.type === "stage_started" && e.stage === "implement")
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: implementEvt.sessionId })

      // Verify implement commit
      const commit1 = events.find((e: any) => e.type === "git_committed" && e.stage === "implement")
      expect(commit1).toBeDefined()

      // Review code passes
      const reviewEvt = events.find((e: any) => e.type === "stage_started" && e.stage === "review_code")
      fsSync.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
      fsSync.writeFileSync(path.join(workspaceDir, ".atelier/code-review.md"), "stub")
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: reviewEvt.sessionId, verdict: "done", outputPath: ".atelier/code-review.md" })

      // Simplify writes more changes
      fsSync.writeFileSync(path.join(workspaceDir, "index.ts"), "export const main = () => console.log('simplified')")
      const simplifyEvt = events.find((e: any) => e.type === "stage_started" && e.stage === "simplify")
      fsSync.writeFileSync(path.join(workspaceDir, ".atelier/simplify.md"), "stub")
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: simplifyEvt.sessionId, outputPath: ".atelier/simplify.md" })

      // Verify simplify commit
      const commit2 = events.find((e: any) => e.type === "git_committed" && e.stage === "simplify")
      expect(commit2).toBeDefined()

      // Drive through e2e_gate + E2E stages to completion
      await signalStage(orchestrator, events, "e2e_gate", { verdict: "proceed", outputPath: ".atelier/e2e-gate.md" }, workspaceDir)
      await signalCompile(orchestrator, engine, events, "compile_e2e_plan")
      await signalStage(orchestrator, events, "write_e2e_plan", { outputPath: ".atelier/e2e-plan.md" }, workspaceDir)
      await signalStage(orchestrator, events, "review_e2e_plan", { verdict: "done", outputPath: ".atelier/e2e-review.md" }, workspaceDir)

      // E2E writes test code
      fsSync.writeFileSync(path.join(workspaceDir, "test.e2e.ts"), "import { test } from 'vitest'")
      const e2eEvt = events.find((e: any) => e.type === "stage_started" && e.stage === "e2e")
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: e2eEvt.sessionId })

      // Verify e2e commit
      const commit3 = events.find((e: any) => e.type === "git_committed" && e.stage === "e2e")
      expect(commit3).toBeDefined()

      // Validate stage now runs (autonomous)
      await signalStage(orchestrator, events, "validate")

      // Verify pipeline completed with git info
      const completedEvt = events.find((e: any) => e.type === "pipeline_completed")
      expect(completedEvt).toBeDefined()
      expect(completedEvt.gitBranch).toBe(branchEvt.branch)
      expect(completedEvt.commitCount).toBe(3)

      // Verify git log on the feature branch
      const log = execFileSync("git", ["log", "--oneline"], { cwd: workspaceDir, encoding: "utf-8" })
      expect(log).toContain("atelier(implement)")
      expect(log).toContain("atelier(simplify)")
      expect(log).toContain("atelier(e2e)")
    })
  })

  // ─── Phase 7: Plan / Task / Bugfix pipeline integration tests ──────────

  describe("plan pipeline", () => {
    it("skips classification and starts at quick_plan", async () => {
      await orchestrator.startPipeline("plan auth refactor", { type: "plan" })
      expect(events.find(e => e.type === "stage_started" && e.stage === "classify")).toBeUndefined()
      expect(events.find(e => e.type === "stage_started" && e.stage === "quick_plan")).toBeTruthy()
    })

    it("plan_gate action:done completes with completionOutcome plan_only", async () => {
      const pipelineId = await orchestrator.startPipeline("plan auth refactor", { type: "plan" })
      await signalStage(orchestrator, events, "quick_plan", { outputPath: ".atelier/plan.md" }, workspaceDir)
      await signalStage(orchestrator, events, "review_quick_plan", { verdict: "done", outputPath: ".atelier/review.md" }, workspaceDir)
      await signalStage(orchestrator, events, "plan_gate", { action: "done" })
      const detail = pipelineState.getPipeline(pipelineId)!
      expect(detail.status).toBe("completed")
      expect(detail.completionOutcome).toBe("plan_only")
      const completedEvt = events.find(e => e.type === "pipeline_completed")
      expect(completedEvt).toBeDefined()
      expect(completedEvt.completionOutcome).toBe("plan_only")
    })

    it("plan_gate implement keeps pipeline running, second signal completes with implemented", async () => {
      const pipelineId = await orchestrator.startPipeline("plan auth refactor", { type: "plan" })
      await signalStage(orchestrator, events, "quick_plan", { outputPath: ".atelier/plan.md" }, workspaceDir)
      await signalStage(orchestrator, events, "review_quick_plan", { verdict: "done", outputPath: ".atelier/review.md" }, workspaceDir)

      // First signal: implement
      const gateEvt = events.find(e => e.type === "stage_started" && e.stage === "plan_gate")
      expect(gateEvt).toBeTruthy()
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: gateEvt.sessionId, action: "implement" })

      // Pipeline should still be running
      const midDetail = pipelineState.getPipeline(pipelineId)!
      expect(midDetail.status).toBe("running")

      // Second signal: stage_complete after implementation
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: gateEvt.sessionId })
      const detail = pipelineState.getPipeline(pipelineId)!
      expect(detail.status).toBe("completed")
      expect(detail.completionOutcome).toBe("implemented")
    })

    it("review_quick_plan has_issues inserts fix_quick_plan", async () => {
      await orchestrator.startPipeline("plan auth refactor", { type: "plan" })
      await signalStage(orchestrator, events, "quick_plan", { outputPath: ".atelier/plan.md" }, workspaceDir)
      await signalStage(orchestrator, events, "review_quick_plan", { verdict: "has_issues", outputPath: ".atelier/review.md" }, workspaceDir)
      expect(events.find(e => e.type === "stage_started" && e.stage === "fix_quick_plan")).toBeTruthy()
    })
  })

  describe("task pipeline", () => {
    it("classification result task routes to task topology", async () => {
      const pipelineId = await orchestrator.startPipeline("add a button")
      await signalClassify(orchestrator, engine, events, pipelineState, { pipelineType: "task" })
      // Task topology starts with compile_task_brainstorm
      const taskStage = events.find(e => e.type === "stage_started" && e.stage === "compile_task_brainstorm")
      expect(taskStage).toBeTruthy()
      // Should NOT have a feature brainstorm
      expect(events.find(e => e.type === "stage_started" && e.stage === "compile_brainstorm")).toBeUndefined()
    })
  })

  describe("bugfix pipeline", () => {
    it("classification result bugfix routes to bugfix stage", async () => {
      const pipelineId = await orchestrator.startPipeline("fix the crash")
      await signalClassify(orchestrator, engine, events, pipelineState, { pipelineType: "bugfix" })
      const bugfixStage = events.find(e => e.type === "stage_started" && e.stage === "bugfix")
      expect(bugfixStage).toBeTruthy()
    })

    it("bugfix without outcome defaults to fixed", async () => {
      const pipelineId = await orchestrator.startPipeline("fix the crash")
      await signalClassify(orchestrator, engine, events, pipelineState, { pipelineType: "bugfix" })
      await signalStage(orchestrator, events, "bugfix", { outputPath: ".atelier/diagnostic.md" })
      const detail = pipelineState.getPipeline(pipelineId)!
      expect(detail.completionOutcome).toBe("fixed")
    })

    it("bugfix with explicit outcome preserves it", async () => {
      const pipelineId = await orchestrator.startPipeline("fix the crash")
      await signalClassify(orchestrator, engine, events, pipelineState, { pipelineType: "bugfix" })
      const bugfixEvt = events.find(e => e.type === "stage_started" && e.stage === "bugfix")
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: bugfixEvt.sessionId, outputPath: ".atelier/diagnostic.md", outcome: "fixed_unverified" })
      const detail = pipelineState.getPipeline(pipelineId)!
      expect(detail.completionOutcome).toBe("fixed_unverified")
    })
  })

  describe("completionOutcome persistence", () => {
    it("setCompletionOutcome round-trips through pipeline state", async () => {
      const pipelineId = await orchestrator.startPipeline("plan something", { type: "plan" })
      pipelineState.setCompletionOutcome(pipelineId, "plan_only")
      const detail = pipelineState.getPipeline(pipelineId)!
      expect(detail.completionOutcome).toBe("plan_only")
    })
  })

  describe("mandatory artifact enforcement", () => {
    it("rejects signal without outputPath on artifact-required stage", async () => {
      const pipelineId = await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      const brainstormEvt = events.find(e => e.type === "stage_started" && e.stage === "brainstorm")!
      await expect(
        orchestrator.handleSignal({ type: "stage_complete", sessionId: brainstormEvt.sessionId })
      ).rejects.toThrow("requires an output artifact")

      // Stage should still be running (not completed)
      const pipeline = pipelineState.getPipeline(pipelineId)!
      const brainstormStage = pipeline.stages.find(s => s.stage === "brainstorm")!
      expect(brainstormStage.status).toBe("running")
    })

    it("rejects signal with non-existent outputPath", async () => {
      await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      const brainstormEvt = events.find(e => e.type === "stage_started" && e.stage === "brainstorm")!
      await expect(
        orchestrator.handleSignal({ type: "stage_complete", sessionId: brainstormEvt.sessionId, outputPath: "missing.md" })
      ).rejects.toThrow("file does not exist")
    })

    it("accepts signal with valid outputPath on artifact-required stage", async () => {
      const pipelineId = await orchestrator.startPipeline("build a todo app")
      await signalClassify(orchestrator, engine, events, pipelineState)
      await signalCompile(orchestrator, engine, events, "compile_brainstorm")

      const brainstormEvt = events.find(e => e.type === "stage_started" && e.stage === "brainstorm")!
      // Write the artifact file
      fsSync.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
      fsSync.writeFileSync(path.join(workspaceDir, ".atelier/spec.md"), "stub spec")
      await orchestrator.handleSignal({ type: "stage_complete", sessionId: brainstormEvt.sessionId, outputPath: ".atelier/spec.md" })

      // Stage should be completed
      const pipeline = pipelineState.getPipeline(pipelineId)!
      const brainstormStage = pipeline.stages.find(s => s.stage === "brainstorm")!
      expect(brainstormStage.status).toBe("completed")
    })
  })
})
