import * as crypto from "node:crypto"
import * as path from "node:path"
import * as os from "node:os"

/**
 * Deterministic 12-char hex hash of a workspace path.
 * Used as the per-workspace identifier in ~/.atelier/ and log directories.
 */
export function workspaceHash(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 12)
}

/**
 * Returns the per-workspace state directory: ~/.atelier/<hash>.
 * Runtime artifacts (PID file, tool config, compiled prompts) live here — not in the workspace.
 */
export function atelierStateDir(workspacePath: string): string {
  return path.join(os.homedir(), ".atelier", workspaceHash(workspacePath))
}
