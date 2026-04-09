import { describe, it, expect, afterEach } from "vitest"
import { createWorkspace, type Workspace } from "./workspace.js"

let workspace: Workspace | null = null
afterEach(async () => { await workspace?.cleanup() })

describe("E2E Workspace", () => {
  it("creates a temp directory with seeded files", async () => {
    workspace = await createWorkspace("test-ws", {
      "hello.ts": "export const x = 1",
      "src/main.ts": "console.log('hello')",
    })
    const { existsSync } = await import("node:fs")
    expect(existsSync(`${workspace.path}/hello.ts`)).toBe(true)
    expect(existsSync(`${workspace.path}/src/main.ts`)).toBe(true)
  })

  it("initializes a git repo", async () => {
    workspace = await createWorkspace("git-ws")
    const { execSync } = await import("node:child_process")
    const status = execSync("git status", { cwd: workspace.path }).toString()
    expect(status).toContain("nothing to commit")
  })

  it("cleanup removes the directory", async () => {
    workspace = await createWorkspace("cleanup-ws")
    const wsPath = workspace.path
    await workspace.cleanup()
    const { existsSync } = await import("node:fs")
    expect(existsSync(wsPath)).toBe(false)
    workspace = null
  })
})
