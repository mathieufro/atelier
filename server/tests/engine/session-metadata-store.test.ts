import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { SessionMetadataStore, type SessionMetadata } from "../../src/engine/session-metadata-store.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

describe("SessionMetadataStore", () => {
  let tmpDir: string
  let storePath: string
  let store: SessionMetadataStore

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-meta-"))
    storePath = path.join(tmpDir, "session-metadata.json")
    store = new SessionMetadataStore(storePath)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("creates and retrieves a session", () => {
    const meta: SessionMetadata = {
      id: "s1",
      title: "Test session",
      backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/workspace",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      parentId: null,
      status: "idle",
    }
    store.create(meta)
    const retrieved = store.get("s1")
    expect(retrieved).toEqual(meta)
  })

  it("updates a session", () => {
    store.create({
      id: "s1", title: "Old", backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o" },
      workspacePath: "/ws", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })
    store.update("s1", { title: "New", status: "busy", lastActiveAt: 2000 })
    const updated = store.get("s1")
    expect(updated!.title).toBe("New")
    expect(updated!.status).toBe("busy")
    expect(updated!.lastActiveAt).toBe(2000)
  })

  it("deletes a session", () => {
    store.create({
      id: "s1", title: "X", backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      workspacePath: "/ws", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })
    store.delete("s1")
    expect(store.get("s1")).toBeNull()
  })

  it("listRootSessions filters by workspace and excludes parentId", () => {
    store.create({
      id: "s1", title: "Root", backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/ws1", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })
    store.create({
      id: "s2", title: "Child", backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/ws1", createdAt: 1000, lastActiveAt: 1000,
      parentId: "pipeline-1", status: "idle",
    })
    store.create({
      id: "s3", title: "Other WS", backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o" },
      workspacePath: "/ws2", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })

    const roots = store.listRootSessions("/ws1")
    expect(roots).toHaveLength(1)
    expect(roots[0].id).toBe("s1")
  })

  it("listRootSessions does not match partial workspace paths", () => {
    store.create({
      id: "s1", title: "Short WS", backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/workspace", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })
    store.create({
      id: "s2", title: "Extended WS", backend: "opencode",
      model: { providerID: "openai", modelID: "gpt-4o" },
      workspacePath: "/workspace-extended", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })

    const results = store.listRootSessions("/workspace")
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("s1")

    const extResults = store.listRootSessions("/workspace-extended")
    expect(extResults).toHaveLength(1)
    expect(extResults[0].id).toBe("s2")
  })

  it("skips entries with missing required fields on load", () => {
    // Write invalid entries to disk
    const data = JSON.stringify([
      { id: "valid", title: "OK", backend: "claude-code", workspacePath: "/ws", model: { providerID: "anthropic", modelID: "test" }, createdAt: 1000, lastActiveAt: 1000, parentId: null, status: "idle" },
      { id: "no-backend", title: "Bad" }, // missing backend and workspacePath
      { title: "no-id", backend: "opencode", workspacePath: "/ws" }, // missing id
    ])
    fs.writeFileSync(storePath, data, "utf-8")

    const store2 = new SessionMetadataStore(storePath)
    expect(store2.get("valid")).toBeTruthy()
    expect(store2.get("no-backend")).toBeNull()
  })

  it("getBackendForSession returns backend ID", () => {
    store.create({
      id: "s1", title: "X", backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/ws", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })
    expect(store.getBackendForSession("s1")).toBe("claude-code")
    expect(store.getBackendForSession("nonexistent")).toBeNull()
  })

  it("persists to disk and loads from disk", async () => {
    store.create({
      id: "s1", title: "Persisted", backend: "claude-code",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
      workspacePath: "/ws", createdAt: 1000, lastActiveAt: 1000,
      parentId: null, status: "idle",
    })

    // Flush async writes before reading from disk
    await store.flush()
    const store2 = new SessionMetadataStore(storePath)
    const loaded = store2.get("s1")
    expect(loaded!.title).toBe("Persisted")
  })

  it("handles corrupt file gracefully", () => {
    fs.writeFileSync(storePath, "not json{{{", "utf-8")
    const store2 = new SessionMetadataStore(storePath)
    expect(store2.get("s1")).toBeNull()
    expect(store2.listRootSessions("/ws")).toEqual([])
  })

  it("handles missing file gracefully", () => {
    const store2 = new SessionMetadataStore(path.join(tmpDir, "nonexistent.json"))
    expect(store2.get("s1")).toBeNull()
  })

  it("update on nonexistent session is a no-op", () => {
    store.update("nonexistent", { title: "Nope" })
    expect(store.get("nonexistent")).toBeNull()
  })

  describe("forkedFrom field", () => {
    it("persists forkedFrom on create and returns it on get", () => {
      store.create({
        id: "fork-1",
        title: "Forked session",
        backend: "claude-code",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        workspacePath: "/workspace",
        createdAt: 1000,
        lastActiveAt: 1000,
        parentId: null,
        status: "idle",
        forkedFrom: "original-1",
      })

      const meta = store.get("fork-1")
      expect(meta).not.toBeNull()
      expect(meta!.forkedFrom).toBe("original-1")
      expect(meta!.parentId).toBeNull()
    })

    it("forked sessions appear in listRootSessions (parentId is null)", () => {
      store.create({
        id: "fork-1",
        title: "Fork",
        backend: "claude-code",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        workspacePath: "/workspace",
        createdAt: 1000,
        lastActiveAt: 1000,
        parentId: null,
        status: "idle",
        forkedFrom: "original-1",
      })

      const roots = store.listRootSessions("/workspace")
      expect(roots).toHaveLength(1)
      expect(roots[0].id).toBe("fork-1")
    })

    it("survives persist-reload cycle with forkedFrom", async () => {
      store.create({
        id: "fork-2",
        title: "Persistent fork",
        backend: "opencode",
        model: { providerID: "openai", modelID: "gpt-4o-mini" },
        workspacePath: "/workspace",
        createdAt: 2000,
        lastActiveAt: 2000,
        parentId: null,
        status: "idle",
        forkedFrom: "src-2",
      })
      await store.flush()

      const store2 = new SessionMetadataStore(storePath)
      const meta = store2.get("fork-2")
      expect(meta).not.toBeNull()
      expect(meta!.forkedFrom).toBe("src-2")
    })

    it("sessions without forkedFrom have it as undefined", () => {
      store.create({
        id: "normal-1",
        title: "Normal session",
        backend: "opencode",
        model: { providerID: "openai", modelID: "gpt-4o-mini" },
        workspacePath: "/workspace",
        createdAt: 1000,
        lastActiveAt: 1000,
        parentId: null,
        status: "idle",
      })

      const meta = store.get("normal-1")
      expect(meta!.forkedFrom).toBeUndefined()
    })
  })
})
