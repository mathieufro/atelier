import { describe, it, expect, vi, beforeEach } from "vitest"
import { ClaudeCodeEngine } from "../../src/engine/claude-code-engine.js"
import { SessionMetadataStore } from "../../src/engine/session-metadata-store.js"
import * as path from "node:path"
import * as os from "node:os"
import * as fsSync from "node:fs"

describe("ClaudeCodeEngine.evictSession", () => {
  let engine: ClaudeCodeEngine
  let metadataStore: SessionMetadataStore

  beforeEach(() => {
    const storeDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "atelier-prune-test-"))
    const storePath = path.join(storeDir, "meta.json")
    metadataStore = new SessionMetadataStore(storePath)

    // Use a mock queryFactory that returns a generator yielding one result then ending
    const mockQueryFactory = () => {
      const gen = (async function* () {
        yield { type: "result", subtype: "success", result: "done", session_id: "mock", usage: {} }
      })() as AsyncGenerator<unknown> & { interrupt: () => Promise<void>; close: () => void }
      gen.interrupt = async () => {}
      gen.close = () => {}
      return gen
    }

    engine = new ClaudeCodeEngine({
      queryFactory: mockQueryFactory as any,
      metadataStore,
    })
  })

  it("evictSession removes LiveSession from in-memory map", async () => {
    const session = await engine.createSession({ directory: "/tmp/test", permission: [] })
    expect(engine.getSessionState(session.id)).not.toBeNull()

    // Verify metadata store still has it
    const metaBefore = metadataStore.get(session.id)
    expect(metaBefore).toBeTruthy()

    // Evict
    const result = engine.evictSession(session.id)
    expect(result).toBe(true)

    // Session gone from engine
    expect(engine.getSessionState(session.id)).toBeNull()

    // Metadata store still has it (not deleted)
    const metaAfter = metadataStore.get(session.id)
    expect(metaAfter).toBeTruthy()
  })

  it("evictSession is a no-op for unknown sessions", () => {
    const result = engine.evictSession("nonexistent-session")
    expect(result).toBe(false)
  })

  it("evictSession during active session is rejected", async () => {
    // Use a queryFactory that yields slowly to simulate active query
    let resolveHang: () => void
    const hangPromise = new Promise<void>(r => { resolveHang = r })
    const hangingQueryFactory = () => {
      const gen = (async function* () {
        yield { type: "result", subtype: "success", result: "done", session_id: "mock", usage: {} }
        await hangPromise
      })() as AsyncGenerator<unknown> & { interrupt: () => Promise<void>; close: () => void }
      gen.interrupt = async () => { resolveHang!() }
      gen.close = () => {}
      return gen
    }

    const hangingEngine = new ClaudeCodeEngine({
      queryFactory: hangingQueryFactory as any,
      metadataStore,
    })

    const session = await hangingEngine.createSession({ directory: "/tmp/test", permission: [] })

    // Start a message (which creates a queryHandle)
    hangingEngine.sendMessage(session.id, { content: "hello" }).catch(() => {})
    // Wait a tick for the event loop to start
    await new Promise(r => setTimeout(r, 50))

    // Evict should be rejected — session is active (queryHandle is set)
    const result = hangingEngine.evictSession(session.id)
    expect(result).toBe(false)

    // Clean up — interrupt releases the hang
    await hangingEngine.shutdown()
  })

  it("sendMessage reconstructs session from metadata after evictSession", async () => {
    const session = await engine.createSession({ directory: "/tmp/test", permission: [] })

    // Evict the session
    engine.evictSession(session.id)
    expect(engine.getSessionState(session.id)).toBeNull()

    // sendMessage should reconstruct from metadata store
    // We can't easily test the full flow (SDK not available in tests), but
    // verify the reconstruction creates the session in the map
    try {
      await engine.sendMessage(session.id, { content: "continue" })
    } catch {
      // May fail on actual SDK query, but the reconstruction should have happened
    }

    // The session should be back in the map (reconstructed from metadata)
    expect(engine.getSessionState(session.id)).not.toBeNull()
  })
})
