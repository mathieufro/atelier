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

  it("rejects relative paths with .. traversal", () => {
    const workspaceDir = createTmpDir("atelier-workspace-")

    expect(() => validateWithinWorkspace("../../etc/passwd", workspaceDir, "promptPath"))
      .toThrow(/within workspace/)
  })

  it("rejects absolute paths outside the workspace", () => {
    const workspaceDir = createTmpDir("atelier-workspace-")
    const outsideDir = createTmpDir("atelier-outside-")

    expect(() => validateWithinWorkspace(path.join(outsideDir, "secret.md"), workspaceDir, "promptPath"))
      .toThrow(/within workspace/)
  })

  it("rejects path-prefix false positive (workspace is a prefix of target path)", () => {
    // Create /tmp/atelier-ws- and /tmp/atelier-ws-extra- to test that
    // /tmp/atelier-ws- does NOT accept files under /tmp/atelier-ws-extra-
    const workspaceDir = createTmpDir("atelier-ws-")
    const similarDir = workspaceDir + "extra"
    fs.mkdirSync(similarDir, { recursive: true })
    tmpDirs.push(similarDir)
    fs.writeFileSync(path.join(similarDir, "secret.md"), "top secret")

    expect(() => validateWithinWorkspace(path.join(similarDir, "secret.md"), workspaceDir, "promptPath"))
      .toThrow(/within workspace/)
  })

  it("allows the workspace root itself", () => {
    const workspaceDir = createTmpDir("atelier-workspace-")

    expect(() => validateWithinWorkspace(".", workspaceDir, "outputPath"))
      .not.toThrow()
  })
})
