import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
// Standalone script — package aliases don't resolve outside workspace packages.
// Use relative path with .ts extension (Bun resolves it directly).
import { terminateProcessTree } from "../packages/core/src/process-platform.ts"

async function main() {
  const atelierDir = path.join(os.homedir(), ".atelier")

  let entries: string[]
  try {
    entries = fs.readdirSync(atelierDir)
  } catch {
    console.log("No Atelier state directory found — nothing to do.")
    return
  }

  let killed = 0
  for (const entry of entries) {
    const pidPath = path.join(atelierDir, entry, "atelier.pid")
    if (!fs.existsSync(pidPath)) continue

    try {
      const pid = parseInt(fs.readFileSync(pidPath, "utf-8").trim().split("\n")[0]!, 10)
      if (Number.isFinite(pid) && pid > 0) {
        await terminateProcessTree(pid)
        killed++
      }
    } catch {
      // PID file unreadable or process already dead
    }
    try { fs.unlinkSync(pidPath) } catch {}
  }

  console.log(`Atelier servers stopped (${killed} killed) — reload VS Code window to restart`)
}

main().catch(console.error)
