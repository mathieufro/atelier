import { exec } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// SECURITY: Pinned to a tagged release to avoid supply-chain risk from mutable refs/heads/main.
// Update the tag when upgrading the bundled OpenCode version.
const INSTALL_URL = "https://raw.githubusercontent.com/opencode-ai/opencode/refs/tags/v0.1.0/install"
const BINARY_PATH = join(homedir(), ".opencode", "bin", "opencode")

export function isOpencodeInstalled(): boolean {
  return existsSync(BINARY_PATH)
}

export interface InstallProgress {
  report(value: { message?: string; increment?: number }): void
}

/**
 * Runs the canonical OpenCode install script (curl | bash).
 * Returns the binary path on success, throws on failure.
 */
export function installOpencode(
  progress: InstallProgress,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Installation cancelled"))
      return
    }

    progress.report({ message: "Downloading OpenCode..." })

    const child = exec(
      `curl -fsSL ${INSTALL_URL} | bash`,
      { timeout: 120_000 },
      (error, _stdout, stderr) => {
        if (signal?.aborted) {
          reject(new Error("Installation cancelled"))
          return
        }
        if (error) {
          reject(new Error(`OpenCode installation failed: ${stderr || error.message}`))
          return
        }
        if (!existsSync(BINARY_PATH)) {
          reject(new Error(`Installation completed but binary not found at ${BINARY_PATH}`))
          return
        }
        progress.report({ message: "OpenCode installed successfully", increment: 100 })
        resolve(BINARY_PATH)
      },
    )

    signal?.addEventListener("abort", () => child.kill(), { once: true })
  })
}
