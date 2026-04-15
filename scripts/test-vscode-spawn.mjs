// Automated repro that mimics VS Code extension host's spawn environment.
// Run with: node scripts/test-vscode-spawn.mjs
// Tests the full cycle: spawn server -> call /config -> print result.
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const ATELIER_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.slice(1)), "..")
const WORKSPACE = ATELIER_DIR
const BUN_EXE = process.env.BUN_EXE || "C:\\ProgramData\\chocolatey\\bin\\bun.exe"
const PID_FILE = path.join(os.homedir(), ".atelier", "050729eb7d16", "atelier.pid")

function stripVsCodeEnv(env) {
  const clone = { ...env }
  for (const k of ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "VSCODE_INSPECTOR_OPTIONS", "VSCODE_IPC_HOOK", "VSCODE_IPC_HOOK_CLI", "VSCODE_NLS_CONFIG", "VSCODE_PID", "VSCODE_CWD"]) delete clone[k]
  return clone
}

try { fs.unlinkSync(PID_FILE) } catch {}

const serverEntry = path.join(ATELIER_DIR, "server", "src", "index.ts")
console.log(`[test] spawning: ${BUN_EXE} run ${serverEntry} ${WORKSPACE}`)

const proc = spawn(BUN_EXE, ["run", serverEntry, WORKSPACE], {
  cwd: WORKSPACE,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
  env: stripVsCodeEnv(process.env),
})
proc.stdin?.end()
let serverStdout = ""
let serverStderr = ""
proc.stdout?.on("data", (c) => { serverStdout += c.toString() })
proc.stderr?.on("data", (c) => { serverStderr += c.toString() })
proc.on("error", (err) => console.error("[test] server spawn error:", err.message))
proc.on("exit", (code) => console.log(`[test] server exited: code=${code}`))

// Wait up to 10 seconds for PID file
const deadline = Date.now() + 10_000
let port = null
while (Date.now() < deadline) {
  try {
    const contents = fs.readFileSync(PID_FILE, "utf-8")
    const lines = contents.trim().split("\n")
    const url = lines[1]
    if (url) {
      port = parseInt(url.match(/:(\d+)$/)?.[1] ?? "0", 10)
      if (port) break
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 200))
}
if (!port) {
  console.error("[test] server did not write PID file within 10s")
  console.error("[test] stderr:", serverStderr.slice(0, 500))
  console.error("[test] stdout:", serverStdout.slice(0, 500))
  proc.kill()
  process.exit(1)
}
console.log(`[test] server listening on port ${port}`)

// Call /config
const t0 = Date.now()
try {
  const res = await fetch(`http://127.0.0.1:${port}/config`, { signal: AbortSignal.timeout(30_000) })
  const body = await res.json()
  const count = body.models?.length ?? 0
  console.log(`[test] /config returned in ${Date.now() - t0}ms, models=${count}`)
  if (count === 0) {
    console.log(`[test] FAIL — server stderr follows:`)
    console.log(serverStderr)
  } else {
    console.log(`[test] PASS — first model: ${JSON.stringify(body.models[0])}`)
  }
} catch (err) {
  console.error(`[test] /config error: ${err.message}`)
  console.error(`[test] server stderr: ${serverStderr.slice(0, 500)}`)
}

proc.kill()
setTimeout(() => process.exit(0), 500)
