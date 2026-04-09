import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
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

/** Signal a compile stage complete by writing the output file and calling handleSignal. */
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

/** Signal the classification stage complete with pipelineType and worktreeChoice in the signal. */
async function signalClassify(
  orch: Orchestrator,
  _engine: MockAgentEngine,
  evts: any[],
): Promise<void> {
  const evt = evts.find(e => e.type === "stage_started" && e.stage === "classify")
  if (!evt) throw new Error("No classify stage_started event found")
  await orch.handleSignal({ type: "stage_complete", sessionId: evt.sessionId, pipelineType: "feature", worktreeChoice: "in-tree" })
  const pipelineId = (await orch.getActivePipelineIds())[0]
  if (pipelineId) {
    await orch.resumeAfterStageModelsConfirmed(pipelineId)
  }
}

/** Drive pipeline to brainstorm stage and return the sessionId. */
async function driveToBrainstorm(
  orch: Orchestrator,
  engine: MockAgentEngine,
  evts: any[],
): Promise<{ pipelineId: string; sessionId: string }> {
  const pipelineId = await orch.startPipeline("build a todo app")
  await signalClassify(orch, engine, evts)
  await signalCompile(orch, engine, evts, "compile_brainstorm")
  const brainstormStarted = evts.find(e => e.type === "stage_started" && e.stage === "brainstorm")
  return { pipelineId, sessionId: brainstormStarted.sessionId }
}

/** Flush microtasks + I/O — needed after vi.advanceTimersByTime to let async callbacks complete.
 *  Interleaves timer advancement with real event-loop ticks to process pending I/O (fs.readFile etc). */
async function flush(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise(r => process.nextTick(r))
    // Advance fake timers by 0 to process any newly-scheduled timers from resolved I/O
    vi.advanceTimersByTime(0)
  }
}

/** Wait for a condition to be true, polling with real delays (for tests using real timers). */
async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise(r => setTimeout(r, 50))
  }
}

describe("Stage retry on transient errors", () => {
  let engine: MockAgentEngine
  let pipelineState: PipelineState
  let eventMerger: ReturnType<typeof createEventMerger>
  let events: any[]
  let orchestrator: Orchestrator
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atelier-retry-test-"))
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

  it("retries stage on transient session_error, succeeds on second attempt", async () => {
    const { pipelineId, sessionId } = await driveToBrainstorm(orchestrator, engine, events)

    expect(events.filter(e => e.type === "stage_started" && e.stage === "brainstorm").length).toBe(1)

    // Monkey-patch setTimeout to near-zero delay so retry fires immediately with real timers
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: any, _delay: any, ...args: any[]) => {
      return originalSetTimeout(fn, 0, ...args)
    }) as any

    try {
      orchestrator.handleNormalizedEvent({
        kind: "session_error",
        sessionId,
        error: "overloaded",
      })

      expect(events.find(e => e.type === "stage_retry")).toBeTruthy()

      // Wait for the retry to create a new stage
      await waitFor(() =>
        events.filter(e => e.type === "stage_started" && e.stage === "brainstorm").length > 1,
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    const starts = events.filter(e => e.type === "stage_started" && e.stage === "brainstorm")
    expect(starts.length).toBe(2)
    expect(starts[1].sessionId).not.toBe(sessionId)
  })

  it("escalates to stuck after max retries exhausted", async () => {
    // Use real timers with short real delays — the retry loop needs multiple
    // async cycles that don't work well with fake timers.
    const { pipelineId, sessionId: firstSessionId } = await driveToBrainstorm(orchestrator, engine, events)

    // Override the retry delay to near-zero by monkey-patching setTimeout
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: any, _delay: any, ...args: any[]) => {
      return originalSetTimeout(fn, 0, ...args)
    }) as any

    const MAX_RETRIES = 5

    try {
      for (let i = 0; i <= MAX_RETRIES; i++) {
        const starts = events.filter(e => e.type === "stage_started" && e.stage === "brainstorm")
        const latestSessionId = starts[starts.length - 1].sessionId

        orchestrator.handleNormalizedEvent({
          kind: "session_error",
          sessionId: latestSessionId,
          error: "rate limit exceeded",
        })

        if (i < MAX_RETRIES) {
          // Wait for the retry to create a new stage
          await waitFor(() =>
            events.filter(e => e.type === "stage_started" && e.stage === "brainstorm").length > starts.length,
          )
        }
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    const stuck = events.find(e => e.type === "stuck_escalation")
    expect(stuck).toBeTruthy()
    expect(stuck.reason).toContain("after 5 retries")
  })

  it("uses exponential backoff between retries", async () => {
    await driveToBrainstorm(orchestrator, engine, events)

    // Verify emitted nextRetryMs values — no need to actually wait for timers
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: any, _delay: any, ...args: any[]) => {
      return originalSetTimeout(fn, 0, ...args)
    }) as any

    const retryEvents: any[] = []

    try {
      for (let i = 0; i < 3; i++) {
        const starts = events.filter(e => e.type === "stage_started" && e.stage === "brainstorm")
        const latestSessionId = starts[starts.length - 1].sessionId

        orchestrator.handleNormalizedEvent({
          kind: "session_error",
          sessionId: latestSessionId,
          error: "502 Bad Gateway",
        })

        const retries = events.filter(e => e.type === "stage_retry")
        retryEvents.push(retries[retries.length - 1])

        // Wait for retry to create new stage
        await waitFor(() =>
          events.filter(e => e.type === "stage_started" && e.stage === "brainstorm").length > starts.length,
        )
      }
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    // Verify exponential backoff delays: 1s, 2s, 4s
    expect(retryEvents[0].nextRetryMs).toBe(1000)
    expect(retryEvents[1].nextRetryMs).toBe(2000)
    expect(retryEvents[2].nextRetryMs).toBe(4000)
  })

  it("does not retry on non-transient errors", async () => {
    const { sessionId } = await driveToBrainstorm(orchestrator, engine, events)

    orchestrator.handleNormalizedEvent({
      kind: "session_error",
      sessionId,
      error: "context_length_exceeded",
    })

    const stuck = events.find(e => e.type === "stuck_escalation")
    expect(stuck).toBeTruthy()
    expect(stuck.reason).toContain("context_length_exceeded")

    expect(events.find(e => e.type === "stage_retry")).toBeFalsy()
  })

  it("retry is cancelled when pipeline is aborted during backoff", async () => {
    const { pipelineId, sessionId } = await driveToBrainstorm(orchestrator, engine, events)

    orchestrator.handleNormalizedEvent({
      kind: "session_error",
      sessionId,
      error: "overloaded",
    })

    expect(events.find(e => e.type === "stage_retry")).toBeTruthy()

    // User abort goes through failPipeline → deactivate, which clears the retry timer
    orchestrator.failPipeline(pipelineId, "Aborted by user")

    // Wait a bit with real timers — the retry (1s delay) should have been cancelled
    await new Promise(r => setTimeout(r, 1500))

    // No second brainstorm stage should have started
    expect(events.filter(e => e.type === "stage_started" && e.stage === "brainstorm").length).toBe(1)
  })

  it("emits stage_retry event for transcript visibility", async () => {
    const { pipelineId, sessionId } = await driveToBrainstorm(orchestrator, engine, events)

    orchestrator.handleNormalizedEvent({
      kind: "session_error",
      sessionId,
      error: "503 Service Unavailable",
    })

    const retryEvent = events.find(e => e.type === "stage_retry")
    expect(retryEvent).toBeTruthy()
    expect(retryEvent.pipelineId).toBe(pipelineId)
    expect(retryEvent.stage).toBe("brainstorm")
    expect(retryEvent.attempt).toBe(1)
    expect(retryEvent.error).toBe("503 Service Unavailable")
    expect(retryEvent.nextRetryMs).toBe(1000)
  })
})
