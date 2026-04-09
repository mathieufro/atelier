import { describe, it, expect, vi } from "vitest"
import { createBridge } from "../src/bridge.js"
import type { AtelierClient } from "../src/atelier-client.js"

function createMockClient(overrides: Partial<AtelierClient> = {}): AtelierClient {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({ id: "new" }),
    getSession: vi.fn(),
    deleteSession: vi.fn(),
    abortSession: vi.fn(),
    resumeSession: vi.fn(),
    getMessages: vi.fn().mockResolvedValue({ messages: [], start: 0, end: 0, total: 0 }),
    sendMessage: vi.fn().mockResolvedValue({}),
    replyPermission: vi.fn(),
    replyQuestion: vi.fn(),
    rejectQuestion: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({ agents: [], models: [], workspacePath: "/tmp" }),
    upsertFavorite: vi.fn(),
    removeFavorite: vi.fn(),
    reorderFavorites: vi.fn(),
    listSkills: vi.fn().mockResolvedValue([]),
    invokeSkill: vi.fn(),
    listPipelines: vi.fn().mockResolvedValue([]),
    getPipeline: vi.fn(),
    restartPipeline: vi.fn(),
    signalPipeline: vi.fn(),
    retryStuck: vi.fn(),
    abortPipeline: vi.fn(),
    health: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    onEvent: vi.fn().mockReturnValue(() => {}),
    onRefreshNeeded: vi.fn().mockReturnValue(() => {}),
    onConnectionStateChange: vi.fn().mockReturnValue(() => {}),
    lastSeq: 0,
    // Ralph methods
    startRalphLoop: vi.fn().mockResolvedValue({ sessionId: "ralph-s1" }),
    cancelRalphLoop: vi.fn().mockResolvedValue({ status: "cancelled" }),
    ...overrides,
  } as AtelierClient
}

describe("Ralph loop bridge handlers", () => {
  it("startRalphLoop calls client and activates new session", async () => {
    const messages: any[] = []
    const client = createMockClient()
    const bridge = createBridge(
      () => client,
      (msg) => messages.push(msg),
    )

    await bridge.handleMessage({
      type: "startRalphLoop",
      promptPath: "./prompt.md",
      maxIterations: 10,
      completionPromise: "DONE",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    } as any)

    expect(client.startRalphLoop).toHaveBeenCalledWith({
      promptPath: "./prompt.md",
      maxIterations: 10,
      completionPromise: "DONE",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    })

    // Should refresh sessions and activate the new session
    expect(client.listSessions).toHaveBeenCalled()
    const activeMsg = messages.find(m => m.type === "activeSession")
    expect(activeMsg?.sessionId).toBe("ralph-s1")
  })

  it("cancelRalphLoop calls client", async () => {
    const client = createMockClient()
    const bridge = createBridge(
      () => client,
      () => {},
    )

    await bridge.handleMessage({
      type: "cancelRalphLoop",
      sessionId: "ralph-s1",
    } as any)

    expect(client.cancelRalphLoop).toHaveBeenCalledWith("ralph-s1")
  })
})
