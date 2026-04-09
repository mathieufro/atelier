/**
 * E2E Scenario 1: Core Tools Journey
 *
 * Spawns a real Atelier server, sends real prompts to real backends,
 * and asserts on real SSE events + file system state.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createWorkspace, type Workspace } from "../workspace.js"
import { createE2EHarness, type E2EHarness } from "../harness.js"
import { getAvailableBackends, getAvailableBackendsFromServer, backends } from "../config.js"

describe.each(getAvailableBackends())("Scenario 1: Core Tools [%s]", (backend) => {
  let workspace: Workspace
  let harness: E2EHarness
  let sessionId: string
  let backendAvailable = false

  beforeAll(async () => {
    workspace = await createWorkspace(`core-tools-${backend}`, {
      "src/index.ts": "export const greeting = 'hello world'",
      "src/utils.ts": "export function add(a: number, b: number) { return a + b }",
    })
    harness = await createE2EHarness(workspace)
    await harness.waitForReady(90_000)

    // Check if this backend is actually available on the running server
    const available = await getAvailableBackendsFromServer(harness.serverUrl)
    backendAvailable = available.includes(backend)
  }, 120_000)

  afterAll(async () => {
    harness?.writeTranscript(`01-core-tools-${backend}`)
    await harness?.cleanup()
    await workspace?.cleanup()
  }, 15_000)

  /** Send message with explicit model for this backend, wait for idle */
  async function sendAndWaitIdle(content: string): Promise<number> {
    if (!backendAvailable) return 0
    const startIdx = harness.events.length
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
    await harness.waitForEvent("session.idle", 120_000, startIdx)
    return startIdx
  }

  /** Find a completed tool in events after startIdx */
  function findCompletedTool(startIdx: number, toolName: string) {
    return harness.events.slice(startIdx).find((e: any) => {
      if (e.type !== "message.part.updated") return false
      const part = e.properties?.part
      return part?.tool === toolName && part?.state?.status === "completed"
    })
  }

  it("Step 1-2: write tool creates a file on disk", async ({ skip }) => {
    if (!backendAvailable) skip()
    const startIdx = await sendAndWaitIdle(
      "Create a file called `hello.ts` in the root of the workspace with content `export const greeting = 'hello world'`"
    )
    const writeTool = findCompletedTool(startIdx, "write")
    expect(writeTool).toBeTruthy()
    const filePath = join(workspace.path, "hello.ts")
    expect(existsSync(filePath)).toBe(true)
    const content = readFileSync(filePath, "utf-8")
    expect(content).toContain("greeting")
  }, 120_000)

  it("Step 3-4: read tool reads file content", async ({ skip }) => {
    if (!backendAvailable) skip()
    const startIdx = await sendAndWaitIdle("Read the file `hello.ts` and tell me its content")
    const readTool = findCompletedTool(startIdx, "read")
    expect(readTool).toBeTruthy()
  }, 120_000)

  it("Step 5-6: edit tool modifies a file", async ({ skip }) => {
    if (!backendAvailable) skip()
    const startIdx = await sendAndWaitIdle("Edit `hello.ts` to change 'hello world' to 'hello atelier'")
    const editTool = harness.events.slice(startIdx).find((e: any) => {
      if (e.type !== "message.part.updated") return false
      const part = e.properties?.part
      const tool = part?.tool
      return (tool === "edit" || tool === "apply_patch" || tool === "patch") && part?.state?.status === "completed"
    })
    expect(editTool).toBeTruthy()
    const content = readFileSync(join(workspace.path, "hello.ts"), "utf-8")
    expect(content).toContain("hello atelier")
  }, 120_000)

  it("Step 7-8: glob tool finds .ts files", async ({ skip }) => {
    if (!backendAvailable) skip()
    const startIdx = await sendAndWaitIdle("Find all .ts files in the workspace using glob")
    const globTool = findCompletedTool(startIdx, "glob")
    expect(globTool).toBeTruthy()
  }, 120_000)

  it("Step 9-10: grep tool searches content", async ({ skip }) => {
    if (!backendAvailable) skip()
    const startIdx = await sendAndWaitIdle("Search for 'greeting' in all files using grep")
    const grepTool = findCompletedTool(startIdx, "grep")
    expect(grepTool).toBeTruthy()
  }, 120_000)

  it("Step 11-12: bash tool executes commands", async ({ skip }) => {
    if (!backendAvailable) skip()
    const startIdx = await sendAndWaitIdle("Run `cat hello.ts` in bash")
    const bashTool = findCompletedTool(startIdx, "bash")
    expect(bashTool).toBeTruthy()
    expect((bashTool as any).properties.part.state.output).toContain("hello atelier")
  }, 120_000)

  it("full journey produces correct event sequence", ({ skip }) => {
    if (!backendAvailable) skip()
    const types = new Set(harness.events.map((e: any) => e.type))
    expect(types.has("session.idle")).toBe(true)
    expect(types.has("message.part.updated")).toBe(true)
    expect(types.has("message.updated")).toBe(true)
  })
})
