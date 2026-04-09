import type { Logger } from "@atelier/core"
import type { ActivePipeline, QuestionPermissionProxy } from "./helpers.js"

export interface AutoInterventionDeps {
  logger: Logger
  proxy?: QuestionPermissionProxy
  findPipelineBySession: (sessionId: string) => ActivePipeline | null
  onInteractionReplied?: (sessionId: string, requestId: string) => void
}

/** Auto-reply to a permission request during a pipeline stage. */
export async function handleAutoPermission(deps: AutoInterventionDeps, sessionId: string, requestId: string): Promise<void> {
  const active = deps.findPipelineBySession(sessionId)
  if (!active) return
  const stageId = active.sessionMap.get(sessionId)
  if (!stageId) return

  deps.logger.info("atelier", "stage", "permission_auto_replied", {
    pipelineId: active.id, stageId,
    data: { requestId },
  })

  try {
    await deps.proxy?.replyPermission(sessionId, requestId, "always")
    deps.onInteractionReplied?.(sessionId, requestId)
  } catch (err) {
    deps.logger.error("atelier", "stage", "permission_reply_failed", {
      error: (err as Error).message,
    })
  }
}
