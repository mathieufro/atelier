import * as childProcess from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { listProcesses, isAlive, terminateProcessTree, waitForExit, type ProcessInfo } from "@atelier/core/process-platform"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { fileURLToPath } from "node:url"
import { atelierStateDir } from "@atelier/core/state-dir"
import { writeSettings, type AtelierSettings } from "@atelier/core/settings"

let spawnSyncRunner: typeof childProcess.spawnSync = childProcess.spawnSync

export function setSpawnSyncRunnerForTests(fn: typeof childProcess.spawnSync | null): void {
  spawnSyncRunner = fn ?? childProcess.spawnSync
}

function getRuntime(): string {
  try {
    // Dynamic import of vscode may not be available in all contexts (e.g. tests)
    const vscode = require("vscode")
    return (vscode.workspace.getConfiguration("atelier").get("runtime", "bun") as string) || "bun"
  } catch {
    return "bun"
  }
}

function normalizePathEntry(entry: string): string {
  return entry.trim().replace(/^"|"$/g, "")
}

function getPathKey(entry: string): string {
  const normalized = normalizePathEntry(entry)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function expandWindowsEnvVars(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (_match, name: string) => {
    const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    return key ? (env[key] ?? "") : `%${name}%`
  })
}

function appendUniquePath(parts: string[], seen: Set<string>, entry: string): void {
  const normalized = normalizePathEntry(entry)
  if (!normalized) return
  const key = getPathKey(normalized)
  if (seen.has(key)) return
  parts.push(normalized)
  seen.add(key)
}

function prependUniquePath(parts: string[], seen: Set<string>, entry: string): void {
  const normalized = normalizePathEntry(entry)
  if (!normalized) return
  const key = getPathKey(normalized)
  if (seen.has(key)) return
  parts.unshift(normalized)
  seen.add(key)
}

function parsePathEntries(raw: string): string[] {
  return raw
    .split(path.delimiter)
    .map(normalizePathEntry)
    .filter(Boolean)
}

function getWindowsCorePathDirs(env: NodeJS.ProcessEnv): string[] {
  const systemRoot = env.SystemRoot ?? "C:\\Windows"
  return [
    path.join(systemRoot, "System32"),
    systemRoot,
    path.join(systemRoot, "System32", "Wbem"),
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
  ]
}

function readWindowsRegistryPath(key: string, env: NodeJS.ProcessEnv): string[] {
  const regExe = path.join(env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe")
  try {
    const result = spawnSyncRunner(regExe, ["query", key, "/v", "Path"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2000,
    })
    if (result.status !== 0 || !result.stdout) return []
    const match = result.stdout.match(/^\s*Path\s+REG_\w+\s+(.+)$/m)
    if (!match) return []
    return match[1]!
      .split(";")
      .map((entry) => expandWindowsEnvVars(entry, env))
      .map(normalizePathEntry)
      .filter(Boolean)
  } catch {
    return []
  }
}

function getWindowsFallbackPathDirs(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== "win32") return []
  return [
    ...getWindowsCorePathDirs(env),
    ...readWindowsRegistryPath("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", env),
    ...readWindowsRegistryPath("HKCU\\Environment", env),
  ]
}

/**
 * Augment PATH with directories that common runtimes (bun, node) are installed to
 * but that VS Code's inherited environment may not include.
 */
function getRuntimeSearchDirs(env: NodeJS.ProcessEnv): string[] {
  const extra = [
    path.join(os.homedir(), ".opencode", "bin"),
    path.join(os.homedir(), ".bun", "bin"),
    path.join(os.homedir(), ".local", "bin"),
  ]
  if (env.BUN_INSTALL) extra.push(path.join(env.BUN_INSTALL, "bin"))
  if (process.platform === "win32") {
    extra.push(path.join(env.LOCALAPPDATA ?? "", "bun"))
    extra.push(path.join(env.ProgramData ?? "C:\\ProgramData", "chocolatey", "bin"))
    extra.push(path.join(env.USERPROFILE ?? os.homedir(), "scoop", "persist", "bun", "bin"))
    extra.push(path.join(env.USERPROFILE ?? os.homedir(), "scoop", "shims"))
    extra.push(path.join(env.APPDATA ?? "", "npm"))
  } else {
    if (env.HOMEBREW_PREFIX) extra.push(path.join(env.HOMEBREW_PREFIX, "bin"))
    extra.push("/usr/local/bin", "/opt/homebrew/bin")
    extra.push("/home/linuxbrew/.linuxbrew/bin")
    extra.push(path.join(os.homedir(), ".linuxbrew", "bin"))
  }
  return extra.filter(Boolean)
}

function augmentPath(env: NodeJS.ProcessEnv): void {
  const parts = parsePathEntries(env.PATH ?? "")
  const seen = new Set(parts.map(getPathKey))
  for (const dir of getWindowsFallbackPathDirs(env)) {
    appendUniquePath(parts, seen, dir)
  }
  for (const dir of getRuntimeSearchDirs(env)) {
    prependUniquePath(parts, seen, dir)
  }
  env.PATH = parts.join(path.delimiter)
}

/**
 * Resolve a runtime name (e.g. "bun") to an absolute path if we can find one.
 * Falls back to the bare name when resolution fails.
 * On Windows, we search the effective PATH first, then known install locations.
 */
export function resolveRuntime(runtime: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(runtime)) return runtime
  if (process.platform !== "win32") return runtime

  const pathParts = (env.PATH ?? "")
    .split(path.delimiter)
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
  const extensions = path.extname(runtime)
    ? [""]
    : (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
  for (const dir of pathParts) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${runtime}${ext}`)
      try { if (fs.existsSync(candidate)) return candidate } catch {}
    }
  }

  for (const dir of getRuntimeSearchDirs(env)) {
    const candidate = path.join(dir, `${runtime}.exe`)
    try { if (fs.existsSync(candidate)) return candidate } catch {}
  }
  return runtime
}

function isOrphan(proc: ProcessInfo): boolean {
  return process.platform === "win32" ? !isAlive(proc.ppid) : proc.ppid === 1
}

export function parseOrphanOpencodePids(procs: ProcessInfo[]): number[] {
  return procs
    .filter((proc) =>
      proc.command.includes("opencode")
      && proc.command.includes("serve")
      && proc.command.includes("--hostname=127.0.0.1")
      && proc.command.includes("--port=0")
      && isOrphan(proc)
    )
    .map((proc) => proc.pid)
}

export function parseOrphanClaudeSdkPids(procs: ProcessInfo[]): number[] {
  return procs
    .filter((proc) => {
      const cmd = proc.command.replace(/\\/g, "/")
      return (cmd.includes("@anthropic-ai/claude-agent-sdk") || cmd.includes("claude-agent-sdk/cli.js"))
        && isOrphan(proc)
    })
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

  private spawnProcess(command: string, args: readonly string[], options: childProcess.SpawnOptions): ChildProcess {
    return childProcess.spawn(command, args, options)
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
    // Strip env vars that can break child Node/Bun processes and the Claude SDK.
    //
    // VS Code-injected (NODE_OPTIONS=--inspect makes subprocesses try to open debug
    // ports and hang; ELECTRON_RUN_AS_NODE confuses Bun; VSCODE_* leak workbench state).
    //
    // Claude Code extension-injected (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT,
    // CLAUDE_CODE_EXECPATH): these tell the Claude Agent SDK "you're running INSIDE a
    // Claude Code VS Code session, connect to the extension's IPC." Atelier's server
    // needs an INDEPENDENT SDK session — without stripping, the SDK's `query()` tries
    // to attach to the extension's IPC pipe/MCP server, blocks forever waiting for
    // a response that never comes, and `supportedModels()` hangs.
    for (const key of [
      "NODE_OPTIONS",
      "ELECTRON_RUN_AS_NODE",
      "ELECTRON_NO_ATTACH_CONSOLE",
      "VSCODE_INSPECTOR_OPTIONS",
      "VSCODE_IPC_HOOK",
      "VSCODE_IPC_HOOK_CLI",
      "VSCODE_NLS_CONFIG",
      "VSCODE_HANDLES_UNCAUGHT_ERRORS",
      "VSCODE_NODE_CACHED_DATA_DIR",
      "VSCODE_CRASH_REPORTER_PROCESS_TYPE",
      "VSCODE_CWD",
      "VSCODE_PID",
      "VSCODE_CODE_CACHE_PATH",
      "VSCODE_ESM_ENTRYPOINT",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_CODE_SSE_PORT",
    ]) {
      delete env[key]
    }
    // Keep ATELIER_PORT env var for backward compat (tool-deployer, subprocess communication)
    if (settingsToWrite.serverPort) {
      env.ATELIER_PORT = String(settingsToWrite.serverPort)
    } else {
      delete env.ATELIER_PORT
    }

    const runtime = getRuntime()
    let resolvedRuntime = resolveRuntime(runtime, env)
    augmentPath(env)
    if (process.platform === "win32" && !path.isAbsolute(resolvedRuntime)) {
      resolvedRuntime = resolveRuntime(runtime, env)
    }
    // Ensure the resolved runtime's directory is on PATH so the Claude Agent SDK
    // (and any other subprocess the server spawns) can find "bun" by bare name.
    // resolveRuntime may find bun at a deep Chocolatey path that isn't on PATH.
    if (path.isAbsolute(resolvedRuntime)) {
      const runtimeDir = path.dirname(resolvedRuntime)
      const parts = (env.PATH ?? "").split(path.delimiter)
      const alreadyInPath = process.platform === "win32"
        ? parts.some((p) => p.toLowerCase() === runtimeDir.toLowerCase())
        : parts.includes(runtimeDir)
      if (!alreadyInPath) {
        env.PATH = `${runtimeDir}${path.delimiter}${env.PATH}`
      }
    }
    if (process.platform === "win32" && !path.isAbsolute(resolvedRuntime)) {
      throw new Error(`Unable to resolve runtime '${runtime}' to an absolute executable path`)
    }
    this.log?.("debug", "server_spawning", `command=${resolvedRuntime} run ${serverEntry}`)
    const proc = this.spawnProcess(resolvedRuntime, ["run", serverEntry, options.cwd], {
      cwd: options.cwd,
      // stdin must be a real pipe (not "ignore") because on Windows the Claude Agent SDK
      // spawns claude.exe as a subprocess that inherits the server's stdio; with stdin
      // ignored (NUL handle), subprocess calls like `query().supportedModels()` hang
      // indefinitely. An empty pipe gives the SDK a valid stdin handle to inherit.
      stdio: ["pipe", "pipe", "pipe"],
      env,
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: false,
    })
    // Close our end of stdin so the server gets EOF if it ever reads
    proc.stdin?.end()
    this.proc = proc
    this.log?.("debug", "server_spawned", `pid=${proc.pid}`)

    // Drain stdout so the pipe buffer never fills up. On Windows the default
    // stdio pipe is ~8KB; once full, the server's writes (and any subprocess
    // inheriting the pipe — like the Claude Agent SDK's claude.exe) block
    // indefinitely, making /config and other endpoints appear to hang.
    proc.stdout?.on("data", () => {})
    // Capture stderr so startup crashes include the actual error message.
    // Cap the buffer size to avoid unbounded memory growth during long sessions.
    let stderrBuffer = ""
    const STDERR_CAP = 64_000
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString()
      if (stderrBuffer.length > STDERR_CAP) stderrBuffer = stderrBuffer.slice(-STDERR_CAP)
    })

    const spawnedAt = Date.now()
    const atelierUrl = await this.waitForPidFile(options.cwd, proc, spawnedAt, 15000, options.signal, () => stderrBuffer)
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
          exited = await waitForExit(this.proc.pid, 5000)
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

  private async waitForPidFile(cwd: string, proc: ChildProcess, spawnedAt: number, timeoutMs: number, signal?: AbortSignal, getStderr?: () => string): Promise<string> {
    const pidPath = path.join(atelierStateDir(cwd), "atelier.pid")
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("Aborted")
      if (proc.exitCode !== null) {
        const stderr = getStderr?.().trim()
        throw new Error(`Atelier exited with code ${proc.exitCode}${stderr ? `:\n${stderr}` : ""}`)
      }

      try {
        const stat = fs.statSync(pidPath)
        // Accept the pid file only if it was written after we spawned (avoids stale files
        // from a previous server). PID equality is unreliable on Windows because Bun
        // wraps `bun run` in a parent process, so process.pid in the script differs
        // from spawn's proc.pid. mtime freshness is the cross-platform reliable check.
        if (stat.mtimeMs >= spawnedAt - 1000) {
          const contents = fs.readFileSync(pidPath, "utf-8").trim().split("\n")
          const pid = parseInt(contents[0]!, 10)
          const url = contents[1]
          if (!isNaN(pid) && url) return url
        }
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
