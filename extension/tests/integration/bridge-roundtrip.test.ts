import { describe, it, expect, vi, beforeEach } from "vitest"
import { createBridge } from "../../src/bridge.js"
import type { HostMessage, WebviewMessage } from "@atelier/core"

function createMockAtelierClient() {
  return {
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ id: "s1" })),
    getSession: vi.fn(async (id: string) => ({ id })),
    deleteSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    resumeSession: vi.fn(async () => {}),
    getMessages: vi.fn(async () => ({ messages: [], start: 0, end: 0, total: 0 })),
    sendMessage: vi.fn(async () => ({ ok: true })),
    replyPermission: vi.fn(async () => {}),
    replyQuestion: vi.fn(async () => {}),
    rejectQuestion: vi.fn(async () => {}),
    getConfig: vi.fn(async () => ({ agents: [], models: [], workspacePath: "/tmp" })),
    upsertFavorite: vi.fn(async () => ({ favorites: [] })),
    removeFavorite: vi.fn(async () => ({ favorites: [] })),
    reorderFavorites: vi.fn(async () => ({ favorites: [] })),
    listPipelines: vi.fn(async () => []),
    getPipeline: vi.fn(async () => ({})),
    restartPipeline: vi.fn(async () => ({ pipelineId: "p2" })),
  }
}

describe("Simplified Bridge", () => {
  let client: ReturnType<typeof createMockAtelierClient>
  let posted: HostMessage[]
  let bridge: ReturnType<typeof createBridge>

  beforeEach(() => {
    client = createMockAtelierClient()
    posted = []
    bridge = createBridge(() => client as any, (msg) => posted.push(msg))
  })

  it("ready → fetches sessions + config + pipelines", async () => {
    await bridge.handleMessage({ type: "ready" })
    expect(client.listSessions).toHaveBeenCalled()
    expect(client.getConfig).toHaveBeenCalled()
    expect(client.listPipelines).toHaveBeenCalled()
  })

  it("sendMessage → calls client.sendMessage", async () => {
    await bridge.handleMessage({
      type: "sendMessage",
      content: "Hello",
      mode: "build",
      sessionId: "s1",
    } as any)
    expect(client.sendMessage).toHaveBeenCalledWith({
      content: "Hello",
      mode: "build",
      sessionId: "s1",
    })
  })

  it("abortSession → calls client.abortSession", async () => {
    await bridge.handleMessage({ type: "abortSession", sessionId: "s1" } as any)
    expect(client.abortSession).toHaveBeenCalledWith("s1")
  })

  it("resumeSession → calls client.resumeSession", async () => {
    await bridge.handleMessage({ type: "resumeSession", sessionId: "s1" } as any)
    expect(client.resumeSession).toHaveBeenCalledWith("s1")
  })

  it("permissionReply → calls client.replyPermission", async () => {
    await bridge.handleMessage({
      type: "permissionReply",
      sessionId: "s1",
      requestId: "req1",
      reply: "always",
    } as any)
    expect(client.replyPermission).toHaveBeenCalledWith("s1", "req1", "always")
  })

  it("questionReply → calls client.replyQuestion", async () => {
    await bridge.handleMessage({
      type: "questionReply",
      sessionId: "s1",
      requestId: "req1",
      answers: [["yes"]],
    } as any)
    expect(client.replyQuestion).toHaveBeenCalledWith("s1", "req1", [["yes"]])
  })

  it("questionReject → calls client.rejectQuestion", async () => {
    await bridge.handleMessage({
      type: "questionReject",
      sessionId: "s1",
      requestId: "req1",
    } as any)
    expect(client.rejectQuestion).toHaveBeenCalledWith("s1", "req1")
  })

  it("openFile is not dispatched to client (host operation)", async () => {
    await bridge.handleMessage({ type: "openFile", path: "/foo/bar.ts" } as any)
    expect(client.sendMessage).not.toHaveBeenCalled()
  })

  it("createSession → creates session, refreshes list, and activates new session", async () => {
    await bridge.handleMessage({ type: "createSession" } as any)
    expect(client.createSession).toHaveBeenCalled()
    expect(client.listSessions).toHaveBeenCalled()
    expect(posted).toContainEqual(expect.objectContaining({ type: "activeSession", sessionId: "s1" }))
  })

  it("deleteSession → calls client.deleteSession and refreshes list", async () => {
    await bridge.handleMessage({ type: "deleteSession", sessionId: "s1" } as any)
    expect(client.deleteSession).toHaveBeenCalledWith("s1")
    expect(client.listSessions).toHaveBeenCalled()
  })

  it("loadPipeline → fetches detail and posts to webview", async () => {
    await bridge.handleMessage({ type: "loadPipeline", pipelineId: "p1" } as any)
    expect(client.getPipeline).toHaveBeenCalledWith("p1")
    expect(posted.some(m => m.type === "pipeline")).toBe(true)
  })

  it("switchSession → loads messages for session", async () => {
    await bridge.handleMessage({ type: "switchSession", sessionId: "s1" } as any)
    expect(client.getMessages).toHaveBeenCalledWith("s1", { limit: 80 })
  })

  it("error from client surfaces as error message to webview", async () => {
    client.sendMessage.mockRejectedValueOnce(new Error("Pipeline active"))
    await bridge.handleMessage({
      type: "sendMessage",
      content: "Hello",
      mode: "build",
    } as any)
    const errorMsg = posted.find(m => m.type === "error")
    expect(errorMsg).toBeDefined()
    expect((errorMsg as any).message).toBe("Pipeline active")
  })

  it("favorites.upsert -> client.upsertFavorite and favorites.state post", async () => {
    client.upsertFavorite = vi.fn(async () => ({ favorites: [{ favoriteKey: "anthropic::sonnet::__none__", providerID: "anthropic", modelID: "sonnet" }] }))
    await bridge.handleMessage({ type: "favorites.upsert", favorite: { providerID: "anthropic", modelID: "sonnet" } } as any)
    expect(client.upsertFavorite).toHaveBeenCalledWith({ providerID: "anthropic", modelID: "sonnet" })
    expect(posted).toContainEqual({ type: "favorites.state", favorites: [{ favoriteKey: "anthropic::sonnet::__none__", providerID: "anthropic", modelID: "sonnet" }] })
  })

  it("favorites.reorder forwards ordered keys to server", async () => {
    client.reorderFavorites = vi.fn(async () => ({ favorites: [] }))
    await bridge.handleMessage({ type: "favorites.reorder", favoriteKeys: ["a::b::__none__"] } as any)
    expect(client.reorderFavorites).toHaveBeenCalledWith(["a::b::__none__"])
  })
})
