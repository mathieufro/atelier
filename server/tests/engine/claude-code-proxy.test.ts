import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { ClaudeCodeProxy } from "../../src/engine/claude-code-proxy.js"
import type { ClaudeCodeEngine } from "../../src/engine/claude-code-engine.js"
import type { SessionMetadataStore } from "../../src/engine/session-metadata-store.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

describe("ClaudeCodeProxy", () => {
  let tmpDir: string
  let sessionDir: string
  let mockEngine: Partial<ClaudeCodeEngine>
  let mockMetaStore: Partial<SessionMetadataStore>
  let proxy: ClaudeCodeProxy

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-proxy-"))
    // Simulate ~/.claude/projects/<encoded-workspace>/
    sessionDir = path.join(tmpDir, "-workspace")
    fs.mkdirSync(sessionDir, { recursive: true })

    mockEngine = {
      sendMessage: vi.fn(),
      interruptSession: vi.fn(),
      resolvePermission: vi.fn(),
      resolveQuestion: vi.fn(),
      fetchSupportedModels: vi.fn().mockResolvedValue([
        { value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
      ]),
    }
    mockMetaStore = {
      get: vi.fn().mockReturnValue({
        id: "s1", title: "Test", backend: "claude-code",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        workspacePath: "/workspace", parentId: null, status: "idle",
        createdAt: 1000, lastActiveAt: 1000,
      }),
      listRootSessions: vi.fn().mockReturnValue([]),
    }

    proxy = new ClaudeCodeProxy({
      engine: mockEngine as ClaudeCodeEngine,
      metadataStore: mockMetaStore as SessionMetadataStore,
      claudeProjectsDir: tmpDir,
      workspacePath: "/workspace",
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("getMessages parses JSONL file into AtelierMessages", async () => {
    const jsonlContent = [
      JSON.stringify({ type: "user", message: { id: "m1", role: "user", content: [{ type: "text", text: "Hello" }] } }),
      JSON.stringify({ type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "Hi there" }] } }),
    ].join("\n")

    fs.writeFileSync(path.join(sessionDir, "s1.jsonl"), jsonlContent)

    const result = await proxy.getMessages("s1")
    expect(result.messages).toHaveLength(2)
    expect(result.messages[0].message.role).toBe("user")
    expect(result.messages[0].parts[0]).toMatchObject({ type: "text", text: "Hello" })
    expect(result.messages[1].message.role).toBe("assistant")
    expect(result.total).toBe(2)
  })

  it("getMessages applies pagination", async () => {
    const lines = Array.from({ length: 10 }, (_, i) =>
      JSON.stringify({ type: "assistant", message: { id: `m${i}`, role: "assistant", content: [{ type: "text", text: `msg ${i}` }] } })
    ).join("\n")

    fs.writeFileSync(path.join(sessionDir, "s1.jsonl"), lines)

    const result = await proxy.getMessages("s1", { limit: 3 })
    expect(result.messages).toHaveLength(3)
    expect(result.start).toBe(7) // last 3 of 10
    expect(result.end).toBe(10)
    expect(result.total).toBe(10)
  })

  it("getMessages with limit > total returns all messages", async () => {
    const lines = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify({ type: "assistant", message: { id: `m${i}`, role: "assistant", content: [{ type: "text", text: `msg ${i}` }] } })
    ).join("\n")
    fs.writeFileSync(path.join(sessionDir, "s1.jsonl"), lines)

    const result = await proxy.getMessages("s1", { limit: 100 })
    expect(result.messages).toHaveLength(3)
    expect(result.start).toBe(0)
    expect(result.end).toBe(3)
    expect(result.total).toBe(3)
  })

  it("getMessages with after cursor beyond total returns empty", async () => {
    const lines = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify({ type: "assistant", message: { id: `m${i}`, role: "assistant", content: [{ type: "text", text: `msg ${i}` }] } })
    ).join("\n")
    fs.writeFileSync(path.join(sessionDir, "s1.jsonl"), lines)

    const result = await proxy.getMessages("s1", { after: 100 })
    expect(result.messages).toHaveLength(0)
    expect(result.start).toBe(3)
    expect(result.end).toBe(3)
  })

  it("getMessages with before cursor at 0 returns empty", async () => {
    const lines = Array.from({ length: 3 }, (_, i) =>
      JSON.stringify({ type: "assistant", message: { id: `m${i}`, role: "assistant", content: [{ type: "text", text: `msg ${i}` }] } })
    ).join("\n")
    fs.writeFileSync(path.join(sessionDir, "s1.jsonl"), lines)

    const result = await proxy.getMessages("s1", { before: 0 })
    expect(result.messages).toHaveLength(0)
    expect(result.start).toBe(0)
    expect(result.end).toBe(0)
  })

  it("getMessages skips malformed lines", async () => {
    const lines = [
      JSON.stringify({ type: "user", message: { id: "m1", role: "user", content: [{ type: "text", text: "ok" }] } }),
      "not valid json{{{",
      JSON.stringify({ type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "fine" }] } }),
    ].join("\n")

    fs.writeFileSync(path.join(sessionDir, "s1.jsonl"), lines)

    const result = await proxy.getMessages("s1")
    expect(result.messages).toHaveLength(2)
  })

  it("getMessages returns empty for missing JSONL file", async () => {
    const result = await proxy.getMessages("nonexistent")
    expect(result.messages).toEqual([])
    expect(result.total).toBe(0)
  })

  it("sendMessage delegates to engine", async () => {
    await proxy.sendMessage("s1", {
      content: "Hello",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    })
    expect(mockEngine.sendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({ content: "Hello" }))
  })

  it("sendMessage throws a clear error for unknown anthropic model", async () => {
    await expect(proxy.sendMessage("s1", {
      content: "Hello",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6-1m" },
    })).rejects.toThrow("Unknown model 'anthropic:claude-opus-4-6-1m'")

    expect(mockEngine.sendMessage).not.toHaveBeenCalled()
  })

  it("fetchModels merges CLI-supported-but-SDK-unlisted models", async () => {
    // SDK returns only sonnet; EXTRA_ANTHROPIC_MODELS should fill in the gap
    // so models Anthropic ships before the SDK's curated list catches up
    // (e.g. Opus 4.7) appear in the picker and pass validation.
    const config = await proxy.getConfig()
    const ids = config.models.map((m) => m.id)
    expect(ids).toContain("claude-sonnet-4-6")
    expect(ids).toContain("claude-opus-4-7")

    // Validation accepts the extra model — no throw, engine is called.
    await proxy.sendMessage("s1", {
      content: "Hello",
      model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
    })
    expect(mockEngine.sendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({
      model: { providerID: "anthropic", modelID: "claude-opus-4-7" },
    }))
  })

  it("fetchModels prefers SDK entry when an extra model is later added to SDK", async () => {
    // Simulate the SDK catching up and listing claude-opus-4-7 itself —
    // it should appear only once, with the SDK's display name.
    const fetchSupportedModels = mockEngine.fetchSupportedModels as ReturnType<typeof vi.fn>
    fetchSupportedModels.mockResolvedValueOnce([
      { value: "claude-opus-4-7", displayName: "Claude Opus 4.7 (official)" },
    ])

    const config = await proxy.getConfig()
    const opus47 = config.models.filter((m) => m.id === "claude-opus-4-7")
    expect(opus47).toHaveLength(1)
    expect(opus47[0].name).toBe("Claude Opus 4.7 (official)")
  })

  it("sendMessage force-refreshes model list before rejecting", async () => {
    const fetchSupportedModels = mockEngine.fetchSupportedModels as ReturnType<typeof vi.fn>
    fetchSupportedModels
      .mockResolvedValueOnce([{ value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" }])
      .mockResolvedValueOnce([{ value: "claude-opus-4-6", displayName: "Claude Opus 4.6" }])

    await proxy.sendMessage("s1", {
      content: "Hello",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
    })

    expect(fetchSupportedModels).toHaveBeenCalledTimes(2)
    expect(mockEngine.sendMessage).toHaveBeenCalledWith("s1", expect.objectContaining({
      content: "Hello",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
    }))
  })

  it("abortSession delegates to engine", async () => {
    await proxy.abortSession("s1")
    expect(mockEngine.interruptSession).toHaveBeenCalledWith("s1")
  })

  it("replyPermission resolves pending permission in engine", async () => {
    await proxy.replyPermission("s1", "r1", "once")
    expect(mockEngine.resolvePermission).toHaveBeenCalledWith("s1", "r1", { behavior: "allow", updatedInput: {} })
  })

  it("replyPermission with reject resolves as deny", async () => {
    await proxy.replyPermission("s1", "r1", "reject")
    expect(mockEngine.resolvePermission).toHaveBeenCalledWith("s1", "r1", { behavior: "deny", message: "User denied" })
  })

  it("getConfig serves cached models while cache is fresh", async () => {
    const result1 = await proxy.getConfig()
    const result2 = await proxy.getConfig()
    expect((mockEngine.fetchSupportedModels as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    expect(result1.workspacePath).toBe(result2.workspacePath)
  })

  it("getConfig refreshes model list after cache TTL", async () => {
    const fetchSupportedModels = mockEngine.fetchSupportedModels as ReturnType<typeof vi.fn>
    fetchSupportedModels
      .mockResolvedValueOnce([{ value: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" }])
      .mockResolvedValueOnce([{ value: "claude-sonnet-4-7", displayName: "Claude Sonnet 4.7" }])

    const first = await proxy.getConfig()
    expect(first.models.some((m) => m.id === "claude-sonnet-4-6")).toBe(true)

    ;(proxy as any).cachedModelsFetchedAt = Date.now() - 31_000

    const second = await proxy.getConfig()
    expect(second.models.some((m) => m.id === "claude-sonnet-4-7")).toBe(true)
    expect(fetchSupportedModels).toHaveBeenCalledTimes(2)
  })

  it("getConfig uses SDK displayName for model labels", async () => {
    const fetchSupportedModels = mockEngine.fetchSupportedModels as ReturnType<typeof vi.fn>
    fetchSupportedModels.mockResolvedValueOnce([
      { value: "claude-opus-4-6", displayName: "Opus 4.6 with 1m Context", description: "old label" },
    ])

    const result = await proxy.getConfig()
    expect(result.models[0]?.name).toBe("Opus 4.6 with 1m Context")
  })

  it("workspace path encoding replaces non-alphanumeric with dashes", () => {
    const encoded = ClaudeCodeProxy.encodeWorkspacePath("/home/dev/repos/myproject")
    expect(encoded).toBe("-home-dev-repos-myproject")
  })
})
