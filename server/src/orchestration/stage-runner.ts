import type { Logger } from "@atelier/core"
import type { AgentEngine, AgentSession } from "@atelier/core/agent-engine"
import type { PipelineState } from "./pipeline-state.js"
import type { createEventMerger } from "../engine/event-merger.js"
import { loadSkill, resolveSkillForStage, STAGE_SKILLS, SIGNAL_FOOTER } from "./skill-loader.js"
import { getTopology, getNextStage } from "./topology.js"
import { generateTaskSlug, resolveUniquePipelineDir } from "../infra/task-slug.js"
import type { PipelineStage } from "@atelier/core"
import {
  type ActivePipeline,
  STAGE_TITLES,
  absPath,
  readCompiledPrompt,
  createInternalSession,
  extractTopicSlug,
} from "./helpers.js"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

export interface StageRunnerDeps {
  engine: AgentEngine
  /** Resolve engine for a specific pipeline's backend. Falls back to `engine` if not provided. */
  getEngineForPipeline?: (pipelineId: string) => Promise<AgentEngine>
  pipelineState: PipelineState
  eventMerger: ReturnType<typeof createEventMerger>
  skillsDir: string
  workspacePath: string
  logger: Logger
  getPipeline: (pipelineId: string) => ActivePipeline | null
  stuckStage: (pipelineId: string, stageId: string, error: string) => Promise<void>
  stuckStageInfrastructure: (pipelineId: string, error: string, stageId: string) => void
  onPipelineCompleted: (pipelineId: string) => void
  onSessionRegistered: (args: {
    sessionId: string
    pipelineId: string
    stageId: string
    stage: string
    assignedOutputPath?: string
  }) => void
  /** Optional backend-aware transcript resolver (e.g. OpenCode export fallback). */
  resolveSourceTranscriptPath?: (args: {
    pipelineId: string
    sourceSessionId: string
    workspacePath: string
  }) => Promise<string | null>
}

export class StageRunner {
  private deps: StageRunnerDeps

  constructor(deps: StageRunnerDeps) {
    this.deps = deps
  }

  /** Resolve the engine for a specific pipeline, falling back to the default engine. */
  private async engineFor(pipelineId: string): Promise<AgentEngine> {
    if (this.deps.getEngineForPipeline) {
      return this.deps.getEngineForPipeline(pipelineId)
    }
    return this.deps.engine
  }

  /** Resolve the effective workspace for a pipeline. Falls back to global workspace. */
  private workspaceFor(pipelineId: string): string {
    const pipeline = this.deps.getPipeline(pipelineId)
    return pipeline?.workspacePath ?? this.deps.workspacePath
  }

  /**
   * Resolve the JSONL transcript path for a source session.
   * Checks both the original workspace encoding and the realpath encoding (macOS symlink fallback).
   * Returns the absolute path if found, null otherwise.
   */
  private async resolveTranscriptPath(workspacePath: string, sessionId: string): Promise<string | null> {
    const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects")
    const encodedWs = workspacePath.replace(/[^a-zA-Z0-9]/g, "-")
    const jsonlFile = `${sessionId}.jsonl`

    // Check primary path
    const primaryPath = path.join(claudeProjectsDir, encodedWs, jsonlFile)
    const primaryExists = await fs.access(primaryPath).then(() => true, () => false)
    if (primaryExists) return primaryPath

    // Fallback: check realpath-encoded directory (macOS: /var → /private/var)
    try {
      const realWs = await fs.realpath(workspacePath)
      if (realWs !== workspacePath) {
        const realEncoded = realWs.replace(/[^a-zA-Z0-9]/g, "-")
        const realPath = path.join(claudeProjectsDir, realEncoded, jsonlFile)
        const realExists = await fs.access(realPath).then(() => true, () => false)
        if (realExists) return realPath
      }
    } catch {
      // realpath failed — workspace may not exist, skip fallback
    }

    return null
  }

  /**
   * Build a <context> block with the source session transcript path, if available.
   * Returns the block to append to the task content, or empty string if no transcript.
   */
  private async buildTranscriptContext(pipelineId: string, workspacePath: string): Promise<string> {
    const pipelineData = this.deps.pipelineState.getPipeline(pipelineId)
    if (!pipelineData?.sourceSessionId) return ""

    let transcriptPath = await this.resolveTranscriptPath(workspacePath, pipelineData.sourceSessionId)
    if (!transcriptPath && this.deps.resolveSourceTranscriptPath) {
      transcriptPath = await this.deps.resolveSourceTranscriptPath({
        pipelineId,
        sourceSessionId: pipelineData.sourceSessionId,
        workspacePath,
      })
    }
    if (!transcriptPath) {
      this.deps.logger.debug("atelier", "stage", "transcript_not_found", { pipelineId, data: { sourceSessionId: pipelineData.sourceSessionId } })
      return ""
    }

    this.deps.logger.debug("atelier", "stage", "transcript_injected", { pipelineId, data: { transcriptPath } })
    return `\n\n<context name="source-session-transcript" description="The user started this pipeline from an active build session. Read this transcript for prior context — decisions made, requirements identified, constraints discovered, relevant code explored.">\n${transcriptPath}\n</context>`
  }

  /** Wrap the user's original prompt in a <user-prompt> tag for clear structural delimitation. */
  private wrapUserPrompt(prompt: string): string {
    return `<user-prompt>\n${prompt}\n</user-prompt>`
  }

  /** Create a responder session for an interactive stage on an autonomous pipeline.
   *  The responder gets the responding skill as system prompt and uses MCP tools
   *  (atelier_poll / atelier_reply) to monitor the pipeline and answer questions. */
  private async createResponderSession(pipelineId: string, prompt: string): Promise<void> {
    const active = this.deps.getPipeline(pipelineId)
    if (!active?.autonomous) return

    // Kill any existing responder from a previous stage before creating a new one.
    // This prevents stale responders from sending messages during autonomous stages.
    if (active.responderSessionId) {
      const oldResponderId = active.responderSessionId
      active.responderSessionId = undefined
      const oldEngine = await this.engineFor(pipelineId)
      oldEngine.interruptSession(oldResponderId).catch(() => {})
      oldEngine.evictSession?.(oldResponderId)
      this.deps.logger.debug("atelier", "stage", "old_responder_killed", { pipelineId, data: { oldResponderId } })
    }

    const engine = await this.engineFor(pipelineId)
    const ws = this.workspaceFor(pipelineId)

    let skillContent: string
    try {
      skillContent = await loadSkill("responding", this.deps.skillsDir)
    } catch (err) {
      this.deps.logger.error("atelier", "stage", "responder_skill_load_failed", {
        pipelineId, error: (err as Error).message,
      })
      return
    }

    const session = await createInternalSession(engine, ws, this.deps.eventMerger, {
      parentID: pipelineId,
      model: active.model,
      variant: active.variant,
      title: "Responder",
      responderPipelineId: pipelineId,
    })

    active.responderSessionId = session.id

    // Send initial directive: skill prompt + pipeline context + instruction to start polling
    const activationMessage = `${skillContent}

---

You are managing autonomous pipeline ${pipelineId}. Your job is to answer questions from the work agent.

Use atelier_poll to monitor the pipeline for events. When you see question.asked events, analyze the questions and call atelier_reply with your answers. Keep polling until you see pipeline_completed.

The original user request: ${prompt}

Start polling now.`

    await engine.sendMessage(session.id, {
      content: activationMessage,
      model: active.model,
      variant: active.variant,
    })

    this.deps.logger.info("atelier", "stage", "responder_session_created", {
      pipelineId,
      data: { responderSessionId: session.id },
    })
  }

  async runStage(pipelineId: string, stage: string, prompt: string, opts?: { dynamicallyInserted?: boolean; parentReviewStageId?: string; restartedFromPartial?: boolean }): Promise<void> {
    // Skip establish_conventions on mature codebases (CLAUDE.md already exists)
    if (stage === "establish_conventions") {
      const hasConventions = await this.hasExistingConventions(pipelineId)
      this.deps.logger.debug("atelier", "stage", "conventions_check", { data: { exists: hasConventions } })
      if (hasConventions) {
        this.deps.logger.info("atelier", "stage", "stage_skipped", { pipelineId, data: { stage, reason: "CLAUDE.md exists" } })
        // Create a stage record so crash recovery can correctly reconstruct topologyIndex
        const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
        this.deps.pipelineState.setStageStatus(pipelineId, stageId, "skipped")
        await this.advanceToNextStage(pipelineId)
        return
      }
    }

    this.deps.pipelineState.updatePipelineStage(pipelineId, stage)
    const active = this.deps.getPipeline(pipelineId)
    if (active) {
      active.currentStage = stage
      active.interrupted = false
    }

    // Apply per-stage model override if configured
    const stageModel = this.deps.pipelineState.getStageModel(pipelineId, stage)
    const previousModel = active?.model
    const previousVariant = active?.variant
    if (active && stageModel) {
      active.model = { providerID: stageModel.providerID, modelID: stageModel.modelID }
      active.variant = stageModel.variant
      this.deps.logger.debug("atelier", "stage", "stage_model_override", {
        pipelineId, stageName: stage,
        data: { providerID: stageModel.providerID, modelID: stageModel.modelID, variant: stageModel.variant },
      })
    }

    const isBrainstorm = StageRunner.BRAINSTORM_STAGES.has(stage)
    const handler = stage.startsWith("compile_") ? "compile" : isBrainstorm ? "brainstorm" : "autonomous"
    this.deps.logger.debug("atelier", "stage", "stage_dispatch", { pipelineId, stageName: stage, data: { handler } })

    try {
      if (stage.startsWith("compile_")) {
        await this.runCompileStage(pipelineId, stage, prompt)
      } else if (isBrainstorm) {
        await this.runBrainstormStage(pipelineId, prompt, stage)
      } else {
        await this.runAutonomousStage(pipelineId, stage, prompt, opts)
      }
    } finally {
      // Restore pipeline-level model/variant so getStageModel can re-resolve per stage
      if (active && previousModel) {
        active.model = previousModel
        active.variant = previousVariant
      }
    }
  }

   async advanceToNextStage(pipelineId: string): Promise<void> {
     const active = this.deps.getPipeline(pipelineId)
     if (!active) return

    const topology = getTopology(active.pipelineType)
    const nextDef = getNextStage(active.topologyIndex, topology)
    if (!nextDef) {
      this.deps.logger.debug("atelier", "pipeline", "topology_exhausted", { pipelineId })
      this.deps.onPipelineCompleted(pipelineId)
      return
    }

    // Update topology index and currentStage synchronously BEFORE runStage —
    // the responder polls getCurrentStageInfo and must see the new stage immediately
    // to know whether it's interactive or autonomous.
    const currentIndex = active.topologyIndex
    active.topologyIndex = topology.indexOf(nextDef)
    active.currentStage = nextDef.stage
    this.deps.logger.debug("atelier", "stage", "advancing_to_next_stage", { pipelineId, data: { currentIndex, nextStage: nextDef.stage } })

    const pipeline = this.deps.pipelineState.getPipeline(pipelineId)
    if (pipeline) {
      await this.runStage(pipelineId, nextDef.stage, pipeline.prompt)
    }
  }

  async runClassifyStage(pipelineId: string, prompt: string): Promise<void> {
    const active = this.deps.getPipeline(pipelineId)!
    const engine = await this.engineFor(pipelineId)

    // Set currentStage so handleSignal routes to classify handler
    this.deps.pipelineState.updatePipelineStage(pipelineId, "classify")
    active.currentStage = "classify"
    active.interrupted = false

    let system: string
    try {
      system = await loadSkill("classifying", this.deps.skillsDir)
    } catch (err) {
      const stageId = this.deps.pipelineState.createStage({ pipelineId, stage: "classify" })
      this.deps.stuckStageInfrastructure(pipelineId, (err as Error).message, stageId)
      return
    }

    // Classification always runs in main workspace (worktree doesn't exist yet)
    let session: import("@atelier/core/agent-engine").AgentSession
    try {
      session = await createInternalSession(engine, this.deps.workspacePath, this.deps.eventMerger, {
        parentID: pipelineId, model: active.model, variant: active.variant, title: STAGE_TITLES.classify,
      })
    } catch (err) {
      const stageId = this.deps.pipelineState.createStage({ pipelineId, stage: "classify" })
      await this.deps.stuckStage(pipelineId, stageId, (err as Error).message)
      return
    }

    const assignedOutputPath = this.buildOutputPath(pipelineId, "classification")
    this.registerStage(pipelineId, "classify", session, engine, { assignedOutputPath })

    // Create responder session for autonomous pipelines
    await this.createResponderSession(pipelineId, prompt)

    const absOutputPath = path.join(this.deps.workspacePath, assignedOutputPath)
    let taskContent = `${system}${SIGNAL_FOOTER}\n\n---\n\nWrite your classification to \`${absOutputPath}\`.\n\n${this.wrapUserPrompt(prompt)}`
    taskContent += await this.buildTranscriptContext(pipelineId, this.deps.workspacePath)

    try {
      await engine.sendMessage(session.id, { content: taskContent, model: active.model, variant: active.variant })
    } catch (err) {
      const stageId = active.sessionMap.get(session.id)!
      await this.deps.stuckStage(pipelineId, stageId, (err as Error).message)
    }
  }

  async generatePipelineDir(pipelineId: string, prompt: string, model?: { providerID: string; modelID: string }): Promise<string> {
    const { pipelineState, eventMerger, workspacePath, logger } = this.deps
    const engine = await this.engineFor(pipelineId)
    let slug: string
    try {
      const session = await createInternalSession(engine, workspacePath, eventMerger, { parentID: pipelineId, model })
      const idlePromise = engine.waitForIdle(session.id, 30_000)
      idlePromise.catch(() => {})
      await engine.sendMessage(session.id, {
        content: `Generate a short 2-5 word kebab-case slug for this task. Reply with ONLY the slug on a single line, nothing else.\n\nTask: ${prompt}`,
        model,
      })
      await idlePromise
      const output = await engine.getSessionOutput(session.id)
      const raw = output.text.trim().split("\n")[0]!.trim()
      slug = raw.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")
      if (!slug || slug.length < 2) slug = generateTaskSlug(prompt)
      try { await engine.deleteSession(session.id) } catch {}
      eventMerger.removeInternalSession(session.id)
    } catch {
      slug = generateTaskSlug(prompt)
    }

    const datePrefix = new Date().toISOString().slice(0, 10)
    const suffix = pipelineId.slice(0, 4)
    const baseDir = `.atelier/pipelines/${datePrefix}-${slug}-${suffix}`
    const pipelineDir = resolveUniquePipelineDir(workspacePath, baseDir)

    logger.debug("atelier", "pipeline", "slug_generated", { pipelineId, data: { slug } })

    const absPipelineDir = path.join(workspacePath, pipelineDir)
    await fs.mkdir(absPipelineDir, { recursive: true })

    pipelineState.updatePipelineDir(pipelineId, pipelineDir)
    logger.info("atelier", "pipeline", "pipeline_dir_created", { pipelineId, data: { pipelineDir, slug } })

    // Emit title update so the extension tab label and webview chatlist can refresh
    const title = slug.replace(/-/g, " ")
    eventMerger.emit({ type: "pipeline_title_updated", pipelineId, title })

    return pipelineDir
  }

  async createBareProgressFile(pipelineDir: string): Promise<void> {
    const content = [
      "# Progress",
      "",
      "## Summary",
      "- Total: 0 | Done: 0 | Remaining: 0",
      "",
      "## Tasks",
      "",
      "| # | Task | Status |",
      "|---|------|--------|",
      "",
      "## Iteration Log",
      "",
    ].join("\n")

    const progressPath = path.join(this.deps.workspacePath, pipelineDir, "progress.md")
    await fs.mkdir(path.dirname(progressPath), { recursive: true })
    await fs.writeFile(progressPath, content, "utf-8")
  }

  /** Build a step-numbered output path for a pipeline artifact. */
  buildOutputPath(pipelineId: string, artifactType: string): string {
    const active = this.deps.getPipeline(pipelineId)
    if (!active) {
      throw new Error(`buildOutputPath: no active pipeline found for ${pipelineId}`)
    }
    if (!active.pipelineDir) {
      throw new Error(`buildOutputPath: pipeline ${pipelineId} has no pipelineDir (was generatePipelineDir called?)`)
    }
    const step = this.deps.pipelineState.incrementStepCounter(pipelineId)
    const nn = String(step).padStart(2, "0")
    const topicSlug = extractTopicSlug(active.pipelineDir)
    return path.join(active.pipelineDir, `${nn}-${topicSlug}-${artifactType}.md`)
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Check if CLAUDE.md (or .claude/CLAUDE.md) already exists in the workspace. */
  private async hasExistingConventions(pipelineId?: string): Promise<boolean> {
    const ws = pipelineId ? this.workspaceFor(pipelineId) : this.deps.workspacePath
    for (const candidate of ["CLAUDE.md", ".claude/CLAUDE.md"]) {
      try {
        await fs.access(path.join(ws, candidate))
        return true
      } catch {}
    }
    return false
  }

  private registerStage(pipelineId: string, stage: string, session: AgentSession, engine: AgentEngine, opts?: { dynamicallyInserted?: boolean; parentReviewStageId?: string; compiledPromptPath?: string; assignedOutputPath?: string; restartedFromPartial?: boolean }): string {
    const active = this.deps.getPipeline(pipelineId)!
     const stageId = this.deps.pipelineState.createStage({ pipelineId, stage, sessionId: session.id, dynamicallyInserted: opts?.dynamicallyInserted, parentReviewStageId: opts?.parentReviewStageId, compiledPromptPath: opts?.compiledPromptPath, assignedOutputPath: opts?.assignedOutputPath, restartedFromPartial: opts?.restartedFromPartial })
     active.sessionMap.set(session.id, stageId)
     this.deps.onSessionRegistered({ sessionId: session.id, pipelineId, stageId, stage, assignedOutputPath: opts?.assignedOutputPath })
     active.currentStageId = stageId
     active.stageSessionMap.set(stage, session.id)

    engine.updateSessionTitle(session.id, STAGE_TITLES[stage] ?? stage)
    this.deps.logger.info("atelier", "stage", "stage_started", { pipelineId, stageId, stageName: stage })
    const pipelineData = this.deps.pipelineState.getPipeline(pipelineId)
    this.deps.eventMerger.emit({
      type: "stage_started", pipelineId, stageId, stage: stage as PipelineStage, sessionId: session.id,
      model: pipelineData?.model ?? undefined, variant: pipelineData?.variant ?? undefined,
    })

    return stageId
  }

  static readonly BRAINSTORM_STAGES = new Set(["brainstorm", "brainstorm_roadmap", "task_brainstorm"])

  static readonly COMPILE_TARGETS: Record<string, string> = {
    compile_brainstorm: "brainstorm",
    compile_plan: "write_plan",
    compile_e2e_plan: "write_e2e_plan",
    compile_roadmap_brainstorm: "brainstorm_roadmap",
    compile_task_brainstorm: "task_brainstorm",
  }

  static readonly COMPILE_OUTPUT_FILES: Record<string, string> = {
    brainstorm: "spec.md",
    write_plan: "plan.md",
    write_e2e_plan: "e2e-plan.md",
    brainstorm_roadmap: "roadmap.md",
    task_brainstorm: "task-spec.md",
  }

  private async runCompileStage(pipelineId: string, stage: string, prompt: string): Promise<void> {
    const active = this.deps.getPipeline(pipelineId)!
    const engine = await this.engineFor(pipelineId)
    const targetStage = StageRunner.COMPILE_TARGETS[stage]
    if (!targetStage) throw new Error(`Unknown compile stage: ${stage}`)
    const targetSkillName = resolveSkillForStage(targetStage, active.pipelineType)
    if (!targetSkillName) throw new Error(`No skill mapping for target stage: ${targetStage}`)
    const compilerSkillName = STAGE_SKILLS[stage]
    if (!compilerSkillName) throw new Error(`No compiler skill mapping for stage: ${stage}`)
    this.deps.logger.info("atelier", "compile", "compile_started", { pipelineId, data: { targetStage } })

    const topology = getTopology(active.pipelineType)
    const stageDef = topology.find(s => s.stage === stage)
    const artifactType = stageDef?.artifactType ?? `compiled-${targetStage}`
    const ws = this.workspaceFor(pipelineId)
    const relOutputPath = this.buildOutputPath(pipelineId, artifactType)
    const outputPath = path.join(ws, relOutputPath)

    let stageSkillContent: string
    let compilerSkillContent: string
    try {
      stageSkillContent = await loadSkill(targetSkillName, this.deps.skillsDir)
      compilerSkillContent = await loadSkill(compilerSkillName, this.deps.skillsDir)
      this.deps.logger.debug("atelier", "compile", "compile_skills_loaded", { pipelineId, data: { compilerLength: compilerSkillContent.length, stageSkillLength: stageSkillContent.length } })
    } catch (err) {
      const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
      this.deps.stuckStageInfrastructure(pipelineId, (err as Error).message, stageId)
      return
    }

    let session: AgentSession
    try {
      session = await createInternalSession(engine, ws, this.deps.eventMerger, {
        parentID: pipelineId, model: active.model, variant: active.variant, title: STAGE_TITLES[stage],
      })
      this.deps.logger.debug("atelier", "compile", "compile_session_created", { pipelineId, sessionId: session.id })
    } catch (err) {
      const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
      await this.deps.stuckStage(pipelineId, stageId, (err as Error).message)
      return
    }

    this.registerStage(pipelineId, stage, session, engine, { compiledPromptPath: relOutputPath, assignedOutputPath: relOutputPath })

     const compilerInput = this.buildCompilerInput(pipelineId, compilerSkillContent, stageSkillContent, {
       targetStage,
       specPath: active.specPath,
       prompt,
       outputPath,
       agentOutputFile: StageRunner.COMPILE_OUTPUT_FILES[targetStage] ?? `${targetStage}.md`,
     })

    const compilerPreamble = `You are a compiler agent. Read the reference material in the user message and produce a compiled prompt file. Write ONLY to the specified output path. Do not brainstorm, plan, or implement anything yourself.` + SIGNAL_FOOTER

    try {
      await engine.sendMessage(session.id, {
        content: `${compilerPreamble}\n\n---\n\n${compilerInput}`,
        model: active.model,
        variant: active.variant,
      })
    } catch (err) {
      const stageId = active.sessionMap.get(session.id)!
      await this.deps.stuckStage(pipelineId, stageId, (err as Error).message)
    }
  }

  private async runBrainstormStage(pipelineId: string, prompt: string, stage: string = "brainstorm"): Promise<void> {
    const active = this.deps.getPipeline(pipelineId)!
    const engine = await this.engineFor(pipelineId)
    const ws = this.workspaceFor(pipelineId)

    // Select compiled prompt path based on stage
    const compiledPromptPath = ({
      brainstorm_roadmap: active.roadmapBrainstormCompiledPromptPath,
      task_brainstorm: active.taskBrainstormCompiledPromptPath,
    } as Record<string, string | undefined>)[stage] ?? active.brainstormCompiledPromptPath

    if (!compiledPromptPath) {
      const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
      this.deps.stuckStageInfrastructure(pipelineId, `${stage} stage has no compiled prompt path`, stageId)
      return
    }

    let system: string
    try {
      const content = await readCompiledPrompt(compiledPromptPath, ws)
      if (!content) {
        const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
        this.deps.stuckStageInfrastructure(pipelineId, `Compiled prompt is empty: ${compiledPromptPath}`, stageId)
        return
      }
      system = content
      this.deps.logger.debug("atelier", "stage", "brainstorm_prompt_loaded", { pipelineId, data: { path: compiledPromptPath, contentLength: system.length } })
    } catch (err) {
      const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
      this.deps.stuckStageInfrastructure(pipelineId, `Failed to read compiled prompt at ${compiledPromptPath}: ${(err as Error).message}`, stageId)
      return
    }

    const topology = getTopology(active.pipelineType)
    const stageDef = topology.find(s => s.stage === stage)
    let assignedOutputPath: string | undefined
    if (stageDef?.artifactType) {
      assignedOutputPath = this.buildOutputPath(pipelineId, stageDef.artifactType)
    }

    let session: AgentSession
    try {
      session = await createInternalSession(engine, ws, this.deps.eventMerger, {
        parentID: pipelineId, model: active.model, variant: active.variant, title: STAGE_TITLES[stage],
      })
      this.deps.logger.debug("atelier", "stage", "brainstorm_session_created", { pipelineId, sessionId: session.id })
    } catch (err) {
      const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
      await this.deps.stuckStage(pipelineId, stageId, (err as Error).message)
      return
    }

    this.registerStage(pipelineId, stage, session, engine, { assignedOutputPath })

    // Create responder session for autonomous pipelines
    const pipelineForResponder = this.deps.pipelineState.getPipeline(pipelineId)
    await this.createResponderSession(pipelineId, pipelineForResponder?.prompt ?? prompt)

    try {
      let taskContent: string
      const wrappedPrompt = this.wrapUserPrompt(prompt)
      if (assignedOutputPath) {
        taskContent = `${system}${SIGNAL_FOOTER}\n\n---\n\nWrite your output to \`${path.join(ws, assignedOutputPath)}\`.\n\n${wrappedPrompt}`
      } else {
        taskContent = `${system}${SIGNAL_FOOTER}\n\n---\n\n${wrappedPrompt}`
      }
      taskContent += await this.buildTranscriptContext(pipelineId, ws)
      await engine.sendMessage(session.id, { content: taskContent, model: active.model, variant: active.variant })
    } catch (err) {
      const stageId = active.sessionMap.get(session.id)!
      await this.deps.stuckStage(pipelineId, stageId, (err as Error).message)
    }
  }

  private async runAutonomousStage(pipelineId: string, stage: string, prompt: string, opts?: { dynamicallyInserted?: boolean; parentReviewStageId?: string; restartedFromPartial?: boolean }): Promise<void> {
    const active = this.deps.getPipeline(pipelineId)!
    let system: string | undefined

    // Compiled-prompt stages: load system prompt from the preceding compile stage's output
    const compiledPromptForStage: Record<string, string | undefined> = {
      write_plan: active.planCompiledPromptPath,
      write_e2e_plan: active.e2ePlanCompiledPromptPath,
    }

    if (stage in compiledPromptForStage) {
      const compiledPath = compiledPromptForStage[stage]
      if (!compiledPath) {
        const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
        this.deps.stuckStageInfrastructure(pipelineId, `${stage} has no compiled prompt path — compile stage must complete first`, stageId)
        return
      }
      try {
        system = await readCompiledPrompt(compiledPath, this.workspaceFor(pipelineId))
      } catch (err) {
        const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
        this.deps.stuckStageInfrastructure(pipelineId, `Failed to read compiled prompt at ${compiledPath}: ${(err as Error).message}`, stageId)
        return
      }
      if (!system) {
        const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
        this.deps.stuckStageInfrastructure(pipelineId, `Compiled prompt is empty: ${compiledPath}`, stageId)
        return
      }
    } else {
      // All other autonomous/interactive stages: resolve skill (brainstorm family is polymorphic on pipelineType).
      const skillName = resolveSkillForStage(stage, active.pipelineType)
      if (skillName) {
        try {
          system = await loadSkill(skillName, this.deps.skillsDir)
          this.deps.logger.debug("atelier", "stage", "skill_loaded", { data: { skillName } })
        } catch (err) {
          const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
          this.deps.stuckStageInfrastructure(pipelineId, (err as Error).message, stageId)
          return
        }
      }
    }

    // Build step-numbered output path for stages with artifacts
    const topology = getTopology(active.pipelineType)
    const stageDef = topology.find(s => s.stage === stage)
    // Dynamically inserted fix stages aren't in the topology but still produce artifacts
    const FIX_ARTIFACT_TYPES: Record<string, string> = {
      fix_spec: "spec-fix",
      fix_plan: "plan-fix",
      fix_code: "code-fix",
      fix_hooks: "hook-fix",
      fix_e2e_plan: "e2e-plan-fix",
      fix_task: "task-fix",
      fix_quick_plan: "plan-fix",
      fix_roadmap: "roadmap-fix",
    }
    const artifactType = stageDef?.artifactType ?? FIX_ARTIFACT_TYPES[stage]
    let assignedOutputPath: string | undefined
    if (artifactType) {
      assignedOutputPath = this.buildOutputPath(pipelineId, artifactType)
      this.deps.logger.debug("atelier", "stage", "output_path_assigned", { pipelineId, stageName: stage, data: { assignedOutputPath } })
    }

    const engine = await this.engineFor(pipelineId)
    let session: AgentSession
    try {
      session = await createInternalSession(engine, this.workspaceFor(pipelineId), this.deps.eventMerger, {
        parentID: pipelineId, model: active.model, variant: active.variant, title: STAGE_TITLES[stage],
      })
      this.deps.logger.debug("atelier", "stage", "autonomous_session_created", { pipelineId, sessionId: session.id, stageName: stage })
    } catch (err) {
      const stageId = this.deps.pipelineState.createStage({ pipelineId, stage })
      await this.deps.stuckStage(pipelineId, stageId, (err as Error).message)
      return
    }

     const stageId = this.registerStage(pipelineId, stage, session, engine, { ...opts, assignedOutputPath })

     let taskInstruction = this.buildTaskInstruction(pipelineId, stage, prompt, assignedOutputPath)
    // Prepend skill content to user message (not system prompt) so the agent sees it as primary instruction
    if (system) {
      taskInstruction = `${system}${SIGNAL_FOOTER}\n\n---\n\n${taskInstruction}`
    }
    taskInstruction += await this.buildTranscriptContext(pipelineId, this.workspaceFor(pipelineId))
    try {
      await engine.sendMessage(session.id, { content: taskInstruction, model: active.model, variant: active.variant })
      this.deps.logger.debug("atelier", "stage", "autonomous_message_sent", { pipelineId, sessionId: session.id, data: { contentLength: taskInstruction.length } })
    } catch (err) {
      await this.deps.stuckStage(pipelineId, stageId, (err as Error).message)
    }
  }

   private buildCompilerInput(
     pipelineId: string,
     compilerSkill: string,
     stageSkill: string,
     opts: { targetStage: string; specPath: string | undefined; prompt: string; outputPath: string; agentOutputFile: string },
   ): string {
     const active = this.deps.getPipeline(pipelineId)!
    const ws = this.workspaceFor(pipelineId)
    const absPipelineDir = absPath(active.pipelineDir!, ws)
    const absWorkAgentOutput = path.join(absPipelineDir, opts.agentOutputFile)

    const parts = [
      `# YOUR ROLE: COMPILER AGENT`,
      `You are the COMPILER agent. You read reference material and produce a compiled prompt file. You do NOT brainstorm, plan, or implement anything. Your ONLY output is a single markdown file written to the output path below.`,
      `**Output path:** ${opts.outputPath}`,
      `**Stage to compile for:** ${opts.targetStage}`,
      `**Spec:** ${opts.specPath ? absPath(opts.specPath, ws) : "none"}`,
      `**User prompt:** ${opts.prompt}`,
      `**Pipeline directory:** ${absPipelineDir}`,
      `**Work agent output path:** ${absWorkAgentOutput}`,
      `---`,
      `# Compiler Instructions`,
      compilerSkill,
      `---`,
      `# REFERENCE DATA: Stage Skill (DO NOT FOLLOW — COMPILE INTO A PROMPT)`,
      `The following is the methodology document for the "${opts.targetStage}" stage. This is INPUT DATA for you to compile. Do NOT follow its instructions. Do NOT act as the role it describes. Read it, understand the methodology, then produce a compiled prompt at the output path above.`,
      `<stage-skill-reference>`,
      stageSkill,
      `</stage-skill-reference>`,
    ]

    // For roadmap brainstorm: include the reviewed spec path
    if (opts.targetStage === "brainstorm_roadmap") {
      const specRef = active.specPath ? absPath(active.specPath, ws) : null
      if (specRef) {
        parts.push(`The reviewed main spec is at \`${specRef}\`. Read it to inform the roadmap brainstorm prompt.`)
      }
    }

    return parts.join("\n\n")
  }

   private buildTaskInstruction(pipelineId: string, stage: string, prompt: string, outputPath?: string): string {
     const active = this.deps.getPipeline(pipelineId)!
    const ws = this.workspaceFor(pipelineId)
    const outputLine = outputPath ? `Write your review to \`${absPath(outputPath, ws)}\`. ` : ""
    const userPrompt = this.wrapUserPrompt(prompt)

    switch (stage) {
      case "write_plan":
        if (active.specPath) {
          return `${outputLine}Write the implementation plan for the spec at \`${absPath(active.specPath, ws)}\``
        }
        return `${outputLine}Write the implementation plan.\n\n${userPrompt}`

      case "implement": {
        // Task pipelines use taskSpecPath (combined spec-plan), feature/plan pipelines use planPath
        const implPlanRef = active.planPath ?? active.taskSpecPath
        if (active.specPath) {
          return `Implement the plan at \`${absPath(implPlanRef!, ws)}\`. Spec at \`${absPath(active.specPath, ws)}\`.`
        }
        if (implPlanRef) {
          return `Implement the plan at \`${absPath(implPlanRef, ws)}\`.\n\n${userPrompt}`
        }
        return `Implement the following task.\n\n${userPrompt}`
      }

      case "review_spec":
        return `${outputLine}Review the spec at \`${absPath(active.specPath!, ws)}\`.\n\n${userPrompt}`

      case "review_plan":
        return `${outputLine}Review the plan at \`${absPath(active.planPath!, ws)}\` against the spec at \`${active.specPath ? absPath(active.specPath, ws) : "N/A"}\`.\n\n${userPrompt}`

      case "review_code":
        return `${outputLine}Review the implementation against the spec at \`${active.specPath ? absPath(active.specPath, ws) : "N/A"}\` and plan at \`${active.planPath ? absPath(active.planPath, ws) : "N/A"}\`.\n\n${userPrompt}`

      case "fix_spec": {
        const reviewRef = active.lastReviewOutputPath ? absPath(active.lastReviewOutputPath, ws) : "N/A"
        const specRef = active.specPath ? absPath(active.specPath, ws) : "N/A"
        return `${outputLine}Apply the review findings at \`${reviewRef}\` to the spec at \`${specRef}\`.`
      }

      case "fix_plan": {
        const reviewRef = active.lastReviewOutputPath ? absPath(active.lastReviewOutputPath, ws) : "N/A"
        const planRef = active.planPath ? absPath(active.planPath, ws) : "N/A"
        const specRef = active.specPath ? absPath(active.specPath, ws) : "N/A"
        return `${outputLine}Apply the review findings at \`${reviewRef}\` to the plan at \`${planRef}\`. Spec at \`${specRef}\`.`
      }

      case "fix_code": {
        const reviewRef = active.lastReviewOutputPath ? absPath(active.lastReviewOutputPath, ws) : "N/A"
        const specRef = active.specPath ? absPath(active.specPath, ws) : "N/A"
        const planRef = active.planPath ? absPath(active.planPath, ws) : "N/A"
        return `${outputLine}Apply the review findings at \`${reviewRef}\`. Spec at \`${specRef}\`, plan at \`${planRef}\`.`
      }

      case "establish_conventions": {
        const artifactNote = outputPath ? `Also copy the conventions to the pipeline artifact at \`${absPath(outputPath, ws)}\`. ` : ""
        return `Write the project's coding conventions into CLAUDE.md at the workspace root. ${artifactNote}Establish coding conventions for this project.\n\n${userPrompt}`
      }

      case "simplify":
        return `${outputLine}Simplify and polish the implementation.\n\n${userPrompt}`

      case "e2e_gate": {
        const specRef = active.specPath ? absPath(active.specPath, ws) : null
        const planRef = active.planPath ? absPath(active.planPath, ws) : null
        const refs = [specRef && `Spec at \`${specRef}\``, planRef && `Plan at \`${planRef}\``].filter(Boolean).join(". ")
        return `${outputLine}Decide whether E2E testing is warranted for this implementation. ${refs}.\n\n${userPrompt}`
      }

      case "write_e2e_plan":
        if (active.specPath) {
          return `${outputLine}Write the E2E test plan for the implementation. Spec at \`${absPath(active.specPath, ws)}\`.`
        }
        return `${outputLine}Write the E2E test plan.\n\n${userPrompt}`

      case "review_e2e_plan":
        return `${outputLine}Review the E2E plan at \`${absPath(active.e2ePlanPath!, ws)}\` against the spec at \`${active.specPath ? absPath(active.specPath, ws) : "N/A"}\`.\n\n${userPrompt}`

      case "e2e":
        return `Execute the E2E plan at \`${absPath(active.e2ePlanPath!, ws)}\`. Spec at \`${active.specPath ? absPath(active.specPath, ws) : "N/A"}\`.`

      case "fix_e2e_plan": {
        const reviewRef = active.lastReviewOutputPath ? absPath(active.lastReviewOutputPath, ws) : "N/A"
        const planRef = active.e2ePlanPath ? absPath(active.e2ePlanPath, ws) : "N/A"
        const specRef = active.specPath ? absPath(active.specPath, ws) : "N/A"
        return `${outputLine}Apply the review findings at \`${reviewRef}\` to the E2E plan at \`${planRef}\`. Spec at \`${specRef}\`.`
      }

      case "review_roadmap": {
        const roadmapRef = active.roadmapPath ? absPath(active.roadmapPath, ws) : "N/A"
        const specRef = active.specPath ? absPath(active.specPath, ws) : "N/A"
        return `${outputLine}Review the roadmap at \`${roadmapRef}\` against the spec at \`${specRef}\`.\n\n${userPrompt}`
      }

      case "fix_roadmap": {
        const reviewRef = active.lastReviewOutputPath ? absPath(active.lastReviewOutputPath, ws) : "N/A"
        const roadmapRef = active.roadmapPath ? absPath(active.roadmapPath, ws) : "N/A"
        const specRef = active.specPath ? absPath(active.specPath, ws) : "N/A"
        return `${outputLine}Apply the review findings at \`${reviewRef}\` to the roadmap at \`${roadmapRef}\`. Spec at \`${specRef}\`.`
      }

      case "validate": {
        const specRef = active.specPath ? absPath(active.specPath, ws) : null
        const planRef = active.planPath ? absPath(active.planPath, ws) : null
        const pipelineDirAbs = absPath(active.pipelineDir!, ws)
        const refs = [
          `Pipeline directory: \`${pipelineDirAbs}\``,
          specRef && `Spec: \`${specRef}\``,
          planRef && `Plan: \`${planRef}\``,
          active.autonomous && `Mode: autonomous`,
        ].filter(Boolean).join(". ")
        return `${outputLine}Validate the implementation. ${refs}.\n\n${userPrompt}`
      }

      case "fix_hooks":
        return prompt // The prompt IS the task instruction (contains hook error)

      case "task_brainstorm":
        return `${outputLine}Collaborate with the user to create a spec-plan hybrid document.\n\n${userPrompt}`

      case "review_task": {
        const specRef = active.taskSpecPath ? absPath(active.taskSpecPath, ws) : "N/A"
        return `${outputLine}Review the task spec-plan at \`${specRef}\`.\n\n${userPrompt}`
      }

      case "fix_task": {
        const reviewRef = active.lastReviewOutputPath ? absPath(active.lastReviewOutputPath, ws) : "N/A"
        const specRef = active.taskSpecPath ? absPath(active.taskSpecPath, ws) : "N/A"
        return `${outputLine}Apply the review findings at \`${reviewRef}\` to the task spec-plan at \`${specRef}\`.`
      }

      case "quick_plan":
        return `${outputLine}Collaborate with the user to create a TDD implementation plan.\n\n${userPrompt}`

      case "review_quick_plan": {
        const planRef = active.planPath ? absPath(active.planPath, ws) : "N/A"
        return `${outputLine}Review the plan at \`${planRef}\`.\n\n${userPrompt}`
      }

      case "fix_quick_plan": {
        const reviewRef = active.lastReviewOutputPath ? absPath(active.lastReviewOutputPath, ws) : "N/A"
        const planRef = active.planPath ? absPath(active.planPath, ws) : "N/A"
        return `${outputLine}Apply the review findings at \`${reviewRef}\` to the plan at \`${planRef}\`.`
      }

      case "plan_gate": {
        const planRef = active.planPath ? absPath(active.planPath, ws) : "N/A"
        return `The reviewed plan is at \`${planRef}\`. Present it to the user and offer [Execute Plan] or [Done]. Pipeline directory: \`${absPath(active.pipelineDir!, ws)}\`.`
      }

      case "bugfix":
        return `${outputLine}Investigate and fix the bug.\n\n${userPrompt}`

      default:
        return userPrompt
    }
  }
}
