import { describe, it, expect, vi } from "vitest"
import { createBridge } from "../src/bridge.js"

function makeClient(overrides?: Record<string, any>) {
  return {
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ id: "s1" })),
    getSession: vi.fn(async () => ({})),
    deleteSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => {}),
    resumeSession: vi.fn(async () => {}),
    getMessages: vi.fn(async () => ({ messages: [], start: 0, end: 0, total: 0 })),
    sendMessage: vi.fn(async () => ({})),
    replyPermission: vi.fn(async () => {}),
    replyQuestion: vi.fn(async () => {}),
    rejectQuestion: vi.fn(async () => {}),
    getConfig: vi.fn(async () => ({ agents: [], models: [], workspacePath: "/tmp" })),
    upsertFavorite: vi.fn(async () => ({ favorites: [] })),
    removeFavorite: vi.fn(async () => ({ favorites: [] })),
    reorderFavorites: vi.fn(async () => ({ favorites: [] })),
    listPipelines: vi.fn(async () => []),
    getPipeline: vi.fn(async () => ({ id: "p1", prompt: "p1", stages: [] })),
    restartPipeline: vi.fn(async () => ({ pipelineId: "p1" })),
    signalPipeline: vi.fn(async () => {}),
    retryStuck: vi.fn(async () => {}),
    abortPipeline: vi.fn(async () => {}),
    health: vi.fn(async () => ({ status: "ok", backends: {} })),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(() => {}),
    onEvent: vi.fn(() => () => {}),
    onRefreshNeeded: vi.fn(() => () => {}),
    onConnectionStateChange: vi.fn(() => () => {}),
    lastSeq: 0,
    ...(overrides ?? {}),
  }
}

describe("createBridge", () => {
  it("does not auto-load a running pipeline on ready", async () => {
    const client = makeClient({
      listPipelines: vi.fn(async () => [
        { id: "p-running", prompt: "Run", status: "running", currentStage: "brainstorm", createdAt: 1, updatedAt: 2 },
      ]),
    })
    const posted: any[] = []
    const bridge = createBridge(() => client as any, (msg) => posted.push(msg))

    await bridge.handleMessage({ type: "ready" } as any)

    expect(client.getPipeline).not.toHaveBeenCalled()
    expect(posted.some((m) => m.type === "pipeline")).toBe(false)
    expect(posted.some((m) => m.type === "pipelines")).toBe(true)
  })

  it("loads pipeline details only on explicit loadPipeline", async () => {
    const client = makeClient()
    const posted: any[] = []
    const bridge = createBridge(() => client as any, (msg) => posted.push(msg))

    await bridge.handleMessage({ type: "loadPipeline", pipelineId: "p1" } as any)

    expect(client.getPipeline).toHaveBeenCalledWith("p1")
    expect(posted.some((m) => m.type === "pipeline")).toBe(true)
  })

  it("invokeSkill calls client.invokeSkill and posts sessions + activeSession", async () => {
    const client = makeClient({
      invokeSkill: vi.fn(async () => ({ sessionId: "skill-s1" })),
      listSessions: vi.fn(async () => [{ id: "skill-s1", title: "Skill session" }]),
    })
    const posted: any[] = []
    const bridge = createBridge(() => client as any, (msg) => posted.push(msg))

    await bridge.handleMessage({
      type: "invokeSkill",
      skillName: "brainstorming",
      content: "Build an API",
    } as any)

    expect(client.invokeSkill).toHaveBeenCalledWith(expect.objectContaining({
      skillName: "brainstorming",
      content: "Build an API",
    }))
    expect(posted.some((m) => m.type === "sessions")).toBe(true)
    expect(posted.some((m) => m.type === "activeSession" && m.sessionId === "skill-s1")).toBe(true)
  })

  it("invokeSkill returns sessionId via rpc", async () => {
    const client = makeClient({
      invokeSkill: vi.fn(async () => ({ sessionId: "skill-s2" })),
    })
    const posted: any[] = []
    const bridge = createBridge(() => client as any, (msg) => posted.push(msg))

    await bridge.handleMessage({
      type: "invokeSkill",
      skillName: "bugfixing",
      content: "Fix the bug",
      _rpcId: "rpc-1",
    } as any)

    const rpcResponse = posted.find((m) => m.type === "_rpc" && m._rpcId === "rpc-1")
    expect(rpcResponse).toBeDefined()
    expect(rpcResponse.sessionId).toBe("skill-s2")
  })

  it("requestSkills calls client.listSkills and posts skills", async () => {
    const mockSkills = [
      { name: "brainstorming", description: "Guides brainstorm sessions", stage: "brainstorm" },
      { name: "bugfixing", description: "Bug investigation", stage: "bugfix" },
    ]
    const client = makeClient({
      listSkills: vi.fn(async () => mockSkills),
    })
    const posted: any[] = []
    const bridge = createBridge(() => client as any, (msg) => posted.push(msg))

    await bridge.handleMessage({ type: "requestSkills" } as any)

    expect(client.listSkills).toHaveBeenCalled()
    const skillsMsg = posted.find((m) => m.type === "skills")
    expect(skillsMsg).toBeDefined()
    expect(skillsMsg.skills).toEqual(mockSkills)
  })
})
