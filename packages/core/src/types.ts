import type {
  Session,
  Message,
  Part,
  Event,
  SessionStatus,
  AgentConfig,
  PermissionRequest,
  QuestionRequest,
  Model,
  PermissionRuleset,
} from "@opencode-ai/sdk/v2"
import type { AtelierEvent } from "./atelier-events.js"

export type {
  Session,
  Message,
  Part,
  Event,
  SessionStatus,
  AgentConfig,
  PermissionRequest,
  QuestionRequest,
  Model,
  PermissionRuleset,
}

export type {
  TextPart,
  ReasoningPart,
  ToolPart,
  SubtaskPart,
  FilePart,
  StepFinishPart,
  AgentPart,
  RetryPart,
  CompactionPart,
  ToolState,
  ToolStatePending,
  ToolStateRunning,
  ToolStateCompleted,
  ToolStateError,
  UserMessage,
  AssistantMessage,
} from "@opencode-ai/sdk/v2"

// --- Atelier-specific types ---

/** Extended session status type — adds Atelier-specific states to the OpenCode SDK's SessionStatus. */
export type AtelierSessionStatus =
  | SessionStatus
  | { type: "stalled"; reason?: string }

export type Mode = "build" | "plan" | "feature" | "bugfix"

/** Reusable model reference shape used across pipeline events, messages, and webview protocol. */
export interface ModelRef {
  providerID: string
  modelID: string
}

/** Unified attachment type for file attachments across the webview and agent-engine protocols. */
export interface Attachment {
  mime: string
  url: string
  filename?: string
}

/** Parameters for sending a prompt — used by the UI for type-safe attachment handling. */
export interface PromptParams {
  content: string
  model?: ModelRef
  variant?: string
  attachments?: Attachment[]
}

// --- Pipeline types ---

export type PipelineStage =
  | "compile_brainstorm"
  | "brainstorm"
  | "review_spec"
  | "fix_spec"
  | "establish_conventions"
  | "compile_plan"
  | "write_plan"
  | "review_plan"
  | "fix_plan"
  | "implement"
  | "review_code"
  | "fix_code"
  | "fix_hooks"
  | "simplify"
  | "e2e_gate"
  | "bugfix"
  | "compile_e2e_plan"
  | "write_e2e_plan"
  | "review_e2e_plan"
  | "fix_e2e_plan"
  | "e2e"
  | "classify"
  | "compile_roadmap_brainstorm"
  | "brainstorm_roadmap"
  | "review_roadmap"
  | "fix_roadmap"
  | "validate"
  // Phase 7: Task pipeline
  | "compile_task_brainstorm"
  | "task_brainstorm"
  | "review_task"
  | "fix_task"
  // Phase 7: Plan pipeline
  | "quick_plan"
  | "review_quick_plan"
  | "fix_quick_plan"
  | "plan_gate"

export type PipelineType = "task" | "feature" | "epic" | "bugfix" | "plan"

export type PipelineStatus = "running" | "completed" | "idle" | "stuck"
export type StageStatus = "running" | "completed" | "skipped" | "stuck" | "idle"

export type PipelineEvent =
  | { type: "stage_started"; pipelineId: string; stageId: string; stage: PipelineStage; sessionId?: string; model?: ModelRef; variant?: string }
  | { type: "stage_completed"; pipelineId: string; stageId: string; outputPath?: string; stageName?: string }
  | { type: "stage_interrupted"; pipelineId: string; stageId: string; sessionId: string }
  | { type: "stage_resumed"; pipelineId: string; stageId: string; sessionId: string }
  | { type: "pipeline_completed"; pipelineId: string; gitBranch?: string; commitCount?: number }
  | { type: "stuck_escalation"; pipelineId: string; stageId: string; stage: PipelineStage; sessionId: string; reviewOutputPath?: string }
  | { type: "fix_stage_inserted"; pipelineId: string; stageId: string; fixStage: PipelineStage; parentReviewStageId: string }
  | { type: "pipeline_title_updated"; pipelineId: string; title: string }
  | { type: "git_branch_created"; pipelineId: string; branch: string; baseBranch: string; baseCommit: string }
  | { type: "git_committed"; pipelineId: string; stageId: string; stage: string; sha: string; message: string }
  | { type: "git_hook_failed"; pipelineId: string; stageId: string; stage: string; error: string }
  | { type: "worktree_created"; pipelineId: string; worktreePath: string; branch: string }
  | { type: "stageModels.confirmed"; pipelineId: string; stageModels: Record<string, StageModelConfig> }
  | { type: "stageModels.updated"; pipelineId: string; stageModels: Record<string, StageModelConfig> }
  | { type: "pipeline.type_determined"; pipelineId: string; pipelineType: string }
  | { type: "presets.state"; pipelineType: string; presets: PresetRecord[] }

/** Connection/infrastructure events — NOT pipeline lifecycle events. */
export type ConnectionEvent =
  | { type: "connection_lost" }
  | { type: "connection_restored" }
  | { type: "full_refresh_required" }

/** Events emitted by the server that are not pipeline or connection lifecycle events. */
export type ServerEvent =
  | { type: "send_error"; sessionId: string; error: string }
  | { type: "skill.used"; sessionId: string; skillName: string }
  | { type: "question.asked"; properties: QuestionRequest }
  | { type: "permission.asked"; properties: PermissionRequest }
  | { type: "favorites.updated"; favorites: FavoriteRecord[] }
  | { type: "config.updated" }

/**
 * OpenCode events forwarded through the event-merger.
 * Uses the SDK's typed Event union for events the SDK defines, plus custom
 * event types emitted by OpenCode that aren't (yet) in the SDK.
 */
export type OpenCodeForwardedEvent =
  | Event
  | { type: "session.busy"; properties: { sessionID: string } }
  | { type: "session.interrupted"; properties: { sessionID: string } }
  | { type: "session.stalled"; properties: { sessionID: string; reason: string; silentForMs: number } }
  | { type: "message.created"; properties: Record<string, unknown> }
  | { type: "message.completed"; properties: Record<string, unknown> }
  | { type: "message.part.created"; properties: Record<string, unknown> }
  | { type: "message.usage"; properties: Record<string, unknown> }

/** Adds the monotonic sequence number present on all SSE-streamed events. */
type WithSeq<T> = T & { seq: number }

/**
 * Event from the unified /events SSE stream. Dispatched by type alone.
 *
 * Includes pipeline events, connection events, server-emitted events,
 * and forwarded OpenCode SDK events with their original dotted-name types.
 */
export type UnifiedEvent = WithSeq<
  PipelineEvent | ConnectionEvent | ServerEvent | AtelierEvent | OpenCodeForwardedEvent
>

export interface PipelineSummary {
  id: string
  prompt: string
  title?: string
  status: PipelineStatus
  currentStage: PipelineStage | null
  createdAt: number
  updatedAt: number
  type?: string
  completionOutcome?: string
}

export interface StageDetail {
  id: string
  stage: PipelineStage
  sessionId?: string
  status: StageStatus
  /** Only meaningful when `status === "running"` — indicates the stage's session was interrupted. */
  interrupted?: boolean
  compiledPromptPath?: string
  outputPath?: string
  error?: string
  startedAt: number
  completedAt?: number
}

export interface PipelineDetail extends PipelineSummary {
  fromPipelineId?: string
  fromStage?: PipelineStage
  pipelineDir?: string
  completedAt?: number
  error?: string
  model?: ModelRef
  variant?: string
  stages: StageDetail[]
  stageModels?: Record<string, StageModelConfig>
  stageModelsConfirmed?: boolean
}

export type ConnectionState = "connected" | "reconnecting" | "disconnected"

export interface FavoritePair {
  providerID: string
  modelID: string
  variant?: string
}

export interface FavoriteRecord extends FavoritePair {
  favoriteKey: string
}

export interface StageModelConfig {
  providerID: string
  modelID: string
  variant?: string
}

export interface PresetRecord {
  id: string
  name: string
  pipelineType: string
  stageModels: Record<string, StageModelConfig>
  createdAt: number
}

/** Skill metadata for slash-command autocomplete and catalog display. */
export interface SkillInfo {
  name: string
  description: string
  stage: string
}

/** Sentinel value used as the variant component in favorite keys when no variant is selected. */
export const FAVORITE_NO_VARIANT = "__none__"

export function favoriteKeyOf(pair: FavoritePair): string {
  return `${pair.providerID}::${pair.modelID}::${pair.variant ?? FAVORITE_NO_VARIANT}`
}

/** Messages bundled with their parts for session loading */
export interface MessageWithParts {
  message: Message
  parts: Part[]
}

/**
 * Runtime validation for message data arriving from backends.
 * Filters out malformed entries (e.g. from sessions that predate a schema change)
 * and ensures every entry has the minimum shape the UI requires.
 */
export function sanitizeMessages(raw: unknown[]): MessageWithParts[] {
  const valid: MessageWithParts[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const msg = rec.message
    if (!msg || typeof msg !== "object") continue
    const m = msg as Record<string, unknown>
    // Minimum required fields: id, sessionID, role
    if (typeof m.id !== "string" || !m.id) continue
    if (typeof m.sessionID !== "string") continue
    if (typeof m.role !== "string") continue
    valid.push({
      message: msg as Message,
      parts: Array.isArray(rec.parts) ? (rec.parts as Part[]) : [],
    })
  }
  return valid
}

// Agent entries include their name (the config key)
export interface AgentEntry {
  name: string
  config: AgentConfig
}

// --- Typed tool input interfaces ---
// These are consumed by the UI package (@atelier/ui) for typed tool rendering.

export interface BashToolInput {
  command: string
  description?: string
}

export interface EditToolInput {
  filePath: string
  oldString?: string
  newString?: string
}

export interface WriteToolInput {
  filePath: string
  content: string
}

export interface WebFetchToolInput {
  url: string
}

export interface TodoToolInput {
  todos?: Array<{ content: string; status: string; activeForm?: string }>
}


// --- Allowed delta fields for safe concatenation ---
// Consumed by the UI package (@atelier/ui) for incremental part updates.

export const ALLOWED_DELTA_FIELDS = new Set(["text", "output", "reasoning"])

// --- postMessage protocol ---

export type ErrorCode =
  | "BRIDGE_ERROR"
  | "PROVIDER_AUTH"
  | "CONTEXT_OVERFLOW"
  | "ABORTED"
  | "CONNECTION_LOST"
  | "PIPELINE_LOAD_FAILED"

export type WebviewMessage =
  | { type: "sendMessage"; content: string; mode: Mode; sessionId?: string; pipelineId?: string; attachments?: Attachment[]; model?: ModelRef; variant?: string; sourceSessionId?: string; _rpcId?: string }
  | { type: "createSession"; _rpcId?: string }
  | { type: "switchSession"; sessionId: string; _rpcId?: string }
  | { type: "loadOlderMessages"; sessionId: string; before: number; limit?: number; _rpcId?: string }
  | { type: "loadNewerMessages"; sessionId: string; after: number; limit?: number; _rpcId?: string }
  | { type: "deleteSession"; sessionId: string; _rpcId?: string }
  | { type: "abortSession"; sessionId: string; _rpcId?: string }
  | { type: "resumeSession"; sessionId: string; _rpcId?: string }
  | { type: "permissionReply"; sessionId: string; requestId: string; reply: "once" | "always" | "reject"; _rpcId?: string }
  | { type: "questionReply"; sessionId: string; requestId: string; answers: string[][]; _rpcId?: string }
  | { type: "questionReject"; sessionId: string; requestId: string; _rpcId?: string }
  | { type: "openFile"; path: string; line?: number; _rpcId?: string }
  | { type: "openContent"; content: string; language?: string; title?: string; _rpcId?: string }
  | { type: "requestFiles"; query: string; _rpcId?: string }
  | { type: "insertActiveFile"; _rpcId?: string }
  | { type: "restartPipeline"; fromPipeline: string; fromStage: string; _rpcId?: string }
  | { type: "loadPipeline"; pipelineId: string; _rpcId?: string }
  | { type: "favorites.upsert"; favorite: FavoritePair; _rpcId?: string }
  | { type: "favorites.remove"; favoriteKey: string; _rpcId?: string }
  | { type: "favorites.reorder"; favoriteKeys: string[]; _rpcId?: string }
  | { type: "invokeSkill"; skillName: string; content: string; sessionId?: string; attachments?: Attachment[]; model?: ModelRef; variant?: string; _rpcId?: string }
  | { type: "requestSkills"; _rpcId?: string }
  | { type: "ready"; _rpcId?: string }
  | { type: "refreshConfig"; _rpcId?: string }
  | { type: "copyToClipboard"; text: string; _rpcId?: string }
  | { type: "startRalphLoop"; promptPath: string; maxIterations?: number; completionPromise?: string; model?: ModelRef; variant?: string; _rpcId?: string }
  | { type: "cancelRalphLoop"; sessionId: string; _rpcId?: string }
  | { type: "forkStageSession"; sessionId: string; _rpcId?: string }
  | { type: "stageModels.confirm"; pipelineId: string; stageModels: Record<string, StageModelConfig>; _rpcId?: string }
  | { type: "stageModels.update"; pipelineId: string; stage?: string; config?: StageModelConfig; stageModels?: Record<string, StageModelConfig>; _rpcId?: string }
  | { type: "presets.list"; pipelineType: string; _rpcId?: string }
  | { type: "presets.save"; pipelineType: string; name: string; stageModels: Record<string, StageModelConfig>; _rpcId?: string }
  | { type: "presets.delete"; presetId: string; _rpcId?: string }

export type HostMessage =
  | { type: "event"; event: UnifiedEvent }
  | { type: "sessions"; sessions: Session[] }
  | {
    type: "messages"
    messages: MessageWithParts[]
    sessionId: string
    start: number
    end: number
    total: number
    direction: "replace" | "prepend" | "append"
  }
  | { type: "config"; agents: AgentEntry[]; models: Model[]; workspacePath: string; variant?: string; favorites?: FavoriteRecord[] }
  | { type: "activeSession"; sessionId: string }
  | { type: "modeChanged"; mode: Mode }
  | { type: "fileResults"; files: Array<{ path: string; name: string }> }
  | { type: "activeFileInserted"; path: string; startLine?: number; endLine?: number }
  | { type: "pipelines"; pipelines: PipelineSummary[] }
  | { type: "pipeline"; pipeline: PipelineDetail }
  | { type: "favorites.state"; favorites: FavoriteRecord[] }
  | { type: "skills"; skills: SkillInfo[] }
  | { type: "favorites.command.upsertCurrent" }
  | { type: "error"; code: ErrorCode; message: string }
  | { type: "connectionState"; state: ConnectionState }
  | { type: "activeFileContext"; path: string; relativePath: string; startLine?: number; endLine?: number }
  | { type: "activeFileContext"; path: null }
  | { type: "_rpc"; _rpcId: string; [key: string]: unknown }
  | { type: "stageModels.confirmed"; pipelineId: string; stageModels: Record<string, StageModelConfig> }
  | { type: "stageModels.updated"; pipelineId: string; stageModels: Record<string, StageModelConfig> }
  | { type: "presets.state"; pipelineType: string; presets: PresetRecord[] }
  | { type: "pipeline.type_determined"; pipelineId: string; pipelineType: string }

export type ActiveFileContext = {
  path: string
  relativePath: string
  startLine?: number
  endLine?: number
} | null
