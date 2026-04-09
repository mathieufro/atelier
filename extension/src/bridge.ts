import type { WebviewMessage, HostMessage, PipelineDetail } from "@atelier/core"
import type { AtelierClient } from "./atelier-client.js"
import type { OutputChannelController } from "./output-channel-controller.js"

/** Number of messages to fetch per page when loading session history. */
const SESSION_PAGE_SIZE = 80

export function createBridge(
  getClient: () => AtelierClient | null,
  postMessage: (msg: HostMessage) => void,
  log?: OutputChannelController,
): { handleMessage: (msg: WebviewMessage) => Promise<void> } {

  async function refreshPipelines(client: AtelierClient, activePipelineId?: string) {
    const pipelines = await client.listPipelines()
    log?.log("debug", "pipelines_refreshed", `count=${pipelines.length}`)
    postMessage({ type: "pipelines", pipelines })
    if (activePipelineId) {
      const detail = await client.getPipeline(activePipelineId)
      postMessage({ type: "pipeline", pipeline: detail })
    }
  }

  /**
   * Shared helper for loading paginated messages (older or newer).
   */
  async function loadMessages(
    client: AtelierClient,
    sessionId: string,
    cursor: { before?: number; after?: number },
    limit: number | undefined,
    direction: "prepend" | "append",
  ) {
    const page = await client.getMessages(sessionId, {
      ...cursor,
      limit: limit ?? SESSION_PAGE_SIZE,
    })
    log?.log("debug", "messages_page_loaded", `direction=${direction} count=${page.messages.length}`)
    postMessage({
      type: "messages",
      messages: page.messages,
      sessionId,
      start: page.start,
      end: page.end,
      total: page.total,
      direction,
    })
  }

  async function handleMessage(msg: WebviewMessage): Promise<void> {
    const client = getClient()
    if (!client) {
      postMessage({
        type: "error",
        code: "CONNECTION_LOST",
        message: "Client is not connected",
      })
      return
    }

    const rpcId = msg._rpcId

    try {
      switch (msg.type) {
        case "ready": {
          log?.log("info", "webview_ready", "fetching sessions, config, pipelines")
          // Fetch sessions/pipelines first (fast), then config separately (may trigger lazy backend init)
          const [sessions, pipelines] = await Promise.all([
            client.listSessions(),
            client.listPipelines(),
          ])
          log?.log("info", "initial_data_loaded", `sessions=${sessions.length} pipelines=${pipelines.length}`)
          postMessage({ type: "sessions", sessions })
          postMessage({ type: "pipelines", pipelines })
          // Config fetched separately — don't block sessions on slow backend init / API calls
          log?.log("info", "config_fetch_start", "starting async config fetch")
          client.getConfig().then((config) => {
            log?.log("info", "config_loaded", `models=${config.models.length} workspacePath=${config.workspacePath}`)
            postMessage({ type: "config", ...config })
            log?.log("info", "config_posted", "config message posted to webview")
          }).catch((err) => {
            log?.log("error", "config_fetch_failed", String(err))
            postMessage({ type: "config", models: [], agents: [], workspacePath: "" })
          })
          break
        }
        case "refreshConfig": {
          log?.log("info", "config_refresh", "re-fetching config (backend became ready)")
          const refreshedConfig = await client.getConfig()
          log?.log("info", "config_refreshed", `models=${refreshedConfig.models.length}`)
          postMessage({ type: "config", ...refreshedConfig })
          break
        }
        case "sendMessage": {
          log?.log("debug", "send_message", `mode=${msg.mode} session=${msg.sessionId ?? "new"} pipeline=${msg.pipelineId ?? "none"} model=${msg.model?.modelID ?? "default"}`)
          const result = await client.sendMessage({
            content: msg.content,
            mode: msg.mode,
            sessionId: msg.sessionId,
            pipelineId: msg.pipelineId,
            attachments: msg.attachments,
            model: msg.model,
            variant: msg.variant,
            sourceSessionId: msg.sourceSessionId,
          })
          if (result.pipelineId) {
            log?.log("info", "pipeline_created", result.pipelineId)
            await refreshPipelines(client, result.pipelineId)
          } else if (result.sessionId) {
            log?.log("info", "session_created", result.sessionId)
            const sessions = await client.listSessions()
            postMessage({ type: "sessions", sessions })
            postMessage({ type: "activeSession", sessionId: result.sessionId })
          }
          if (rpcId) postMessage({ type: "_rpc", _rpcId: rpcId, ...result })
          break
        }
        case "createSession": {
          log?.log("info", "create_session")
          const created = await client.createSession()
          const sessions = await client.listSessions()
          postMessage({ type: "sessions", sessions })
          postMessage({ type: "activeSession", sessionId: created.id })
          break
        }
        case "switchSession": {
          log?.log("info", "switch_session", msg.sessionId)
          // Always post activeSession + messages, even on error — prevents stuck loading state
          let page: { messages: any[]; start: number; end: number; total: number }
          try {
            page = await client.getMessages(msg.sessionId, { limit: SESSION_PAGE_SIZE })
          } catch (switchErr) {
            log?.log("info", "switch_session_deferred", `backend not ready for ${msg.sessionId}: ${String(switchErr)}`)
            page = { messages: [], start: 0, end: 0, total: 0 }
          }
          log?.log("debug", "messages_loaded", `count=${page.messages.length} total=${page.total}`)
          postMessage({ type: "activeSession", sessionId: msg.sessionId })
          postMessage({
            type: "messages",
            messages: page.messages,
            sessionId: msg.sessionId,
            start: page.start,
            end: page.end,
            total: page.total,
            direction: "replace",
          })
          // Auto-fetch subagent child session messages for TaskToolView rendering
          fetchSubagentMessages(client, page.messages)
          break
        }
        case "loadOlderMessages": {
          log?.log("debug", "load_older_messages", `session=${msg.sessionId} before=${msg.before}`)
          await loadMessages(client, msg.sessionId, { before: msg.before }, msg.limit, "prepend")
          break
        }
        case "loadNewerMessages": {
          log?.log("debug", "load_newer_messages", `session=${msg.sessionId} after=${msg.after}`)
          await loadMessages(client, msg.sessionId, { after: msg.after }, msg.limit, "append")
          break
        }
        case "deleteSession": {
          log?.log("info", "delete_session", msg.sessionId)
          await client.deleteSession(msg.sessionId)
          const sessions = await client.listSessions()
          postMessage({ type: "sessions", sessions })
          break
        }
        case "abortSession":
          log?.log("info", "abort_session", msg.sessionId)
          await client.abortSession(msg.sessionId)
          break
        case "resumeSession":
          log?.log("info", "resume_session", msg.sessionId)
          await client.resumeSession(msg.sessionId)
          break
        case "permissionReply":
          log?.log("debug", "permission_reply", `session=${msg.sessionId} request=${msg.requestId}`)
          await client.replyPermission(msg.sessionId, msg.requestId, msg.reply)
          break
        case "questionReply":
          log?.log("debug", "question_reply", `session=${msg.sessionId} request=${msg.requestId}`)
          await client.replyQuestion(msg.sessionId, msg.requestId, msg.answers)
          break
        case "questionReject":
          log?.log("debug", "question_reject", `session=${msg.sessionId} request=${msg.requestId}`)
          await client.rejectQuestion(msg.sessionId, msg.requestId)
          break
        case "invokeSkill": {
          log?.log("info", "invoke_skill", `skill=${msg.skillName} session=${msg.sessionId ?? "new"}`)
          const skillResult = await client.invokeSkill({
            skillName: msg.skillName,
            content: msg.content,
            sessionId: msg.sessionId,
            attachments: msg.attachments,
            model: msg.model,
            variant: msg.variant,
          })
          // Send RPC response BEFORE activeSession so handleInvokeSkill can call
          // setPendingSkill before the session switch triggers a message fetch.
          if (rpcId) postMessage({ type: "_rpc", _rpcId: rpcId, sessionId: skillResult.sessionId })
          if (skillResult.sessionId && skillResult.sessionId !== msg.sessionId) {
            // New session created (or backend mismatch forced a new one) — refresh list and switch to it
            const sessions = await client.listSessions()
            postMessage({ type: "sessions", sessions })
            postMessage({ type: "activeSession", sessionId: skillResult.sessionId })
          }
          break
        }
        case "requestSkills": {
          log?.log("info", "request_skills")
          const skills = await client.listSkills()
          postMessage({ type: "skills", skills })
          break
        }
        case "restartPipeline": {
          log?.log("info", "restart_pipeline", `from=${msg.fromPipeline} stage=${msg.fromStage}`)
          const restartResult = await client.restartPipeline(msg.fromPipeline, msg.fromStage)
          await refreshPipelines(client, restartResult.pipelineId)
          break
        }
        case "loadPipeline": {
          log?.log("info", "load_pipeline", msg.pipelineId)
          let detail: PipelineDetail
          try {
            detail = await client.getPipeline(msg.pipelineId)
          } catch (pipelineErr) {
            log?.log("error", "load_pipeline_failed", `pipelineId=${msg.pipelineId} error=${String(pipelineErr)}`)
            // Send a minimal pipeline so the UI at least exits loading state
            postMessage({
              type: "error",
              code: "PIPELINE_LOAD_FAILED",
              message: `Failed to load pipeline: ${pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr)}`,
            })
            break
          }
          postMessage({ type: "pipeline", pipeline: detail })
          // Fetch messages for all stage sessions so the UI has full history
          const stageSessionIds = (detail.stages ?? [])
            .filter((s) => s.sessionId)
            .map((s) => s.sessionId as string)
          const results = await Promise.all(
            stageSessionIds.map((sid: string) =>
              client.getMessages(sid, { limit: SESSION_PAGE_SIZE }).catch((err) => {
                log?.log("info", "stage_messages_fetch_failed", `sessionId=${sid} error=${String(err)}`)
                return null
              }),
            ),
          )
          for (let i = 0; i < stageSessionIds.length; i++) {
            const page = results[i]
            // Always send a messages response for each stage session —
            // even empty pages clear any pending loading state in the UI
            postMessage({
              type: "messages",
              messages: page?.messages ?? [],
              sessionId: stageSessionIds[i]!,
              start: page?.start ?? 0,
              end: page?.end ?? 0,
              total: page?.total ?? 0,
              direction: "replace",
            })
          }
          break
        }
        case "favorites.upsert": {
          const result = await client.upsertFavorite(msg.favorite)
          postMessage({ type: "favorites.state", favorites: result.favorites })
          break
        }
        case "favorites.remove": {
          const result = await client.removeFavorite(msg.favoriteKey)
          postMessage({ type: "favorites.state", favorites: result.favorites })
          break
        }
        case "favorites.reorder": {
          const result = await client.reorderFavorites(msg.favoriteKeys)
          postMessage({ type: "favorites.state", favorites: result.favorites })
          break
        }
        case "startRalphLoop": {
          log?.log("info", "start_ralph_loop", `path=${msg.promptPath}`)
          const ralphResult = await client.startRalphLoop({
            promptPath: msg.promptPath,
            maxIterations: msg.maxIterations,
            completionPromise: msg.completionPromise,
            model: msg.model,
            variant: msg.variant,
          })
          // Refresh session list and activate the new loop session
          const sessions = await client.listSessions()
          postMessage({ type: "sessions", sessions })
          postMessage({ type: "activeSession", sessionId: ralphResult.sessionId })
          if (rpcId) postMessage({ type: "_rpc", _rpcId: rpcId, sessionId: ralphResult.sessionId })
          break
        }
        case "cancelRalphLoop": {
          log?.log("info", "cancel_ralph_loop", `session=${msg.sessionId}`)
          await client.cancelRalphLoop(msg.sessionId)
          if (rpcId) postMessage({ type: "_rpc", _rpcId: rpcId, ok: true })
          break
        }
        case "stageModels.confirm": {
          log?.log("info", "stage_models_confirm", `pipeline=${msg.pipelineId}`)
          await client.confirmStageModels(msg.pipelineId, msg.stageModels)
          if (rpcId) postMessage({ type: "_rpc", _rpcId: rpcId, ok: true })
          break
        }
        case "stageModels.update": {
          log?.log("debug", "stage_models_update", `pipeline=${msg.pipelineId} stage=${msg.stage}`)
          await client.updateStageModel(msg.pipelineId, msg.stage, msg.config)
          if (rpcId) postMessage({ type: "_rpc", _rpcId: rpcId, ok: true })
          break
        }
        case "presets.list": {
          log?.log("debug", "presets_list", `pipelineType=${msg.pipelineType}`)
          const presets = await client.listPresets(msg.pipelineType)
          postMessage({ type: "presets.state", pipelineType: msg.pipelineType, presets })
          if (rpcId) postMessage({ type: "_rpc", _rpcId: rpcId, ok: true })
          break
        }
        case "presets.save": {
          log?.log("info", "presets_save", `name=${msg.name}`)
          await client.savePreset(msg.pipelineType, msg.name, msg.stageModels)
          const presets = await client.listPresets(msg.pipelineType)
          postMessage({ type: "presets.state", pipelineType: msg.pipelineType, presets })
          if (rpcId) postMessage({ type: "_rpc", _rpcId: rpcId, ok: true })
          break
        }
        case "presets.delete": {
          log?.log("info", "presets_delete", `presetId=${msg.presetId}`)
          await client.deletePreset(msg.presetId)
          if (rpcId) postMessage({ type: "_rpc", _rpcId: rpcId, ok: true })
          break
        }
        default:
          log?.log("info", "unhandled_message_type", `type=${msg.type}`)
          break
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      log?.log("error", "bridge_error", `${msg.type}: ${errMsg}`)
      if (rpcId) {
        postMessage({ type: "_rpc", _rpcId: rpcId, error: errMsg })
      } else {
        postMessage({
          type: "error",
          code: "BRIDGE_ERROR",
          message: errMsg,
        })
      }
    }
  }

  /** Extract subagent child session IDs from message parts and fetch their messages */
  function fetchSubagentMessages(client: AtelierClient, messages: any[]) {
    const childSessionIds = new Set<string>()
    for (const entry of messages) {
      for (const part of entry.parts ?? []) {
        if (part.type === "tool" && part.tool === "task") {
          const sid = part.state?.metadata?.sessionId
          if (typeof sid === "string" && sid.startsWith("subagent-")) {
            childSessionIds.add(sid)
          }
        }
      }
    }
    log?.log("debug", "subagent_sessions_found", `count=${childSessionIds.size}`)
    for (const sid of childSessionIds) {
      client.getMessages(sid, { limit: SESSION_PAGE_SIZE }).then((page) => {
        if (page.messages.length > 0) {
          postMessage({
            type: "messages",
            messages: page.messages,
            sessionId: sid,
            start: page.start,
            end: page.end,
            total: page.total,
            direction: "replace",
          })
        }
      }).catch(() => {})
    }
  }

  return { handleMessage }
}
