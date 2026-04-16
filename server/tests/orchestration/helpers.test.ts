import { describe, it, expect, afterEach } from "vitest"
import { validateWithinWorkspace } from "../../src/orchestration/helpers.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const tmpDirs: string[] = []

function createTmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("validateWithinWorkspace", () => {
  it("rejects symlink or junction escapes outside the workspace", () => {
    const workspaceDir = createTmpDir("atelier-workspace-")
    const outsideDir = createTmpDir("atelier-outside-")
    fs.writeFileSync(path.join(outsideDir, "secret.md"), "top secret")

    const escapeDir = path.join(workspaceDir, "escape")
    fs.symlinkSync(outsideDir, escapeDir, process.platform === "win32" ? "junction" : "dir")

    expect(() => validateWithinWorkspace(path.join("escape", "secret.md"), workspaceDir, "promptPath"))
      .toThrow(/within workspace/)
  })

  it("allows missing paths when their existing ancestors stay inside the workspace", () => {
    const workspaceDir = createTmpDir("atelier-workspace-")

    expect(() => validateWithinWorkspace(path.join("nested", "new-file.md"), workspaceDir, "outputPath"))
      .not.toThrow()
  })
})
