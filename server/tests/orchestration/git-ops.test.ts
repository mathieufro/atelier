import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync } from "node:child_process"
import {
  ensureGitRepo,
  isWorkingTreeClean,
  isRebaseOrMergeInProgress,
  getCurrentBranch,
  getHeadSha,
  createFeatureBranch,
  checkoutBranch,
  branchExists,
  stageAll,
  hasStagedChanges,
  commit,
  type GitCommitResult,
} from "../../src/orchestration/git-ops.js"

/** Run a git command synchronously for test setup. */
function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
}

/** Initialize a temp git repo for tests. */
function initRepo(dir: string): void {
  git(["init"], dir)
  git(["config", "user.name", "Test"], dir)
  git(["config", "user.email", "test@test.com"], dir)
  git(["commit", "--allow-empty", "-m", "seed"], dir)
}

describe("git-ops: ensureGitRepo", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ops-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("initializes a new repo in a non-git directory", async () => {
    const result = await ensureGitRepo(tmpDir)
    expect(result.initialized).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, ".git"))).toBe(true)
  })

  it("returns initialized=false for an existing repo", async () => {
    initRepo(tmpDir)
    const result = await ensureGitRepo(tmpDir)
    expect(result.initialized).toBe(false)
  })

  it("creates initial commit with existing files (greenfield)", async () => {
    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "hello")
    const result = await ensureGitRepo(tmpDir)
    expect(result.initialized).toBe(true)
    const log = git(["log", "--oneline"], tmpDir)
    expect(log).toContain("initial commit")
  })

  it("creates initial commit with --allow-empty when directory is empty", async () => {
    const result = await ensureGitRepo(tmpDir)
    expect(result.initialized).toBe(true)
    const log = git(["log", "--oneline"], tmpDir)
    expect(log).toContain("initial commit")
  })
})

describe("git-ops: workspace checks", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ops-test-"))
    initRepo(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("isWorkingTreeClean returns true for clean tree", async () => {
    expect(await isWorkingTreeClean(tmpDir)).toBe(true)
  })

  it("isWorkingTreeClean returns false for dirty tree", async () => {
    fs.writeFileSync(path.join(tmpDir, "dirty.txt"), "dirty")
    expect(await isWorkingTreeClean(tmpDir)).toBe(false)
  })

  it("isRebaseOrMergeInProgress returns false normally", async () => {
    expect(await isRebaseOrMergeInProgress(tmpDir)).toBe(false)
  })

  it("isRebaseOrMergeInProgress returns true during merge", async () => {
    // Create a conflict scenario
    git(["checkout", "-b", "branch-a"], tmpDir)
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "a")
    git(["add", "-A"], tmpDir)
    git(["commit", "-m", "a"], tmpDir)
    git(["checkout", "-b", "branch-b", "HEAD~1"], tmpDir)
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "b")
    git(["add", "-A"], tmpDir)
    git(["commit", "-m", "b"], tmpDir)
    try { git(["merge", "branch-a"], tmpDir) } catch { /* merge conflicts expected */ }
    expect(await isRebaseOrMergeInProgress(tmpDir)).toBe(true)
  })

  it("getCurrentBranch returns the current branch name", async () => {
    expect(await getCurrentBranch(tmpDir)).toMatch(/^(main|master)$/)
  })

  it("getHeadSha returns a 40-char hex string", async () => {
    const sha = await getHeadSha(tmpDir)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe("git-ops: branch operations", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ops-test-"))
    initRepo(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("createFeatureBranch creates and checks out a new branch", async () => {
    await createFeatureBranch(tmpDir, "atelier/test-branch")
    expect(await getCurrentBranch(tmpDir)).toBe("atelier/test-branch")
  })

  it("branchExists returns true for existing branch", async () => {
    await createFeatureBranch(tmpDir, "atelier/existing")
    await checkoutBranch(tmpDir, "-")
    expect(await branchExists(tmpDir, "atelier/existing")).toBe(true)
  })

  it("branchExists returns false for non-existing branch", async () => {
    expect(await branchExists(tmpDir, "atelier/nope")).toBe(false)
  })

  it("checkoutBranch switches to an existing branch", async () => {
    await createFeatureBranch(tmpDir, "atelier/target")
    await checkoutBranch(tmpDir, "-")
    await checkoutBranch(tmpDir, "atelier/target")
    expect(await getCurrentBranch(tmpDir)).toBe("atelier/target")
  })

  it("createFeatureBranch throws on branch name collision", async () => {
    await createFeatureBranch(tmpDir, "atelier/dupe")
    await checkoutBranch(tmpDir, "-")
    await expect(createFeatureBranch(tmpDir, "atelier/dupe")).rejects.toThrow()
  })
})

describe("git-ops: commit operations", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-ops-test-"))
    initRepo(tmpDir)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("stageAll stages new and modified files", async () => {
    fs.writeFileSync(path.join(tmpDir, "new.txt"), "content")
    await stageAll(tmpDir)
    expect(await hasStagedChanges(tmpDir)).toBe(true)
  })

  it("hasStagedChanges returns false when nothing staged", async () => {
    expect(await hasStagedChanges(tmpDir)).toBe(false)
  })

  it("commit succeeds and returns SHA", async () => {
    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content")
    await stageAll(tmpDir)
    const result = await commit(tmpDir, "test commit")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it("commit detects hook failure via exit code", async () => {
    const hookDir = path.join(tmpDir, ".git", "hooks")
    fs.mkdirSync(hookDir, { recursive: true })
    fs.writeFileSync(path.join(hookDir, "pre-commit"), "#!/bin/sh\necho 'lint error: missing semicolons' >&2\nexit 1", { mode: 0o755 })

    fs.writeFileSync(path.join(tmpDir, "file.txt"), "content")
    await stageAll(tmpDir)
    const result = await commit(tmpDir, "should fail")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.hookFailed).toBe(true)
      expect(result.error).toContain("lint error")
    }
  })

  it("commit auto-retries when hooks auto-fix files", async () => {
    const hookDir = path.join(tmpDir, ".git", "hooks")
    fs.mkdirSync(hookDir, { recursive: true })
    const hookScript = `#!/bin/sh
MARKER="${tmpDir}/.hook-ran"
if [ ! -f "$MARKER" ]; then
  echo "formatted" > "${tmpDir}/file.txt"
  touch "$MARKER"
  echo "auto-fixed formatting" >&2
  exit 1
fi
exit 0`
    fs.writeFileSync(path.join(hookDir, "pre-commit"), hookScript, { mode: 0o755 })

    fs.writeFileSync(path.join(tmpDir, "file.txt"), "unformatted")
    await stageAll(tmpDir)
    const result = await commit(tmpDir, "auto-fix commit")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
    }
  })

  it("commit returns hookFailed=false for non-hook git errors", async () => {
    const result = await commit(tmpDir, "empty commit")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.hookFailed).toBe(false)
    }
  })
})
