/**
 * E2E Scenario 4: MCP & Context Journey
 *
 * Reasoning/thinking parts, multi-turn context.
 * Real backends producing real content.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createWorkspace, type Workspace } from "../workspace.js"
import { createE2EHarness, type E2EHarness } from "../harness.js"
import { getAvailableBackends, getAvailableBackendsFromServer, backends } from "../config.js"

describe.each(getAvailableBackends())("Scenario 4: MCP & Context [%s]", (backend) => {
  let workspace: Workspace
  let harness: E2EHarness
  let sessionId: string
  let backendAvailable = false

  beforeAll(async () => {
    workspace = await createWorkspace(`mcp-context-${backend}`, {
      "src/index.ts": "export function fibonacci(n: number): number { return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2) }",
      "src/data.json": JSON.stringify({ items: [1, 2, 3, 4, 5], label: "test data" }),
    })
    harness = await createE2EHarness(workspace)
    await harness.waitForReady(90_000)

    // Check if this backend is actually available on the running server
    const available = await getAvailableBackendsFromServer(harness.serverUrl)
    backendAvailable = available.includes(backend)
  }, 120_000)

  afterAll(async () => {
    harness?.writeTranscript(`04-mcp-context-${backend}`)
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
    await harness.waitForEvent("session.idle", 120_000, idx)
    return idx
  }

  it("Step 6-7: agent produces tool usage on optimization request", async ({ skip }) => {
    if (!backendAvailable) skip()

    await sendAndWaitIdle(
      "Optimize the fibonacci function in src/index.ts to use memoization. Edit the file directly.",
    )

    // Check that tool parts were used
    const toolParts = harness.events.filter((e: any) => {
      if (e.type !== "message.part.updated") return false
      const part = e.properties?.part
      return part?.tool && part?.state?.status === "completed"
    })
    expect(toolParts.length).toBeGreaterThan(0)
  }, 120_000)

  it("Step 8-9: multi-turn conversation uses context", async ({ skip }) => {
    if (!backendAvailable) skip()
    const startIdx = harness.events.length

    // First message
    await sendAndWaitIdle("Read src/data.json and tell me what's in it", startIdx)

    const midIdx = harness.events.length

    // Second message referencing previous context
    await sendAndWaitIdle("Now add a 'count' field to that JSON file with the number of items in the items array", midIdx)

    // Agent should have edited the file
    const content = readFileSync(join(workspace.path, "src/data.json"), "utf-8")
    const parsed = JSON.parse(content)
    expect(parsed.count).toBe(5)
  }, 180_000)
})
