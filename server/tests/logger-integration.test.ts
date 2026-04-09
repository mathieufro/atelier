import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createLogger } from "../src/infra/logger.js"
import { Orchestrator } from "../src/orchestration/orchestrator.js"
import { MockAgentEngine } from "./__utils__/mock-engine.js"
import { createPipelineState } from "../src/orchestration/pipeline-state.js"
import { createEventMerger } from "../src/engine/event-merger.js"
import { filterEvents, type LogEvent } from "@atelier/core"
import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs"

const SKILLS_DIR = path.resolve(import.meta.dirname, "../../skills")

describe("Logger integration", () => {
  let logDir: string
  let workspaceDir: string
  let logger: ReturnType<typeof createLogger>
  let logEvents: LogEvent[]

  beforeEach(() => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-log-int-"))
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "atelier-ws-"))
    fs.mkdirSync(path.join(workspaceDir, ".atelier"), { recursive: true })
    logger = createLogger({ logDir })
    logEvents = []
    logger.onEvent((e) => logEvents.push(e))
  })

  afterEach(async () => {
    await logger.flush()
    fs.rmSync(logDir, { recursive: true, force: true })
    fs.rmSync(workspaceDir, { recursive: true, force: true })
  })

  it("captures full pipeline lifecycle in logs", async () => {
    const engine = new MockAgentEngine()
    engine.nextOutput = { text: "done", tokens: { input: 100, output: 50 } }

    const pipelineState = createPipelineState(workspaceDir)
    const eventMerger = createEventMerger({ logger })
    const events: any[] = []
    eventMerger.subscribe((event) => events.push(event))

    const orchestrator = new Orchestrator({
      engine, pipelineState, eventMerger,
      skillsDir: SKILLS_DIR,
      workspacePath: workspaceDir,
      logger,
    })

    const pipelineId = await orchestrator.startPipeline("build a todo app")

    // Signal classification first
    const classEvt = events.find(e => e.type === "stage_started" && e.stage === "classify")!
    await orchestrator.handleSignal({ type: "stage_complete", sessionId: classEvt.sessionId, pipelineType: "feature", worktreeChoice: "in-tree" })

    // Resume pipeline after classify (pipeline pauses to allow model configuration)
    pipelineState.setStageModelConfirmed(pipelineId, true)
    await orchestrator.resumeAfterStageModelsConfirmed(pipelineId)

    // Signal compile_brainstorm complete to advance to brainstorm
    const compileEvt = events.find(e => e.type === "stage_started" && e.stage === "compile_brainstorm")!
    const compileMsg = engine.messages.find(m => m.sessionId === compileEvt.sessionId && m.content?.includes("**Output path:**"))
    const match = compileMsg?.content.match(/\*\*Output path:\*\* (.+)/)
    if (match) {
      fs.mkdirSync(path.dirname(match[1]), { recursive: true })
      fs.writeFileSync(match[1], "compiled prompt content")
    }
    await orchestrator.handleSignal({ type: "stage_complete", sessionId: compileEvt.sessionId })

    // Pipeline created should be logged
    const created = logEvents.find(e => e.action === "pipeline_created")
    expect(created).toBeTruthy()
    expect(created!.pipelineId).toBe(pipelineId)

    // Filter log for just this pipeline
    const pipelineLog = filterEvents(logEvents, { pipelineId })
    expect(pipelineLog.length).toBeGreaterThan(0)

    // Should contain stage transitions
    const stages = pipelineLog.filter(e => e.action === "stage_started").map(e => e.stageName)
    expect(stages).toContain("compile_brainstorm")
    expect(stages).toContain("brainstorm")

    orchestrator.destroy()
    await pipelineState.flush()
  })

  it("log events are valid JSONL when written to disk", async () => {
    logger.info("atelier", "server", "server_started", { source: "server", data: { port: 3000 } })
    logger.error("atelier", "pipeline", "pipeline_idle_error", { source: "orchestrator", pipelineId: "p1", error: "timeout" })
    await logger.flush()

    const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log"))
    expect(files.length).toBeGreaterThanOrEqual(1)

    const content = fs.readFileSync(path.join(logDir, files[0]), "utf-8").trim()
    const lines = content.split("\n")

    for (const line of lines) {
      const parsed = JSON.parse(line) // Should not throw
      expect(parsed.ts).toBeDefined()
      expect(parsed.seq).toBeDefined()
      expect(parsed.level).toBeDefined()
      expect(parsed.layer).toBeDefined()
      expect(parsed.category).toBeDefined()
      expect(parsed.action).toBeDefined()
    }
  })
})
