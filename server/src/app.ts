import { Hono } from "hono"
import type { Context } from "hono"
import type { createEventMerger } from "./engine/event-merger.js"
import type { RalphLoopController } from "./ralph-loop-controller.js"
import { modeToPermissionRuleset, sanitizeMessages, type PermissionRuleset } from "@atelier/core"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Attachment, BackendId, LogEvent, Mode, ModelRef, PipelineType, SkillInfo, Logger, StageModelConfig } from "@atelier/core"
import { loadSkillCatalog, loadSkill } from "./orchestration/skill-loader.js"
import { readSettings, writeSettings } from "@atelier/core/settings"
import { atelierStateDir } from "@atelier/core/state-dir"
import type { FavoritesStore } from "./engine/favorites-store.js"
import type { PresetStore } from "./engine/preset-store.js"
import type { BackendProxy } from "./engine/backend-proxy.js"
import type { BackendRegistry } from "./engine/backend-registry.js"
import type { SessionMetadataStore } from "./engine/session-metadata-store.js"
import type { PipelineState, StageData } from "./orchestration/pipeline-state.js"
import { generateSessionTitle } from "./infra/task-slug.js"
import { validateWithinWorkspace } from "./orchestration/helpers.js"

export interface OpenCodeProxy extends BackendProxy {
  createSession(permission?: PermissionRuleset): Promise<{ id: string }>
}

export interface OrchestratorInterface {
  hasActivePipeline(): boolean
  hasPipeline(pipelineId: string): boolean
  getActiveStageName(pipelineId: string): string | null
  getActiveStageSessionId(pipelineId: string): string | null
  isStageInterrupted(pipelineId: string): boolean
  isStageInterruptedForSession(sessionId: string): boolean
  isSessionOwnedByPipeline(sessionId: string): boolean
  findPipelineIdBySession(sessionId: string): string | null
  startPipelineAsync(prompt: string, opts?: { type?: PipelineType; fromPipelineId?: string; fromStage?: string; model?: ModelRef; variant?: string; sourceSessionId?: string; autonomous?: boolean; pipelineType?: PipelineType; worktreeChoice?: "in-tree" | "worktree" }): { pipelineId: string; completion: Promise<void> }
  abortStageSession(sessionId: string): Promise<void>
  resumeStageSession(sessionId: string): Promise<void>
  clearInterruptAndRoute(sessionId: string, content: string, opts?: { model?: { providerID: string; modelID: string }; variant?: string }): Promise<void>
  routeStageMessage(sessionId: string, content: string, opts?: { attachments?: Attachment[]; model?: { providerID: string; modelID: string }; variant?: string }): Promise<void>
  handleSignal(signal: { type: string; sessionId: string; outputPath?: string; verdict?: string; action?: string; outcome?: string; pipelineType?: string; worktreeChoice?: string }): Promise<void>
  handleStuckRetry(pipelineId: string, stageId: string, action: "fix" | "resume"): Promise<void>
  failPipeline(pipelineId: string, error: string): Promise<void>
  getActivePipelineIds(): string[]
  handleAutoPermission(sessionId: string, requestId: string): Promise<void>
  handleInteractionReplied(sessionId: string, requestId: string): void
  deletePipeline(pipelineId: string): Promise<void>
  rehydrateFromDisk(pipelineId: string): Promise<boolean>
  getSessionsForPipeline(pipelineId: string): Set<string>
  getResponderSession(pipelineId: string): string | undefined
  getPipelineStatus(pipelineId: string): "running" | "completed" | "failed" | "unknown"
  getCurrentStageInfo(pipelineId: string): { stage: string | null; interactive: boolean }
  resumeAfterStageModelsConfirmed(pipelineId: string): Promise<void>
}

export interface AppOptions {
  registry: BackendRegistry
  metadataStore: SessionMetadataStore
  workspacePath: string
  eventMerger: ReturnType<typeof createEventMerger>
  getOrchestrator: () => OrchestratorInterface | null
  getStatus: () => "starting" | "ready" | "error"
  getPipelineState?: () => PipelineState
  favoritesStore?: FavoritesStore
  presetStore?: PresetStore
  /** Path to the skills directory (contains SKILL.md files). */
  skillsDir?: string
  /** Subscribe to log events. Returns unsubscribe function. Called by /log-events SSE endpoint. */
  onLogSubscribe?: (handler: (event: LogEvent) => void, level: string) => () => void
  /** Log callback for message rejection events (409 responses). */
  onMessageRejected?: (reason: string) => void
  /** Called on every HTTP request — used by idle timeout to track activity. */
  onActivity?: () => void
  /** Graceful shutdown callback. Called by POST /shutdown (Windows graceful shutdown path). */
  onShutdown?: () => Promise<void>
  /** Ralph loop controller — manages iterative agent loops as standalone sessions. */
  ralphController?: RalphLoopController
  logger?: Logger
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ValidationError"
  }
}

export function pickDefaultBackend(registry: BackendRegistry): BackendId {
  const readyBackends = registry.listReadyBackends()
  if (readyBackends.includes("opencode")) return "opencode"
  if (readyBackends.includes("claude-code")) return "claude-code"

  const allBackends = registry.listAllBackendIds()
  if (allBackends.includes("opencode")) return "opencode"
  if (allBackends.includes("claude-code")) return "claude-code"

  throw new Error("No backend is available")
}

const VALID_MODES = new Set(["feature", "build", "plan", "bugfix"])
const VALID_SIGNAL_TYPES = new Set(["stage_complete"])
const VALID_VERDICTS = new Set(["done", "has_issues", "stuck", "proceed", "skip"])
const VALID_PIPELINE_TYPES = new Set(["task", "feature", "epic", "bugfix"])
const VALID_WORKTREE_CHOICES = new Set(["in-tree", "worktree"])
const VALID_ACTIONS = new Set(["implement", "done"])
const VALID_OUTCOMES = new Set(["fixed", "fixed_unverified", "inconclusive"])

async function parseJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    return await c.req.json() as Record<string, unknown>
  } catch {
    throw new ValidationError("Malformed JSON in request body")
  }
}

function validateString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${name} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function optionalVariant(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") {
    throw new ValidationError("variant must be a string when provided")
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function optionalIntParam(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value)) throw new ValidationError(`${name} must be a non-negative integer`)
  return Number.parseInt(value, 10)
}

/**
 * Wraps an async OpenCode proxy call, returning 502 on failure.
 * Reduces the repeated try/catch pattern
 * across all proxy endpoints to a single-line call.
 */
async function proxyCall<T>(c: Context, fn: () => Promise<T>): Promise<Response> {
  try {
    const result = await fn()
    return c.json(result)
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502)
  }
}

/**
 * Strips null-valued fields from an object so they are omitted from JSON serialization.
 * Needed because pipeline-state stores nullable fields (e.g. `error: null`) that the
 * REST API should omit rather than expose as explicit nulls to the frontend.
 */
function stripNulls<T extends Record<string, unknown>>(obj: T): T {
  const result = { ...obj }
  for (const key in result) {
    if (result[key] === null) {
      delete result[key]
    }
  }
  return result
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono()
  const { registry, metadataStore, workspacePath, eventMerger: merger, getOrchestrator, getStatus, favoritesStore, ralphController } = options
  const log = options.logger?.child({ source: "app" })

  // Track activity for idle timeout — every HTTP request resets the idle clock
  if (options.onActivity) {
    const touch = options.onActivity
    app.use("*", async (c, next) => { touch(); return next() })
  }

  /** Resolve which backend owns a session, falling back to the default available backend when unknown. */
  function resolveSessionBackend(sessionId: string): BackendId {
    // Virtual subagent sessions are always owned by the claude-code backend
    if (sessionId.startsWith("subagent-")) return "claude-code"
    return registry.resolveBackendForSession(sessionId) ?? pickDefaultBackend(registry)
  }

  async function getProxyForSession(sessionId: string): Promise<BackendProxy> {
    return registry.getProxy(resolveSessionBackend(sessionId))
  }

  async function replayPendingInteraction(sessionId: string): Promise<"question" | "permission" | null> {
    const proxy = registry.getProxyIfReady(resolveSessionBackend(sessionId))
    if (!proxy) return null

    const [questions, permissions] = await Promise.all([
      proxy.listPendingQuestions().catch(() => []),
      proxy.listPendingPermissions().catch(() => []),
    ])

    const question = questions.find((item) => item.sessionID === sessionId)
    if (question) {
      merger.emit({ type: "question.asked", properties: question })
      return "question"
    }

    const permission = permissions.find((item) => item.sessionID === sessionId)
    if (permission) {
      merger.emit({ type: "permission.asked", properties: permission })
      return "permission"
    }

    return null
  }

  // Middleware: reject cross-origin requests from unknown origins
  app.use("*", async (c, next) => {
    const origin = c.req.header("Origin")
    if (origin) {
      try {
        const url = new URL(origin)
        if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && !origin.startsWith("vscode-webview://") && !origin.startsWith("vscode-file://")) {
          return c.json({ error: "Forbidden origin" }, 403)
        }
      } catch {
        return c.json({ error: "Invalid origin" }, 403)
      }
    }
    await next()
    if (!c.res.headers.get("Content-Type")?.includes("text/event-stream")) {
      c.res.headers.set("X-Atelier-Seq", String(merger.currentSeq()))
    }
  })

  app.onError((err, c) => {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400)
    return c.json({ error: "Internal server error" }, 500)
  })

  // --- Health ---
  app.get("/health", (c) => {
    const status = getStatus()
    const backends: Record<string, string> = {}
    for (const id of registry.listReadyBackends()) {
      backends[id] = "ready"
    }
    return c.json({ status, backends })
  })

  // --- Shutdown ---
  app.post("/shutdown", async (c) => {
    if (!options.onShutdown) {
      return c.json({ error: "Shutdown not configured" }, 501)
    }
    // Fire-and-forget — the server may exit before the response is fully sent.
    // We return 200 immediately, then trigger shutdown asynchronously.
    const shutdownPromise = options.onShutdown()
    shutdownPromise.catch(() => {})
    return c.json({ ok: true })
  })

  // --- Proxy endpoints ---
  app.get("/sessions", (c) => {
    const sessions = metadataStore.listRootSessions(workspacePath)
    const pipelineState = options.getPipelineState?.()
    const pipelineSessionIds = pipelineState ? new Set(pipelineState.getAllPipelineSessionIds()) : new Set<string>()
    // Transform SessionMetadata → OpenCode Session-compatible shape for the UI
    const mapped = sessions
      .filter((s) => !pipelineSessionIds.has(s.id))
      .map((meta) => ({
        id: meta.id,
        title: meta.title,
        slug: meta.id,
        projectID: "",
        directory: meta.workspacePath,
        version: "1",
        time: { created: meta.createdAt, updated: meta.lastActiveAt },
        parentID: meta.parentId ?? undefined,
        forkedFrom: meta.forkedFrom,
      }))
    return c.json(mapped)
  })

  app.post("/session", async (c) => {
    let body: Record<string, unknown> = {}
    try { body = await c.req.json() as Record<string, unknown> } catch { /* no body = defaults */ }
    const model = validateModel(body.model)
    const backendId: BackendId = model ? registry.resolveBackend(model) : pickDefaultBackend(registry)
    log?.debug("atelier", "session", "session_create_requested", { data: { backendId, model: model?.modelID } })
    return proxyCall(c, async () => {
      const engine = await registry.getEngine(backendId)
      const session = await engine.createSession({
        directory: workspacePath,
        permission: modeToPermissionRuleset("build"),
      })
      return { id: session.id }
    })
  })

  app.get("/session/:id", async (c) => {
    const id = c.req.param("id")
    return proxyCall(c, async () => {
      const proxy = await getProxyForSession(id)
      const session = await proxy.getSession(id)
      // Merge forkedFrom from metadata store for consistency across backends
      const meta = metadataStore.get(id)
      if (meta?.forkedFrom && !(session as any).forkedFrom) {
        ;(session as any).forkedFrom = meta.forkedFrom
      }
      return session
    })
  })

  app.delete("/session/:id", async (c) => {
    const id = c.req.param("id")
    const orchestrator = getOrchestrator()
    if (orchestrator?.isSessionOwnedByPipeline(id)) {
      return c.json({ error: "Cannot delete pipeline-owned session" }, 409)
    }
    log?.debug("atelier", "session", "session_delete_requested", { sessionId: id })
    return proxyCall(c, async () => {
      const proxy = await getProxyForSession(id)
      await proxy.deleteSession(id)
      return { ok: true }
    })
  })

  app.post("/session/:id/fork", async (c) => {
    const id = c.req.param("id")
    let body: Record<string, unknown> = {}
    try { body = await c.req.json() as Record<string, unknown> } catch { /* no body */ }
    const title = typeof body.title === "string" ? body.title : undefined
    log?.debug("atelier", "session", "session_fork_requested", { sessionId: id, data: { title } })
    return proxyCall(c, async () => {
      const backendId = resolveSessionBackend(id)
      const engine = await registry.getEngine(backendId)
      const forked = await engine.forkSession(id, { title })

      // Emit session.created so all SSE subscribers (webviews, test harnesses) see the fork
      const meta = metadataStore.get(forked.id)
      if (meta) {
        merger.emit({
          type: "session.created",
          properties: {
            info: {
              id: forked.id,
              title: meta.title,
              slug: forked.id,
              projectID: "",
              directory: meta.workspacePath,
              version: "1",
              time: { created: meta.createdAt, updated: meta.lastActiveAt },
            },
          },
        })
      }

      return { id: forked.id }
    })
  })

  app.get("/session/:id/messages", async (c) => {
    const id = c.req.param("id")
    return proxyCall(c, async () => {
      const proxy = await getProxyForSession(id)
      const before = optionalIntParam(c.req.query("before"), "before")
      const after = optionalIntParam(c.req.query("after"), "after")
      const limit = optionalIntParam(c.req.query("limit"), "limit")
      if (before !== undefined && after !== undefined) {
        throw new ValidationError("before and after cannot be used together")
      }
      const page = await proxy.getMessages(id, { before, after, limit })
      const cleaned = sanitizeMessages(page.messages)
      return { ...page, messages: cleaned }
    })
  })

  app.post("/session/:id/abort", async (c) => {
    const id = c.req.param("id")
    const orchestrator = getOrchestrator()
    if (orchestrator?.isSessionOwnedByPipeline(id)) {
      await orchestrator.abortStageSession(id)
      return c.json({ ok: true })
    }
    // Check for active Ralph loop — delegate to controller
    if (ralphController?.hasActiveLoop(id)) {
      await ralphController.cancelLoop(id)
      return c.json({ ok: true })
    }
    return proxyCall(c, async () => {
      const proxy = await getProxyForSession(id)
      await proxy.abortSession(id)
      return { ok: true }
    })
  })

  app.post("/session/:id/resume", async (c) => {
    const id = c.req.param("id")
    const orchestrator = getOrchestrator()
    if (orchestrator?.isSessionOwnedByPipeline(id)) {
      if (!orchestrator.isStageInterruptedForSession(id)) {
        return c.json({ error: "Session is not interrupted" }, 409)
      }
      await orchestrator.resumeStageSession(id)
      return c.json({ ok: true })
    }
    return c.json({ error: "Session not found or not interruptible" }, 404)
  })

  app.post("/session/:id/permission", async (c) => {
    const id = c.req.param("id")
    const body = await parseJson(c)
    const requestId = validateString(body.requestId, "requestId")
    const reply = validateString(body.reply, "reply")
    log?.debug("atelier", "message", "permission_reply_forwarded", { sessionId: id, data: { requestId } })
    return proxyCall(c, async () => {
      const proxy = await getProxyForSession(id)
      await proxy.replyPermission(id, requestId, reply)
      getOrchestrator()?.handleInteractionReplied(id, requestId)
      return { ok: true }
    })
  })

  app.post("/session/:id/question", async (c) => {
    const id = c.req.param("id")
    const body = await parseJson(c)
    const requestId = validateString(body.requestId, "requestId")
    if (!Array.isArray(body.answers) || !body.answers.every((a: unknown) => Array.isArray(a))) {
      throw new ValidationError("answers must be an array of arrays")
    }
    log?.debug("atelier", "message", "question_reply_forwarded", { sessionId: id, data: { requestId } })
    return proxyCall(c, async () => {
      const proxy = await getProxyForSession(id)
      await proxy.replyQuestion(id, requestId, body.answers as string[][])
      getOrchestrator()?.handleInteractionReplied(id, requestId)
      return { ok: true }
    })
  })

  app.post("/session/:id/message", async (c) => {
    const id = c.req.param("id")
    const body = await parseJson(c)
    const content = validateString(body.content, "content")
    const model = validateModel(body.model)
    const variant = optionalVariant(body.variant)
    log?.debug("atelier", "message", "session_message_sent", { sessionId: id })
    const proxy = await getProxyForSession(id)
    proxy.sendMessage(id, { content, model, variant }).catch((err) => {
      merger.emit({ type: "send_error", sessionId: id, error: err instanceof Error ? err.message : "Message delivery failed" })
    })
    return c.json({ ok: true })
  })

  app.post("/session/:id/question/reject", async (c) => {
    const id = c.req.param("id")
    const body = await parseJson(c)
    const requestId = validateString(body.requestId, "requestId")
    return proxyCall(c, async () => {
      const proxy = await getProxyForSession(id)
      await proxy.rejectQuestion(id, requestId)
      getOrchestrator()?.handleInteractionReplied(id, requestId)
      return { ok: true }
    })
  })

  app.get("/config", (c) => proxyCall(c, async () => {
    const allModels: Array<Record<string, unknown>> = []
    let configWorkspacePath = workspacePath
    const configTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
      Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))])
    const allBackends = registry.listAllBackendIds()
    const results = await Promise.allSettled(allBackends.map(async (backendId) => {
      const proxy = await configTimeout(registry.getProxy(backendId), 10_000)
      const config = await configTimeout(proxy.getConfig(), 10_000)
      return { backendId, config }
    }))
    for (const result of results) {
      if (result.status === "fulfilled") {
        const { backendId, config } = result.value
        for (const m of config.models) allModels.push({ ...m, backend: backendId })
        configWorkspacePath = config.workspacePath
      }
    }
    // When Claude Code is available, claim all anthropic models under its banner
    const hasClaudeCode = allBackends.includes("claude-code")
    if (hasClaudeCode) {
      for (const model of allModels) {
        if (model.providerID === "anthropic") model.backend = "claude-code"
      }
    }
    // Deduplicate by providerID:modelID (e.g. SDK aliases overlap with full IDs won't collide,
    // but guards against any true duplicates from multiple backends)
    const seen = new Map<string, Record<string, unknown>>()
    for (const model of allModels) {
      const key = `${model.providerID}:${model.id}`
      if (!seen.has(key)) seen.set(key, model)
    }
    const dedupedModels = [...seen.values()]
    const favorites = favoritesStore ? await favoritesStore.listFavorites() : []
    log?.debug("atelier", "server", "config_models_aggregated", { data: { backendCount: allBackends.length, modelCount: dedupedModels.length } })
    return { models: dedupedModels, workspacePath: configWorkspacePath, favorites }
  }))

  // --- Settings ---

  app.get("/settings", (c) => {
    const settings = readSettings(atelierStateDir(workspacePath))
    return c.json(settings)
  })

  app.patch("/settings", async (c) => {
    const body = await parseJson(c)
    const current = readSettings(atelierStateDir(workspacePath))
    if (typeof body.gitEnabled === "boolean") current.gitEnabled = body.gitEnabled
    if ("serverPort" in body) {
      current.serverPort = body.serverPort === null ? null
        : typeof body.serverPort === "number" ? body.serverPort
        : current.serverPort
    }
    writeSettings(atelierStateDir(workspacePath), current)
    return c.json(current)
  })

  // --- Skill catalog & invocation ---
  let skillCatalogCache: { skills: SkillInfo[]; ts: number } | null = null
  const SKILL_CACHE_TTL_MS = 30_000

  app.get("/skills", async (c) => {
    if (!options.skillsDir) return c.json([])
    const now = Date.now()
    if (skillCatalogCache && now - skillCatalogCache.ts < SKILL_CACHE_TTL_MS) {
      return c.json(skillCatalogCache.skills)
    }
    const skills = await loadSkillCatalog(options.skillsDir)
    skillCatalogCache = { skills, ts: now }
    return c.json(skills)
  })

  app.post("/skill", async (c) => {
    if (!options.skillsDir) return c.json({ error: "Skills not configured" }, 503)
    const body = await parseJson(c)
    const skillName = validateString(body.skillName, "skillName")
    const content = validateString(body.content, "content")
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined
    const model = validateModel(body.model)
    const variant = optionalVariant(body.variant)
    const attachments = validateAttachments(body.attachments)
    await validateModelAndVariant(registry, model, variant)

    let skillContent: string
    try {
      skillContent = await loadSkill(skillName, options.skillsDir)
    } catch {
      throw new ValidationError(`Unknown skill '${skillName}'`)
    }

    const permission = modeToPermissionRuleset("build")
    return proxyCall(c, async () => {
      let targetSessionId: string
      let backendId: BackendId
      let isNewSession = !sessionId

      if (sessionId) {
        const sessionBackend = resolveSessionBackend(sessionId)
        const modelBackend = model ? registry.resolveBackend(model) : sessionBackend
        if (modelBackend !== sessionBackend) {
          backendId = modelBackend
          const engine = await registry.getEngine(backendId)
          const session = await engine.createSession({ directory: workspacePath, permission, model, variant })
          targetSessionId = session.id
          isNewSession = true
        } else {
          targetSessionId = sessionId
          backendId = sessionBackend
        }
      } else {
        backendId = model ? registry.resolveBackend(model) : pickDefaultBackend(registry)
        const engine = await registry.getEngine(backendId)
        const session = await engine.createSession({ directory: workspacePath, permission, model, variant })
        targetSessionId = session.id
      }

      // For any new session (brand new or backend-mismatch), set title and emit session.updated
      if (isNewSession) {
        const title = generateSessionTitle(content)
        const titleProxy = await registry.getProxy(backendId)
        titleProxy.updateSessionTitle(targetSessionId, title).catch(() => {})
        merger.emit({
          type: "session.updated",
          properties: {
            info: {
              id: targetSessionId,
              title,
              slug: targetSessionId,
              projectID: "",
              directory: workspacePath,
              version: "1",
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        })
      }

      const proxy = await registry.getProxy(backendId)
      // Claude Code: deliver as slash command (native skill routing).
      // OpenCode: prepend skill to message content (system param is unreliable).
      const skillRoutedContent = backendId === "claude-code"
        ? `/${skillName}\n${content}`
        : `${skillContent}\n\n---\n\n${content}`
      const skillRoutedSystem = undefined
      // Persist skill name in session metadata so it survives reloads
      metadataStore.update(targetSessionId, { skillName })
      // Emit skill.used so the UI can tag the user message with a badge
      merger.emit({ type: "skill.used", sessionId: targetSessionId, skillName })
      log?.debug("atelier", "message", "skill_routing_decided", { data: { skillName, sessionId: targetSessionId, backendId, isNewSession, delivery: backendId === "claude-code" ? "slash_command" : "content_prepend" } })
      // Fire-and-forget: prompt streams via SSE
      proxy.sendMessage(targetSessionId, { content: skillRoutedContent, system: skillRoutedSystem, attachments, model, variant }).catch((err) => {
        log?.error("atelier", "message", "skill_send_failed", { sessionId: targetSessionId, error: String(err) })
        merger.emit({ type: "send_error", sessionId: targetSessionId, error: err instanceof Error ? err.message : "Message delivery failed" })
      })
      return isNewSession ? { sessionId: targetSessionId } : { ok: true, sessionId: targetSessionId }
    })
  })

  app.put("/favorites", async (c) => {
    if (!favoritesStore) return c.json({ error: "Favorites not configured" }, 503)
    const body = await parseJson(c)
    const providerID = validateString(body.providerID, "providerID")
    const modelID = validateString(body.modelID, "modelID")
    const variant = optionalVariant(body.variant)
    return proxyCall(c, async () => {
      const favorites = await favoritesStore.upsertFavorite({ providerID, modelID, variant })
      merger.emit({ type: "favorites.updated", favorites })
      return { favorites }
    })
  })

  app.delete("/favorites/:favoriteKey", async (c) => {
    if (!favoritesStore) return c.json({ error: "Favorites not configured" }, 503)
    return proxyCall(c, async () => {
      const favorites = await favoritesStore.removeFavorite(c.req.param("favoriteKey"))
      merger.emit({ type: "favorites.updated", favorites })
      return { favorites }
    })
  })

  app.post("/favorites/reorder", async (c) => {
    if (!favoritesStore) return c.json({ error: "Favorites not configured" }, 503)
    const body = await parseJson(c)
    if (!Array.isArray(body.favoriteKeys) || body.favoriteKeys.some((value) => typeof value !== "string")) {
      throw new ValidationError("favoriteKeys must be an array of strings")
    }

    const keys = body.favoriteKeys as string[]
    if (new Set(keys).size !== keys.length) {
      throw new ValidationError("favoriteKeys must not contain duplicates")
    }

    const current = await favoritesStore.listFavorites()
    const currentKeys = new Set(current.map((favorite) => favorite.favoriteKey))
    if (keys.length !== current.length || keys.some((key) => !currentKeys.has(key))) {
      throw new ValidationError("favoriteKeys must include each known favorite exactly once")
    }

    return proxyCall(c, async () => {
      const favorites = await favoritesStore.reorderFavorites(keys)
      merger.emit({ type: "favorites.updated", favorites })
      return { favorites }
    })
  })

  // --- Preset routes ---
  app.get("/presets/:pipelineType", async (c) => {
    if (!options.presetStore) return c.json({ error: "Presets not configured" }, 503)
    const pipelineType = c.req.param("pipelineType")
    const presets = await options.presetStore.listPresets(pipelineType)
    return c.json(presets)
  })

  app.post("/presets/:pipelineType", async (c) => {
    if (!options.presetStore) return c.json({ error: "Presets not configured" }, 503)
    const pipelineType = c.req.param("pipelineType")
    const body = await parseJson(c)
    const name = validateString(body.name, "name")
    if (!body.stageModels || typeof body.stageModels !== "object") {
      throw new ValidationError("stageModels must be an object")
    }
    const preset = await options.presetStore.savePreset(
      pipelineType,
      name,
      body.stageModels as Record<string, StageModelConfig>,
    )
    return c.json(preset)
  })

  app.delete("/presets/:presetId", async (c) => {
    if (!options.presetStore) return c.json({ error: "Presets not configured" }, 503)
    const presetId = c.req.param("presetId")
    await options.presetStore.deletePreset(presetId)
    return c.json({ ok: true })
  })

  // --- Stage model routes ---
  app.post("/pipelines/:id/stage-models", async (c) => {
    const pipelineState = options.getPipelineState?.()
    if (!pipelineState) return c.json({ error: "Not available" }, 503)
    const pipelineId = c.req.param("id")
    const pipeline = pipelineState.getPipeline(pipelineId)
    if (!pipeline) return c.json({ error: "Pipeline not found" }, 404)
    
    const body = await parseJson(c)
    if (!body.stageModels || typeof body.stageModels !== "object") {
      throw new ValidationError("stageModels must be an object")
    }
    
    const stageModels = body.stageModels as Record<string, StageModelConfig>
    for (const [stage, config] of Object.entries(stageModels)) {
      pipelineState.setStageModel(pipelineId, stage, config)
    }
    
    const wasConfirmed = pipelineState.isStageModelsConfirmed(pipelineId)

    if (body.confirmed === true) {
      pipelineState.setStageModelConfirmed(pipelineId, true)
    }

    const updated = pipelineState.getPipeline(pipelineId)

    // Emit the correct event: "confirmed" only when the user clicks Confirm,
    // "updated" for individual model changes (so the UI keeps the picker open).
    if (body.confirmed === true) {
      merger.emit({
        type: "stageModels.confirmed",
        pipelineId,
        stageModels: updated!.stageModels,
      })
    } else {
      merger.emit({
        type: "stageModels.updated",
        pipelineId,
        stageModels: updated!.stageModels,
      })
    }

    // Resume pipeline if this is the first confirmation
    if (body.confirmed === true && !wasConfirmed) {
      const orchestrator = getOrchestrator()
      if (orchestrator) {
        orchestrator.resumeAfterStageModelsConfirmed(pipelineId).catch((err) => {
          log?.error("atelier", "pipeline", "resume_after_confirmation_failed", {
            pipelineId,
            error: String(err),
          })
        })
      }
    }
    
    return c.json({ ok: true, stageModels: updated!.stageModels })
  })

  // --- Ralph loop routes ---

  app.post("/ralph-loop", async (c) => {
    try {
      if (!ralphController) return c.json({ error: "Ralph loop controller not available" }, 500)

      const body = await parseJson(c)
      const rawPath = validateString(body.promptPath, "promptPath")
      // Validate path is within workspace to prevent reading arbitrary files
      validateWithinWorkspace(rawPath, workspacePath, "promptPath")
      const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(workspacePath, rawPath)

      // Validate file exists
      try {
        await fs.promises.access(absolutePath, fs.constants.R_OK)
      } catch {
        return c.json({ error: `Prompt file not found or not readable: ${rawPath}` }, 400)
      }

      const maxIterations = typeof body.maxIterations === "number" ? body.maxIterations : 0
      const completionPromise = typeof body.completionPromise === "string" ? body.completionPromise : null
      const model = body.model as ModelRef | undefined
      const variant = optionalString(body.variant)

      // Resolve backend and create session
      const backendId = model ? registry.resolveBackend(model) : "claude-code"
      const engine = await registry.getEngine(backendId)
      const session = await engine.createSession({
        directory: workspacePath,
        permission: modeToPermissionRuleset("build"),
        variant,
      })

      // Set title: "Ralph: <filename without extension>"
      const filename = path.basename(absolutePath, path.extname(absolutePath))
      const title = `Ralph: ${filename}`
      const titleProxy = await registry.getProxy(backendId)
      titleProxy.updateSessionTitle(session.id, title).catch(() => {})

      // Emit session.updated (same pattern as POST /skill and POST /message)
      merger.emit({
        type: "session.updated",
        properties: {
          info: {
            id: session.id,
            title,
            slug: session.id,
            projectID: "",
            directory: workspacePath,
            version: "1",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      })

      // Start the loop (fire-and-forget)
      ralphController.startLoop(engine, session.id, backendId, {
        promptPath: absolutePath,
        maxIterations,
        completionPromise,
        model,
        variant,
      })

      options.onActivity?.()
      return c.json({ sessionId: session.id })
    } catch (err) {
      if (err instanceof ValidationError) return c.json({ error: err.message }, 400)
      throw err
    }
  })

  app.post("/ralph-loop/:sessionId/cancel", async (c) => {
    if (!ralphController) return c.json({ error: "Ralph loop controller not available" }, 500)
    const sessionId = c.req.param("sessionId")
    const result = await ralphController.cancelLoop(sessionId)
    if (!result) return c.json({ error: "No active loop for session" }, 404)
    options.onActivity?.()
    return c.json(result)
  })

  app.get("/ralph-loop", (c) => {
    if (!ralphController) return c.json({ loops: [] })
    return c.json({ loops: ralphController.listLoops() })
  })

  app.get("/ralph-loop/:sessionId", (c) => {
    if (!ralphController) return c.json({ error: "Ralph loop controller not available" }, 500)
    const sessionId = c.req.param("sessionId")
    const loop = ralphController.getLoop(sessionId)
    if (!loop) return c.json({ error: "No loop for session" }, 404)
    return c.json(loop)
  })

  // --- Message routing ---
  app.post("/message", async (c) => {
    const body = await parseJson(c)
    const content = validateString(body.content, "content")
    const mode = validateString(body.mode, "mode")
    if (!VALID_MODES.has(mode)) {
      throw new ValidationError(`mode must be one of: ${[...VALID_MODES].join(", ")}`)
    }
    const sessionId = optionalString(body.sessionId)
    const pipelineId = optionalString(body.pipelineId)
    const variant = optionalVariant(body.variant)

    const sourceSessionId = typeof body.sourceSessionId === "string" ? body.sourceSessionId : undefined
    const autonomous = body.autonomous === true
    // Optional pre-classification: skip classify stage when both are provided
    const reqPipelineType = optionalString(body.pipelineType)
    const reqWorktreeChoice = optionalString(body.worktreeChoice)
    if (reqPipelineType && !VALID_PIPELINE_TYPES.has(reqPipelineType)) {
      throw new ValidationError(`pipelineType must be one of: ${[...VALID_PIPELINE_TYPES].join(", ")}`)
    }
    if (reqWorktreeChoice && reqWorktreeChoice !== "in-tree" && reqWorktreeChoice !== "worktree") {
      throw new ValidationError(`worktreeChoice must be "in-tree" or "worktree"`)
    }
    const skipClassify = reqPipelineType && reqWorktreeChoice
      ? { pipelineType: reqPipelineType as PipelineType, worktreeChoice: reqWorktreeChoice as "in-tree" | "worktree" }
      : undefined
    const model = validateModel(body.model)
    const attachments = validateAttachments(body.attachments)
    try {
      await validateModelAndVariant(registry, model, variant)
    } catch (err) {
      if (err instanceof ValidationError) {
        if (sessionId) {
          merger.emit({ type: "send_error", sessionId, error: err.message })
        } else if ((mode === "feature" || mode === "plan" || mode === "bugfix") && pipelineId) {
          const stageSessionId = getOrchestrator()?.getActiveStageSessionId(pipelineId)
          if (stageSessionId) {
            merger.emit({ type: "send_error", sessionId: stageSessionId, error: err.message })
          }
        }
      }
      throw err
    }

    const orchestrator = getOrchestrator()

    if (mode === "feature") {
      return routePipelineMessage(c, orchestrator, content, attachments, model, variant, pipelineId, "feature", sourceSessionId, autonomous, skipClassify)
    }

    if (mode === "plan") {
      return routePipelineMessage(c, orchestrator, content, attachments, model, variant, pipelineId, "plan", sourceSessionId, autonomous)
    }

    if (mode === "bugfix") {
      return routePipelineMessage(c, orchestrator, content, attachments, model, variant, pipelineId, "bugfix", sourceSessionId, autonomous)
    }

    if (sessionId && orchestrator?.isSessionOwnedByPipeline(sessionId)) {
      return c.json({ error: "Session is managed by a pipeline" }, 400)
    }

    if (sessionId) {
      const pending = await replayPendingInteraction(sessionId)
      if (pending) {
        log?.debug("atelier", "message", "message_rejected_pending_interaction", { sessionId, data: { pendingType: pending } })
        const message = pending === "question"
          ? "Session is waiting for a question reply. Answer the question before sending a new message."
          : "Session is waiting for a permission reply. Approve or reject the permission before sending a new message."
        options.onMessageRejected?.(message)
        return c.json({ error: message }, 409)
      }
    }

    // Forward to resolved backend with mode-appropriate permissions on new sessions
    const permission = modeToPermissionRuleset(mode as Mode)
    return proxyCall(c, async () => {
      let targetSessionId: string
      let backendId: BackendId
      let isNewSession = !sessionId

      if (sessionId) {
        const sessionBackend = resolveSessionBackend(sessionId)
        const modelBackend = model ? registry.resolveBackend(model) : sessionBackend
        if (modelBackend !== sessionBackend) {
          // Model targets a different backend — create a new session on the correct backend
          // (happens when user creates a session then switches to a model on another backend)
          backendId = modelBackend
          const engine = await registry.getEngine(backendId)
          const session = await engine.createSession({ directory: workspacePath, permission, model, variant })
          targetSessionId = session.id
          isNewSession = true
        } else {
          targetSessionId = sessionId
          backendId = sessionBackend
        }
      } else {
        backendId = model ? registry.resolveBackend(model) : pickDefaultBackend(registry)
        const engine = await registry.getEngine(backendId)
        const session = await engine.createSession({ directory: workspacePath, permission, model, variant })
        targetSessionId = session.id
      }

      const sessionBackend = resolveSessionBackend(sessionId ?? targetSessionId)
      const modelBackend = model ? registry.resolveBackend(model) : sessionBackend
      log?.debug("atelier", "message", "message_routing_decided", { sessionId: targetSessionId, data: { backendId, isNewSession, modelMismatch: sessionId ? modelBackend !== sessionBackend : false } })

      const proxy = await registry.getProxy(backendId)
      if (isNewSession) {
        const title = generateSessionTitle(content)
        proxy.updateSessionTitle(targetSessionId, title).catch(() => {})
        merger.emit({
          type: "session.updated",
          properties: {
            info: {
              id: targetSessionId,
              title,
              slug: targetSessionId,
              projectID: "",
              directory: workspacePath,
              version: "1",
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        })
      }
      // Fire-and-forget: prompt streams via SSE, don't block the HTTP response
      proxy.sendMessage(targetSessionId, { content, attachments, model, variant }).catch((err) => {
        log?.error("atelier", "message", "send_failed", { sessionId: targetSessionId, error: String(err) })
        merger.emit({ type: "send_error", sessionId: targetSessionId, error: err instanceof Error ? err.message : "Message delivery failed" })
      })
      return isNewSession ? { sessionId: targetSessionId } : { ok: true }
    })
  })

  // --- Pipeline endpoints ---
  app.get("/pipelines", (c) => {
    const pipelineState = options.getPipelineState?.()
    if (!pipelineState) return c.json([])
    return c.json(pipelineState.listPipelines())
  })

  app.delete("/pipeline/:id", async (c) => {
    const id = c.req.param("id")
    const orchestrator = getOrchestrator()
    if (orchestrator) {
      await orchestrator.deletePipeline(id)
    } else {
      const ps = options.getPipelineState?.()
      if (ps) ps.deletePipeline(id)
    }
    return c.json({ ok: true })
  })

  app.get("/pipeline/:id", (c) => {
    const pipelineState = options.getPipelineState?.()
    if (!pipelineState) return c.json({ error: "Not available" }, 404)
    const data = pipelineState.getPipeline(c.req.param("id"))
    if (!data) return c.json({ error: "Pipeline not found" }, 404)
    return c.json({
      ...stripNulls(data as unknown as Record<string, unknown>),
      stages: data.stages.map((s: StageData) => ({
        ...stripNulls(s as unknown as Record<string, unknown>),
        interrupted: s.interrupted || undefined,
      })),
    })
  })

  // --- Pipeline poll (responder MCP) ---
  app.get("/pipeline/:pipelineId/poll", async (c) => {
    const pipelineId = c.req.param("pipelineId")
    const orchestrator = getOrchestrator()
    if (!orchestrator) return c.json({ error: "Orchestrator not ready" }, 503)

    const afterParam = c.req.query("after")
    const timeoutParam = c.req.query("timeout")
    const sourceParam = c.req.query("source") // "responder" = exclude responder's own session
    let after = afterParam ? parseInt(afterParam, 10) : 0
    const rawTimeout = timeoutParam ? parseInt(timeoutParam, 10) : 5000
    const timeout = Math.min(Math.max(rawTimeout, 0), 30000)

    const pipelineStatus = orchestrator.getPipelineStatus(pipelineId)
    const stageInfo = orchestrator.getCurrentStageInfo(pipelineId)

    // Extract a short human-readable summary from tool input for external logs.
    function toolInputSummary(tool: string, input: Record<string, unknown> | undefined): string | undefined {
      if (!input) return undefined
      switch (tool) {
        case "bash": {
          const cmd = input.command as string | undefined
          return cmd ? cmd.slice(0, 150) : undefined
        }
        case "read": return input.file_path as string | undefined
        case "write": return input.file_path as string | undefined
        case "edit": return input.file_path as string | undefined
        case "glob": return input.pattern as string | undefined
        case "grep": return input.pattern as string | undefined
        case "task": return (input.description as string | undefined)?.slice(0, 150) ?? (input.prompt as string | undefined)?.slice(0, 150)
        default: return undefined
      }
    }

    // Simplify events for external consumers: include stage lifecycle, text, tools, and questions.
    // Re-reads pipelineSessions on each call so newly-created sessions are included.
    function simplifyEvents(rawEvents: Array<Record<string, unknown>>, excludeSessionId?: string | null): Array<Record<string, unknown>> {
      const pipelineSessions = orchestrator!.getSessionsForPipeline(pipelineId)
      const responderSessionId = orchestrator!.getResponderSession(pipelineId)
      // Match pipeline sessions + subagent sessions + any session not in our known set
      // (pipeline sessions may be registered after events are emitted; better to over-include
      // than silently drop events)
      const isPipelineSession = (sid: string | undefined) => !!sid
      /** Tag events with "responder" or "worker" role based on session origin. */
      const sessionRole = (sid: string | undefined): string =>
        sid === responderSessionId ? "responder" : "worker"
      const simplified: Array<Record<string, unknown>> = []
      for (const event of rawEvents) {
        const type = event.type as string
        const props = event.properties as Record<string, unknown> | undefined

        // Skip events from the excluded session (used by responder to ignore its own events)
        if (excludeSessionId) {
          const info = props?.info as Record<string, unknown> | undefined
          const part = props?.part as Record<string, unknown> | undefined
          const evtSessionId = (props?.sessionID ?? info?.sessionID ?? part?.sessionID ?? event.sessionId) as string | undefined
          if (evtSessionId === excludeSessionId) continue
        }

        // Stage lifecycle events (emitted at pipeline level)
        if (type === "stage_started" || type === "stage_completed") {
          if ((event.pipelineId as string) === pipelineId) {
            simplified.push({ event: type, stage: event.stage, pipelineId: event.pipelineId })
          }
          continue
        }

        if (type === "pipeline_completed" || type === "pipeline_failed") {
          if ((event.pipelineId as string) === pipelineId) {
            simplified.push({ event: type, pipelineId: event.pipelineId, error: event.error })
          }
          continue
        }

        // Question asked events (normalized: properties.id, properties.sessionID, properties.questions)
        if (type === "question.asked") {
          const sessionId = (props?.sessionID ?? event.sessionId) as string | undefined
          if (isPipelineSession(sessionId)) {
            simplified.push({
              event: "question.asked",
              sessionId,
              requestId: (props?.id ?? event.requestId) as string,
              questions: props?.questions ?? event.question,
            })
          }
          continue
        }

        // Permission asked events
        if (type === "permission.asked") {
          const sessionId = (props?.sessionID ?? event.sessionId) as string | undefined
          if (isPipelineSession(sessionId)) {
            simplified.push({
              event: "permission.asked",
              sessionId,
              requestId: (props?.id ?? event.requestId) as string,
            })
          }
          continue
        }

        // Session idle events (normalized: properties.sessionID)
        if (type === "session.idle") {
          const sessionId = (props?.sessionID ?? event.sessionId) as string | undefined
          if (isPipelineSession(sessionId)) {
            simplified.push({ event: "idle", sessionId })
          }
          continue
        }

        // message.completed — legacy handler for OpenCode backend path.
        // Claude Code engine events go through normalizeForUI() which converts
        // message.completed → message.updated + message.part.updated, so this
        // handler only fires for raw OpenCode SSE events (if any).
        if (type === "message.completed") {
          const sessionId = (event.sessionId ?? props?.sessionID) as string | undefined
          if (isPipelineSession(sessionId)) {
            const role = event.role as string | undefined
            const blocks = event.contentBlocks as Array<Record<string, unknown>> | undefined
            if (role === "assistant" && blocks) {
              for (const block of blocks) {
                if (block.type === "text" && block.text) {
                  simplified.push({ event: "text", text: (block.text as string).slice(0, 500), sessionId })
                }
                if (block.type === "tool_use") {
                  simplified.push({ event: "tool", tool: block.name as string, status: "running", sessionId })
                }
                if (block.type === "tool_result") {
                  simplified.push({ event: "tool", tool: block.name as string, status: "completed", sessionId })
                }
              }
            }
          }
          continue
        }

        // message.updated — assistant turn completed (contains finish reason, role, usage)
        if (type === "message.updated") {
          const info = (props?.info) as Record<string, unknown> | undefined
          if (info?.role === "assistant" && info?.finish) {
            const sessionId = (info.sessionID ?? event.sessionId) as string | undefined
            if (isPipelineSession(sessionId)) {
              simplified.push({ event: "assistant_done", finish: info.finish as string, model: info.model as string | undefined, sessionId, role: sessionRole(sessionId) })
            }
          }
          continue
        }

        // message.part.updated — tool calls (with input detail) and text blocks.
        // normalizeForUI() converts AtelierEvents into these:
        //   tool.started/completed → message.part.updated with part.type="tool"
        //   message.completed text blocks → message.part.updated with part.type="text"
        if (type === "message.part.updated") {
          const part = props?.part as Record<string, unknown> | undefined
          if (!part) { continue }
          const partSessionId = (part.sessionID ?? props?.sessionID) as string | undefined
          if (!isPipelineSession(partSessionId)) { continue }

          // Text blocks — final text from assistant message completion
          if (part.type === "text") {
            const text = part.text as string | undefined
            if (text) {
              simplified.push({ event: "text", text: text.slice(0, 500), sessionId: partSessionId, role: sessionRole(partSessionId) })
            }
          }

          // Tool calls — running, completed, or error.
          // "running" from tool.started arrives before completion (genuine start signal).
          // message.completed normalization also re-emits tool_use as "running" AFTER completion,
          // but those have empty tool names (from tool_result blocks) and are filtered below.
          if (part.type === "tool") {
            const state = part.state as Record<string, unknown> | undefined
            const status = (state?.status ?? state?.type) as string | undefined
            const tool = (part.tool ?? part.toolName) as string
            // Filter out tool_result duplicates (empty tool name from message.completed normalization)
            if (!tool) { continue }
            if (status === "completed" || status === "error" || status === "running") {
              const input = state?.input as Record<string, unknown> | undefined
              const detail = toolInputSummary(tool, input)
              const output = status === "completed" ? (state?.output as string | undefined)?.slice(0, 300) : undefined
              simplified.push({
                event: "tool",
                tool,
                status,
                ...(detail ? { detail } : {}),
                ...(output ? { output } : {}),
                ...(status === "error" && state?.error ? { error: (state.error as string).slice(0, 300) } : {}),
                sessionId: partSessionId,
                role: sessionRole(partSessionId),
              })
            }
          }
          continue
        }

        // Skip remaining streaming updates — too noisy for external consumers.
        if (type === "message.part.delta" ||
            type === "message.created" || type === "message.delta" ||
            type === "session.created" || type === "session.updated" || type === "session.deleted" ||
            type === "session.busy" || type === "session.idle" || type === "session.status" ||
            type === "session.error" || type === "session.interrupted") {
          continue
        }
      }
      return simplified
    }

    // When source=responder, exclude the responder's own session events so
    // the long-poll actually blocks until WORKER events arrive.
    const excludeSessionId = sourceParam === "responder"
      ? orchestrator.getResponderSession(pipelineId) ?? null
      : null

    // Try to get events from the ring buffer
    const rawEvents = merger.getEventsAfter(after)
    if (rawEvents && rawEvents.length > 0) {
      const events = simplifyEvents(rawEvents, excludeSessionId)
      // Debug: periodically log what's being filtered (every 10th poll with no results)
      if (events.length === 0 && rawEvents.length > 0) {
        const sample = rawEvents.slice(0, 5).map(e => e.type).join(", ")
        console.error(`[poll] ${rawEvents.length} raw events simplified to 0. Types: ${sample}`)
      }
      if (events.length > 0) {
        const nextCursor = rawEvents[rawEvents.length - 1]!.seq as number
        const status = pipelineStatus === "completed" ? "completed" : "busy"
        return c.json({ events, nextCursor, status, currentStage: stageInfo.stage, interactive: stageInfo.interactive })
      }
      // Raw events exist but none simplified to relevant pipeline events.
      // DON'T skip cursor — stage lifecycle events might arrive between now
      // and the next subscriber notification. Advancing past them would miss them.
    }

    // No new events — if pipeline is done or timeout is 0, return immediately
    if (pipelineStatus === "completed" || pipelineStatus === "failed" || timeout === 0) {
      return c.json({
        events: [],
        nextCursor: merger.currentSeq(),
        status: pipelineStatus === "completed" ? "completed" : pipelineStatus === "failed" ? "completed" : "idle",
        currentStage: stageInfo.stage,
        interactive: stageInfo.interactive,
      })
    }

    // Long-poll: subscribe and wait for new events or timeout
    const pollAfter = after // capture updated cursor for subscriber
    return new Promise<Response>((resolve) => {
      let resolved = false
      const timer = setTimeout(() => {
        if (resolved) return
        resolved = true
        unsub()
        const si = orchestrator.getCurrentStageInfo(pipelineId)
        resolve(c.json({
          events: [],
          nextCursor: merger.currentSeq(),
          status: (() => { const s = orchestrator.getPipelineStatus(pipelineId); return s === "completed" ? "completed" : s === "failed" ? "completed" : s === "running" ? "busy" : "idle" })(),
          currentStage: si.stage,
          interactive: si.interactive,
        }))
      }, timeout)

      const unsub = merger.subscribe((event) => {
        if (resolved) return
        // Check if this event is relevant to the pipeline (excluding responder's own if source=responder)
        const simplified = simplifyEvents([event], excludeSessionId)
        if (simplified.length > 0) {
          resolved = true
          clearTimeout(timer)
          unsub()
          // Gather all available events now (not just the one that triggered us)
          const allRaw = merger.getEventsAfter(pollAfter)
          const si2 = orchestrator.getCurrentStageInfo(pipelineId)
          if (allRaw && allRaw.length > 0) {
            const allSimplified = simplifyEvents(allRaw, excludeSessionId)
            const nextCursor = allRaw[allRaw.length - 1]!.seq as number
            resolve(c.json({ events: allSimplified, nextCursor, status: "busy", currentStage: si2.stage, interactive: si2.interactive }))
          } else {
            resolve(c.json({ events: simplified, nextCursor: event.seq as number, status: "busy", currentStage: si2.stage, interactive: si2.interactive }))
          }
        }
      })
    })
  })

  app.post("/pipeline/restart", async (c) => {
    const orchestrator = getOrchestrator()
    if (!orchestrator) return c.json({ error: "Orchestrator not ready" }, 503)
    const body = await parseJson(c)
    const fromPipeline = validateString(body.fromPipeline, "fromPipeline")
    const fromStage = validateString(body.fromStage, "fromStage")
    const pipelineState = options.getPipelineState?.()
    if (!pipelineState) return c.json({ error: "Not available" }, 503)
    const sourcePipeline = pipelineState.getPipeline(fromPipeline)
    if (!sourcePipeline) return c.json({ error: "Source pipeline not found" }, 404)
    // Carry over model/variant from source pipeline, allow optional override
    const model = validateModel(body.model) ?? sourcePipeline.model ?? undefined
    const variant = optionalVariant(body.variant) ?? sourcePipeline.variant ?? undefined
    await validateModelAndVariant(registry, model, variant)
    log?.debug("atelier", "pipeline", "pipeline_restart_requested", { data: { fromPipeline, fromStage } })
    const result = orchestrator.startPipelineAsync(sourcePipeline.prompt, { fromPipelineId: fromPipeline, fromStage, model, variant })
    result.completion.catch(() => {}) // Errors handled internally by orchestrator
    return c.json({ pipelineId: result.pipelineId })
  })

  app.post("/pipeline/signal", async (c) => {
    const orchestrator = getOrchestrator()
    if (!orchestrator) return c.json({ error: "Orchestrator not ready" }, 503)
    const body = await parseJson(c)
    const type = validateString(body.type, "type")
    if (!VALID_SIGNAL_TYPES.has(type)) {
      throw new ValidationError(`type must be one of: ${[...VALID_SIGNAL_TYPES].join(", ")}`)
    }
    const sessionId = validateString(body.sessionId, "sessionId")
    const outputPath = optionalString(body.outputPath)
    const verdict = optionalString(body.verdict)
    if (verdict && !VALID_VERDICTS.has(verdict)) {
      throw new ValidationError(`verdict must be one of: ${[...VALID_VERDICTS].join(", ")}`)
    }
    const action = optionalString(body.action)
    if (action && !VALID_ACTIONS.has(action)) {
      throw new ValidationError(`action must be one of: ${[...VALID_ACTIONS].join(", ")}`)
    }
    const outcome = optionalString(body.outcome)
    if (outcome && !VALID_OUTCOMES.has(outcome)) {
      throw new ValidationError(`outcome must be one of: ${[...VALID_OUTCOMES].join(", ")}`)
    }
    const pipelineType = optionalString(body.pipelineType)
    if (pipelineType && !VALID_PIPELINE_TYPES.has(pipelineType)) {
      throw new ValidationError(`pipelineType must be one of: ${[...VALID_PIPELINE_TYPES].join(", ")}`)
    }
    const worktreeChoice = optionalString(body.worktreeChoice)
    if (worktreeChoice && !VALID_WORKTREE_CHOICES.has(worktreeChoice)) {
      throw new ValidationError(`worktreeChoice must be one of: ${[...VALID_WORKTREE_CHOICES].join(", ")}`)
    }
    log?.debug("atelier", "signal", "signal_endpoint_received", { data: { type, sessionId, verdict } })
    try {
      await orchestrator.handleSignal({ type, sessionId, outputPath, verdict, action, outcome, pipelineType, worktreeChoice })
      return c.json({ ok: true })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log?.error("atelier", "signal", "signal_error", { error: String(err) })
      return c.json({ error: message }, 500)
    }
  })

  app.post("/pipeline/retry-stuck", async (c) => {
    const orchestrator = getOrchestrator()
    if (!orchestrator) return c.json({ error: "Orchestrator not ready" }, 503)
    const body = await parseJson(c)
    const pipelineId = validateString(body.pipelineId, "pipelineId")
    const stageId = validateString(body.stageId, "stageId")
    const action = validateString(body.action, "action")
    if (action !== "fixer" && action !== "resume") {
      throw new ValidationError("action must be 'fixer' or 'resume'")
    }
    const mappedAction = action === "fixer" ? "fix" : "resume" as const
    try {
      await orchestrator.handleStuckRetry(pipelineId, stageId, mappedAction)
      return c.json({ ok: true })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return c.json({ error: message }, 500)
    }
  })

  app.post("/pipeline/abort", async (c) => {
    const orchestrator = getOrchestrator()
    if (!orchestrator) return c.json({ error: "Orchestrator not ready" }, 503)
    const body = await parseJson(c)
    const pipelineId = validateString(body.pipelineId, "pipelineId")
    if (!orchestrator.hasPipeline(pipelineId)) {
      return c.json({ error: "Pipeline not active" }, 404)
    }
    log?.debug("atelier", "pipeline", "pipeline_abort_requested", { pipelineId })
    await orchestrator.failPipeline(pipelineId, "Aborted by user")
    return c.json({ ok: true })
  })

  /** Creates an SSE Response. `setup` receives a writer and returns an unsubscribe function. */
  function createSSEStream(ctx: Context, setup: (write: (chunk: string) => void) => () => void): Response {
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const write = (chunk: string) => { writer.write(encoder.encode(chunk)).catch(() => {}) }

    const unsubscribe = setup(write)

    // Flush an initial SSE comment so the client-side fetch() resolves immediately
    // (Node.js/undici won't resolve until the first body byte arrives)
    write(":ok\n\n")

    const heartbeat = setInterval(() => {
      writer.write(encoder.encode(":keepalive\n\n")).catch(() => {
        clearInterval(heartbeat)
      })
    }, 15000)

    ctx.req.raw.signal?.addEventListener("abort", () => {
      unsubscribe()
      clearInterval(heartbeat)
      writer.close()
    })

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }

  // --- Log events SSE (observability) ---
  app.get("/log-events", (c) => {
    const levelParam = c.req.query("level") ?? "info"
    const validLevels = new Set(["error", "info", "debug", "trace"])
    if (!validLevels.has(levelParam)) {
      return c.json({ error: `Invalid level: ${levelParam}. Must be one of: error, info, debug, trace` }, 400)
    }

    if (!options.onLogSubscribe) {
      return c.json({ error: "Logging not configured" }, 503)
    }

    return createSSEStream(c, (write) => {
      return options.onLogSubscribe!((event) => {
        write(`event: log\ndata: ${JSON.stringify(event)}\n\n`)
      }, levelParam)
    })
  })

  // --- Unified SSE ---
  app.get("/events", (c) => {
    return createSSEStream(c, (write) => {
      const lastEventId = c.req.header("Last-Event-ID")
      const parsedLastEventId = parseInt(lastEventId ?? "", 10)
      let lastWrittenSeq = Number.isFinite(parsedLastEventId) ? parsedLastEventId : 0

      function writeSSE(id: number, data: string): void {
        write(`id: ${id}\ndata: ${data}\n\n`)
      }

      // Subscribe FIRST to avoid missing events between replay and subscribe.
      // Events with seq <= lastWrittenSeq are deduplicated.
      const unsubscribe = merger.subscribe((event, json) => {
        const seq = event.seq as number
        if (seq <= lastWrittenSeq) return
        writeSSE(seq, json)
      })

      // Replay buffered events
      if (lastWrittenSeq > 0) {
        const replay = merger.getEventsAfter(lastWrittenSeq)
        if (replay === null) {
          const seq = merger.currentSeq()
          writeSSE(seq, JSON.stringify({ type: "full_refresh_required", seq }))
          lastWrittenSeq = seq
        } else {
          for (const event of replay) {
            writeSSE(event.seq, JSON.stringify(event))
            lastWrittenSeq = event.seq
          }
        }
      }

      return unsubscribe
    })
  })

  // --- Test routes (used by Test MCP Server for E2E pipeline validation) ---
  {
  const ALLOWED_TEST_COMMANDS = new Set(["atelier.openChat", "atelier.openChatInNewTab"])

  app.post("/test/command", async (c) => {
    const body = await parseJson(c)
    const command = validateString(body.command, "command")
    if (!ALLOWED_TEST_COMMANDS.has(command)) {
      throw new ValidationError(`command must be one of: ${[...ALLOWED_TEST_COMMANDS].join(", ")}`)
    }
    merger.emit({ type: "test_command", command })
    return c.json({ ok: true })
  })

  const ALLOWED_WEBVIEW_MESSAGES = new Set(["switchSession", "loadPipeline", "createSession"])

  app.post("/test/webview-message", async (c) => {
    const body = await parseJson(c)
    const msgType = validateString(body.type, "type")
    if (!ALLOWED_WEBVIEW_MESSAGES.has(msgType)) {
      throw new ValidationError(`type must be one of: ${[...ALLOWED_WEBVIEW_MESSAGES].join(", ")}`)
    }
    merger.emit({ type: "test_webview_message", message: body })
    return c.json({ ok: true })
  })

  app.post("/test/navigate-session", async (c) => {
    const body = await parseJson(c)
    const sessionId = optionalString(body.sessionId)
    const pipelineId = optionalString(body.pipelineId)
    const openNewTab = body.openNewTab === true
    // Emit a navigate event that the extension picks up to switch/open tabs
    merger.emit({
      type: "test_navigate_session",
      sessionId: sessionId ?? undefined,
      pipelineId: pipelineId ?? undefined,
      openNewTab,
    } as any)
    return c.json({ ok: true })
  })

  app.post("/test/send-message", async (c) => {
    const body = await parseJson(c)
    const sessionId = validateString(body.sessionId, "sessionId")
    const content = validateString(body.content, "content")
    const model = validateModel(body.model)
    const variant = optionalVariant(body.variant)
    const attachments = validateAttachments(body.attachments)
    await validateModelAndVariant(registry, model, variant)

    // Check if this is an interrupted pipeline session — route through orchestrator
    const orchestrator = getOrchestrator()
    if (orchestrator && orchestrator.isSessionOwnedByPipeline(sessionId)) {
      const pipelineId = orchestrator.findPipelineIdBySession(sessionId)
      if (
        pipelineId &&
        orchestrator.getActiveStageSessionId(pipelineId) === sessionId &&
        orchestrator.isStageInterrupted(pipelineId)
      ) {
        return proxyCall(c, async () => {
          await orchestrator.clearInterruptAndRoute(sessionId, content, { model, variant })
          return { ok: true }
        })
      }
      return proxyCall(c, async () => {
        await orchestrator.routeStageMessage(sessionId, content, { attachments, model, variant })
        return { ok: true }
      })
    }

    // Fire-and-forget: message streams via SSE, don't block the HTTP response
    getProxyForSession(sessionId).then((proxy) =>
      proxy.sendMessage(sessionId, { content, model, attachments })
    ).catch((err) => {
      merger.emit({ type: "send_error", sessionId, error: err instanceof Error ? err.message : "Message delivery failed" })
    })
    return c.json({ ok: true })
  })
  }

  return app

  // --- Internal helpers (closure-scoped) ---

  async function routePipelineMessage(
    c: Context,
    orchestrator: OrchestratorInterface | null,
    content: string,
    attachments: Array<{ mime: string; url: string; filename?: string }> | undefined,
    model?: { providerID: string; modelID: string },
    variant?: string,
    pipelineId?: string,
    pipelineType: PipelineType = "feature",
    sourceSessionId?: string,
    autonomous?: boolean,
    skipClassify?: { pipelineType: PipelineType; worktreeChoice: "in-tree" | "worktree" },
  ): Promise<Response> {
    if (!orchestrator) {
      return c.json({ error: "Server starting" }, 503)
    }

    // If pipelineId provided, route to that specific pipeline
    if (pipelineId) {
      if (!orchestrator.hasPipeline(pipelineId)) {
        // Pipeline exists on disk but not in memory (server restarted) — rehydrate it
        const rehydrated = await orchestrator.rehydrateFromDisk(pipelineId)
        log?.debug("atelier", "pipeline", "pipeline_rehydration_attempted", { pipelineId, data: { success: rehydrated } })
        if (!rehydrated) {
          return c.json({ error: "Pipeline not found" }, 404)
        }
        // Fall through to normal in-memory routing below
      }
      const stageSessionId = orchestrator.getActiveStageSessionId(pipelineId)
      if (!stageSessionId) {
        return c.json({ error: "Pipeline is transitioning between stages. Try again shortly.", pipelineId }, 409)
      }
      log?.debug("atelier", "pipeline", "feature_message_routed_to_pipeline", { pipelineId, data: { stageSessionId, isInterrupted: orchestrator.isStageInterrupted(pipelineId) } })
      if (orchestrator.isStageInterrupted(pipelineId)) {
        orchestrator.clearInterruptAndRoute(stageSessionId, content, { model, variant }).catch((err) => {
          log?.error("atelier", "message", "clear_interrupt_failed", { sessionId: stageSessionId, error: String(err) })
          merger.emit({ type: "send_error", sessionId: stageSessionId, error: err instanceof Error ? err.message : "Message delivery failed" })
        })
        return c.json({ ok: true, pipelineId })
      }
      const pending = await replayPendingInteraction(stageSessionId)
      if (pending) {
        const message = pending === "question"
          ? "Stage session is waiting for a question reply before it can continue."
          : "Stage session is waiting for a permission reply before it can continue."
        options.onMessageRejected?.(message)
        return c.json({ error: message }, 409)
      }
      orchestrator.routeStageMessage(stageSessionId, content, { attachments, model, variant }).catch((err) => {
        log?.error("atelier", "message", "pipeline_send_failed", { sessionId: stageSessionId, error: String(err) })
        merger.emit({ type: "send_error", sessionId: stageSessionId, error: err instanceof Error ? err.message : "Message delivery failed" })
      })
      return c.json({ ok: true, pipelineId })
    }

    // No pipelineId — start a new pipeline
    const result = orchestrator.startPipelineAsync(content, {
      type: skipClassify?.pipelineType ?? pipelineType,
      model, variant, sourceSessionId, autonomous,
      pipelineType: skipClassify?.pipelineType,
      worktreeChoice: skipClassify?.worktreeChoice,
    })
    log?.debug("atelier", "pipeline", "feature_pipeline_started", { pipelineId: result.pipelineId })
    result.completion.catch((err) => {
      const msg = `PIPELINE ERROR [${result.pipelineId}]: ${err instanceof Error ? err.stack : String(err)}`
      console.error(msg)
      log?.error("atelier", "pipeline", "pipeline_completion_error", { pipelineId: result.pipelineId, error: String(err) })
      // Write to file for debugging in containers where stdout is buffered
      try { fs.appendFileSync(path.join(os.tmpdir(), "atelier-pipeline-errors.log"), msg + "\n") } catch {}
    })
    return c.json({ pipelineId: result.pipelineId })
  }
}

// --- Validation helpers ---

// Long-lived cache for merged models, scoped per registry instance to avoid
// cross-test pollution. The merged list rarely changes once a backend is up,
// so the previous 5s TTL was paying the full Claude SDK helper spawn (~900ms)
// every 30s on the message hot path. We now keep the cache fresh in the
// background (see startMergedModelsRefresher) and the foreground validation
// reads from a stale-but-warm cache when available.
const _mergedModelsCaches = new WeakMap<BackendRegistry, { models: Array<Record<string, unknown>>; ts: number }>()
const _mergedModelsRefreshing = new WeakMap<BackendRegistry, Promise<Array<Record<string, unknown>>>>()
const CONFIG_CACHE_FRESH_MS = 60_000   // serve from cache without refresh
const CONFIG_CACHE_STALE_MS = 5 * 60_000 // serve stale cache + kick async refresh
const CONFIG_BACKGROUND_REFRESH_MS = 30_000

async function fetchMergedModels(registry: BackendRegistry): Promise<Array<Record<string, unknown>>> {
  const models: Array<Record<string, unknown>> = []
  for (const backendId of registry.listReadyBackends()) {
    const proxy = registry.getProxyIfReady(backendId)
    if (proxy) {
      try {
        const config = await proxy.getConfig()
        models.push(...config.models)
      } catch { /* skip unavailable backends */ }
    }
  }
  _mergedModelsCaches.set(registry, { models, ts: Date.now() })
  return models
}

function refreshMergedModelsInBackground(registry: BackendRegistry): void {
  if (_mergedModelsRefreshing.has(registry)) return
  const p = fetchMergedModels(registry).finally(() => _mergedModelsRefreshing.delete(registry))
  _mergedModelsRefreshing.set(registry, p)
  p.catch(() => {})
}

async function getMergedModels(registry: BackendRegistry): Promise<Array<Record<string, unknown>>> {
  const now = Date.now()
  const cached = _mergedModelsCaches.get(registry)
  if (cached) {
    const age = now - cached.ts
    if (age < CONFIG_CACHE_FRESH_MS) return cached.models
    if (age < CONFIG_CACHE_STALE_MS) {
      // Stale-but-usable: kick background refresh, return cached.
      refreshMergedModelsInBackground(registry)
      return cached.models
    }
  }
  // Cold or very stale: must fetch synchronously so callers (route validation)
  // get correct data. Reuse an in-flight background refresh if any.
  const inflight = _mergedModelsRefreshing.get(registry)
  if (inflight) return inflight
  return fetchMergedModels(registry)
}

/** Start a background interval that keeps the merged models cache warm so the
 *  message hot path never blocks on the Claude SDK helper subprocess. */
export function startMergedModelsRefresher(registry: BackendRegistry): { stop: () => void } {
  // Initial warm-up — best-effort.
  refreshMergedModelsInBackground(registry)
  const handle = setInterval(() => refreshMergedModelsInBackground(registry), CONFIG_BACKGROUND_REFRESH_MS)
  // Don't keep the process alive just for the refresher.
  if (typeof (handle as { unref?: () => void })?.unref === "function") (handle as { unref: () => void }).unref()
  return { stop: () => clearInterval(handle) }
}

async function validateModelAndVariant(
  registry: BackendRegistry,
  model: { providerID: string; modelID: string } | undefined,
  variant: string | undefined,
): Promise<void> {
  if (!model) return
  let available = await getMergedModels(registry)
  let match = available.find((m) => m.providerID === model.providerID && m.id === model.modelID)
  if (!match) {
    _mergedModelsCaches.delete(registry)
    available = await getMergedModels(registry)
    match = available.find((m) => m.providerID === model.providerID && m.id === model.modelID)
  }
  if (!match) {
    const list = available.map((m) => `${m.providerID}:${m.id}`).join(", ")
    throw new ValidationError(`Unknown model '${model.providerID}:${model.modelID}'. Available: ${list}`)
  }
  const variants = match.variants as Record<string, unknown> | undefined
  if (variant && variants) {
    const validVariants = Object.keys(variants)
    if (validVariants.length > 0 && !validVariants.includes(variant)) {
      throw new ValidationError(`Unknown variant '${variant}' for model '${model.providerID}:${model.modelID}'. Available variants: ${validVariants.join(", ")}`)
    }
  }
  if (variant && (!variants || Object.keys(variants).length === 0)) {
    throw new ValidationError(`Model '${model.providerID}:${model.modelID}' does not support variants`)
  }
}

function validateModel(value: unknown): { providerID: string; modelID: string } | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "object") {
    throw new ValidationError("model must have providerID and modelID strings")
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.providerID !== "string" || typeof obj.modelID !== "string") {
    throw new ValidationError("model must have providerID and modelID strings")
  }
  const m = value as { providerID: string; modelID: string }
  return { providerID: m.providerID, modelID: m.modelID }
}

function validateAttachments(value: unknown): Array<{ mime: string; url: string; filename?: string }> | undefined {
  if (!Array.isArray(value)) return undefined
  for (const att of value) {
    if (typeof att !== "object" || att === null || typeof att.mime !== "string" || typeof att.url !== "string") {
      throw new ValidationError("Each attachment must have mime and url strings")
    }
  }
  return value as Array<{ mime: string; url: string; filename?: string }>
}
