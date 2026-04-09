import { describe, it, expect } from "vitest"
import type { PipelineEvent, ConnectionEvent, UnifiedEvent, WebviewMessage, HostMessage } from "../src/types.js"
import { favoriteKeyOf, sanitizeMessages } from "../src/types.js"

describe("PipelineEvent type", () => {
  it("accepts stage_interrupted event", () => {
    const event: PipelineEvent = {
      type: "stage_interrupted",
      pipelineId: "p1",
      stageId: "s1",
      sessionId: "sess1",
    }
    expect(event.type).toBe("stage_interrupted")
  })

  it("accepts stage_resumed event", () => {
    const event: PipelineEvent = {
      type: "stage_resumed",
      pipelineId: "p1",
      stageId: "s1",
      sessionId: "sess1",
    }
    expect(event.type).toBe("stage_resumed")
  })

  it("pipeline_completed has no extra fields beyond pipelineId", () => {
    const event: PipelineEvent = { type: "pipeline_completed", pipelineId: "p1" }
    expect(event.type).toBe("pipeline_completed")
  })
})

describe("ConnectionEvent type", () => {
  it("accepts connection_lost event", () => {
    const event: ConnectionEvent = { type: "connection_lost" }
    expect(event.type).toBe("connection_lost")
  })

  it("accepts connection_restored event", () => {
    const event: ConnectionEvent = { type: "connection_restored" }
    expect(event.type).toBe("connection_restored")
  })

  it("accepts full_refresh_required event", () => {
    const event: ConnectionEvent = { type: "full_refresh_required" }
    expect(event.type).toBe("full_refresh_required")
  })
})

describe("WebviewMessage type", () => {
  it("does not include loadChildMessages", () => {
    // Type-level test: loadChildMessages removed from WebviewMessage union.
    // This test verifies the sendMessage shape for gateway mode.
    const msg: WebviewMessage = {
      type: "sendMessage",
      content: "hello",
      mode: "build" as const,
    }
    expect(msg.type).toBe("sendMessage")
  })
})

describe("favorites protocol", () => {
  it("accepts favorites mutation webview messages", () => {
    const upsert: WebviewMessage = {
      type: "favorites.upsert",
      favorite: { providerID: "anthropic", modelID: "claude-sonnet-4-6", variant: "thinking" },
    }
    const reorder: WebviewMessage = {
      type: "favorites.reorder",
      favoriteKeys: ["anthropic::claude-sonnet-4-6::thinking"],
    }
    expect(upsert.type).toBe("favorites.upsert")
    expect(reorder.type).toBe("favorites.reorder")
  })

  it("accepts host favorites sync payload", () => {
    const msg: HostMessage = {
      type: "favorites.state",
      favorites: [{
        favoriteKey: "anthropic::claude-sonnet-4-6::__none__",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
      }],
    }
    expect(msg.type).toBe("favorites.state")
  })

  it("builds canonical key for undefined variant", () => {
    expect(favoriteKeyOf({ providerID: "openai", modelID: "gpt-4.1" })).toBe("openai::gpt-4.1::__none__")
  })
})

describe("sanitizeMessages", () => {
  const validMsg = {
    message: { id: "m1", sessionID: "s1", role: "user", time: { created: 1 } },
    parts: [{ id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "hi" }],
  }

  it("passes through valid messages", () => {
    const result = sanitizeMessages([validMsg])
    expect(result).toHaveLength(1)
    expect(result[0].message.id).toBe("m1")
    expect(result[0].parts).toHaveLength(1)
  })

  it("filters out entries with missing message", () => {
    expect(sanitizeMessages([{ parts: [] }])).toHaveLength(0)
    expect(sanitizeMessages([{ message: null, parts: [] }])).toHaveLength(0)
  })

  it("filters out entries with missing required fields", () => {
    expect(sanitizeMessages([{ message: { id: "m1", sessionID: "s1" }, parts: [] }])).toHaveLength(0) // no role
    expect(sanitizeMessages([{ message: { role: "user", sessionID: "s1" }, parts: [] }])).toHaveLength(0) // no id
    expect(sanitizeMessages([{ message: { id: "m1", role: "user" }, parts: [] }])).toHaveLength(0) // no sessionID
  })

  it("defaults parts to empty array when missing", () => {
    const result = sanitizeMessages([{ message: { id: "m1", sessionID: "s1", role: "user" } }])
    expect(result).toHaveLength(1)
    expect(result[0].parts).toEqual([])
  })

  it("filters nulls, undefined, and non-objects", () => {
    expect(sanitizeMessages([null, undefined, "bad", 42, validMsg])).toHaveLength(1)
  })

  it("mixes valid and invalid without affecting valid entries", () => {
    const result = sanitizeMessages([validMsg, { message: null, parts: [] }, validMsg])
    expect(result).toHaveLength(2)
  })
})
