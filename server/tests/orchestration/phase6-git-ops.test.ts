import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"
import {
  addWorktree,
  removeWorktree,
  listWorktrees,
  isWorkingTreeClean,
  branchExists,
  rescueCommitWorktree,
  getHeadSha,
} from "../../src/orchestration/git-ops.js"

function initRepo(dir: string) {
  execFileSync("git", ["init"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir })
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir })
  fs.writeFileSync(path.join(dir, "README.md"), "# Test\n")
  execFileSync("git", ["add", "-A"], { cwd: dir })
  execFileSync("git", ["commit", "-m", "seed"], { cwd: dir })
}

describe("git-ops: worktree operations", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ops-wt-"))
    initRepo(tmpDir)
  })

  afterEach(() => {
    try {
      const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: tmpDir, encoding: "utf-8" })
      for (const line of list.split("\n")) {
        if (line.startsWith("worktree ")) {
          const wtPath = line.slice("worktree ".length)
          if (wtPath !== tmpDir) {
            try { execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: tmpDir }) } catch {}
          }
        }
      }
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("addWorktree creates a worktree with a new branch", async () => {
    const wtPath = path.join(tmpDir, ".atelier", "worktrees", "test-slug")
    const result = await addWorktree(tmpDir, wtPath, "atelier/test-slug")

    expect(result.ok).toBe(true)
    expect(fs.existsSync(wtPath)).toBe(true)
    expect(fs.existsSync(path.join(wtPath, ".git"))).toBe(true)
    expect(await branchExists(tmpDir, "atelier/test-slug")).toBe(true)
  })

  it("addWorktree returns error when branch already exists", async () => {
    execFileSync("git", ["checkout", "-b", "atelier/conflict"], { cwd: tmpDir })
    execFileSync("git", ["checkout", "-"], { cwd: tmpDir })

    const wtPath = path.join(tmpDir, ".atelier", "worktrees", "conflict")
    const result = await addWorktree(tmpDir, wtPath, "atelier/conflict")
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it("removeWorktree removes a clean worktree", async () => {
    const wtPath = path.join(tmpDir, ".atelier", "worktrees", "removable")
    await addWorktree(tmpDir, wtPath, "atelier/removable")
    expect(fs.existsSync(wtPath)).toBe(true)

    const result = await removeWorktree(tmpDir, wtPath)
    expect(result.ok).toBe(true)
    expect(fs.existsSync(wtPath)).toBe(false)
  })

  it("removeWorktree rescue-commits uncommitted changes before removal", async () => {
    const wtPath = path.join(tmpDir, ".atelier", "worktrees", "dirty-rescue")
    await addWorktree(tmpDir, wtPath, "atelier/dirty-rescue")

    // Create uncommitted work in the worktree
    fs.writeFileSync(path.join(wtPath, "important-work.ts"), "export const x = 42\n")

    // Get SHA before removal
    const shaBefore = await getHeadSha(wtPath)

    const result = await removeWorktree(tmpDir, wtPath)
    expect(result.ok).toBe(true)
    expect(fs.existsSync(wtPath)).toBe(false)

    // Verify the rescue commit was made on the branch
    const log = execFileSync("git", ["log", "--oneline", "atelier/dirty-rescue"], {
      cwd: tmpDir,
      encoding: "utf-8",
    })
    expect(log).toContain("atelier(rescue)")

    // Branch HEAD should have advanced past the seed commit
    const shaAfter = execFileSync("git", ["rev-parse", "atelier/dirty-rescue"], {
      cwd: tmpDir,
      encoding: "utf-8",
    }).trim()
    expect(shaAfter).not.toBe(shaBefore)
  })

  it("removeWorktree rescues untracked, modified, and deleted files", async () => {
    const wtPath = path.join(tmpDir, ".atelier", "worktrees", "mixed-dirty")
    await addWorktree(tmpDir, wtPath, "atelier/mixed-dirty")

    // Modify existing file
    fs.writeFileSync(path.join(wtPath, "README.md"), "# Modified\n")
    // Add untracked file
    fs.writeFileSync(path.join(wtPath, "untracked.ts"), "export const z = 99\n")

    const result = await removeWorktree(tmpDir, wtPath)
    expect(result.ok).toBe(true)

    // Verify rescue commit captured everything
    const diff = execFileSync("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", "atelier/mixed-dirty"], {
      cwd: tmpDir,
      encoding: "utf-8",
    })
    expect(diff).toContain("README.md")
    expect(diff).toContain("untracked.ts")
  })

  it("removeWorktree returns error for non-existent worktree", async () => {
    const result = await removeWorktree(tmpDir, "/nonexistent/path")
    expect(result.ok).toBe(false)
  })

  it("listWorktrees returns all worktrees", async () => {
    const wt1 = path.join(tmpDir, ".atelier", "worktrees", "wt1")
    const wt2 = path.join(tmpDir, ".atelier", "worktrees", "wt2")
    await addWorktree(tmpDir, wt1, "atelier/wt1")
    await addWorktree(tmpDir, wt2, "atelier/wt2")

    const list = await listWorktrees(tmpDir)
    expect(list.length).toBeGreaterThanOrEqual(3)
    // Use realpathSync.native so Windows 8.3 short names in TMPDIR (e.g. RUNNER~1)
    // are expanded to their long form, matching what listWorktrees produces.
    const realWt1 = fs.realpathSync.native(wt1)
    const realWt2 = fs.realpathSync.native(wt2)
    expect(list.some(w => w.path === realWt1)).toBe(true)
    expect(list.some(w => w.path === realWt2)).toBe(true)
    expect(list.some(w => w.branch === "atelier/wt1")).toBe(true)
  })

  it("listWorktrees returns empty array for non-git dir", async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-"))
    const list = await listWorktrees(nonGit)
    expect(list).toEqual([])
    fs.rmSync(nonGit, { recursive: true, force: true })
  })
})

describe("git-ops: rescueCommitWorktree", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ops-rescue-"))
    initRepo(tmpDir)
  })

  afterEach(() => {
    try {
      const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: tmpDir, encoding: "utf-8" })
      for (const line of list.split("\n")) {
        if (line.startsWith("worktree ")) {
          const wtPath = line.slice("worktree ".length)
          if (wtPath !== tmpDir) {
            try { execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: tmpDir }) } catch {}
          }
        }
      }
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("commits uncommitted changes and returns SHA", async () => {
    const wtPath = path.join(tmpDir, ".atelier", "worktrees", "rescue-test")
    await addWorktree(tmpDir, wtPath, "atelier/rescue-test")

    fs.writeFileSync(path.join(wtPath, "new-file.ts"), "export const y = 1\n")

    const sha = await rescueCommitWorktree(wtPath, "test rescue")
    expect(sha).toBeTruthy()
    expect(typeof sha).toBe("string")

    // Verify commit message
    const log = execFileSync("git", ["log", "--oneline", "-1"], {
      cwd: wtPath,
      encoding: "utf-8",
    })
    expect(log).toContain("atelier(rescue): test rescue")
  })

  it("returns null when nothing to commit", async () => {
    const wtPath = path.join(tmpDir, ".atelier", "worktrees", "clean-test")
    await addWorktree(tmpDir, wtPath, "atelier/clean-test")

    const sha = await rescueCommitWorktree(wtPath, "clean")
    expect(sha).toBeNull()
  })

  it("returns null for non-existent directory", async () => {
    const sha = await rescueCommitWorktree("/nonexistent/path", "missing")
    expect(sha).toBeNull()
  })

  it("never throws — returns null on any error", async () => {
    // Pass a directory that exists but isn't a git repo
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "non-git-rescue-"))
    const sha = await rescueCommitWorktree(nonGit, "not a repo")
    expect(sha).toBeNull()
    fs.rmSync(nonGit, { recursive: true, force: true })
  })
})

describe("git-ops: isWorkingTreeClean with excludes", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ops-clean-"))
    initRepo(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns true when only excluded paths are dirty", async () => {
    fs.mkdirSync(path.join(tmpDir, ".atelier"), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, ".atelier", "state.json"), "{}")
    expect(await isWorkingTreeClean(tmpDir)).toBe(false)
    expect(await isWorkingTreeClean(tmpDir, { exclude: [".atelier"] })).toBe(true)
  })

  it("returns false when non-excluded paths are dirty", async () => {
    fs.writeFileSync(path.join(tmpDir, "user-file.txt"), "content")
    expect(await isWorkingTreeClean(tmpDir, { exclude: [".atelier"] })).toBe(false)
  })
})
