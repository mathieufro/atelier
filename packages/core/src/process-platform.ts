import { spawnSync } from "node:child_process"
import * as path from "node:path"

export type ProcessInfo = { pid: number; ppid: number; command: string }

const IS_WINDOWS = process.platform === "win32"
const WINDOWS_SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows"
const WINDOWS_POWERSHELL = path.join(WINDOWS_SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const WINDOWS_TASKKILL = path.join(WINDOWS_SYSTEM_ROOT, "System32", "taskkill.exe")
const WINDOWS_PROCESS_LIST_TIMEOUT_MS = 4000
const WINDOWS_PROCESS_CACHE_TTL_MS = 250

let windowsProcessCache: { expiresAt: number; procs: ProcessInfo[] } | null = null

export function isAlive(pid: number): boolean {
  // Guard: pid <= 0 is never a valid user process.
  // On Unix, process.kill(0, 0) sends signal 0 to the entire process group (not PID 0),
  // which would return true — a dangerous side-effect. Negative PIDs target process groups.
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return !isAlive(pid)
}

export function listProcesses(filter?: (proc: ProcessInfo) => boolean): ProcessInfo[] {
  try {
    const procs = IS_WINDOWS ? listProcessesWindowsCached() : listProcessesUnix()
    return filter ? procs.filter(filter) : procs
  } catch {
    return []
  }
}

function listProcessesUnix(): ProcessInfo[] {
  const result = spawnSync("ps", ["-axo", "pid,ppid,command"], {
    encoding: "utf8",
    windowsHide: true,
  })
  if (result.status !== 0 || !result.stdout) return []
  return parseUnixPsOutput(result.stdout)
}

function listProcessesWindows(): ProcessInfo[] {
  const result = spawnSync(WINDOWS_POWERSHELL, [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation",
  ], {
    encoding: "utf8",
    timeout: WINDOWS_PROCESS_LIST_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.status !== 0 || !result.stdout) return []
  return parseWindowsCsvOutput(result.stdout)
}

function listProcessesWindowsCached(): ProcessInfo[] {
  const now = Date.now()
  if (windowsProcessCache && windowsProcessCache.expiresAt > now) return windowsProcessCache.procs

  const procs = listProcessesWindows()
  if (procs.length > 0) {
    windowsProcessCache = {
      expiresAt: now + WINDOWS_PROCESS_CACHE_TTL_MS,
      procs,
    }
  }
  return procs
}

/** @internal Exported for testing — parse Unix `ps -axo pid,ppid,command` output. */
export function parseUnixPsOutput(stdout: string): ProcessInfo[] {
  const lines = stdout.split("\n")
  const procs: ProcessInfo[] = []
  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
    if (!match) continue
    const pid = parseInt(match[1]!, 10)
    const ppid = parseInt(match[2]!, 10)
    const command = match[3]!
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      procs.push({ pid, ppid, command })
    }
  }
  return procs
}

/** @internal Exported for testing — parse Windows CSV output from Get-CimInstance. */
export function parseWindowsCsvOutput(stdout: string): ProcessInfo[] {
  const lines = stdout.split("\n")
  const procs: ProcessInfo[] = []
  // Skip CSV header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    // CSV format: "ProcessId","ParentProcessId","CommandLine"
    // CommandLine can be empty/null for system processes — PowerShell renders null as:
    //   "" (empty quoted field) in most versions, or
    //   empty/missing (no quotes, trailing comma) in some versions
    const csvMatch = line.match(/^"(\d+)","(\d+)","(.*)"$/)
      ?? line.match(/^"(\d+)","(\d+)",(.*)$/)
    if (!csvMatch) continue
    const pid = parseInt(csvMatch[1]!, 10)
    const ppid = parseInt(csvMatch[2]!, 10)
    const command = (csvMatch[3] ?? "")
      .replace(/^"|"$/g, "")
      .replace(/""/g, '"')
    if (Number.isFinite(pid) && Number.isFinite(ppid)) {
      procs.push({ pid, ppid, command })
    }
  }
  return procs
}

export async function terminateProcessTree(
  pid: number,
  options?: { graceMs?: number; forceMs?: number }
): Promise<void> {
  if (IS_WINDOWS) {
    // taskkill /T /F kills the entire process tree. No graceful phase — it's atomic.
    try {
      spawnSync(WINDOWS_TASKKILL, ["/T", "/F", "/PID", String(pid)], {
        windowsHide: true,
      })
    } catch {}
    // Confirm the process actually died — taskkill can fail silently for
    // protected processes or delayed cleanup.
    await waitForExit(pid, 1000)
    return
  }

  // Unix: graceful SIGTERM, then forceful SIGKILL
  const graceMs = options?.graceMs ?? 2500
  const forceMs = options?.forceMs ?? 1000

  try { process.kill(-pid, "SIGTERM") } catch {}
  try { process.kill(pid, "SIGTERM") } catch {}

  if (await waitForExit(pid, graceMs)) return

  try { process.kill(-pid, "SIGKILL") } catch {}
  try { process.kill(pid, "SIGKILL") } catch {}
  await waitForExit(pid, forceMs)
}
