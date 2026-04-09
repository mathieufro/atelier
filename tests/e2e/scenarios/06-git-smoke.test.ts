/**
 * E2E Smoke Test: Git Branch Creation
 *
 * Minimum viable git integration test: start feature pipeline,
 * verify git_branch_created event, confirm branch in git.
 * If this passes, harness works, server starts, git-ops execute, events flow.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createE2EHarness, type E2EHarness } from "../harness.js"
import { getAvailableBackends, getAvailableBackendsFromServer, backends } from "../config.js"
import { createGitWorkspace, gitBranch, cleanupStateDir } from "../git-helpers.js"
import type { Workspace } from "../workspace.js"

describe.each(getAvailableBackends())("Smoke: git branch creation [%s]", (backend) => {
  let workspace: Workspace
  let harness: E2EHarness
  let backendAvailable = false

  beforeAll(async () => {
    workspace = await createGitWorkspace(`git-smoke-${backend}`, {
      "index.ts": "export const x = 1",
    })
    harness = await createE2EHarness(workspace)
    await harness.waitForReady(90_000)
    const available = await getAvailableBackendsFromServer(harness.serverUrl)
    backendAvailable = available.includes(backend)
  }, 120_000)

  afterAll(async () => {
    harness?.writeTranscript(`06-git-smoke-${backend}`)
    await harness?.cleanup()
    await workspace?.cleanup()
  }, 15_000)

  it("feature pipeline creates git branch", async ({ skip }) => {
    if (!backendAvailable) skip()

    const config = backends[backend]
    const body: Record<string, unknown> = {
      content: "Add a greet function that returns 'hello'",
      mode: "feature",
      model: config.model,
    }
    if (config.variant) body.variant = config.variant

    const res = await fetch(`${harness.serverUrl}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(res.ok).toBe(true)
    const resBody = (await res.json()) as Record<string, unknown>
    expect(resBody.pipelineId).toBeDefined()

    // Wait for branch creation event
    const event = (await harness.waitForEvent("git_branch_created", 120_000)) as Record<string, unknown>
    expect(event.branch).toBeDefined()
    expect(typeof event.branch).toBe("string")
    expect(event.branch as string).toMatch(/^atelier\//)
    expect(event.baseBranch).toBeTruthy()

    // Verify actual git state
    const currentBranch = gitBranch(workspace.path)
    expect(currentBranch).toMatch(/^atelier\//)
  }, 120_000)
})
