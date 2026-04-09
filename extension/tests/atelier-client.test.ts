import { describe, it, expect, vi, beforeEach } from "vitest"
import { createAtelierClient } from "../src/atelier-client.js"

// Mock fetch
const originalFetch = globalThis.fetch
const mockFetch = vi.fn()
globalThis.fetch = mockFetch as any

describe("AtelierClient", () => {
  let client: ReturnType<typeof createAtelierClient>

  beforeEach(() => {
    mockFetch.mockReset()
    client = createAtelierClient("http://localhost:3000")
  })

  it("listSessions calls GET /sessions", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: "s1" }],
      headers: new Headers({ "X-Atelier-Seq": "5" }),
    })
    const sessions = await client.listSessions()
    expect(sessions).toHaveLength(1)
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/sessions",
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("sendMessage calls POST /message", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
      headers: new Headers(),
    })
    const result = await client.sendMessage({
      content: "Hello",
      mode: "build",
      sessionId: "s1",
    })
    expect(result.ok).toBe(true)
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.content).toBe("Hello")
    expect(body.mode).toBe("build")
  })

  it("sendMessage for feature mode returns pipelineId", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pipelineId: "p1" }),
      headers: new Headers(),
    })
    const result = await client.sendMessage({
      content: "Build auth",
      mode: "feature",
    })
    expect(result.pipelineId).toBe("p1")
  })

  it("sendMessage passes pipelineId to server", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
      headers: new Headers(),
    })

    await client.sendMessage({
      content: "Add auth",
      mode: "feature",
      pipelineId: "p-123",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
    })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body).toMatchObject({
      content: "Add auth",
      mode: "feature",
      pipelineId: "p-123",
    })
  })

  it("abortSession calls POST /session/:id/abort", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }), headers: new Headers() })
    await client.abortSession("s1")
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/session/s1/abort",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("resumeSession calls POST /session/:id/resume", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }), headers: new Headers() })
    await client.resumeSession("s1")
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/session/s1/resume",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("throws on non-ok response with error body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "Pipeline active" }),
      headers: new Headers(),
    })
    await expect(client.sendMessage({ content: "Hello", mode: "build" }))
      .rejects.toThrow("Pipeline active")
  })

  it("replyPermission calls POST /session/:id/permission", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}), headers: new Headers() })
    await client.replyPermission("s1", "req1", "always")
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.requestId).toBe("req1")
    expect(body.reply).toBe("always")
  })

  it("getConfig calls GET /config", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ agents: [], models: [], workspacePath: "/tmp" }),
      headers: new Headers(),
    })
    const config = await client.getConfig()
    expect(config.workspacePath).toBe("/tmp")
  })

  it("getMessages calls GET /session/:id/messages", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [{ id: "m1" }], start: 0, end: 1, total: 1 }),
      headers: new Headers(),
    })
    const messages = await client.getMessages("s1")
    expect(messages.messages).toHaveLength(1)
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/session/s1/messages",
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("getMessages supports before/limit query params", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ messages: [], start: 0, end: 0, total: 0 }),
      headers: new Headers(),
    })
    await client.getMessages("s1", { before: 10, limit: 20 })
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/session/s1/messages?before=10&limit=20",
      expect.objectContaining({ method: "GET" }),
    )
  })

  it("listPipelines calls GET /pipelines", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: "p1" }],
      headers: new Headers(),
    })
    const pipelines = await client.listPipelines()
    expect(pipelines).toHaveLength(1)
  })

  it("getPipeline calls GET /pipeline/:id", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "p1", status: "completed" }),
      headers: new Headers(),
    })
    const pipeline = await client.getPipeline("p1")
    expect(pipeline.id).toBe("p1")
  })

  it("signalPipeline calls POST /pipeline/signal", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }), headers: new Headers() })
    await client.signalPipeline({ type: "stage_complete", sessionId: "s1", outputPath: "spec.md" })
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.type).toBe("stage_complete")
    expect(body.sessionId).toBe("s1")
  })

  it("replyQuestion calls POST /session/:id/question", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}), headers: new Headers() })
    await client.replyQuestion("s1", "req1", [["yes"]])
    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.requestId).toBe("req1")
    expect(body.answers).toEqual([["yes"]])
  })

  it("rejectQuestion calls POST /session/:id/question/reject", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}), headers: new Headers() })
    await client.rejectQuestion("s1", "req1")
    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/session/s1/question/reject",
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("health calls GET /health", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "ready", backends: { "claude-code": "ready" } }),
      headers: new Headers(),
    })
    const health = await client.health()
    expect(health.status).toBe("ready")
  })
})

describe("SSE connection", () => {
  let client: ReturnType<typeof createAtelierClient>

  beforeEach(() => {
    mockFetch.mockReset()
    client = createAtelierClient("http://localhost:3000")
  })

  it("connect() establishes SSE connection and forwards events to onEvent handler", async () => {
    const received: any[] = []
    client.onEvent((event) => received.push(event))

    const sseData = 'id: 1\ndata: {"type":"pipeline_completed","pipelineId":"p1","seq":1}\n\n'
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData))
          controller.close()
        },
      }),
    })

    await client.connect()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("pipeline_completed")
    expect(received[0].seq).toBe(1)
  })

  it("full_refresh_required triggers onRefreshNeeded callback", async () => {
    let refreshTriggered = false
    client.onRefreshNeeded(() => { refreshTriggered = true })

    const sseData = 'id: 1\ndata: {"type":"full_refresh_required","seq":1}\n\n'
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData))
          controller.close()
        },
      }),
    })

    await client.connect()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(refreshTriggered).toBe(true)
  })

  it("SSE connection error triggers onConnectionStateChange('reconnecting')", async () => {
    const states: string[] = []
    client.onConnectionStateChange((state) => states.push(state))

    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"))

    await client.connect()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(states).toContain("reconnecting")
  })

  it("disconnect() cleans up SSE connection", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: new ReadableStream({ start() {} }),
    })

    await client.connect()
    client.disconnect()

    const states: string[] = []
    client.onConnectionStateChange((state) => states.push(state))
    expect(states).not.toContain("connected")
  })

  it("reconnection sends Last-Event-ID from previous events", async () => {
    // First connection: receive an event with seq=5
    const sseData = 'id: 5\ndata: {"type":"pipeline_completed","pipelineId":"p1","seq":5}\n\n'
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData))
          controller.close()
        },
      }),
    })

    await client.connect()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(client.lastSeq).toBe(5)
    client.disconnect()

    // Second connection should include Last-Event-ID: 5
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: new ReadableStream({ start() {} }),
    })

    await client.connect()
    const secondCall = mockFetch.mock.calls[1]
    expect(secondCall[1]?.headers?.["Last-Event-ID"]).toBe("5")
    client.disconnect()
  })

  it("malformed SSE data is handled gracefully", async () => {
    const received: any[] = []
    client.onEvent((event) => received.push(event))

    const sseData = 'id: 1\ndata: {invalid json}\n\nid: 2\ndata: {"type":"pipeline_completed","pipelineId":"p1","seq":2}\n\n'
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseData))
          controller.close()
        },
      }),
    })

    await client.connect()
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(received).toHaveLength(1)
    expect(received[0].seq).toBe(2)
  })
})

describe("forkSession", () => {
  let client: ReturnType<typeof createAtelierClient>

  beforeEach(() => {
    mockFetch.mockReset()
    client = createAtelierClient("http://localhost:3000")
  })

  it("calls POST /session/:id/fork with title", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "forked-123" }),
      headers: new Headers({ "X-Atelier-Seq": "10" }),
    })

    const result = await client.forkSession("src-456", "My fork")

    expect(result.id).toBe("forked-123")
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/session/src-456/fork"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "My fork" }),
      }),
    )
  })

  it("calls without body when no title", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "forked-789" }),
      headers: new Headers(),
    })

    const result = await client.forkSession("src-000")
    expect(result.id).toBe("forked-789")
  })

  it("throws on error response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => ({ error: "Session not found" }),
      headers: new Headers(),
    })

    await expect(client.forkSession("bad-id")).rejects.toThrow("Session not found")
  })
})
