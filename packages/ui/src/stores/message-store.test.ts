import { describe, it, expect } from "vitest"
import { createRoot } from "solid-js"
import { createMessageStore } from "./message-store.js"
import type { Message, Part, Event } from "@atelier/core"

const makeUserMsg = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "user" as const,
  time: { created: Date.now() },
  agent: "coder",
  model: { providerID: "anthropic", modelID: "claude" },
})

const makeAssistantMsg = (id: string, sessionID: string): Message => ({
  id,
  sessionID,
  role: "assistant" as const,
  time: { created: Date.now() },
  parentID: "u1",
  modelID: "claude",
  providerID: "anthropic",
  mode: "default",
  agent: "coder",
  path: { cwd: "/", root: "/" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
})

const makeTextPart = (id: string, msgId: string, sessionID: string): Part => ({
  id,
  sessionID,
  messageID: msgId,
  type: "text" as const,
  text: "hello",
})

describe("Flat session-indexed MessageStore", () => {
  it("stores messages for any sessionID without registration", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      const event = {
        type: "message.updated" as const,
        properties: {
          info: makeUserMsg("u1", "unknown-session"),
        },
      }
      store.handleEvent(event as Event)
      const msgs = store.messages("unknown-session")
      expect(msgs).toHaveLength(1)
      dispose()
    })
  })

  it("messages() returns messages for a specific sessionId", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      store.handleEvent({
        type: "message.updated" as const,
        properties: { info: makeUserMsg("u1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.updated" as const,
        properties: { info: makeUserMsg("u2", "s2") },
      } as Event)
      expect(store.messages("s1")).toHaveLength(1)
      expect(store.messages("s2")).toHaveLength(1)
      dispose()
    })
  })

  it("messages() returns empty for unknown session", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      expect(store.messages("nonexistent")).toHaveLength(0)
      dispose()
    })
  })

  it("handles message.part.updated event", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      store.handleEvent({
        type: "message.updated",
        properties: { info: makeAssistantMsg("a1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.part.updated",
        properties: { part: makeTextPart("p1", "a1", "s1") },
      } as Event)
      const parts = store.getParts("s1", "a1")
      expect(parts).toHaveLength(1)
      expect(parts[0]!.type).toBe("text")
      dispose()
    })
  })

  it("handles message.part.delta event for text", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      store.handleEvent({
        type: "message.updated",
        properties: { info: makeAssistantMsg("a1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.part.updated",
        properties: { part: makeTextPart("p1", "a1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "s1",
          messageID: "a1",
          partID: "p1",
          field: "text",
          delta: " world",
        },
      } as Event)
      const parts = store.getParts("s1", "a1")
      expect((parts[0] as any).text).toBe("hello world")
      dispose()
    })
  })

  it("handles message.part.removed event", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      store.handleEvent({
        type: "message.updated",
        properties: { info: makeAssistantMsg("a1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.part.updated",
        properties: { part: makeTextPart("p1", "a1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.part.removed",
        properties: { sessionID: "s1", messageID: "a1", partID: "p1" },
      } as Event)
      expect(store.getParts("s1", "a1")).toHaveLength(0)
      dispose()
    })
  })

  it("handles message.removed event", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      store.handleEvent({
        type: "message.updated",
        properties: { info: makeAssistantMsg("a1", "s1") },
      } as Event)
      expect(store.messages("s1")).toHaveLength(1)
      store.handleEvent({
        type: "message.removed",
        properties: { sessionID: "s1", messageID: "a1" },
      } as Event)
      expect(store.messages("s1")).toHaveLength(0)
      dispose()
    })
  })

  it("rejects delta for disallowed fields", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      store.handleEvent({
        type: "message.updated",
        properties: { info: makeAssistantMsg("a1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.part.updated",
        properties: { part: makeTextPart("p1", "a1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "s1",
          messageID: "a1",
          partID: "p1",
          field: "id",
          delta: "injected",
        },
      } as Event)
      const parts = store.getParts("s1", "a1")
      expect((parts[0] as any).text).toBe("hello")
      dispose()
    })
  })

  it("increments deltaVersion on part delta", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      const initial = store.deltaVersion()
      store.handleEvent({
        type: "message.updated",
        properties: { info: makeAssistantMsg("a1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.part.updated",
        properties: { part: makeTextPart("p1", "a1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "s1",
          messageID: "a1",
          partID: "p1",
          field: "text",
          delta: " world",
        },
      } as Event)
      expect(store.deltaVersion()).toBe(initial + 2)
      dispose()
    })
  })

  it("scopes deltaVersion per session", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      // Setup two sessions with messages and parts
      store.handleEvent({ type: "message.updated", properties: { info: makeAssistantMsg("a1", "s1") } } as Event)
      store.handleEvent({ type: "message.part.updated", properties: { part: makeTextPart("p1", "a1", "s1") } } as Event)
      store.handleEvent({ type: "message.updated", properties: { info: makeAssistantMsg("a2", "s2") } } as Event)
      store.handleEvent({ type: "message.part.updated", properties: { part: makeTextPart("p2", "a2", "s2") } } as Event)

      const v1Before = store.deltaVersion("s1")
      const v2Before = store.deltaVersion("s2")

      // Delta in session s2 only
      store.handleEvent({
        type: "message.part.delta",
        properties: { sessionID: "s2", messageID: "a2", partID: "p2", field: "text", delta: " more" },
      } as Event)

      expect(store.deltaVersion("s1")).toBe(v1Before) // s1 unchanged
      expect(store.deltaVersion("s2")).toBe(v2Before + 1) // s2 incremented
      dispose()
    })
  })

  it("tokenUsage scoped to session", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      expect(store.tokenUsage("s1")).toBeUndefined()
      dispose()
    })
  })

  it("handles delta before message.part.updated gracefully", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      store.handleEvent({
        type: "message.updated",
        properties: { info: makeAssistantMsg("a1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "s1",
          messageID: "a1",
          partID: "p1",
          field: "text",
          delta: "hello",
        },
      } as Event)
      expect(store.getParts("s1", "a1")).toHaveLength(0)
      dispose()
    })
  })

  it("handles out-of-order: message.part.updated upserts existing", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      store.handleEvent({
        type: "message.updated",
        properties: { info: makeAssistantMsg("a1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.part.updated",
        properties: { part: { ...makeTextPart("p1", "a1", "s1"), text: "v1" } },
      } as Event)
      store.handleEvent({
        type: "message.part.updated",
        properties: { part: { ...makeTextPart("p1", "a1", "s1"), text: "v2" } },
      } as Event)
      const parts = store.getParts("s1", "a1")
      expect(parts).toHaveLength(1)
      expect((parts[0] as any).text).toBe("v2")
      dispose()
    })
  })

  it("multiple sessions coexist independently", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      store.handleEvent({
        type: "message.updated",
        properties: { info: makeUserMsg("u1", "s1") },
      } as Event)
      store.handleEvent({
        type: "message.updated",
        properties: { info: makeUserMsg("u2", "s2") },
      } as Event)
      store.handleEvent({
        type: "message.updated",
        properties: { info: makeUserMsg("u3", "s1") },
      } as Event)
      expect(store.messages("s1")).toHaveLength(2)
      expect(store.messages("s2")).toHaveLength(1)
      dispose()
    })
  })

  it("tracks pagination window metadata", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      store.applyMessagePage(
        "s1",
        [{ message: makeUserMsg("u3", "s1"), parts: [] }],
        { start: 2, total: 5, direction: "replace" },
      )
      const info = store.windowInfo("s1")
      expect(info.start).toBe(2)
      expect(info.end).toBe(3)
      expect(info.hasOlder).toBe(true)
      expect(info.hasNewer).toBe(true)
      dispose()
    })
  })

  it("caps in-memory window for long sessions", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      const msgs = Array.from({ length: 260 }, (_, i) => ({
        message: makeUserMsg(`u${i}`, "s1"),
        parts: [],
      }))
      store.applyMessagePage("s1", msgs, { start: 0, total: 260, direction: "replace" })
      expect(store.messages("s1").length).toBeLessThanOrEqual(240)
      expect(store.windowInfo("s1").hasOlder).toBe(true)
      dispose()
    })
  })

  it("keeps optimistic user message across replace pages until delivered", () => {
    createRoot((dispose) => {
      const store = createMessageStore()
      store.addOptimisticUserMessage("s1", "queued input")

      store.applyMessagePage("s1", [{ message: makeAssistantMsg("a1", "s1"), parts: [] }], {
        start: 0,
        total: 1,
        direction: "replace",
      })

      const pending = store.messages("s1")
      expect(pending.some((entry) => entry.message.role === "user")).toBe(true)

      store.handleEvent({
        type: "message.updated",
        properties: { info: makeUserMsg("u-real", "s1") },
      } as Event)

      const afterDelivery = store.messages("s1")
      expect(afterDelivery.some((entry) => entry.message.id.startsWith("optimistic-user-"))).toBe(false)
      expect(afterDelivery.some((entry) => entry.message.id === "u-real")).toBe(true)
      dispose()
    })
  })

  describe("skill metadata", () => {
    it("optimistic message carries skill name", () => {
      createRoot((dispose) => {
        const store = createMessageStore()
        store.addOptimisticUserMessage("s1", "Build an API", undefined, "brainstorming")
        const msgs = store.messages("s1")
        expect(msgs).toHaveLength(1)
        expect(msgs[0]!.skill).toBe("brainstorming")
        expect(store.getSkill("s1", msgs[0]!.message.id)).toBe("brainstorming")
        dispose()
      })
    })

    it("skill transfers from optimistic to real message via pendingSkillBySession", () => {
      createRoot((dispose) => {
        const store = createMessageStore()
        store.addOptimisticUserMessage("s1", "Build an API", undefined, "brainstorming")
        // Simulate message.updated for the real user message (triggers clearOptimisticUserMessage)
        store.handleEvent({
          type: "message.updated",
          properties: { info: makeUserMsg("u-real", "s1") },
        } as Event)
        const msgs = store.messages("s1")
        // Optimistic should be gone, real message should have the skill
        expect(msgs.some((m) => m.message.id.startsWith("optimistic-user-"))).toBe(false)
        expect(store.getSkill("s1", "u-real")).toBe("brainstorming")
        dispose()
      })
    })

    it("setPendingSkill attaches skill to next user message", () => {
      createRoot((dispose) => {
        const store = createMessageStore()
        store.setPendingSkill("s1", "bugfixing")
        // Simulate message.updated for a user message
        store.handleEvent({
          type: "message.updated",
          properties: { info: makeUserMsg("u1", "s1") },
        } as Event)
        expect(store.getSkill("s1", "u1")).toBe("bugfixing")
        dispose()
      })
    })

    it("skill survives applyMessagePage replace when pendingSkill is set", () => {
      createRoot((dispose) => {
        const store = createMessageStore()
        store.setPendingSkill("s1", "brainstorming")
        const userMsg = makeUserMsg("u1", "s1")
        const textPart = makeTextPart("p1", "u1", "s1")
        store.applyMessagePage("s1", [{ message: userMsg, parts: [textPart] }], { direction: "replace" })
        expect(store.getSkill("s1", "u1")).toBe("brainstorming")
        dispose()
      })
    })

    it("skill on optimistic message survives applyMessagePage replace by text match", () => {
      createRoot((dispose) => {
        const store = createMessageStore()
        store.addOptimisticUserMessage("s1", "Build an API", undefined, "brainstorming")
        // REST replace: incoming has the real user message with same text
        const userMsg = makeUserMsg("u-real", "s1")
        const textPart: Part = { id: "p1", sessionID: "s1", messageID: "u-real", type: "text" as const, text: "Build an API" }
        store.applyMessagePage("s1", [{ message: userMsg, parts: [textPart] }], { direction: "replace" })
        const msgs = store.messages("s1")
        // Optimistic should be gone (text matched and delivered)
        expect(msgs.some((m) => m.message.id.startsWith("optimistic-user-"))).toBe(false)
        // The real message should have the skill
        expect(store.getSkill("s1", "u-real")).toBe("brainstorming")
        dispose()
      })
    })
  })
})
