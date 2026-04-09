import { createSignal } from "solid-js"
import type { PermissionRequest, QuestionRequest, OpenCodeForwardedEvent } from "@atelier/core"

export interface CompletedQuestion {
  request: QuestionRequest
  answers?: string[][]
  rejected: boolean
}

export function createInteractionStore() {
  const [permissions, setPermissions] = createSignal(new Map<string, PermissionRequest>())
  const [questions, setQuestions] = createSignal(new Map<string, QuestionRequest>())
  const [completedQuestions, setCompletedQuestions] = createSignal<CompletedQuestion[]>([])

  /** Return the pending permission for one of the given session IDs (scoped to current tab). */
  const pendingPermissionFor = (sessionIds: Set<string>): PermissionRequest | null => {
    const map = permissions()
    for (const [sid, req] of map) {
      if (sessionIds.has(sid)) return req
    }
    return null
  }

  /** Return the pending question for one of the given session IDs (scoped to current tab). */
  const pendingQuestionFor = (sessionIds: Set<string>): QuestionRequest | null => {
    const map = questions()
    for (const [sid, req] of map) {
      if (sessionIds.has(sid)) return req
    }
    return null
  }

  /** Return completed questions for the given session IDs (scoped to current tab). */
  const completedQuestionsFor = (sessionIds: Set<string>): CompletedQuestion[] => {
    return completedQuestions().filter(cq => sessionIds.has(cq.request.sessionID))
  }

  /** Mark a pending question as completed (answered or rejected). Called from UI before sending to server. */
  function completeQuestion(sessionId: string, answers?: string[][], rejected = false) {
    const map = questions()
    const request = map.get(sessionId)
    if (!request) return
    setCompletedQuestions(prev => [...prev, { request, answers, rejected }])
    // Remove from pending immediately so the banner disappears
    setQuestions(prev => { const m = new Map(prev); m.delete(sessionId); return m })
  }

  function handleEvent(event: OpenCodeForwardedEvent) {
    switch (event.type) {
      case "permission.asked": {
        const sid = event.properties.sessionID
        setPermissions(prev => new Map(prev).set(sid, event.properties))
        break
      }
      case "permission.replied": {
        const sid = (event.properties as { sessionID: string }).sessionID
        setPermissions(prev => { const m = new Map(prev); m.delete(sid); return m })
        break
      }
      case "question.asked": {
        const sid = event.properties.sessionID
        setQuestions(prev => new Map(prev).set(sid, event.properties))
        break
      }
      case "question.replied":
      case "question.rejected": {
        // If the question was already moved to completed via completeQuestion(), just clean up.
        // If it wasn't (e.g. auto-aborted), move it to completed as rejected.
        const sid = (event.properties as { sessionID: string }).sessionID
        const map = questions()
        const request = map.get(sid)
        if (request) {
          const isRejected = event.type === "question.rejected"
          setCompletedQuestions(prev => [...prev, { request, rejected: isRejected }])
          setQuestions(prev => { const m = new Map(prev); m.delete(sid); return m })
        }
        break
      }
    }
  }

  return {
    pendingPermissionFor,
    pendingQuestionFor,
    completedQuestionsFor,
    completeQuestion,
    handleEvent,
  }
}

export type InteractionStore = ReturnType<typeof createInteractionStore>
