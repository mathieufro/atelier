import type { PipelineState, StageData } from "./pipeline-state.js"
import type { AgentEngine, AgentSession } from "@atelier/core/agent-engine"
import type { createEventMerger } from "../engine/event-merger.js"
import type { IdleDetectorStagePolicyOverride } from "./idle-detector-config.js"
import type { BackendId, PipelineType } from "@atelier/core"
import { existsSync, realpathSync } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuestionPermissionProxy {
  replyPermission(sessionId: string, requestId: string, reply: string): Promise<void>
  replyQuestion(sessionId: string, requestId: string, answers: string[][]): Promise<void>
  rejectQuestion(sessionId: string, requestId: string): Promise<void>
}

export interface ActivePipeline {
  id: string
  backendId: BackendId
  sessionMap: Map<string, string> // sessionId → stageId
  stageSessionMap: Map<string, string> // stage → sessionId
  model?: { providerID: string; modelID: string }
  variant?: string
  pipelineDir?: string // workspace-relative path, e.g. ".atelier/pipelines/2026-02-28-todo-app"
  brainstormCompiledPromptPath?: string
  planCompiledPromptPath?: string
  e2ePlanCompiledPromptPath?: string
  roadmapBrainstormCompiledPromptPath?: string
  specPath?: string
  planPath?: string
  e2ePlanPath?: string
  roadmapPath?: string
  currentStage?: string
  currentStageId?: string
  interrupted?: boolean
  topologyIndex: number
  pipelineType: PipelineType
  lastReviewOutputPath?: string
  /** Plan gate: true after the agent signals action: "implement", awaiting stage_complete */
  planGateImplementing?: boolean
  /** Task pipeline: path to the task-spec hybrid document */
  taskSpecPath?: string
  /** Task pipeline: path to the compiled prompt for task_brainstorm */
  taskBrainstormCompiledPromptPath?: string
  detectorConfig?: Partial<IdleDetectorStagePolicyOverride>
  /** Stage retry state: stage name → retry count (for transient API error retries) */
  stageRetryCount?: Map<string, number>
  /** Active backoff timer handle (for abort cancellation) */
  stageRetryTimer?: ReturnType<typeof setTimeout>
  workspacePath: string
  worktreePath?: string
  worktreeChoice?: "in-tree" | "worktree"
  /** Pipeline completed but session kept alive for continued user interaction */
  completed?: boolean
  /** Fully autonomous mode — responder agent handles interactive stage questions */
  autonomous?: boolean
  /** Responder session ID for the current interactive stage */
  responderSessionId?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STAGE_TITLES: Record<string, string> = {
  compile_brainstorm: "⚙ Compile brainstorm",
  brainstorm: "💬 Brainstorm",
  review_spec: "🔍 Review Spec",
  fix_spec: "🔧 Fix Spec",
  establish_conventions: "📐 Establish Conventions",
  compile_plan: "⚙ Compile plan",
  write_plan: "📋 Write Plan",
  review_plan: "🔍 Review Plan",
  fix_plan: "🔧 Fix Plan",
  implement: "🔨 Implement",
  review_code: "🔍 Review Code",
  fix_code: "🔧 Fix Code",
  fix_hooks: "🔧 Fix Hooks",
  simplify: "✨ Simplify",
  e2e_gate: "🚦 E2E Gate",
  compile_e2e_plan: "⚙ Compile E2E plan",
  write_e2e_plan: "📋 Write E2E Plan",
  review_e2e_plan: "🔍 Review E2E Plan",
  fix_e2e_plan: "🔧 Fix E2E Plan",
  e2e: "🧪 E2E Tests",
  classify: "🏷 Classify",
  compile_roadmap_brainstorm: "⚙ Compile roadmap brainstorm",
  brainstorm_roadmap: "💬 Brainstorm Roadmap",
  review_roadmap: "🔍 Review Roadmap",
  fix_roadmap: "🔧 Fix Roadmap",
  validate: "✅ Validate",
  compile_task_brainstorm: "⚙ Compile task brainstorm",
  task_brainstorm: "💬 Task Brainstorm",
  review_task: "🔍 Review Task Plan",
  fix_task: "🔧 Fix Task Plan",
  quick_plan: "📋 Quick Plan",
  review_quick_plan: "🔍 Review Plan",
  fix_quick_plan: "🔧 Fix Plan",
  plan_gate: "🚪 Plan Gate",
  bugfix: "🔧 Bugfix",
}

export const COMPILED_STAGES = new Set(["brainstorm", "write_plan", "write_e2e_plan", "brainstorm_roadmap", "task_brainstorm"])

export const SIGNAL_INSTRUCTION = `Call the atelier_signal tool with type "stage_complete" and the path to your output artifact. For review stages, include a verdict ("done", "has_issues", or "stuck"). Do not wait — signal now.`

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

// Fixer stages restart from their parent review stage
const FIXER_TO_REVIEW: Record<string, string> = {
  fix_spec: "review_spec",
  fix_plan: "review_plan",
  fix_code: "review_code",
  fix_e2e_plan: "review_e2e_plan",
  fix_roadmap: "review_roadmap",
  fix_task: "review_task",
  fix_quick_plan: "review_quick_plan",
}

/** Compute the actual start stage: compiled stages need their compile step re-run, fixer stages restart from their parent review. */
const COMPILED_TO_COMPILE: Record<string, string> = {
  brainstorm: "compile_brainstorm",
  write_plan: "compile_plan",
  write_e2e_plan: "compile_e2e_plan",
  brainstorm_roadmap: "compile_roadmap_brainstorm",
  task_brainstorm: "compile_task_brainstorm",
}

export function resolveStartStage(fromStage?: string): string {
  if (!fromStage) return "compile_brainstorm"
  if (FIXER_TO_REVIEW[fromStage]) return FIXER_TO_REVIEW[fromStage]
  if (!COMPILED_STAGES.has(fromStage)) return fromStage
  return COMPILED_TO_COMPILE[fromStage] ?? fromStage
}

/** Extract topic slug from pipeline dir name (e.g. "2026-03-10-weather-dashboard-3266" → "weather-dashboard") */
export function extractTopicSlug(pipelineDir: string): string {
  const dirName = path.basename(pipelineDir)
  // Format: YYYY-MM-DD-<slug>-<suffix> — must start with date prefix
  if (!/^\d{4}-\d{2}-\d{2}-/.test(dirName)) return dirName
  const withoutDate = dirName.slice(11) // "weather-dashboard-3266"
  const withoutSuffix = withoutDate.replace(/-[a-z0-9]{4}$/, "") // "weather-dashboard"
  return withoutSuffix || dirName
}

/** Validate that a path resolves within the workspace, rejecting symlink/junction escapes. */
export function validateWithinWorkspace(relativePath: string, workspacePath: string, label = "Output path"): void {
  let realWorkspace: string
  try { realWorkspace = realpathSync(workspacePath) } catch { realWorkspace = path.resolve(workspacePath) }
  const absolute = path.isAbsolute(relativePath)
    ? path.resolve(relativePath)
    : path.resolve(realWorkspace, relativePath)

  let probe = absolute
  const missingSegments: string[] = []
  while (!existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    missingSegments.unshift(path.basename(probe))
    probe = parent
  }

  let resolved = absolute
  try {
    const realProbe = realpathSync(probe)
    resolved = missingSegments.length > 0
      ? path.join(realProbe, ...missingSegments)
      : realProbe
  } catch {
    resolved = absolute
  }

  if (!resolved.startsWith(realWorkspace + path.sep) && resolved !== realWorkspace) {
    throw new Error(`${label} must be within workspace`)
  }
}

/** Resolve a path to absolute, handling both relative and already-absolute paths. */
export function absPath(p: string, workspacePath: string): string {
  return path.isAbsolute(p) ? p : path.join(workspacePath, p)
}

/** Read a compiled prompt file, resolving relative paths against the workspace.
 *  Throws on file-read failure so callers can surface the error instead of
 *  silently running a stage without its compiled prompt. */
export async function readCompiledPrompt(compiledPromptPath: string | undefined, workspacePath: string): Promise<string | undefined> {
  if (!compiledPromptPath) return undefined
  const abs = path.isAbsolute(compiledPromptPath)
    ? compiledPromptPath
    : path.resolve(workspacePath, compiledPromptPath)
  return fs.readFile(abs, "utf-8")
}

/** Look up a stage by ID and return it only if status is "running" or "stuck" (stuck stages accept revised verdicts). */
export function findSignalableStage(ps: PipelineState, pipelineId: string, stageId: string): StageData | null {
  const detail = ps.getPipeline(pipelineId)
  const stage = detail?.stages.find((s) => s.id === stageId)
  if (!stage || (stage.status !== "running" && stage.status !== "stuck")) return null
  return stage
}


/** Create an engine session with full workspace permissions and register it as internal. */
export async function createInternalSession(
  engine: AgentEngine,
  workspacePath: string,
  eventMerger: ReturnType<typeof createEventMerger>,
  extras?: { parentID?: string; model?: { providerID: string; modelID: string }; variant?: string; title?: string; responderPipelineId?: string },
): Promise<AgentSession> {
  eventMerger.beginInternalCreation()
  const session = await engine.createSession({
    directory: workspacePath,
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
    parentID: extras?.parentID,
    title: extras?.title,
    model: extras?.model,
    variant: extras?.variant,
    responderPipelineId: extras?.responderPipelineId,
  })
  eventMerger.completeInternalCreation(session.id)
  return session
}
