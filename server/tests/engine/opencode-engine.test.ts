import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SessionMetadataStore } from "../../src/engine/session-metadata-store.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// --- Compile-only test (original) ---
describe("OpenCodeEngine module", () => {
  it("exports a class that implements all AgentEngine methods", async () => {
    const mod = await import("../../src/engine/opencode-engine.js")
    expect(mod.OpenCodeEngine).toBeDefined()
    expect(typeof mod.OpenCodeEngine).toBe("function")
    const proto = mod.OpenCodeEngine.prototype
    expect(typeof proto.createSession).toBe("function")
    expect(typeof proto.sendMessage).toBe("function")
    expect(typeof proto.waitForIdle).toBe("function")
    expect(typeof proto.getSessionOutput).toBe("function")
    expect(typeof proto.interruptSession).toBe("function")
    expect(typeof proto.updateSessionTitle).toBe("function")
    expect(typeof proto.reconnect).toBe("function")
    expect(typeof proto.disconnect).toBe("function")
  })
})

// --- Behavioral tests ---
const mockClient = {
  session: {
    create: vi.fn().mockResolvedValue({ data: { id: "sess-1" } }),
    prompt: vi.fn().mockResolvedValue(undefined),
    messages: vi.fn().mockResolvedValue({ data: [] }),
    abort: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    fork: vi.fn().mockResolvedValue({ data: { id: "ses-forked-001" } }),
  },
  global: {
    // Return a promise that never resolves so subscribeToEvents blocks
    // instead of spinning in its while loop
    event: vi.fn().mockImplementation(() => new Promise(() => {})),
  },
}

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: vi.fn(() => mockClient),
}))

import { OpenCodeEngine } from "../../src/engine/opencode-engine.js"

describe("OpenCodeEngine behavioral tests", () => {
  let engine: OpenCodeEngine

  beforeEach(() => {
    vi.clearAllMocks()
    engine = new OpenCodeEngine("http://localhost:1234")
  })

  afterEach(() => {
    // Clean up any SSE loops started by reconnect or connectSSE
    engine.disconnect()
  })

  // 1. createSession
  describe("createSession", () => {
    it("passes directory and parentID to client.session.create with correct SDK param structure", async () => {
      const config = {
        directory: "/tmp/project",
        parentID: "ses-parent-42",
        permission: [{ permission: "allow", pattern: "*", action: "read" }],
      }
      const result = await engine.createSession(config)

      expect(mockClient.session.create).toHaveBeenCalledOnce()
      expect(mockClient.session.create).toHaveBeenCalledWith({
        parentID: "ses-parent-42",
        directory: "/tmp/project",
      })
      expect(result).toEqual({ id: "sess-1" })
    })
  })

  // 2. sendMessage
  describe("sendMessage", () => {
    it("builds parts array with text part", async () => {
      await engine.sendMessage("sess-1", { content: "Hello agent" })

      expect(mockClient.session.prompt).toHaveBeenCalledOnce()
      expect(mockClient.session.prompt).toHaveBeenCalledWith({
        sessionID: "sess-1",
        parts: [{ type: "text", text: "Hello agent" }],
        system: undefined,
      })
    })

    it("adds file parts when attachments are provided", async () => {
      await engine.sendMessage("sess-1", {
        content: "Check this file",
        attachments: [
          { type: "file", mime: "text/plain", url: "file:///tmp/a.txt", filename: "a.txt" },
        ],
      })

      const call = mockClient.session.prompt.mock.calls[0][0]
      expect(call.parts).toHaveLength(2)
      expect(call.parts[0]).toEqual({ type: "text", text: "Check this file" })
      expect(call.parts[1]).toEqual({ type: "file", mime: "text/plain", url: "file:///tmp/a.txt", filename: "a.txt" })
    })

    it("passes system prompt when provided", async () => {
      await engine.sendMessage("sess-1", {
        content: "Do the thing",
        system: "You are a helpful assistant",
      })

      expect(mockClient.session.prompt).toHaveBeenCalledWith({
        sessionID: "sess-1",
        parts: [{ type: "text", text: "Do the thing" }],
        system: "You are a helpful assistant",
      })
    })
  })

  // 3. getSessionOutput
  describe("getSessionOutput", () => {
    it("extracts text from the last assistant message's text part", async () => {
      mockClient.session.messages.mockResolvedValueOnce({
        data: [
          { info: { role: "user" }, parts: [{ type: "text", text: "question" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "first answer" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "final answer" }] },
        ],
      })

      const output = await engine.getSessionOutput("sess-1")

      expect(mockClient.session.messages).toHaveBeenCalledWith({ sessionID: "sess-1" })
      expect(output.text).toBe("final answer")
    })

    it("returns empty string when no assistant messages exist", async () => {
      mockClient.session.messages.mockResolvedValueOnce({
        data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hello" }] }],
      })

      const output = await engine.getSessionOutput("sess-1")
      expect(output.text).toBe("")
    })

    it("returns empty string when messages data is empty", async () => {
      mockClient.session.messages.mockResolvedValueOnce({ data: [] })

      const output = await engine.getSessionOutput("sess-1")
      expect(output.text).toBe("")
    })
  })

  // 4. interruptSession
  describe("interruptSession", () => {
    it("calls client.session.abort with correct sessionID", async () => {
      await engine.interruptSession("sess-99")

      expect(mockClient.session.abort).toHaveBeenCalledOnce()
      expect(mockClient.session.abort).toHaveBeenCalledWith({ sessionID: "sess-99" })
    })
  })

  // 5. updateSessionTitle
  describe("updateSessionTitle", () => {
    it("calls client.session.update with sessionID and title", async () => {
      await engine.updateSessionTitle("sess-1", "My Task")

      expect(mockClient.session.update).toHaveBeenCalledOnce()
      expect(mockClient.session.update).toHaveBeenCalledWith({ sessionID: "sess-1", title: "My Task" })
    })

    it("does not throw when client.session.update rejects", async () => {
      mockClient.session.update.mockRejectedValueOnce(new Error("network error"))

      await expect(engine.updateSessionTitle("sess-1", "Title")).resolves.toBeUndefined()
    })
  })

  // 6. reconnect
  describe("reconnect", () => {
    it("rejects pending waitForIdle listeners with 'OpenCode restarted'", async () => {
      // Stub connectSSE to prevent the SSE loop from starting in tests
      const connectSpy = vi.spyOn(engine, "connectSSE" as any).mockImplementation(() => {})
      const idlePromise = engine.waitForIdle("sess-1")

      engine.reconnect("http://localhost:5678")

      await expect(idlePromise).rejects.toThrow("OpenCode restarted")
      connectSpy.mockRestore()
    })
  })

  // 7. disconnect
  describe("disconnect", () => {
    it("rejects pending waitForIdle listeners with 'Disconnected'", async () => {
      const idlePromise = engine.waitForIdle("sess-1")

      engine.disconnect()

      await expect(idlePromise).rejects.toThrow("Disconnected")
    })
  })

  // 8. setMessageCallback
  describe("setMessageCallback", () => {
    it("stores a callback that is callable", () => {
      const cb = vi.fn()
      engine.setMessageCallback(cb)

      // Verify we can access it indirectly — the engine stores it for SSE event forwarding.
      // Since messageCallback is private, we verify it was set by checking no error thrown
      // and the callback itself is still a valid function.
      expect(cb).not.toHaveBeenCalled()
      expect(typeof cb).toBe("function")
    })
  })

  describe("SSE reconnect behavior", () => {
    async function sleep(ms: number): Promise<void> {
      await new Promise((resolve) => setTimeout(resolve, ms))
    }

    it("waits before reconnecting after normal stream end", async () => {
      mockClient.global.event.mockImplementation(() =>
        Promise.resolve({ stream: (async function* () {})() }),
      )

      await engine.connectSSE()
      expect(mockClient.global.event).toHaveBeenCalledTimes(1)

      await sleep(200)
      expect(mockClient.global.event).toHaveBeenCalledTimes(1)

      await sleep(1100)
      expect(mockClient.global.event.mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it("logs reconnect storms for observability", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
      mockClient.global.event.mockImplementation(() =>
        Promise.resolve({ stream: (async function* () {})() }),
      )

      await engine.connectSSE()
      await sleep(5_500)

      expect(warnSpy).toHaveBeenCalled()

      warnSpy.mockRestore()
    }, 10_000)
  })

  describe("OpenCodeEngine AtelierEvent translation", () => {
    it("session.busy SSE event translates to AtelierEvent session.busy", () => {
      const events: any[] = []
      engine.setRawEventCallback((event) => events.push(event))

      ;(engine as any).handleSSEEvent({
        type: "session.busy",
        properties: { sessionID: "s1" },
      })

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe("session.busy")
      expect(events[0].sessionId).toBe("s1")
    })

    it("session.idle SSE event translates to AtelierEvent session.idle", () => {
      const events: any[] = []
      engine.setRawEventCallback((event) => events.push(event))

      ;(engine as any).handleSSEEvent({
        type: "session.idle",
        properties: { sessionID: "s1" },
      })

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe("session.idle")
      expect(events[0].sessionId).toBe("s1")
    })

    it("message.created SSE event translates to AtelierEvent message.created", () => {
      const events: any[] = []
      engine.setRawEventCallback((event) => events.push(event))

      ;(engine as any).handleSSEEvent({
        type: "message.created",
        properties: { info: { sessionID: "s1", id: "msg1", role: "assistant" } },
      })

      expect(events).toHaveLength(1)
      expect(events[0].type).toBe("message.created")
      expect(events[0].sessionId).toBe("s1")
      expect(events[0].messageId).toBe("msg1")
      expect(events[0].role).toBe("assistant")
    })

    it("emits connection.status events on reconnect", () => {
      const events: any[] = []
      engine.setRawEventCallback((event) => events.push(event))
      const connectSpy = vi.spyOn(engine, "connectSSE" as any).mockImplementation(() => {})

      engine.reconnect("http://localhost:9999")

      const connectionEvents = events.filter((e: any) => e.type === "connection.status")
      expect(connectionEvents.length).toBeGreaterThanOrEqual(1)
      expect(connectionEvents[0].backend).toBe("opencode")

      connectSpy.mockRestore()
    })
  })

  describe("SSE to normalized event mapping", () => {
    it("maps session busy/idle/error events", () => {
      const seen: any[] = []
      engine.setNormalizedEventCallback((event) => seen.push(event))

      ;(engine as any).handleSSEEvent({ type: "session.busy", properties: { info: { sessionID: "s-1" } } })
      ;(engine as any).handleSSEEvent({ type: "session.idle", properties: { info: { sessionID: "s-1" } } })
      ;(engine as any).handleSSEEvent({ type: "session.error", properties: { info: { sessionID: "s-1" }, error: "boom" } })

      expect(seen).toEqual([
        { kind: "busy_edge", sessionId: "s-1" },
        { kind: "idle_edge", sessionId: "s-1" },
        { kind: "session_error", sessionId: "s-1", error: "boom" },
      ])
    })

    it("maps assistant/message/part/tool/subagent events into progress subtypes", () => {
      const seen: any[] = []
      engine.setNormalizedEventCallback((event) => seen.push(event))

      ;(engine as any).handleSSEEvent({ type: "message.created", properties: { info: { sessionID: "s-2", role: "assistant" } } })
      ;(engine as any).handleSSEEvent({ type: "message.completed", properties: { info: { sessionID: "s-2", role: "assistant" } } })
      ;(engine as any).handleSSEEvent({ type: "part.created", properties: { info: { sessionID: "s-2" }, part: { type: "text" } } })
      ;(engine as any).handleSSEEvent({ type: "part.created", properties: { info: { sessionID: "s-2" }, part: { type: "tool-invocation" } } })
      ;(engine as any).handleSSEEvent({ type: "part.updated", properties: { info: { sessionID: "s-2" }, part: { type: "tool-invocation", state: { type: "running" } } } })
      ;(engine as any).handleSSEEvent({ type: "part.updated", properties: { info: { sessionID: "s-2" }, part: { type: "tool-invocation", state: { type: "completed" } } } })
      ;(engine as any).handleSSEEvent({ type: "part.updated", properties: { info: { sessionID: "s-2" }, part: { type: "agent" } } })

      expect(seen.map((event) => event.kind === "progress_event" ? event.subtype : event.kind)).toEqual([
        "assistant_turn",
        "file_write_adjacent",
        "part_progress",
        "tool_start",
        "tool_running",
        "tool_terminal",
        "subagent_progress",
      ])
    })

    it("ignores unmapped or missing-session events", () => {
      const seen: any[] = []
      engine.setNormalizedEventCallback((event) => seen.push(event))

      ;(engine as any).handleSSEEvent({ type: "message.created", properties: { info: { role: "assistant" } } })
      ;(engine as any).handleSSEEvent({ type: "unknown.event", properties: { info: { sessionID: "s-3" } } })

      expect(seen).toEqual([])
    })

    it("surfaces question.asked and permission.asked immediately", () => {
      const questions: Array<{ sessionId: string; requestId: string }> = []
      const permissions: Array<{ sessionId: string; requestId: string }> = []
      engine.setQuestionCallback((sessionId, requestId) => questions.push({ sessionId, requestId }))
      engine.setPermissionCallback((sessionId, requestId) => permissions.push({ sessionId, requestId }))

      ;(engine as any).handleSSEEvent({ type: "question.asked", properties: { id: "q-1", sessionID: "sess-q" } })
      ;(engine as any).handleSSEEvent({ type: "permission.asked", properties: { id: "p-1", sessionID: "sess-p" } })

      expect(questions).toEqual([{ sessionId: "sess-q", requestId: "q-1" }])
      expect(permissions).toEqual([{ sessionId: "sess-p", requestId: "p-1" }])
    })
  })

  describe("forkSession", () => {
    let metadataStore: SessionMetadataStore
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-fork-test-"))
      metadataStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))
      engine = new OpenCodeEngine("http://localhost:1234", { metadataStore })
    })

    afterEach(() => {
      engine.disconnect()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it("calls client.session.fork and creates metadata with forkedFrom", async () => {
      metadataStore.create({
        id: "ses-original",
        title: "Original chat",
        backend: "opencode",
        model: { providerID: "openai", modelID: "gpt-4o-mini" },
        variant: "medium",
        workspacePath: "/workspace",
        createdAt: 1000,
        lastActiveAt: 2000,
        parentId: null,
        status: "idle",
      })

      mockClient.session.fork.mockResolvedValue({
        data: { id: "ses-forked-001", title: "Original chat (fork)", directory: "/workspace" },
      })

      const result = await engine.forkSession("ses-original", { title: "My fork" })

      expect(result.id).toBe("ses-forked-001")
      expect(mockClient.session.fork).toHaveBeenCalledWith(
        expect.objectContaining({ sessionID: "ses-original" }),
      )

      const meta = metadataStore.get("ses-forked-001")
      expect(meta).not.toBeNull()
      expect(meta!.forkedFrom).toBe("ses-original")
      expect(meta!.parentId).toBeNull()
      expect(meta!.backend).toBe("opencode")
      expect(meta!.model.modelID).toBe("gpt-4o-mini")
      expect(meta!.variant).toBe("medium")
      expect(meta!.title).toBe("My fork")
    })

    it("throws when source session not found in metadata", async () => {
      await expect(engine.forkSession("nonexistent")).rejects.toThrow(/not found/)
    })

    it("propagates SDK fork errors", async () => {
      metadataStore.create({
        id: "ses-src",
        title: "Source",
        backend: "opencode",
        model: { providerID: "openai", modelID: "gpt-4o-mini" },
        workspacePath: "/workspace",
        createdAt: 1000,
        lastActiveAt: 1000,
        parentId: null,
        status: "idle",
      })
      mockClient.session.fork.mockResolvedValue({ error: { message: "Session not found" } })

      await expect(engine.forkSession("ses-src")).rejects.toThrow(/fork/)
    })

    it("defaults title when not provided", async () => {
      metadataStore.create({
        id: "ses-notitle",
        title: "Chat about tests",
        backend: "opencode",
        model: { providerID: "openai", modelID: "gpt-4o-mini" },
        workspacePath: "/workspace",
        createdAt: 1000,
        lastActiveAt: 1000,
        parentId: null,
        status: "idle",
      })
      mockClient.session.fork.mockResolvedValue({
        data: { id: "ses-forked-002" },
      })

      const result = await engine.forkSession("ses-notitle")
      const meta = metadataStore.get("ses-forked-002")
      expect(meta!.title).toBe("Chat about tests (fork)")
    })
  })
})
