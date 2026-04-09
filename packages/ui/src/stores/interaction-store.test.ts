import { describe, it, expect } from "vitest"
import { createRoot } from "solid-js"
import { createInteractionStore } from "./interaction-store.js"
import type { Event } from "@atelier/core"

const S1 = new Set(["s1"])
const S2 = new Set(["s2"])
const ALL = new Set(["s1", "s2"])

describe("InteractionStore", () => {
  it("initializes with no pending requests", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      expect(store.pendingPermissionFor(S1)).toBeNull()
      expect(store.pendingQuestionFor(S1)).toBeNull()
      dispose()
    })
  })

  it("sets pending permission on permission.asked", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      store.handleEvent({
        type: "permission.asked",
        properties: {
          id: "perm1",
          sessionID: "s1",
          permission: "bash",
          patterns: ["*"],
          metadata: {},
          always: [],
        },
      } as Event)
      expect(store.pendingPermissionFor(S1)?.id).toBe("perm1")
      dispose()
    })
  })

  it("clears permission on permission.replied", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      store.handleEvent({
        type: "permission.asked",
        properties: {
          id: "perm1",
          sessionID: "s1",
          permission: "bash",
          patterns: [],
          metadata: {},
          always: [],
        },
      } as Event)
      store.handleEvent({
        type: "permission.replied",
        properties: { sessionID: "s1", requestID: "perm1", reply: "once" },
      } as Event)
      expect(store.pendingPermissionFor(S1)).toBeNull()
      dispose()
    })
  })

  it("sets pending question on question.asked", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      store.handleEvent({
        type: "question.asked",
        properties: {
          id: "q1",
          sessionID: "s1",
          questions: [
            {
              question: "Which?",
              header: "Choice",
              options: [{ label: "A", description: "Option A" }],
            },
          ],
        },
      } as Event)
      expect(store.pendingQuestionFor(S1)?.id).toBe("q1")
      dispose()
    })
  })

  it("clears question on question.replied and adds to completed", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      store.handleEvent({
        type: "question.asked",
        properties: {
          id: "q1",
          sessionID: "s1",
          questions: [
            {
              question: "Which?",
              header: "Choice",
              options: [{ label: "A", description: "Option A" }],
            },
          ],
        },
      } as Event)
      store.handleEvent({
        type: "question.replied",
        properties: { sessionID: "s1", requestID: "q1", answers: [["A"]] },
      } as Event)
      expect(store.pendingQuestionFor(S1)).toBeNull()
      // question.replied via event (not completeQuestion) moves to completed
      const completed = store.completedQuestionsFor(S1)
      expect(completed).toHaveLength(1)
      expect(completed[0]!.request.id).toBe("q1")
      expect(completed[0]!.rejected).toBe(false)
      dispose()
    })
  })

  it("clears question on question.rejected and adds to completed as rejected", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      store.handleEvent({
        type: "question.asked",
        properties: {
          id: "q1",
          sessionID: "s1",
          questions: [
            {
              question: "Which?",
              header: "Choice",
              options: [{ label: "A", description: "Option A" }],
            },
          ],
        },
      } as Event)
      store.handleEvent({
        type: "question.rejected",
        properties: { sessionID: "s1", requestID: "q1" },
      } as Event)
      expect(store.pendingQuestionFor(S1)).toBeNull()
      const completed = store.completedQuestionsFor(S1)
      expect(completed).toHaveLength(1)
      expect(completed[0]!.rejected).toBe(true)
      dispose()
    })
  })

  it("completeQuestion moves question to completed with answers", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      store.handleEvent({
        type: "question.asked",
        properties: {
          id: "q1",
          sessionID: "s1",
          questions: [
            {
              question: "Which?",
              header: "Choice",
              options: [{ label: "A", description: "Option A" }, { label: "B", description: "Option B" }],
            },
          ],
        },
      } as Event)
      store.completeQuestion("s1", [["B"]], false)
      expect(store.pendingQuestionFor(S1)).toBeNull()
      const completed = store.completedQuestionsFor(S1)
      expect(completed).toHaveLength(1)
      expect(completed[0]!.answers).toEqual([["B"]])
      expect(completed[0]!.rejected).toBe(false)
      dispose()
    })
  })

  it("completeQuestion as rejected stores dismissed state", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      store.handleEvent({
        type: "question.asked",
        properties: {
          id: "q1",
          sessionID: "s1",
          questions: [
            {
              question: "Which?",
              header: "Choice",
              options: [{ label: "A", description: "Option A" }],
            },
          ],
        },
      } as Event)
      store.completeQuestion("s1", undefined, true)
      expect(store.pendingQuestionFor(S1)).toBeNull()
      const completed = store.completedQuestionsFor(S1)
      expect(completed).toHaveLength(1)
      expect(completed[0]!.rejected).toBe(true)
      expect(completed[0]!.answers).toBeUndefined()
      dispose()
    })
  })

  it("does not duplicate completed when completeQuestion is called before event", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      store.handleEvent({
        type: "question.asked",
        properties: {
          id: "q1",
          sessionID: "s1",
          questions: [{ question: "Which?", header: "Choice", options: [{ label: "A", description: "Option A" }] }],
        },
      } as Event)
      // UI calls completeQuestion first
      store.completeQuestion("s1", [["A"]], false)
      // Then the server event arrives — question is already gone from pending so no duplicate
      store.handleEvent({
        type: "question.replied",
        properties: { sessionID: "s1", requestID: "q1" },
      } as Event)
      expect(store.completedQuestionsFor(S1)).toHaveLength(1)
      dispose()
    })
  })

  it("replaces previous permission with new one", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      store.handleEvent({
        type: "permission.asked",
        properties: {
          id: "perm1",
          sessionID: "s1",
          permission: "bash",
          patterns: [],
          metadata: {},
          always: [],
        },
      } as Event)
      store.handleEvent({
        type: "permission.asked",
        properties: {
          id: "perm2",
          sessionID: "s1",
          permission: "edit",
          patterns: [],
          metadata: {},
          always: [],
        },
      } as Event)
      expect(store.pendingPermissionFor(S1)?.id).toBe("perm2")
      dispose()
    })
  })

  it("scopes questions to matching session IDs only", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      store.handleEvent({
        type: "question.asked",
        properties: {
          id: "q1",
          sessionID: "s2",
          questions: [{ question: "Which?", header: "Choice", options: [{ label: "A", description: "Option A" }] }],
        },
      } as Event)
      // s2 question should NOT appear when querying for s1
      expect(store.pendingQuestionFor(S1)).toBeNull()
      // but should appear when querying for s2 or the full set
      expect(store.pendingQuestionFor(S2)?.id).toBe("q1")
      expect(store.pendingQuestionFor(ALL)?.id).toBe("q1")
      dispose()
    })
  })

  it("scopes permissions to matching session IDs only", () => {
    createRoot((dispose) => {
      const store = createInteractionStore()
      store.handleEvent({
        type: "permission.asked",
        properties: {
          id: "perm1",
          sessionID: "s2",
          permission: "bash",
          patterns: [],
          metadata: {},
          always: [],
        },
      } as Event)
      expect(store.pendingPermissionFor(S1)).toBeNull()
      expect(store.pendingPermissionFor(S2)?.id).toBe("perm1")
      expect(store.pendingPermissionFor(ALL)?.id).toBe("perm1")
      dispose()
    })
  })
})
