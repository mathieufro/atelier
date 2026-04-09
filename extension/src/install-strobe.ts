import { exec, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// SECURITY: Pinned to main — update when strobe has tagged releases.
const INSTALL_URL = "https://raw.githubusercontent.com/mathieufro/strobe/main/install.sh"
const BINARY_PATH = join(homedir(), ".strobe", "bin", "strobe")
const CARGO_BINARY_PATH = join(homedir(), ".cargo", "bin", "strobe")

export function isStrobeInstalled(): boolean {
  if (existsSync(BINARY_PATH)) return true
  if (existsSync(CARGO_BINARY_PATH)) return true
  // Also check if strobe is available on PATH
  try {
    execFileSync("strobe", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

interface InstallProgress {
  report(value: { message?: string; increment?: number }): void
}

/**
 * Runs the Strobe install script (curl | bash).
 * Returns the binary path on success, throws on failure.
 */
export function installStrobe(
  progress: InstallProgress,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Installation cancelled"))
      return
    }

    progress.report({ message: "Installing Strobe..." })

    const child = exec(
      `curl -fsSL ${INSTALL_URL} | bash`,
      { timeout: 300_000 },
      (error, _stdout, stderr) => {
        if (signal?.aborted) {
          reject(new Error("Installation cancelled"))
          return
        }
        if (error) {
          reject(new Error(`Strobe installation failed: ${stderr || error.message}`))
          return
        }
        if (!existsSync(BINARY_PATH)) {
          reject(new Error(`Installation completed but binary not found at ${BINARY_PATH}`))
          return
        }
        progress.report({ message: "Strobe installed successfully", increment: 100 })
        resolve(BINARY_PATH)
      },
    )

    signal?.addEventListener("abort", () => child.kill(), { once: true })
  })
}
