import { describe, it, expect, vi, beforeEach } from "vitest"
import { BackendRegistry } from "../../src/engine/backend-registry.js"
import type { AgentEngine } from "@atelier/core/agent-engine"
import type { BackendProxy } from "../../src/engine/backend-proxy.js"

function createMockEngine(): AgentEngine {
  return {
    createSession: vi.fn(),
    sendMessage: vi.fn(),
    waitForIdle: vi.fn(),
    getSessionOutput: vi.fn(),
    interruptSession: vi.fn(),
    deleteSession: vi.fn(),
    updateSessionTitle: vi.fn(),
  }
}

function createMockProxy(): BackendProxy {
  return {
    listSessions: vi.fn(),
    getSession: vi.fn(),
    deleteSession: vi.fn(),
    abortSession: vi.fn(),
    getMessages: vi.fn(),
    sendMessage: vi.fn(),
    getConfig: vi.fn(),
    replyPermission: vi.fn(),
    replyQuestion: vi.fn(),
    rejectQuestion: vi.fn(),
    listPendingPermissions: vi.fn(),
    listPendingQuestions: vi.fn(),
    updateSessionTitle: vi.fn(),
  }
}

describe("BackendRegistry", () => {
  let registry: BackendRegistry

  beforeEach(() => {
    registry = new BackendRegistry()
  })

  it("resolveBackend routes anthropic to claude-code", () => {
    expect(registry.resolveBackend({ providerID: "anthropic", modelID: "claude-sonnet-4-6" })).toBe("claude-code")
  })

  it("resolveBackend routes non-anthropic to opencode", () => {
    expect(registry.resolveBackend({ providerID: "openai", modelID: "gpt-4o" })).toBe("opencode")
    expect(registry.resolveBackend({ providerID: "google", modelID: "gemini-2.0" })).toBe("opencode")
  })

  it("getEngine returns null before registration", () => {
    expect(registry.getEngineIfReady("claude-code")).toBeNull()
    expect(registry.getEngineIfReady("opencode")).toBeNull()
  })

  it("registers and retrieves engine", () => {
    const engine = createMockEngine()
    registry.registerEngine("claude-code", engine)
    expect(registry.getEngineIfReady("claude-code")).toBe(engine)
  })

  it("registers and retrieves proxy", () => {
    const proxy = createMockProxy()
    registry.registerProxy("claude-code", proxy)
    expect(registry.getProxyIfReady("claude-code")).toBe(proxy)
  })

  it("listReadyBackends returns only initialized backends", () => {
    expect(registry.listReadyBackends()).toEqual([])
    registry.registerEngine("opencode", createMockEngine())
    registry.registerProxy("opencode", createMockProxy())
    expect(registry.listReadyBackends()).toEqual(["opencode"])
  })

  it("getEngine throws for unregistered backend", async () => {
    await expect(registry.getEngine("claude-code")).rejects.toThrow()
  })

  it("lazy init with factory resolves on first call", async () => {
    const engine = createMockEngine()
    const factory = vi.fn().mockResolvedValue(engine)
    registry.registerEngineFactory("claude-code", factory)

    const result = await registry.getEngine("claude-code")
    expect(result).toBe(engine)
    expect(factory).toHaveBeenCalledTimes(1)

    // Second call returns cached
    const result2 = await registry.getEngine("claude-code")
    expect(result2).toBe(engine)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("concurrent getEngine calls share the same factory invocation", async () => {
    const engine = createMockEngine()
    let resolveFactory: (e: AgentEngine) => void
    const factory = vi.fn().mockImplementation(() => new Promise<AgentEngine>((r) => { resolveFactory = r }))
    registry.registerEngineFactory("claude-code", factory)

    const p1 = registry.getEngine("claude-code")
    const p2 = registry.getEngine("claude-code")
    resolveFactory!(engine)

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(engine)
    expect(r2).toBe(engine)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("factory rejection propagates to all waiters", async () => {
    const factory = vi.fn().mockRejectedValue(new Error("SDK not installed"))
    registry.registerEngineFactory("claude-code", factory)

    await expect(registry.getEngine("claude-code")).rejects.toThrow("SDK not installed")
  })

  it("retries factory after rejection (does not cache failure)", async () => {
    const engine = createMockEngine()
    let callCount = 0
    const factory = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.reject(new Error("transient failure"))
      return Promise.resolve(engine)
    })
    registry.registerEngineFactory("claude-code", factory)

    // First call fails
    await expect(registry.getEngine("claude-code")).rejects.toThrow("transient failure")
    // Second call retries and succeeds
    const result = await registry.getEngine("claude-code")
    expect(result).toBe(engine)
    expect(factory).toHaveBeenCalledTimes(2)
  })
})
