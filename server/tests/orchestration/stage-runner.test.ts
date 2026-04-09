import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { StageRunner } from "../../src/orchestration/stage-runner.js"
import type { StageRunnerDeps } from "../../src/orchestration/stage-runner.js"
import type { ActivePipeline } from "../../src/orchestration/helpers.js"
import { createPipelineState } from "../../src/orchestration/pipeline-state.js"
import { createEventMerger } from "../../src/engine/event-merger.js"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

/** Minimal mock engine that captures sendMessage calls. */
function createMockEngine() {
  const messages: Array<{ sessionId: string; content: string; system?: string }> = []
  return {
    messages,
    engine: {
      createSession: vi.fn().mockResolvedValue({ id: "mock-session-1" }),
      sendMessage: vi.fn().mockImplementation(async (sid: string, opts: any) => {
        messages.push({ sessionId: sid, content: opts.content, system: opts.system })
      }),
      abort: vi.fn(),
      subscribe: vi.fn().mockReturnValue(() => {}),
      listSessions: vi.fn().mockResolvedValue([]),
      getMessages: vi.fn().mockResolvedValue([]),
      isOwnSession: vi.fn().mockReturnValue(false),
      updateSessionTitle: vi.fn(),
    },
  }
}

describe("StageRunner — transcript injection", () => {
  let workDir: string
  let transcriptDir: string
  let pipelinesDir: string
  let ps: ReturnType<typeof createPipelineState>
  let mockEngine: ReturnType<typeof createMockEngine>
  let merger: ReturnType<typeof createEventMerger>
  const skillsDir = path.resolve(import.meta.dirname, "../../../skills")

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-runner-test-"))
    pipelinesDir = path.join(workDir, ".atelier", "pipelines")
    fs.mkdirSync(pipelinesDir, { recursive: true })

    // Place transcript in the real ~/.claude/projects/ dir (Bun's os.homedir() ignores process.env.HOME)
    const encodedWs = workDir.replace(/[^a-zA-Z0-9]/g, "-")
    transcriptDir = path.join(os.homedir(), ".claude", "projects", encodedWs)
    fs.mkdirSync(transcriptDir, { recursive: true })
    fs.writeFileSync(
      path.join(transcriptDir, "build-sess-123.jsonl"),
      '{"type":"user","content":"hello"}\n{"type":"assistant","content":"hi"}\n'
    )

    ps = createPipelineState(workDir)
    mockEngine = createMockEngine()
    merger = createEventMerger()
  })

  afterEach(async () => {
    await ps.flush()
    fs.rmSync(workDir, { recursive: true, force: true })
    fs.rmSync(transcriptDir, { recursive: true, force: true })
  })

  function createStageRunner(activePipeline: ActivePipeline, opts?: { resolveSourceTranscriptPath?: StageRunnerDeps["resolveSourceTranscriptPath"] }): StageRunner {
    const deps: StageRunnerDeps = {
      engine: mockEngine.engine as any,
      pipelineState: ps,
      eventMerger: merger,
      skillsDir,
      workspacePath: workDir,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      getPipeline: () => activePipeline,
      stuckStage: vi.fn().mockResolvedValue(undefined),
      stuckStageInfrastructure: vi.fn(),
      onPipelineCompleted: vi.fn(),
      onSessionRegistered: vi.fn(),
      resolveSourceTranscriptPath: opts?.resolveSourceTranscriptPath,
    }
    return new StageRunner(deps)
  }

  it("appends transcript section when sourceSessionId points to existing JSONL", async () => {
    const pipelineDir = ".atelier/pipelines/2026-01-01-test"
    fs.mkdirSync(path.join(workDir, pipelineDir), { recursive: true })

    const pipelineId = ps.createPipeline({
      prompt: "test fork",
      workspacePath: workDir,
      pipelineDir,
      sourceSessionId: "build-sess-123",
    })

    const compiledPath = path.join(pipelineDir, "02-test-compiled-brainstorm.md")
    fs.writeFileSync(path.join(workDir, compiledPath), "# Compiled Brainstorm\n\nYou are a brainstorm agent.")

    const active: ActivePipeline = {
      id: pipelineId,
      backendId: "claude-code",
      sessionMap: new Map(),
      stageSessionMap: new Map(),
      topologyIndex: 1,
      pipelineType: "feature",
      pipelineDir: pipelineDir,
      brainstormCompiledPromptPath: compiledPath,
      workspacePath: workDir,
    }

    const runner = createStageRunner(active)
    await runner.runStage(pipelineId, "brainstorm", "test fork")

    expect(mockEngine.messages).toHaveLength(1)
    const content = mockEngine.messages[0].content
    expect(content).toContain('<context name="source-session-transcript"')
    expect(content).toContain("build-sess-123.jsonl")
  })

  it("skips transcript section when sourceSessionId is null", async () => {
    const pipelineDir = ".atelier/pipelines/2026-01-01-test2"
    fs.mkdirSync(path.join(workDir, pipelineDir), { recursive: true })

    const pipelineId = ps.createPipeline({
      prompt: "no fork",
      workspacePath: workDir,
      pipelineDir,
    })

    const compiledPath = path.join(pipelineDir, "02-test-compiled-brainstorm.md")
    fs.writeFileSync(path.join(workDir, compiledPath), "# Compiled Brainstorm\n\nYou are a brainstorm agent.")

    const active: ActivePipeline = {
      id: pipelineId,
      backendId: "claude-code",
      sessionMap: new Map(),
      stageSessionMap: new Map(),
      topologyIndex: 1,
      pipelineType: "feature",
      pipelineDir: pipelineDir,
      brainstormCompiledPromptPath: compiledPath,
      workspacePath: workDir,
    }

    const runner = createStageRunner(active)
    await runner.runStage(pipelineId, "brainstorm", "no fork")

    expect(mockEngine.messages).toHaveLength(1)
    const content = mockEngine.messages[0].content
    expect(content).not.toContain('<context name="source-session-transcript"')
  })

  it("skips transcript section when JSONL file does not exist", async () => {
    const pipelineDir = ".atelier/pipelines/2026-01-01-test3"
    fs.mkdirSync(path.join(workDir, pipelineDir), { recursive: true })

    const pipelineId = ps.createPipeline({
      prompt: "stale fork",
      workspacePath: workDir,
      pipelineDir,
      sourceSessionId: "nonexistent-session-id",
    })

    const compiledPath = path.join(pipelineDir, "02-test-compiled-brainstorm.md")
    fs.writeFileSync(path.join(workDir, compiledPath), "# Compiled Brainstorm\n\nYou are a brainstorm agent.")

    const active: ActivePipeline = {
      id: pipelineId,
      backendId: "claude-code",
      sessionMap: new Map(),
      stageSessionMap: new Map(),
      topologyIndex: 1,
      pipelineType: "feature",
      pipelineDir: pipelineDir,
      brainstormCompiledPromptPath: compiledPath,
      workspacePath: workDir,
    }

    const runner = createStageRunner(active)
    await runner.runStage(pipelineId, "brainstorm", "stale fork")

    expect(mockEngine.messages).toHaveLength(1)
    const content = mockEngine.messages[0].content
    expect(content).not.toContain('<context name="source-session-transcript"')
  })

  it("uses backend transcript resolver fallback when Claude JSONL is missing", async () => {
    const pipelineDir = ".atelier/pipelines/2026-01-01-test-opencode"
    fs.mkdirSync(path.join(workDir, pipelineDir), { recursive: true })

    const pipelineId = ps.createPipeline({
      prompt: "opencode fork",
      workspacePath: workDir,
      pipelineDir,
      sourceSessionId: "opencode-sess-123",
    })

    const compiledPath = path.join(pipelineDir, "02-test-compiled-brainstorm.md")
    fs.writeFileSync(path.join(workDir, compiledPath), "# Compiled Brainstorm\n\nYou are a brainstorm agent.")

    const active: ActivePipeline = {
      id: pipelineId,
      backendId: "opencode",
      sessionMap: new Map(),
      stageSessionMap: new Map(),
      topologyIndex: 1,
      pipelineType: "feature",
      pipelineDir,
      brainstormCompiledPromptPath: compiledPath,
      workspacePath: workDir,
    }

    const resolveSourceTranscriptPath = vi.fn().mockResolvedValue("/tmp/opencode-sess-123.jsonl")
    const runner = createStageRunner(active, { resolveSourceTranscriptPath })
    await runner.runStage(pipelineId, "brainstorm", "opencode fork")

    expect(resolveSourceTranscriptPath).toHaveBeenCalledTimes(1)
    expect(mockEngine.messages).toHaveLength(1)
    const content = mockEngine.messages[0].content
    expect(content).toContain('<context name="source-session-transcript"')
    expect(content).toContain("/tmp/opencode-sess-123.jsonl")
  })

  it("finds transcript via realpath fallback on macOS", async () => {
    // On macOS, /tmp → /private/tmp. If the workspace path is /tmp/...,
    // Claude Code may store transcripts under the /private/tmp/... encoding.
    // This test creates a transcript under the realpath-encoded dir only.
    const realWorkDir = fs.realpathSync(workDir)
    if (realWorkDir === workDir) {
      // No symlink difference on this platform — test is a no-op
      return
    }

    // Remove transcript from primary (non-realpath) dir
    const primaryEncoded = workDir.replace(/[^a-zA-Z0-9]/g, "-")
    const primaryDir = path.join(os.homedir(), ".claude", "projects", primaryEncoded)
    fs.rmSync(primaryDir, { recursive: true, force: true })

    // Create transcript under realpath-encoded dir only
    const realEncoded = realWorkDir.replace(/[^a-zA-Z0-9]/g, "-")
    const realTranscriptDir = path.join(os.homedir(), ".claude", "projects", realEncoded)
    fs.mkdirSync(realTranscriptDir, { recursive: true })
    fs.writeFileSync(
      path.join(realTranscriptDir, "build-sess-123.jsonl"),
      '{"type":"user","content":"hello"}\n'
    )

    const pipelineDir = ".atelier/pipelines/2026-01-01-test4"
    fs.mkdirSync(path.join(workDir, pipelineDir), { recursive: true })

    const pipelineId = ps.createPipeline({
      prompt: "realpath test",
      workspacePath: workDir,
      pipelineDir,
      sourceSessionId: "build-sess-123",
    })

    const compiledPath = path.join(pipelineDir, "02-test-compiled-brainstorm.md")
    fs.writeFileSync(path.join(workDir, compiledPath), "# Compiled Brainstorm\n\nAgent prompt.")

    const active: ActivePipeline = {
      id: pipelineId,
      backendId: "claude-code",
      sessionMap: new Map(),
      stageSessionMap: new Map(),
      topologyIndex: 1,
      pipelineType: "feature",
      pipelineDir: pipelineDir,
      brainstormCompiledPromptPath: compiledPath,
      workspacePath: workDir,
    }

    const runner = createStageRunner(active)
    await runner.runStage(pipelineId, "brainstorm", "realpath test")

    expect(mockEngine.messages).toHaveLength(1)
    expect(mockEngine.messages[0].content).toContain('<context name="source-session-transcript"')

    // Cleanup realpath dir
    fs.rmSync(realTranscriptDir, { recursive: true, force: true })
  })
})

describe("StageRunner — validate stage runs (not skipped)", () => {
  let workDir: string
  let pipelinesDir: string
  let ps: ReturnType<typeof createPipelineState>
  let mockEngine: ReturnType<typeof createMockEngine>
  let merger: ReturnType<typeof createEventMerger>
  const skillsDir = path.resolve(import.meta.dirname, "../../../skills")

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "stage-runner-validate-"))
    pipelinesDir = path.join(workDir, ".atelier", "pipelines")
    fs.mkdirSync(pipelinesDir, { recursive: true })

    ps = createPipelineState(workDir)
    mockEngine = createMockEngine()
    merger = createEventMerger()
  })

  afterEach(async () => {
    await ps.flush()
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  function createStageRunner(activePipeline: ActivePipeline): StageRunner {
    const deps: StageRunnerDeps = {
      engine: mockEngine.engine as any,
      pipelineState: ps,
      eventMerger: merger,
      skillsDir,
      workspacePath: workDir,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
      getPipeline: () => activePipeline,
      stuckStage: vi.fn().mockResolvedValue(undefined),
      stuckStageInfrastructure: vi.fn(),
      onPipelineCompleted: vi.fn(),
      onSessionRegistered: vi.fn(),
    }
    return new StageRunner(deps)
  }

  it("does not skip validate for autonomous in-tree pipelines", async () => {
    const pipelineDir = ".atelier/pipelines/2026-01-01-validate-test"
    fs.mkdirSync(path.join(workDir, pipelineDir), { recursive: true })

    const pipelineId = ps.createPipeline({
      prompt: "test validate",
      workspacePath: workDir,
      pipelineDir,
    })

    const active: ActivePipeline = {
      id: pipelineId,
      backendId: "claude-code",
      sessionMap: new Map(),
      stageSessionMap: new Map(),
      topologyIndex: 15,
      pipelineType: "feature",
      pipelineDir,
      workspacePath: workDir,
      autonomous: true,
      worktreeChoice: "in-tree",
      specPath: pipelineDir + "/03-validate-test-spec.md",
    }

    const runner = createStageRunner(active)
    await runner.runStage(pipelineId, "validate", "test validate")

    // Session was created (not skipped)
    expect(mockEngine.engine.createSession).toHaveBeenCalled()
    // Message was sent
    expect(mockEngine.messages).toHaveLength(1)

    // Stage was NOT set to "skipped"
    const pipeline = ps.getPipeline(pipelineId)
    const stages = pipeline?.stages ?? []
    const validateStage = stages.find(s => s.stage === "validate")
    expect(validateStage?.status).not.toBe("skipped")
  })

  it("does not skip validate for non-autonomous worktree pipelines", async () => {
    const pipelineDir = ".atelier/pipelines/2026-01-01-validate-wt"
    fs.mkdirSync(path.join(workDir, pipelineDir), { recursive: true })

    const pipelineId = ps.createPipeline({
      prompt: "test validate wt",
      workspacePath: workDir,
      pipelineDir,
    })

    const active: ActivePipeline = {
      id: pipelineId,
      backendId: "claude-code",
      sessionMap: new Map(),
      stageSessionMap: new Map(),
      topologyIndex: 15,
      pipelineType: "feature",
      pipelineDir,
      workspacePath: workDir,
      worktreeChoice: "worktree",
    }

    const runner = createStageRunner(active)
    await runner.runStage(pipelineId, "validate", "test validate wt")

    expect(mockEngine.engine.createSession).toHaveBeenCalled()
    expect(mockEngine.messages).toHaveLength(1)
  })

  it("validate task instruction includes spec path and pipeline directory", async () => {
    const pipelineDir = ".atelier/pipelines/2026-01-01-validate-instr"
    fs.mkdirSync(path.join(workDir, pipelineDir), { recursive: true })

    const specPath = pipelineDir + "/03-validate-instr-spec.md"
    const planPath = pipelineDir + "/07-validate-instr-plan.md"

    const pipelineId = ps.createPipeline({
      prompt: "test instruction",
      workspacePath: workDir,
      pipelineDir,
    })

    const active: ActivePipeline = {
      id: pipelineId,
      backendId: "claude-code",
      sessionMap: new Map(),
      stageSessionMap: new Map(),
      topologyIndex: 15,
      pipelineType: "feature",
      pipelineDir,
      workspacePath: workDir,
      specPath,
      planPath,
    }

    const runner = createStageRunner(active)
    await runner.runStage(pipelineId, "validate", "test instruction")

    expect(mockEngine.messages).toHaveLength(1)
    const content = mockEngine.messages[0]!.content
    expect(content).toContain("Validate the implementation")
    expect(content).toContain(path.join(workDir, pipelineDir))
    expect(content).toContain(path.join(workDir, specPath))
    expect(content).toContain(path.join(workDir, planPath))
  })

  it("validate task instruction includes autonomous mode indicator", async () => {
    const pipelineDir = ".atelier/pipelines/2026-01-01-validate-auto"
    fs.mkdirSync(path.join(workDir, pipelineDir), { recursive: true })

    const pipelineId = ps.createPipeline({
      prompt: "test auto",
      workspacePath: workDir,
      pipelineDir,
    })

    const active: ActivePipeline = {
      id: pipelineId,
      backendId: "claude-code",
      sessionMap: new Map(),
      stageSessionMap: new Map(),
      topologyIndex: 15,
      pipelineType: "feature",
      pipelineDir,
      workspacePath: workDir,
      autonomous: true,
    }

    const runner = createStageRunner(active)
    await runner.runStage(pipelineId, "validate", "test auto")

    expect(mockEngine.messages).toHaveLength(1)
    const content = mockEngine.messages[0]!.content
    expect(content).toContain("Mode: autonomous")
  })

  it("validate task instruction omits autonomous indicator for interactive pipelines", async () => {
    const pipelineDir = ".atelier/pipelines/2026-01-01-validate-int"
    fs.mkdirSync(path.join(workDir, pipelineDir), { recursive: true })

    const pipelineId = ps.createPipeline({
      prompt: "test interactive",
      workspacePath: workDir,
      pipelineDir,
    })

    const active: ActivePipeline = {
      id: pipelineId,
      backendId: "claude-code",
      sessionMap: new Map(),
      stageSessionMap: new Map(),
      topologyIndex: 15,
      pipelineType: "feature",
      pipelineDir,
      workspacePath: workDir,
    }

    const runner = createStageRunner(active)
    await runner.runStage(pipelineId, "validate", "test interactive")

    expect(mockEngine.messages).toHaveLength(1)
    const content = mockEngine.messages[0]!.content
    // The task instruction (after the skill + "---" separator) should not contain "Mode: autonomous"
    const taskPart = content.split("\n---\n").pop()!
    expect(taskPart).not.toContain("Mode: autonomous")
  })

})
