import * as fs from "node:fs"
import * as path from "node:path"
import { execFile as execFileCb } from "node:child_process"
import { promisify } from "node:util"
import type { Logger } from "@atelier/core"

const execFile = promisify(execFileCb)

/** Run a git command via child_process. Returns { stdout, stderr, exitCode }. */
async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFile("git", args, { cwd })
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 }
  } catch (err: any) {
    // execFile rejects on non-zero exit codes — extract stderr and exit code
    return {
      stdout: (err.stdout ?? "").trim(),
      stderr: (err.stderr ?? "").trim(),
      exitCode: err.code ?? 1,
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace checks
// ---------------------------------------------------------------------------

export async function ensureGitRepo(workspacePath: string, logger?: Logger): Promise<{ initialized: boolean }> {
  // Check if already a git repo
  const check = await runGit(["rev-parse", "--git-dir"], workspacePath)
  if (check.exitCode === 0) {
    logger?.debug("atelier", "git", "git_repo_exists", { data: { workspacePath } })
    logger?.debug("atelier", "git", "git_repo_verified", { data: { workspacePath } })
    return { initialized: false }
  }

  // git init
  const init = await runGit(["init"], workspacePath)
  if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr}`)

  // Ensure git user config exists (CI environments may not have global config)
  const userName = await runGit(["config", "user.name"], workspacePath)
  if (userName.exitCode !== 0) {
    await runGit(["config", "user.name", "Atelier"], workspacePath)
    await runGit(["config", "user.email", "atelier@local"], workspacePath)
  }

  // Stage all existing files
  await runGit(["add", "-A"], workspacePath)

  // Check if anything was staged — use --allow-empty for empty directories
  const diff = await runGit(["diff", "--cached", "--quiet"], workspacePath)
  const commitArgs = diff.exitCode !== 0
    ? ["commit", "-m", "initial commit"]
    : ["commit", "--allow-empty", "-m", "initial commit"]
  const initCommit = await runGit(commitArgs, workspacePath)
  if (initCommit.exitCode !== 0) throw new Error(`initial commit failed: ${initCommit.stderr}`)

  logger?.debug("atelier", "git", "git_repo_initialized", { data: { workspacePath } })
  logger?.debug("atelier", "git", "git_repo_verified", { data: { workspacePath } })
  return { initialized: true }
}

export async function isWorkingTreeClean(
  workspacePath: string,
  opts?: { exclude?: string[] },
  logger?: Logger,
): Promise<boolean> {
  const args = ["status", "--porcelain"]
  if (opts?.exclude?.length) {
    args.push("--", ".")
    for (const p of opts.exclude) args.push(`:!${p}`)
  }
  const result = await runGit(args, workspacePath)
  const clean = result.stdout === ""
  logger?.debug("atelier", "git", "working_tree_checked", { data: { clean } })
  return clean
}

export async function isRebaseOrMergeInProgress(workspacePath: string, logger?: Logger): Promise<boolean> {
  // Check for merge
  const merge = await runGit(["rev-parse", "--verify", "MERGE_HEAD"], workspacePath)
  if (merge.exitCode === 0) {
    logger?.debug("atelier", "git", "rebase_merge_checked", { data: { inProgress: true } })
    return true
  }
  // Check for rebase
  const rebase = await runGit(["rev-parse", "--verify", "REBASE_HEAD"], workspacePath)
  if (rebase.exitCode === 0) {
    logger?.debug("atelier", "git", "rebase_merge_checked", { data: { inProgress: true } })
    return true
  }
  // Also check rebase-merge and rebase-apply directories (covers interrupted rebases
  // where REBASE_HEAD may not yet exist)
  const gitDir = await runGit(["rev-parse", "--git-dir"], workspacePath)
  const gitPath = path.isAbsolute(gitDir.stdout) ? gitDir.stdout : path.join(workspacePath, gitDir.stdout)
  const inProgress = fs.existsSync(path.join(gitPath, "rebase-merge")) || fs.existsSync(path.join(gitPath, "rebase-apply"))
  logger?.debug("atelier", "git", "rebase_merge_checked", { data: { inProgress } })
  return inProgress
}

export async function getCurrentBranch(workspacePath: string, logger?: Logger): Promise<string> {
  const result = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath)
  if (result.exitCode !== 0) throw new Error(`Failed to get current branch: ${result.stderr}`)
  logger?.debug("atelier", "git", "current_branch_read", { data: { branch: result.stdout } })
  return result.stdout
}

export async function getHeadSha(workspacePath: string, logger?: Logger): Promise<string> {
  const result = await runGit(["rev-parse", "HEAD"], workspacePath)
  if (result.exitCode !== 0) throw new Error(`Failed to get HEAD SHA: ${result.stderr}`)
  logger?.debug("atelier", "git", "head_sha_read", { data: { sha: result.stdout } })
  return result.stdout
}

// ---------------------------------------------------------------------------
// Branch operations
// ---------------------------------------------------------------------------

export async function createFeatureBranch(workspacePath: string, name: string, logger?: Logger): Promise<void> {
  const result = await runGit(["checkout", "-b", name], workspacePath)
  if (result.exitCode !== 0) throw new Error(`Failed to create branch '${name}': ${result.stderr}`)
  logger?.debug("atelier", "git", "feature_branch_created", { data: { name } })
}

export async function checkoutBranch(workspacePath: string, name: string, logger?: Logger): Promise<void> {
  const result = await runGit(["checkout", name], workspacePath)
  if (result.exitCode !== 0) throw new Error(`Failed to checkout branch '${name}': ${result.stderr}`)
  logger?.debug("atelier", "git", "branch_checked_out", { data: { name } })
}

export async function branchExists(workspacePath: string, name: string, logger?: Logger): Promise<boolean> {
  const result = await runGit(["rev-parse", "--verify", name], workspacePath)
  const exists = result.exitCode === 0
  logger?.debug("atelier", "git", "branch_existence_checked", { data: { name, exists } })
  return exists
}

// ---------------------------------------------------------------------------
// Commit operations
// ---------------------------------------------------------------------------

export type GitCommitResult =
  | { ok: true; sha: string }
  | { ok: false; hookFailed: true; error: string }
  | { ok: false; hookFailed: false; error: string }

export async function stageAll(workspacePath: string, logger?: Logger): Promise<void> {
  const result = await runGit(["add", "-A"], workspacePath)
  if (result.exitCode !== 0) throw new Error(`git add -A failed: ${result.stderr}`)
  logger?.debug("atelier", "git", "git_staged_all", {})
}

export async function hasStagedChanges(workspacePath: string, logger?: Logger): Promise<boolean> {
  const result = await runGit(["diff", "--cached", "--quiet"], workspacePath)
  const hasChanges = result.exitCode !== 0 // exitCode 1 = has differences
  logger?.debug("atelier", "git", "staged_changes_checked", { data: { hasChanges } })
  return hasChanges
}

function isHookFailure(exitCode: number, stdout: string, stderr: string): boolean {
  if (exitCode === 0) return false
  // Check both stdout and stderr — git puts "nothing to commit" in stdout
  const combined = (stdout + " " + stderr).toLowerCase()
  // Common non-hook-failure patterns — these are git's own messages
  const nonHookPatterns = [
    "nothing to commit",
    "nothing added to commit",
    "no changes added to commit",
  ]
  if (nonHookPatterns.some(p => combined.includes(p))) return false
  // Hook-related stderr patterns (covers husky, pre-commit framework, lint-staged, etc.)
  const hookPatterns = [
    "hook", "pre-commit", "husky", "lint-staged",
  ]
  if (hookPatterns.some(p => combined.includes(p))) return true
  // Exit code 1 with non-"nothing to commit" output is likely a hook failure
  // Exit codes > 1 without hook patterns are treated as non-hook errors (known limitation)
  return exitCode === 1
}

export async function commit(workspacePath: string, message: string, logger?: Logger): Promise<GitCommitResult> {
  const first = await runGit(["commit", "-m", message], workspacePath)

  if (first.exitCode === 0) {
    const sha = await getHeadSha(workspacePath, logger)
    logger?.debug("atelier", "git", "git_commit_succeeded", { data: { sha } })
    return { ok: true, sha }
  }

  if (!isHookFailure(first.exitCode, first.stdout, first.stderr)) {
    return { ok: false, hookFailed: false, error: first.stderr }
  }

  // Hook failed — check if hooks auto-fixed files (use status --porcelain to catch
  // both modified AND newly created files, e.g. lockfiles generated by hooks)
  logger?.debug("atelier", "git", "git_hook_failure_detected", { data: { stderr: first.stderr.slice(0, 500) } })
  const status = await runGit(["status", "--porcelain"], workspacePath)
  if (status.stdout === "") {
    // No auto-fixed files — return hook error
    return { ok: false, hookFailed: true, error: first.stderr }
  }

  // Auto-fixed files detected — re-stage and retry once
  await stageAll(workspacePath, logger)
  const retry = await runGit(["commit", "-m", message], workspacePath)
  if (retry.exitCode === 0) {
    const sha = await getHeadSha(workspacePath, logger)
    logger?.debug("atelier", "git", "git_commit_succeeded", { data: { sha } })
    return { ok: true, sha }
  }

  // Retry also failed — return the full error
  return { ok: false, hookFailed: true, error: retry.stderr }
}


// ---------------------------------------------------------------------------
// Worktree operations
// ---------------------------------------------------------------------------

export interface WorktreeResult { ok: boolean; error?: string }
export interface WorktreeEntry { path: string; branch: string; head: string }

export async function addWorktree(repoPath: string, worktreePath: string, branchName: string): Promise<WorktreeResult> {
  const result = await runGit(["worktree", "add", worktreePath, "-b", branchName], repoPath)
  if (result.exitCode !== 0) return { ok: false, error: result.stderr }
  return { ok: true }
}

/**
 * Rescue-commit any uncommitted changes in a worktree.
 * Returns the SHA if a commit was made, null if nothing to commit.
 * This is a critical safety function — it must never throw.
 */
export async function rescueCommitWorktree(
  worktreePath: string,
  reason: string,
  logger?: Logger,
): Promise<string | null> {
  try {
    // Check if worktree directory still exists
    if (!fs.existsSync(worktreePath)) return null

    // Check if it's actually a git worktree (has .git file)
    const gitCheck = await runGit(["rev-parse", "--git-dir"], worktreePath)
    if (gitCheck.exitCode !== 0) return null

    await stageAll(worktreePath, logger)
    if (!(await hasStagedChanges(worktreePath, logger))) return null

    // Bypass hooks for rescue commits — we cannot risk hook failure preventing the save
    const result = await runGit(["commit", "--no-verify", "-m", `atelier(rescue): ${reason}`], worktreePath)
    if (result.exitCode !== 0) {
      logger?.error("atelier", "git", "rescue_commit_failed", { data: { error: result.stderr, worktreePath } })
      return null
    }

    const sha = await getHeadSha(worktreePath, logger)
    logger?.info("atelier", "git", "rescue_commit_saved", { data: { sha, worktreePath, reason } })
    return sha
  } catch (err) {
    logger?.error("atelier", "git", "rescue_commit_error", { data: { error: String(err), worktreePath } })
    return null
  }
}

/**
 * Remove a git worktree. SAFETY: refuses to remove a worktree that has uncommitted changes.
 * Callers must rescue-commit first (or pass force: true with an explicit reason).
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  opts?: { force?: boolean; logger?: Logger },
): Promise<WorktreeResult> {
  // Defense in depth: check for uncommitted changes before removal
  if (fs.existsSync(worktreePath)) {
    const status = await runGit(["status", "--porcelain"], worktreePath)
    if (status.exitCode === 0 && status.stdout !== "") {
      // Worktree has uncommitted changes — attempt rescue commit
      opts?.logger?.warn("atelier", "git", "worktree_remove_blocked_dirty", {
        data: { worktreePath, uncommittedFiles: status.stdout.split("\n").length },
      })
      const sha = await rescueCommitWorktree(
        worktreePath,
        "safety net — uncommitted work rescued before worktree removal",
        opts?.logger,
      )
      if (!sha && !opts?.force) {
        return {
          ok: false,
          error: `Refusing to remove worktree with uncommitted changes (rescue commit also failed). Path: ${worktreePath}`,
        }
      }
    }
  }

  const result = await runGit(["worktree", "remove", worktreePath, "--force"], repoPath)
  if (result.exitCode !== 0) return { ok: false, error: result.stderr }
  return { ok: true }
}

export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const result = await runGit(["worktree", "list", "--porcelain"], repoPath)
  if (result.exitCode !== 0) return []
  const entries: WorktreeEntry[] = []
  let current: Partial<WorktreeEntry> = {}
  for (const rawLine of result.stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (!line) continue
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current as WorktreeEntry)
      // Git outputs paths with forward slashes even on Windows; normalize to native separators
      // so equality checks against fs.realpathSync output work cross-platform.
      // Also resolve symlinks: git's porcelain output and Node's path.resolve can disagree
      // on Linux when TMPDIR contains symlinked components (e.g. some GitHub Actions runners).
      const resolved = path.resolve(line.slice("worktree ".length))
      let canonical = resolved
      try { canonical = fs.realpathSync(resolved) } catch {}
      current = { path: canonical }
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch refs/heads/".length)
    }
  }
  if (current.path) entries.push(current as WorktreeEntry)
  return entries
}
