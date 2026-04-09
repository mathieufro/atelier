import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { BackendRegistry } from "../../src/engine/backend-registry.js"
import { SessionMetadataStore } from "../../src/engine/session-metadata-store.js"
import { createEventMerger } from "../../src/engine/event-merger.js"
import { MockAgentEngine } from "../__utils__/mock-engine.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

describe("Multi-backend integration", () => {
  let tmpDir: string
  let registry: BackendRegistry
  let metaStore: SessionMetadataStore
  let merger: ReturnType<typeof createEventMerger>
  let ocEngine: MockAgentEngine
  let ccEngine: MockAgentEngine

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-backend-"))
    metaStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))
    merger = createEventMerger()
    registry = new BackendRegistry()

    ocEngine = new MockAgentEngine()
    ccEngine = new MockAgentEngine()
    registry.registerEngine("opencode", ocEngine)
    registry.registerEngine("claude-code", ccEngine)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("resolves anthropic model to claude-code, others to opencode", () => {
    expect(registry.resolveBackend({ providerID: "anthropic", modelID: "claude-sonnet-4-6" })).toBe("claude-code")
    expect(registry.resolveBackend({ providerID: "openai", modelID: "gpt-4o" })).toBe("opencode")
  })

  it("sessions from both backends appear in metadata store", async () => {
    const ccSession = await ccEngine.createSession({ directory: "/ws", permission: [] })
    metaStore.create({
      id: ccSession.id, title: "CC Session", backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/ws", createdAt: Date.now(), lastActiveAt: Date.now(),
      parentId: null, status: "idle",
    })

    const ocSession = await ocEngine.createSession({ directory: "/ws", permission: [] })
    metaStore.create({
      id: ocSession.id, title: "OC Session", backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o" },
      workspacePath: "/ws", createdAt: Date.now(), lastActiveAt: Date.now(),
      parentId: null, status: "idle",
    })

    const roots = metaStore.listRootSessions("/ws")
    expect(roots).toHaveLength(2)
    expect(roots.map((r) => r.backend).sort()).toEqual(["claude-code", "opencode"])
  })

  it("metadata store resolves correct backend for session routing", () => {
    metaStore.create({
      id: "cc-s1", title: "CC", backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      workspacePath: "/ws", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })
    metaStore.create({
      id: "oc-s1", title: "OC", backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o" },
      workspacePath: "/ws", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })

    expect(metaStore.getBackendForSession("cc-s1")).toBe("claude-code")
    expect(metaStore.getBackendForSession("oc-s1")).toBe("opencode")
  })

  it("message routed to correct engine via registry + metadata store", async () => {
    registry.setMetadataStore(metaStore)

    const ccSession = await ccEngine.createSession({ directory: "/ws", permission: [] })
    metaStore.create({
      id: ccSession.id, title: "CC", backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/ws", createdAt: Date.now(), lastActiveAt: Date.now(),
      parentId: null, status: "idle",
    })

    const ocSession = await ocEngine.createSession({ directory: "/ws", permission: [] })
    metaStore.create({
      id: ocSession.id, title: "OC", backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o" },
      workspacePath: "/ws", createdAt: Date.now(), lastActiveAt: Date.now(),
      parentId: null, status: "idle",
    })

    // Resolve and verify correct engine for claude-code session
    const ccBackend = registry.resolveBackendForSession(ccSession.id)
    expect(ccBackend).toBe("claude-code")
    const ccEng = await registry.getEngine(ccBackend!)
    expect(ccEng).toBe(ccEngine)

    // Resolve and verify correct engine for opencode session
    const ocBackend = registry.resolveBackendForSession(ocSession.id)
    expect(ocBackend).toBe("opencode")
    const ocEng = await registry.getEngine(ocBackend!)
    expect(ocEng).toBe(ocEngine)

    // Send message through resolved engine — verify it hits the right one
    await ccEng.sendMessage(ccSession.id, { content: "hello from cc" })
    expect(ccEngine.messages).toHaveLength(1)
    expect(ocEngine.messages).toHaveLength(0)

    await ocEng.sendMessage(ocSession.id, { content: "hello from oc" })
    expect(ocEngine.messages).toHaveLength(1)
  })

  it("event merger forwards events from both backends", () => {
    const received: unknown[] = []
    merger.subscribe((event) => received.push(event))

    merger.emit({ type: "session.busy", sessionId: "cc-s1" })
    merger.emit({ type: "session.busy", sessionId: "oc-s1" })

    expect(received).toHaveLength(2)
  })
})
