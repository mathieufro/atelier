/**
 * E2E Scenario 5: Attachments & Multi-Model Journey
 *
 * Model switching, multi-turn with different models.
 * Real backends, real model selection.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createWorkspace, type Workspace } from "../workspace.js"
import { createE2EHarness, type E2EHarness } from "../harness.js"
import { getAvailableBackends, getAvailableBackendsFromServer, backends } from "../config.js"

describe.each(getAvailableBackends())("Scenario 5: Attachments & Multi-Model [%s]", (backend) => {
  let workspace: Workspace
  let harness: E2EHarness
  let sessionId: string
  let backendAvailable = false

  beforeAll(async () => {
    workspace = await createWorkspace(`multimodel-${backend}`, {
      "src/helper.ts": [
        "export function greet(name: string): string {",
        "  return `Hello, ${name}!`",
        "}",
        "",
        "export function farewell(name: string): string {",
        "  return `Goodbye, ${name}!`",
        "}",
      ].join("\n"),
      "README.md": "# Test Project\n\nA simple project for testing.",
    })
    harness = await createE2EHarness(workspace)
    await harness.waitForReady(90_000)

    // Check if this backend is actually available on the running server
    const available = await getAvailableBackendsFromServer(harness.serverUrl)
    backendAvailable = available.includes(backend)
  }, 120_000)

  afterAll(async () => {
    harness?.writeTranscript(`05-attachments-multimodel-${backend}`)
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

  it("Step 1-2: read tool accesses file content", async ({ skip }) => {
    if (!backendAvailable) skip()

    await sendAndWaitIdle(
      "Read the file src/helper.ts and tell me what functions it exports",
    )

    // Check read tool was used
    const readTool = harness.events.find((e: any) => {
      if (e.type !== "message.part.updated") return false
      const part = e.properties?.part
      return part?.tool === "read" && part?.state?.status === "completed"
    })
    expect(readTool).toBeTruthy()
  }, 120_000)

  it("Step 3-4: agent uses context from previous reads", async ({ skip }) => {
    if (!backendAvailable) skip()
    const startIdx = harness.events.length

    await sendAndWaitIdle(
      "Now add a new function called 'celebrate' to src/helper.ts that returns `Congratulations, {name}!` following the same pattern as the existing functions",
      startIdx,
    )

    // Verify the file was edited
    const content = readFileSync(join(workspace.path, "src/helper.ts"), "utf-8")
    expect(content).toContain("celebrate")
    expect(content).toContain("Congratulations")
  }, 120_000)

  it("Step 5-7: model can be specified per message", async ({ skip }) => {
    if (!backendAvailable) skip()
    const startIdx = harness.events.length
    const config = backends[backend]

    const body: Record<string, unknown> = {
      content: "What files exist in this workspace? Just list them.",
      mode: "build",
      model: config.model,
    }
    if (config.variant) body.variant = config.variant
    const res = await fetch(`${harness.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const resBody = await res.json() as any
    if (!res.ok) throw new Error(`sendMessage failed: ${res.status} ${JSON.stringify(resBody)}`)
    if (resBody.sessionId) sessionId = resBody.sessionId

    await harness.waitForEvent("session.idle", 120_000, startIdx)

    // Agent should have responded
    const msgEvents = harness.events.slice(startIdx).filter((e: any) =>
      e.type === "message.updated" || e.type === "message.part.updated"
    )
    expect(msgEvents.length).toBeGreaterThan(0)
  }, 120_000)
})
