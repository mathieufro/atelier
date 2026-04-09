/**
 * E2E Scenario 3: Skill & Pipeline Journey
 *
 * Pipeline stage progression via feature mode.
 * Real backends, real pipeline orchestration.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createWorkspace, type Workspace } from "../workspace.js"
import { createE2EHarness, type E2EHarness } from "../harness.js"
import { getAvailableBackends, getAvailableBackendsFromServer, backends } from "../config.js"

describe.each(getAvailableBackends())("Scenario 3: Skill & Pipeline [%s]", (backend) => {
  let workspace: Workspace
  let harness: E2EHarness
  let backendAvailable = false

  beforeAll(async () => {
    workspace = await createWorkspace(`skill-pipeline-${backend}`, {
      "src/index.ts": "export function main() { console.log('hello') }",
      "package.json": JSON.stringify({ name: "test-project", version: "1.0.0" }),
    })
    harness = await createE2EHarness(workspace)
    await harness.waitForReady(90_000)

    // Check if this backend is actually available on the running server
    const available = await getAvailableBackendsFromServer(harness.serverUrl)
    backendAvailable = available.includes(backend)
  }, 120_000)

  afterAll(async () => {
    harness?.writeTranscript(`03-skill-pipeline-${backend}`)
    await harness?.cleanup()
    await workspace?.cleanup()
  }, 15_000)

  it("Step 1-3: pipeline starts with feature mode and produces events", async ({ skip }) => {
    if (!backendAvailable) skip()

    const config = backends[backend]
    const body: Record<string, unknown> = {
      content: "Add a simple config file reader that reads a JSON config from disk",
      mode: "feature",
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

    // Wait for pipeline activity — should see stage or session events
    // Pipeline drives multiple sessions, so we see session.idle events
    await harness.waitForEvent("session.idle", 300_000)

    // Verify we got real events from the pipeline
    const types = new Set(harness.events.map((e: any) => e.type))
    expect(types.has("message.part.updated")).toBe(true)
  }, 300_000)

  it("Step 4-5: stage events or pipeline events flow through", async ({ skip }) => {
    if (!backendAvailable) skip()

    // Pipeline should have produced multiple sessions worth of events
    const sessionEvents = harness.events.filter((e: any) =>
      e.type === "session.idle" || e.type === "session.created" || e.type === "session.updated"
    )
    expect(sessionEvents.length).toBeGreaterThan(0)
  })
})
