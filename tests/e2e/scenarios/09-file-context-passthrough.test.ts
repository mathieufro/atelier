/**
 * E2E Scenario 9: File Context Server Passthrough
 *
 * Verifies that messages with [context: ...] prefixes pass through the Atelier
 * server without errors. The prefix is injected client-side (augmentWithFileContext
 * in InputBar.tsx) before the message reaches the server — the server must treat
 * it as ordinary message text.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createWorkspace, type Workspace } from "../workspace.js"
import { createE2EHarness, type E2EHarness } from "../harness.js"
import { getAvailableBackends, getAvailableBackendsFromServer, backends } from "../config.js"

describe.each(getAvailableBackends())("Scenario 9: File Context Passthrough [%s]", (backend) => {
  let workspace: Workspace
  let harness: E2EHarness
  let backendAvailable = false

  beforeAll(async () => {
    workspace = await createWorkspace(`ctx-passthrough-${backend}`, {
      "src/app.ts": "export const x = 1\n",
      "package.json": JSON.stringify({ name: "ctx-passthrough-test", version: "1.0.0" }),
    })
    harness = await createE2EHarness(workspace)
    await harness.waitForReady(90_000)

    const available = await getAvailableBackendsFromServer(harness.serverUrl)
    backendAvailable = available.includes(backend)
  }, 120_000)

  afterAll(async () => {
    harness?.writeTranscript(`09-file-context-passthrough-${backend}`)
    await harness?.cleanup()
    await workspace?.cleanup()
  }, 15_000)

  it("server processes context-prefixed message normally", async ({ skip }) => {
    if (!backendAvailable) skip()

    const cfg = backends[backend]
    const sessionId = await harness.createSession(backend)

    const startIdx = harness.events.length

    // Send a message with the [context: ...] prefix that augmentWithFileContext would produce
    const body: Record<string, unknown> = {
      content: "[context: src/app.ts:1-5]\nWhat does this file do?",
      mode: "build",
      sessionId,
      model: cfg.model,
    }
    if (cfg.variant) body.variant = cfg.variant

    const res = await fetch(`${harness.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(res.ok).toBe(true)

    // Wait for the session to become idle — confirms the server processed the message
    const idleEvent = await harness.waitForEvent("session.idle", 180_000, startIdx)
    expect(idleEvent).toBeTruthy()

    // Confirm the backend produced assistant output (non-empty response)
    const assistantEvents = harness.events
      .slice(startIdx)
      .filter((e: any) => e.type === "assistant.text" || e.type === "assistant.delta")
    expect(assistantEvents.length).toBeGreaterThan(0)
  }, 300_000)
})
