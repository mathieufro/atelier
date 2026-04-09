/**
 * Git workspace helpers for E2E tests.
 *
 * Specialized workspace creators for git-specific scenarios:
 * greenfield (no .git), dirty working tree, pre-commit hooks.
 * Plus git query utilities for assertions.
 */
import { mkdtemp, writeFile, rm, mkdir, chmod } from "node:fs/promises"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir, homedir } from "node:os"
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"
import type { Workspace } from "./workspace.js"

// ---------------------------------------------------------------------------
// Git identity
// ---------------------------------------------------------------------------

/** Configure local git identity in a workspace (required for CI without global git config). */
export function configureGitIdentity(workspacePath: string): void {
  execSync('git config user.email "test@atelier.dev" && git config user.name "Atelier Test"', {
    cwd: workspacePath,
    stdio: "ignore",
  })
}

// ---------------------------------------------------------------------------
// Settings (gitEnabled)
// ---------------------------------------------------------------------------

/** Compute the ~/.atelier/<hash> state dir for a workspace path. */
function stateDirFor(workspacePath: string): string {
  const hash = createHash("sha256").update(workspacePath).digest("hex").slice(0, 12)
  return join(homedir(), ".atelier", hash)
}

/** Write settings.json with gitEnabled:true so the orchestrator enables git integration. */
export function enableGitForWorkspace(workspacePath: string): void {
  const dir = stateDirFor(workspacePath)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ gitEnabled: true }))
}

/** Clean up the ~/.atelier/<hash> state dir created for the workspace. */
export async function cleanupStateDir(workspacePath: string): Promise<void> {
  const dir = stateDirFor(workspacePath)
  if (existsSync(dir)) {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Workspace creators
// ---------------------------------------------------------------------------

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [filePath, content] of Object.entries(files)) {
    const full = join(dir, filePath)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
}

/** Create workspace WITHOUT git init — for greenfield testing. */
export async function createGreenfield(
  name: string,
  files: Record<string, string>,
): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), `atelier-e2e-${name}-`))
  await writeFiles(dir, files)
  // No git init — the orchestrator's ensureGitRepo() handles it.
  // enableGitForWorkspace must be called separately after we know the path.
  enableGitForWorkspace(dir)
  return { path: dir, cleanup: () => cleanupStateDir(dir).then(() => rm(dir, { recursive: true, force: true })) }
}

/** Create workspace with a pre-commit hook (git identity pre-configured). */
export async function createWorkspaceWithHook(
  name: string,
  files: Record<string, string>,
  hookScript: string,
): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), `atelier-e2e-${name}-`))
  await writeFiles(dir, files)
  execSync("git init", { cwd: dir, stdio: "ignore" })
  configureGitIdentity(dir)
  // Initial commit BEFORE hook install so seed files commit without triggering the hook
  execSync("git add -A && git commit -m 'init' --allow-empty", { cwd: dir, stdio: "ignore" })
  // Install pre-commit hook AFTER initial commit
  const hooksDir = join(dir, ".git", "hooks")
  await mkdir(hooksDir, { recursive: true })
  const hookPath = join(hooksDir, "pre-commit")
  await writeFile(hookPath, hookScript)
  await chmod(hookPath, 0o755)
  enableGitForWorkspace(dir)
  return { path: dir, cleanup: () => cleanupStateDir(dir).then(() => rm(dir, { recursive: true, force: true })) }
}

/** Create workspace with dirty working tree (uncommitted changes after init). */
export async function createDirtyWorkspace(
  name: string,
  files: Record<string, string>,
  dirtyFiles: Record<string, string>,
): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), `atelier-e2e-${name}-`))
  await writeFiles(dir, files)
  execSync("git init", { cwd: dir, stdio: "ignore" })
  configureGitIdentity(dir)
  execSync("git add -A && git commit -m 'init'", { cwd: dir, stdio: "ignore" })
  // Write dirty files AFTER commit
  await writeFiles(dir, dirtyFiles)
  enableGitForWorkspace(dir)
  return { path: dir, cleanup: () => cleanupStateDir(dir).then(() => rm(dir, { recursive: true, force: true })) }
}

/** Create a standard workspace with git init + gitEnabled (extends base createWorkspace pattern). */
export async function createGitWorkspace(
  name: string,
  files: Record<string, string>,
): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), `atelier-e2e-${name}-`))
  await writeFiles(dir, files)
  execSync("git init", { cwd: dir, stdio: "ignore" })
  configureGitIdentity(dir)
  execSync("git add -A && git commit -m 'init' --allow-empty", { cwd: dir, stdio: "ignore" })
  enableGitForWorkspace(dir)
  return { path: dir, cleanup: () => cleanupStateDir(dir).then(() => rm(dir, { recursive: true, force: true })) }
}

// ---------------------------------------------------------------------------
// Git query utilities
// ---------------------------------------------------------------------------

/** Run a git command in the workspace and return trimmed stdout. */
export function git(workspacePath: string, ...args: string[]): string {
  return execSync(`git ${args.join(" ")}`, { cwd: workspacePath, encoding: "utf-8" }).trim()
}

/** Parse git log into structured objects. */
export function gitLog(workspacePath: string): Array<{ sha: string; message: string }> {
  const raw = git(workspacePath, "log", "--oneline", "--no-decorate")
  if (!raw) return []
  return raw.split("\n").map((line) => {
    const spaceIdx = line.indexOf(" ")
    return { sha: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1) }
  })
}

/** Get current branch name. */
export function gitBranch(workspacePath: string): string {
  return git(workspacePath, "branch", "--show-current")
}

/** Check if a branch exists. */
export function gitBranchExists(workspacePath: string, name: string): boolean {
  try {
    git(workspacePath, "rev-parse", "--verify", name)
    return true
  } catch {
    return false
  }
}

/** List all branches matching a pattern. */
export function gitBranchList(workspacePath: string, pattern?: string): string[] {
  const args = ["branch", "--list"]
  if (pattern) args.push(pattern)
  const raw = git(workspacePath, ...args)
  if (!raw) return []
  return raw.split("\n").map((b) => b.replace(/^\*?\s+/, ""))
}

/** Get git status (porcelain). Empty string = clean. */
export function gitStatus(workspacePath: string): string {
  return git(workspacePath, "status", "--porcelain")
}
