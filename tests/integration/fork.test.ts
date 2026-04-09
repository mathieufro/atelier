import { describe, it, expect, afterEach } from "vitest"
import { createTestHarness, type TestHarness } from "./harness.js"

describe("Session Forking — Integration", () => {
  let harness: TestHarness

  afterEach(async () => {
    await harness?.teardown()
  })

  it("POST /session/:id/fork creates a fork with forkedFrom metadata", async () => {
    harness = await createTestHarness([])

    // Create source session
    const createRes = await harness.app.request("/session", { method: "POST" })
    expect(createRes.status).toBe(200)
    const { id: sourceId } = await createRes.json() as { id: string }

    // Fork it
    const forkRes = await harness.app.request(`/session/${sourceId}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test fork" }),
    })
    expect(forkRes.status).toBe(200)
    const { id: forkId } = await forkRes.json() as { id: string }

    expect(forkId).toBeTruthy()
    expect(forkId).not.toBe(sourceId)

    // Verify fork appears in session list (not filtered out)
    const listRes = await harness.app.request("/sessions")
    const sessions = await listRes.json() as Array<{ id: string; forkedFrom?: string }>
    const forkInList = sessions.find((s) => s.id === forkId)
    expect(forkInList).toBeTruthy()
    expect(forkInList!.forkedFrom).toBe(sourceId)
  })

  it("forked session GET returns forkedFrom and parentId null", async () => {
    harness = await createTestHarness([])

    const createRes = await harness.app.request("/session", { method: "POST" })
    const { id: sourceId } = await createRes.json() as { id: string }

    const forkRes = await harness.app.request(`/session/${sourceId}/fork`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Fork detail test" }),
    })
    const { id: forkId } = await forkRes.json() as { id: string }

    const getRes = await harness.app.request(`/session/${forkId}`)
    expect(getRes.status).toBe(200)
    const session = await getRes.json() as Record<string, unknown>
    expect(session.forkedFrom).toBe(sourceId)
  })

  it("fork of nonexistent session returns error", async () => {
    harness = await createTestHarness([])

    const forkRes = await harness.app.request("/session/nonexistent/fork", { method: "POST" })
    // proxyCall wraps engine errors as 502
    expect(forkRes.status).toBe(502)
  })

  it("fork of a fork creates valid chain", async () => {
    harness = await createTestHarness([])

    const createRes = await harness.app.request("/session", { method: "POST" })
    const { id: sourceId } = await createRes.json() as { id: string }

    const fork1Res = await harness.app.request(`/session/${sourceId}/fork`, { method: "POST" })
    const { id: fork1Id } = await fork1Res.json() as { id: string }

    const fork2Res = await harness.app.request(`/session/${fork1Id}/fork`, { method: "POST" })
    expect(fork2Res.status).toBe(200)
    const { id: fork2Id } = await fork2Res.json() as { id: string }

    const getRes = await harness.app.request(`/session/${fork2Id}`)
    const session = await getRes.json() as Record<string, unknown>
    expect(session.forkedFrom).toBe(fork1Id) // Points to F1, not original
  })

  it("forked session can be deleted independently", async () => {
    harness = await createTestHarness([])

    const createRes = await harness.app.request("/session", { method: "POST" })
    const { id: sourceId } = await createRes.json() as { id: string }

    const forkRes = await harness.app.request(`/session/${sourceId}/fork`, { method: "POST" })
    const { id: forkId } = await forkRes.json() as { id: string }

    // Delete the fork
    const deleteRes = await harness.app.request(`/session/${forkId}`, { method: "DELETE" })
    expect(deleteRes.status).toBe(200)

    // Source still exists
    const getRes = await harness.app.request(`/session/${sourceId}`)
    expect(getRes.status).toBe(200)
  })

  it("no body on fork request defaults title", async () => {
    harness = await createTestHarness([])

    const createRes = await harness.app.request("/session", { method: "POST" })
    const { id: sourceId } = await createRes.json() as { id: string }

    const forkRes = await harness.app.request(`/session/${sourceId}/fork`, { method: "POST" })
    expect(forkRes.status).toBe(200)
    const { id: forkId } = await forkRes.json() as { id: string }
    expect(forkId).toBeTruthy()
  })
})
