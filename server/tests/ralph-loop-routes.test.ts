import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createApp } from "../src/app.js"
import { createEventMerger } from "../src/engine/event-merger.js"
import { BackendRegistry } from "../src/engine/backend-registry.js"
import { SessionMetadataStore } from "../src/engine/session-metadata-store.js"
import { RalphLoopController } from "../src/ralph-loop-controller.js"
import type { AgentEngine } from "@atelier/core/agent-engine"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

function createMockEngine(): AgentEngine {
  return {
    createSession: vi.fn().mockResolvedValue({ id: "ralph-session-1" }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    waitForIdle: vi.fn().mockImplementation(() => new Promise(() => {})), // Hang to keep loop running
    getSessionOutput: vi.fn().mockResolvedValue({ text: "", tokens: { input: 0, output: 0 } }),
    interruptSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    updateSessionTitle: vi.fn().mockResolvedValue(undefined),
  }
}

describe("Ralph loop API routes", () => {
  let tmpDir: string
  let promptPath: string
  let app: ReturnType<typeof createApp>
  let merger: ReturnType<typeof createEventMerger>
  let controller: RalphLoopController
  let registry: BackendRegistry
  let engine: AgentEngine

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralph-api-"))
    promptPath = path.join(tmpDir, "prompt.md")
    fs.writeFileSync(promptPath, "Fix the auth bug")

    merger = createEventMerger({ bufferSize: 100 })
    controller = new RalphLoopController(merger)
    registry = new BackendRegistry()
    engine = createMockEngine()
    registry.registerEngine("claude-code", engine)

    // Register a mock proxy for session title updates
    registry.registerProxy("claude-code", {
      updateSessionTitle: vi.fn().mockResolvedValue(undefined),
      listSessions: vi.fn().mockResolvedValue([]),
      getSession: vi.fn(),
      deleteSession: vi.fn(),
      abortSession: vi.fn(),
      getMessages: vi.fn(),
      sendMessage: vi.fn(),
      getConfig: vi.fn(),
      replyPermission: vi.fn(),
      replyQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      listPendingPermissions: vi.fn().mockResolvedValue([]),
      listPendingQuestions: vi.fn().mockResolvedValue([]),
    } as any)

    const metadataStore = new SessionMetadataStore(path.join(tmpDir, "meta.json"))

    app = createApp({
      registry,
      metadataStore,
      workspacePath: tmpDir,
      eventMerger: merger,
      getOrchestrator: () => null,
      getStatus: () => "ready",
      ralphController: controller,
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("POST /ralph-loop", () => {
    it("creates session and starts loop", async () => {
      const res = await app.request("/ralph-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promptPath: "prompt.md",
          maxIterations: 5,
          completionPromise: "DONE",
          model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
        }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sessionId).toBe("ralph-session-1")

      // Controller should have registered the loop
      const loop = controller.getLoop("ralph-session-1")
      expect(loop).toBeTruthy()
      expect(loop!.status).toBe("running")
      expect(loop!.maxIterations).toBe(5)
      expect(loop!.completionPromise).toBe("DONE")
    })

    it("returns 400 for missing promptPath", async () => {
      const res = await app.request("/ralph-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(400)
    })

    it("returns 400 for non-existent prompt file", async () => {
      const res = await app.request("/ralph-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptPath: "nonexistent.md" }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toContain("not found")
    })

    it("defaults maxIterations to 0 and completionPromise to null", async () => {
      const res = await app.request("/ralph-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptPath: "prompt.md" }),
      })
      expect(res.status).toBe(200)
      const loop = controller.getLoop("ralph-session-1")!
      expect(loop.maxIterations).toBe(0)
      expect(loop.completionPromise).toBeNull()
    })

    it("emits session.updated for the new session", async () => {
      const emitted: any[] = []
      merger.subscribe((event) => emitted.push(event))

      await app.request("/ralph-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptPath: "prompt.md" }),
      })

      const sessionUpdated = emitted.find(e => e.type === "session.updated")
      expect(sessionUpdated).toBeTruthy()
      expect(sessionUpdated.properties.info.title).toContain("Ralph:")
    })
  })

  describe("POST /ralph-loop/:sessionId/cancel", () => {
    it("cancels an active loop", async () => {
      // Start a loop
      await app.request("/ralph-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptPath: "prompt.md" }),
      })

      // Wait for loop to start
      await vi.waitFor(() => { expect(engine.sendMessage).toHaveBeenCalled() })

      const res = await app.request("/ralph-loop/ralph-session-1/cancel", { method: "POST" })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe("cancelled")
    })

    it("returns 404 for unknown session", async () => {
      const res = await app.request("/ralph-loop/nonexistent/cancel", { method: "POST" })
      expect(res.status).toBe(404)
    })
  })

  describe("GET /ralph-loop", () => {
    it("lists all loops", async () => {
      await app.request("/ralph-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptPath: "prompt.md" }),
      })

      const res = await app.request("/ralph-loop")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.loops).toHaveLength(1)
      expect(body.loops[0].sessionId).toBe("ralph-session-1")
    })
  })

  describe("GET /ralph-loop/:sessionId", () => {
    it("returns loop state for existing loop", async () => {
      await app.request("/ralph-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptPath: "prompt.md", maxIterations: 10 }),
      })

      const res = await app.request("/ralph-loop/ralph-session-1")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.sessionId).toBe("ralph-session-1")
      expect(body.maxIterations).toBe(10)
    })

    it("returns 404 for unknown session", async () => {
      const res = await app.request("/ralph-loop/nonexistent")
      expect(res.status).toBe(404)
    })
  })

  describe("POST /session/:id/abort — Ralph loop delegation", () => {
    it("delegates to loop controller for session with active loop", async () => {
      await app.request("/ralph-loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptPath: "prompt.md" }),
      })

      await vi.waitFor(() => { expect(engine.sendMessage).toHaveBeenCalled() })

      const res = await app.request("/session/ralph-session-1/abort", { method: "POST" })
      expect(res.status).toBe(200)

      const loop = controller.getLoop("ralph-session-1")!
      expect(loop.status).toBe("cancelled")
    })
  })
})
