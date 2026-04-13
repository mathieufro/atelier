import { spawn, type ChildProcess } from "node:child_process"
import { listProcesses, isAlive, terminateProcessTree, waitForExit, type ProcessInfo } from "@atelier/core/process-platform"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { fileURLToPath } from "node:url"
import { atelierStateDir } from "@atelier/core/state-dir"
import { writeSettings, type AtelierSettings } from "@atelier/core/settings"

function getRuntime(): string {
  try {
    // Dynamic import of vscode may not be available in all contexts (e.g. tests)
    const vscode = require("vscode")
    return (vscode.workspace.getConfiguration("atelier").get("runtime", "bun") as string) || "bun"
  } catch {
    return "bun"
  }
}

/**
 * Augment PATH with directories that common runtimes (bun, node) are installed to
 * but that VS Code's inherited environment may not include.
 */
function augmentPath(env: NodeJS.ProcessEnv): void {
  const extra = [
    path.join(os.homedir(), ".opencode", "bin"),
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), ".local", "bin"),
  ]
  if (process.platform === "win32") {
    extra.push(path.join(process.env.LOCALAPPDATA ?? "", "bun"))
  } else {
    extra.push("/usr/local/bin", "/opt/homebrew/bin")
  }
  const current = env.PATH ?? ""
  const parts = current.split(path.delimiter).filter(Boolean)
  for (const dir of extra) {
    if (!parts.includes(dir)) parts.unshift(dir)
  }
  env.PATH = parts.join(path.delimiter)
}

function isOrphan(proc: ProcessInfo): boolean {
  return process.platform === "win32" ? !isAlive(proc.ppid) : proc.ppid === 1
}

export function parseOrphanOpencodePids(procs: ProcessInfo[]): number[] {
  return procs
    .filter((proc) =>
      proc.command === "opencode serve --hostname=127.0.0.1 --port=0"
      && isOrphan(proc)
    )
    .map((proc) => proc.pid)
}

export function parseOrphanClaudeSdkPids(procs: ProcessInfo[]): number[] {
  return procs
    .filter((proc) =>
      (proc.command.includes("@anthropic-ai/claude-agent-sdk") || proc.command.includes("claude-agent-sdk/cli.js"))
      && isOrphan(proc)
    )
    .map((proc) => proc.pid)
}

export type ServerState = "idle" | "starting" | "running" | "failed" | "crashed" | "stopped"

export class AtelierServerManager {
  private _state: ServerState = "idle"
  private _atelierUrl: string | null = null
  private proc: ChildProcess | null = null
  private pidWatcher: ReturnType<typeof setInterval> | null = null
  private stateHandlers: ((state: ServerState) => void)[] = []
  private stopping = false
  private log?: (level: string, action: string, detail?: string) => void
  private _lastCwd: string | null = null
  /** True when the server exited due to idle timeout (not a crash). */
  idleShutdown = false

  get state(): ServerState { return this._state }
  get atelierUrl(): string | null { return this._atelierUrl }

  setLogger(log: (level: string, action: string, detail?: string) => void): void {
    this.log = log
  }

  async start(options: { cwd: string; signal?: AbortSignal; atelierPort?: number | null; settings?: AtelierSettings }): Promise<{ atelierUrl: string }> {
    if (this._state === "starting" || this._state === "running") {
      throw new Error("AtelierServerManager is already starting or running")
    }

    this.setState("starting")
    this.stopping = false
    this._lastCwd = options.cwd
    this.idleShutdown = false

    const thisDir = path.dirname(fileURLToPath(import.meta.url))
    const serverEntry = path.resolve(thisDir, "../../server/src/index.ts")

    // Clean up leaked orphan processes from previous crashes
    await this.killOrphanProcesses()

    // Kill any stale server from a previous session that wasn't cleaned up
    await this.killStaleProcess(options.cwd)

    // Write settings file before spawning — the server reads it on startup
    const stateDir = atelierStateDir(options.cwd)
    const settingsToWrite: AtelierSettings = {
      ...options.settings,
    }
    // Merge atelierPort into settings (backward-compat: callers may pass it directly)
    if (typeof options.atelierPort === "number" && Number.isFinite(options.atelierPort) && options.atelierPort > 0) {
      settingsToWrite.serverPort = options.atelierPort
    }
    writeSettings(stateDir, settingsToWrite)

    const env: NodeJS.ProcessEnv = { ...process.env }
    augmentPath(env)
    // Keep ATELIER_PORT env var for backward compat (tool-deployer, subprocess communication)
    if (settingsToWrite.serverPort) {
      env.ATELIER_PORT = String(settingsToWrite.serverPort)
    } else {
      delete env.ATELIER_PORT
    }

    const runtime = getRuntime()
    this.log?.("debug", "server_spawning", `command=${runtime} run ${serverEntry}`)
    const proc = spawn(runtime, ["run", serverEntry, options.cwd], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
    })
    this.proc = proc
    this.log?.("debug", "server_spawned", `pid=${proc.pid}`)

    // Capture stderr so startup crashes include the actual error message
    let stderrBuffer = ""
    proc.stderr?.on("data", (chunk: Buffer) => { stderrBuffer += chunk.toString() })

    const atelierUrl = await this.waitForPidFile(options.cwd, proc, 10000, options.signal, () => stderrBuffer)
    this._atelierUrl = atelierUrl

    await this.pollHealth(atelierUrl, 10000)

    this.setState("running")

    proc.on("exit", () => {
      if (this._state === "running" && !this.stopping) {
        this._atelierUrl = null
        // Check if server self-terminated due to idle timeout (not a crash)
        if (this._lastCwd) {
          const markerPath = path.join(atelierStateDir(this._lastCwd), "idle-shutdown")
          if (fs.existsSync(markerPath)) {
            try { fs.unlinkSync(markerPath) } catch {}
            this.idleShutdown = true
            this.setState("stopped")
            return
          }
        }
        this.setState("crashed")
      }
    })

    return { atelierUrl }
  }

  async reconnect(cwd: string): Promise<boolean> {
    const pidPath = path.join(atelierStateDir(cwd), "atelier.pid")
    if (!fs.existsSync(pidPath)) return false

    this.log?.("debug", "reconnect_attempt", pidPath)
    const contents = fs.readFileSync(pidPath, "utf-8").trim().split("\n")
    const pid = parseInt(contents[0]!, 10)
    const atelierUrl = contents[1]
    if (isNaN(pid) || !atelierUrl) return false

    if (!isAlive(pid)) {
      this.log?.("debug", "reconnect_pid_dead", `pid=${pid}`)
      return false
    }

    try {
      await this.pollHealth(atelierUrl, 5000)
      this._atelierUrl = atelierUrl
      this.setState("running")
      this.watchPid(pid)
      return true
    } catch {
      return false
    }
  }

  /** Connect to an externally-managed Atelier server (no process spawn). */
  async connectExternal(serverUrl: string): Promise<{ atelierUrl: string }> {
    if (this._state === "starting" || this._state === "running") {
      throw new Error("AtelierServerManager is already starting or running")
    }

    this.setState("starting")
    this.stopping = false
    this._atelierUrl = serverUrl

    try {
      await this.pollHealth(serverUrl, 10000)
    } catch (err) {
      this._atelierUrl = null
      this.setState("idle")
      throw err
    }

    this.setState("running")
    // No PID watcher — we don't own the external process.
    // Poll health periodically to detect if it goes away.
    this.pidWatcher = setInterval(async () => {
      try {
        const res = await fetch(`${serverUrl}/health`)
        if (!res.ok) throw new Error("unhealthy")
      } catch {
        if (this.pidWatcher) { clearInterval(this.pidWatcher); this.pidWatcher = null }
        if (this._state === "running") {
          this._atelierUrl = null
          this.setState("crashed")
        }
      }
    }, 5000)

    return { atelierUrl: serverUrl }
  }

  async restart(cwd: string, atelierPort?: number | null, settings?: AtelierSettings): Promise<{ atelierUrl: string }> {
    await this.stop()
    return this.start({ cwd, atelierPort, settings })
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.pidWatcher) { clearInterval(this.pidWatcher); this.pidWatcher = null }
    if (this.proc?.pid) {
      let exited = false
      // On Windows, attempt graceful shutdown via HTTP before killing the process tree
      if (process.platform === "win32" && this._atelierUrl) {
        try {
          await fetch(`${this._atelierUrl}/shutdown`, { method: "POST" })
          exited = await waitForExit(this.proc.pid, 2000)
        } catch {
          // Server already dead or unreachable — fall through to terminateProcessTree
        }
      }
      if (!exited) {
        await terminateProcessTree(this.proc.pid)
      }
    }
    this.proc = null
    this._atelierUrl = null
    if (this._state !== "idle") {
      this.setState("stopped")
    }
  }

  /** Write updated settings to disk. The server reads them lazily on next use. */
  syncSettings(cwd: string, settings: AtelierSettings): void {
    writeSettings(atelierStateDir(cwd), settings)
  }

  onStateChange(handler: (state: ServerState) => void): () => void {
    this.stateHandlers.push(handler)
    return () => { this.stateHandlers = this.stateHandlers.filter(h => h !== handler) }
  }

  private setState(state: ServerState): void {
    const oldState = this._state
    this._state = state
    this.log?.("debug", "state_transition", `${oldState} → ${state}`)
    for (const handler of this.stateHandlers) handler(state)
  }

  /** Kill any stale server process from a previous session (crash recovery). */
  private async killStaleProcess(cwd: string): Promise<void> {
    const pidPath = path.join(atelierStateDir(cwd), "atelier.pid")
    if (!fs.existsSync(pidPath)) return
    try {
      const pid = parseInt(fs.readFileSync(pidPath, "utf-8").split("\n")[0]!, 10)
      if (!isNaN(pid) && isAlive(pid)) {
        this.log?.("debug", "pid_file_read", `path=${pidPath}`)
        await terminateProcessTree(pid)
      }
    } catch { /* PID file unreadable */ }
    try { fs.unlinkSync(pidPath) } catch { /* already removed */ }
  }

  /** Kill orphaned opencode serve and claude-agent-sdk processes from previous crashes. */
  private async killOrphanProcesses(): Promise<void> {
    const procs = listProcesses()
    const opencodePids = parseOrphanOpencodePids(procs)
    const sdkPids = parseOrphanClaudeSdkPids(procs)
    this.log?.("debug", "orphan_scan", `opencode=${opencodePids.length} sdk=${sdkPids.length}`)

    for (const pid of [...opencodePids, ...sdkPids]) {
      await terminateProcessTree(pid)
    }
  }

  /** Poll a PID for liveness when we don't own the child process (reconnect case). */
  private watchPid(pid: number): void {
    if (this.pidWatcher) clearInterval(this.pidWatcher)
    this.pidWatcher = setInterval(() => {
      if (!isAlive(pid)) {
        clearInterval(this.pidWatcher!)
        this.pidWatcher = null
        if (this._state === "running") {
          this._atelierUrl = null
          this.setState("crashed")
        }
      }
    }, 2000)
  }

  private async waitForPidFile(cwd: string, proc: ChildProcess, timeoutMs: number, signal?: AbortSignal, getStderr?: () => string): Promise<string> {
    const pidPath = path.join(atelierStateDir(cwd), "atelier.pid")
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Aborted")
      if (proc.exitCode !== null) {
        const stderr = getStderr?.().trim()
        throw new Error(`Atelier exited with code ${proc.exitCode}${stderr ? `:\n${stderr}` : ""}`)
      }

      try {
        const contents = fs.readFileSync(pidPath, "utf-8").trim().split("\n")
        const pid = parseInt(contents[0]!, 10)
        const url = contents[1]
        if (!isNaN(pid) && url && pid === proc.pid) return url
      } catch { /* file not written yet */ }

      await new Promise(r => setTimeout(r, 100))
    }
    throw new Error("Timeout waiting for Atelier server")
  }

  private async pollHealth(atelierUrl: string, timeoutMs: number): Promise<void> {
    this.log?.("debug", "health_poll_start", atelierUrl)
    let attempt = 0
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      attempt++
      try {
        const res = await fetch(`${atelierUrl}/health`)
        this.log?.("debug", "health_poll_attempt", `attempt=${attempt} status=${res.status}`)
        if (res.ok) {
          const body = await res.json() as Record<string, unknown>
          if (body.status === "ready") {
            return
          }
          // "starting" means the server is up but backends aren't ready yet — keep polling
        }
      } catch {
        /* retry network errors */
      }
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error("Timeout polling Atelier health endpoint")
  }
}
