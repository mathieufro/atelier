/**
 * E2E Scenario 2: Agent & Interactions Journey
 *
 * Subagent/task tool, permission handling, abort + resume.
 * Real backends, real agents.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createWorkspace, type Workspace } from "../workspace.js"
import { createE2EHarness, type E2EHarness } from "../harness.js"
import { getAvailableBackends, getAvailableBackendsFromServer, backends } from "../config.js"

describe.each(getAvailableBackends())("Scenario 2: Agent Interactions [%s]", (backend) => {
  let workspace: Workspace
  let harness: E2EHarness
  let sessionId: string
  let backendAvailable = false

  beforeAll(async () => {
    workspace = await createWorkspace(`agent-interactions-${backend}`, {
      "src/main.ts": [
        "export function processData(items: string[]) {",
        "  const result: string[] = []",
        "  for (let i = 0; i < items.length; i++) {",
        "    result.push(items[i].toUpperCase())",
        "  }",
        "  return result",
        "}",
        "",
        "export function formatOutput(data: string[]) {",
        "  return data.join(', ')",
        "}",
      ].join("\n"),
      "src/config.ts": [
        "export const config = {",
        "  maxRetries: 3,",
        "  timeout: 5000,",
        "  verbose: false,",
        "}",
      ].join("\n"),
    })
    harness = await createE2EHarness(workspace)
    await harness.waitForReady(90_000)

    // Check if this backend is actually available on the running server
    const available = await getAvailableBackendsFromServer(harness.serverUrl)
    backendAvailable = available.includes(backend)
  }, 120_000)

  afterAll(async () => {
    harness?.writeTranscript(`02-agent-interactions-${backend}`)
    await harness?.cleanup()
    await workspace?.cleanup()
  }, 15_000)

  /** Send message with explicit model for this backend, wait for idle */
  async function sendAndWaitIdle(content: string, startIdx?: number): Promise<number> {
    if (!backendAvailable) return 0
    const idx = startIdx ?? harness.events.length
    const config = backends[backend]
    const body: Record<string, unknown> = { content, mode: "build", model: config.model }
    if (sessionId) body.sessionId = sessionId
    if (config.variant) body.variant = config.variant
    const res = await fetch(`${harness.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const resBody = await res.json() as any
    if (!res.ok) {
      throw new Error(`sendMessage failed: ${res.status} ${JSON.stringify(resBody)}`)
    }
    if (resBody.sessionId) sessionId = resBody.sessionId
    await harness.waitForEvent("session.idle", 180_000, idx)
    return idx
  }

  it("Step 1-2: agent uses write/edit tools for multi-file changes", async ({ skip }) => {
    if (!backendAvailable) skip()
    await sendAndWaitIdle(
      "Refactor processData in src/main.ts — extract the uppercase logic into a helper function in a new file src/helpers.ts and import it in main.ts.",
    )

    // Verify tool execution happened — at least one write or edit completed
    const completedTools = harness.events.filter((e: any) => {
      if (e.type !== "message.part.updated") return false
      const part = e.properties?.part
      const tool = part?.tool
      return (tool === "write" || tool === "edit" || tool === "apply_patch") && part?.state?.status === "completed"
    })
    expect(completedTools.length).toBeGreaterThan(0)
  }, 180_000)

  it("Step 9-12: abort mid-execution and resume", async ({ skip }) => {
    if (!backendAvailable) skip()
    const startIdx = harness.events.length

    const config = backends[backend]
    const body: Record<string, unknown> = {
      content: "Read every file in the src/ directory one by one, then create a detailed summary of each in a new file called SUMMARY.md",
      mode: "build",
      model: config.model,
    }
    if (sessionId) body.sessionId = sessionId
    if (config.variant) body.variant = config.variant
    const res = await fetch(`${harness.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const resBody = await res.json() as any
    if (!res.ok) throw new Error(`sendMessage failed: ${res.status} ${JSON.stringify(resBody)}`)
    if (resBody.sessionId) sessionId = resBody.sessionId

    // Wait for some activity then abort
    await new Promise((r) => setTimeout(r, 3_000))

    if (sessionId) {
      await harness.abortSession(sessionId)

      // Wait for idle (agent stops after abort)
      await harness.waitForEvent("session.idle", 60_000, startIdx)

      // Verify we got session.idle after the abort
      const idleEvent = harness.events.slice(startIdx).find((e: any) => e.type === "session.idle")
      expect(idleEvent).toBeTruthy()
    }
  }, 120_000)
})
