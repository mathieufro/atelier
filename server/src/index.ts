import { createApp, startMergedModelsRefresher } from "./app.js"
import { createPipelineState } from "./orchestration/pipeline-state.js"
import { createEventMerger } from "./engine/event-merger.js"
import { RalphLoopController } from "./ralph-loop-controller.js"
import { createOpenCodeProxy } from "./engine/opencode-proxy.js"
import { FavoritesStore } from "./engine/favorites-store.js"
import { PresetStore } from "./engine/preset-store.js"
import { Orchestrator } from "./orchestration/orchestrator.js"
import { OpenCodeEngine } from "./engine/opencode-engine.js"
import { BackendRegistry } from "./engine/backend-registry.js"
import { SessionMetadataStore } from "./engine/session-metadata-store.js"
import { deployCallbackTool, deployMcpSignalTool, deployResponderMcp } from "./infra/tool-deployer.js"
import { readMcpConfigs } from "./engine/mcp-instructions.js"
import { atelierStateDir } from "@atelier/core/state-dir"
import { readSettings } from "@atelier/core/settings"
import { createLogger } from "./infra/logger.js"
import { meetsLevel, type LogLevel } from "@atelier/core"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import { terminateProcessTree } from "@atelier/core/process-platform"
import type { IdleDetectorStagePolicyOverride } from "./orchestration/idle-detector-config.js"

// Ensure the runtime executable's directory is on PATH so the Claude Agent SDK
// (and any other subprocess) can resolve "bun" when spawning child processes.
// On Windows, Bun installed via Chocolatey lives at a deep path like
// C:\ProgramData\chocolatey\lib\bun\tools\bun-windows-x64\bun.exe — which is
// NOT on PATH by default. Without this, the SDK's spawn("bun", ["cli.js",...])
// fails silently and supportedModels()/query() promises never resolve.
{
  const execDir = path.dirname(process.execPath)
  const currentPath = process.env.PATH ?? ""
  if (!currentPath.split(path.delimiter).includes(execDir)) {
    process.env.PATH = `${execDir}${path.delimiter}${currentPath}`
  }
}

const workspacePath = process.argv[2] || process.cwd()

// Port resolution: settings file > env var > auto-assign (0)
const settings = readSettings(atelierStateDir(workspacePath))
const atelierPort = settings.serverPort ?? parseInt(process.env.ATELIER_PORT || "0", 10)

/**
 * Build OpenCode config from workspace conventions:
 * - Converts .mcp.json stdio servers to OpenCode's mcp format
 * - Adds .claude/CLAUDE.md to instructions (OpenCode only auto-discovers
 *   root CLAUDE.md, not the .claude/ subdirectory that Claude Code uses)
 */
function buildOpenCodeConfig(workspace: string): string {
  const config: Record<string, unknown> = {
    // Auto-approve all tool permissions — Atelier agents run autonomously
    permission: "allow",
  }

  // Include .claude/CLAUDE.md so OpenCode agents see the same project
  // instructions that Claude Code agents get. OpenCode only auto-discovers
  // root-level CLAUDE.md — the .claude/ subdirectory convention is Claude Code-specific.
  const claudeSubdir = path.join(workspace, ".claude", "CLAUDE.md")
  if (fs.existsSync(claudeSubdir)) {
    config.instructions = [".claude/CLAUDE.md"]
  }

  // Convert .mcp.json servers to OpenCode mcp config
  const mcpConfigs = readMcpConfigs(workspace)
  const mcpEntries = Object.entries(mcpConfigs)
  if (mcpEntries.length > 0) {
    const mcp: Record<string, { type: "local"; command: string[]; environment?: Record<string, string> }> = {}
    for (const [name, cfg] of mcpEntries) {
      mcp[name] = {
        type: "local",
        command: [cfg.command, ...(cfg.args ?? [])],
        ...(cfg.env ? { environment: cfg.env } : {}),
      }
    }
    config.mcp = mcp
  }

  return JSON.stringify(config)
}

function openCodeConfigContent(): string {
  const rawConfig = process.env.ATELIER_OPENCODE_CONFIG ?? buildOpenCodeConfig(workspacePath)
  const config = JSON.parse(rawConfig) as unknown
  if (!config || typeof config !== "object" || Array.isArray(config)) return rawConfig

  const existing = config as Record<string, unknown>
  const permission = existing.permission
  if (permission && (typeof permission !== "object" || Array.isArray(permission))) return rawConfig

  return JSON.stringify({
    ...existing,
    permission: {
      ...(permission as Record<string, unknown> | undefined),
      webfetch: "allow",
      websearch: "allow",
    },
  })
}

let opencodeUrl: string | null = null
let opencodeProc: ChildProcess | null = null

/**
 * Check whether `opencode` is on PATH and executable. Used as a pre-flight guard
 * before attempting to spawn it — on Bun, spawn() throws synchronously on ENOENT
 * in a way that bypasses Promise rejection handling.
 */
function isOpencodeAvailable(): boolean {
  try {
    const result = spawnSync("opencode", ["--version"], {
      stdio: "ignore",
      windowsHide: true,
      timeout: 3000,
      shell: process.platform === "win32",
    })
    return result.status === 0
  } catch {
    return false
  }
}

async function startOpenCode(knownAtelierPort: number, stateDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("opencode", ["serve", "--hostname=127.0.0.1", "--port=0"], {
      cwd: workspacePath,
      detached: process.platform !== "win32",
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ATELIER_PORT: String(knownAtelierPort),
        // Keep .opencode/ out of the workspace — tools/config live in the state dir instead
        OPENCODE_CONFIG_DIR: stateDir,
        OPENCODE_ENABLE_EXA: "1",
        // Allow E2E tests (or CI) to inject a model config without changing source.
        // Falls back to empty config (OpenCode picks up env-based providers).
        // Merge MCP servers from .mcp.json so OpenCode connects to them (e.g. Strobe).
        OPENCODE_CONFIG_CONTENT: openCodeConfigContent(),
        // Prevent OpenCode from auto-discovering Claude Code skills in .claude/skills/ —
        // Atelier injects the right skill per stage via the orchestrator.
        OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
      },
    })
    opencodeProc = proc

    let done = false
    let output = ""
    const finish = (kind: "resolve" | "reject", value: string | Error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (kind === "resolve") {
        resolve(value as string)
        return
      }
      if (proc.pid) void terminateProcessTree(proc.pid)
      reject(value as Error)
    }

    const timer = setTimeout(() => finish("reject", new Error("Timeout waiting for OpenCode")), 10000)

    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/opencode server listening on (https?:\/\/[^\s]+)/)
      if (match) {
        finish("resolve", match[1]!)
      }
    })

    proc.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString() })
    proc.on("error", (err) => finish("reject", err))
    proc.on("exit", (code) => finish("reject", new Error(`OpenCode exited with code ${code}`)))
  })
}

async function main() {
  const stateDir = atelierStateDir(workspacePath)
  fs.mkdirSync(stateDir, { recursive: true })

  await deployCallbackTool(stateDir)
  await deployMcpSignalTool(stateDir)
  await deployResponderMcp(stateDir)

  // Clean stale ~/.claude/ide/*.lock files whose owner PIDs are dead.
  // These are left behind when VS Code windows crash/close unexpectedly. When
  // the Claude Agent SDK spawns its claude subprocess, claude scans this dir
  // to find an IDE to connect to; if it hits a stale lock whose TCP port is
  // in a TIME_WAIT or half-open state, the subprocess can hang indefinitely.
  try {
    const claudeIdeDir = path.join(os.homedir(), ".claude", "ide")
    if (fs.existsSync(claudeIdeDir)) {
      let removed = 0
      for (const name of fs.readdirSync(claudeIdeDir)) {
        if (!name.endsWith(".lock")) continue
        const lockPath = path.join(claudeIdeDir, name)
        try {
          const content = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as { pid?: number }
          const pid = typeof content.pid === "number" ? content.pid : 0
          if (pid > 0) {
            try { process.kill(pid, 0) } catch { fs.unlinkSync(lockPath); removed++ }
          }
        } catch { /* malformed lock — leave it */ }
      }
      if (removed > 0) {
        // Can't log here yet (logger not created); use console.error for startup diagnostics
        console.error(`[atelier] Cleaned ${removed} stale Claude IDE lock file(s)`)
      }
    }
  } catch { /* non-fatal */ }

  const logger = createLogger({ workspacePath })

  const pipelineState = createPipelineState(workspacePath, logger)
  const serverLogger = logger.child({ source: "server" })

  // Internal sessions shared between event merger (SSE filtering) and proxy (session list filtering)
  const internalSessions = new Set<string>()
  const eventMerger = createEventMerger({ internalSessions, logger })

  // Register all pipeline-owned sessions as internal on startup so they're
  // hidden from the session list even before crash recovery runs.
  for (const sessionId of pipelineState.getAllPipelineSessionIds()) {
    internalSessions.add(sessionId)
  }

  let engineError: string | null = null
  const orchestratorRef: { current: Orchestrator | null } = { current: null }
  const globalFavoritesPath = path.join(os.homedir(), ".atelier", "favorites.json")
  const favoritesStore = new FavoritesStore(globalFavoritesPath)
  const presetStore = new PresetStore(path.join(os.homedir(), ".atelier", "presets"))

  // Mutable proxy ref -- updated when OpenCode starts or reconnects.
  // The Proxy delegate forwards all property access to proxyRef.current,
  // so the app automatically picks up proxy swaps without recreation.
  const proxyRef: { current: import("./engine/backend-proxy.js").BackendProxy } = {
    current: createPlaceholderProxy(),
  }
  const proxyDelegate = new Proxy({} as import("./engine/backend-proxy.js").BackendProxy, {
    get: (_target, prop) => (proxyRef.current as unknown as Record<string, unknown>)[prop as string],
  })

  const registry = new BackendRegistry(logger)
  // OpenCode proxy registered via factory — getProxy("opencode") waits until the
  // process is ready instead of hitting the placeholder and returning empty data.
  let resolveOpenCodeProxy: (proxy: import("./engine/backend-proxy.js").BackendProxy) => void
  let rejectOpenCodeProxy: (err: Error) => void
  const openCodeProxyReady = new Promise<import("./engine/backend-proxy.js").BackendProxy>((resolve, reject) => {
    resolveOpenCodeProxy = resolve
    rejectOpenCodeProxy = reject
  })
  registry.registerProxyFactory("opencode", () => openCodeProxyReady)

  const metadataStorePath = path.join(stateDir, "session-metadata.json")
  const metadataStore = new SessionMetadataStore(metadataStorePath, logger)
  registry.setMetadataStore(metadataStore)

  // Mutable engine ref — set when OpenCode initializes (lazy or eager).
  let openCodeEngine: OpenCodeEngine | null = null

  /** Wire engine callbacks for orchestrator and event merger. */
  function wireEngineCallbacks(engine: OpenCodeEngine): void {
    engine.setActivityCallback((sessionId) => {
      touchActivity()
      orchestratorRef.current?.handleSessionActivity(sessionId)
    })
    engine.setBusyCallback((sessionId) =>
      orchestratorRef.current?.handleSessionBusy(sessionId))
    engine.setIdleCallback((sessionId) =>
      orchestratorRef.current?.handleSessionIdle(sessionId))
    engine.setRawEventCallback((event) =>
      eventMerger.forwardEvent(event))
    engine.setRawOpenCodeEventCallback((event) =>
      eventMerger.forwardOpenCodeEvent(event))
    engine.setNormalizedEventCallback((event) =>
      orchestratorRef.current?.handleNormalizedEvent(event, "opencode"))
    engine.setQuestionCallback((sessionId, requestId) => {
      if (orchestratorRef.current?.isSessionOwnedByPipeline(sessionId)) {
        orchestratorRef.current.handleInteractionAsked(sessionId, requestId)
      }
    })
    engine.setPermissionCallback((_sessionId, _requestId) => {
      // No-op: opencode backend is full yolo, no approval gates
    })
  }

  /** Initialize the OpenCode backend: spawn process, create proxy, engine, wire callbacks. */
  async function initOpenCode(knownPort: number): Promise<OpenCodeEngine> {
    opencodeUrl = await startOpenCode(knownPort, stateDir)
    serverLogger.info("atelier", "server", "opencode_connected")
    // Notify UI to re-fetch config now that OpenCode models are available
    eventMerger.emit({ type: "config.updated" } as any)

    // Register exit handler immediately after startOpenCode resolves
    function registerExitHandler() {
      opencodeProc?.on("exit", (code) => handleOpenCodeCrash(code))
    }
    registerExitHandler()

    const sdkClient = createOpencodeClient({ baseUrl: opencodeUrl })
    proxyRef.current = createOpenCodeProxy(sdkClient, internalSessions, workspacePath, metadataStore)
    resolveOpenCodeProxy!(proxyDelegate)

    const engine = new OpenCodeEngine(opencodeUrl, { metadataStore })
    await engine.connectSSE()

    openCodeEngine = engine
    wireEngineCallbacks(engine)
    registry.registerEngine("opencode", engine)

    return engine

    async function handleOpenCodeCrash(code: number | null) {
      if (code === null || code === 0) return
      serverLogger.error("atelier", "server", "opencode_disconnected", { error: `OpenCode exited with code ${code}` })

      eventMerger.emit({ type: "connection_lost" })

      if (orchestratorRef.current) {
        for (const pipelineId of orchestratorRef.current.getActivePipelineIds()) {
          await orchestratorRef.current.failPipeline(pipelineId, `OpenCode process exited with code ${code}`)
        }
      }

      try {
        opencodeUrl = await startOpenCode(knownPort, stateDir)
        serverLogger.info("atelier", "server", "opencode_reconnected")
        engine.reconnect(opencodeUrl)

        const newClient = createOpencodeClient({ baseUrl: opencodeUrl })
        proxyRef.current = createOpenCodeProxy(newClient, internalSessions, workspacePath, metadataStore)

        // Re-register exit handler on the new process after crash recovery
        registerExitHandler()

        eventMerger.emit({ type: "connection_restored" })

        const idled = pipelineState.markCrashedPipelinesAsIdle()
        if (idled > 0) serverLogger.info("atelier", "pipeline", "pipelines_idled", { data: { count: idled } })
      } catch (err) {
        engineError = (err as Error).message
        serverLogger.error("atelier", "server", "opencode_restart_failed", { error: String(err) })
      }
    }
  }

  // Create a placeholder engine for the orchestrator (used before OpenCode init).
  // All methods throw — the real engine replaces this via the registry.
  const placeholderEngine = createPlaceholderEngine()

  const orchestrator = new Orchestrator({
    engine: placeholderEngine,
    registry,
    pipelineState,
    eventMerger,
    skillsDir: path.resolve(import.meta.dirname, "../../skills"),
    workspacePath,
    ensureToolDeployed: (targetDir?: string) => deployCallbackTool(targetDir ?? stateDir),
    logger,
    proxy: proxyDelegate,
    detectorServerDefaults: parseDetectorServerDefaults(),
  })
  orchestratorRef.current = orchestrator

  // Mark any pipelines left "running" from a previous server lifetime as idle.
  const cleaned = pipelineState.markCrashedPipelinesAsIdle()
  if (cleaned > 0) serverLogger.info("atelier", "pipeline", "stale_pipeline_cleaned", { data: { count: cleaned } })

  // Idle timeout — server self-terminates after 10 minutes of inactivity
  let lastActivityAt = Date.now()
  const IDLE_TIMEOUT_MS = 10 * 60 * 1000
  function touchActivity() { lastActivityAt = Date.now() }

  const ralphController = new RalphLoopController(eventMerger)

  // Assigned after Bun.serve() + pidPath are available, before any async setup begins.
  let shutdownRef: (() => Promise<void>) | undefined

  const app = createApp({
    registry,
    metadataStore,
    workspacePath,
    eventMerger,
    favoritesStore,
    presetStore,
    skillsDir: path.resolve(import.meta.dirname, "../../skills"),
    ralphController,
    getOrchestrator: () => orchestratorRef.current,
    getStatus() {
      if (registry.listReadyBackends().length > 0) return "ready" as const
      if (engineError) return "error" as const
      if (registry.hasAnyBackend()) return "starting" as const
      return "starting" as const
    },
    getPipelineState: () => pipelineState,
    onLogSubscribe: (handler, level) => {
      return logger.onEvent((event) => {
        if (meetsLevel(event.level, level as LogLevel)) {
          handler(event)
        }
      })
    },
    onMessageRejected: (reason) => {
      serverLogger.info("atelier", "message", "message_rejected", { data: { reason } })
    },
    onActivity: touchActivity,
    onShutdown: async () => { await shutdownRef?.() },
    logger,
  })

  const server = Bun.serve({
    hostname: process.env.ATELIER_HOST ?? "127.0.0.1",
    port: atelierPort,
    fetch: app.fetch,
    // Disable idle timeout so SSE connections stay open for the full pipeline duration.
    idleTimeout: 0,
  })

  const actualPort = server.port
  serverLogger.info("atelier", "server", "server_started", { data: { port: actualPort } })

  const pidPath = path.join(stateDir, "atelier.pid")
  fs.writeFileSync(pidPath, `${process.pid}\nhttp://127.0.0.1:${actualPort}`, { mode: 0o600 })

  // Define shutdown and wire it to shutdownRef BEFORE any async setup begins.
  // Without this, POST /shutdown would be a no-op during the startup window
  // between Bun.serve() and the end of initialization (the extension can discover
  // the server URL from the PID file immediately after the write above).
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    serverLogger.info("atelier", "server", "server_stopped")
    // Rescue-commit any uncommitted worktree work before tearing down
    await orchestrator.rescueAllWorktrees()
    orchestrator.destroy()
    pipelineState.markCrashedPipelinesAsIdle()
    try { fs.unlinkSync(pidPath) } catch {}
    await logger.flush()
    logger.close()
    // Interrupt all Claude Code sessions to kill SDK subprocesses
    const claudeEngine = registry.getEngineIfReady("claude-code")
    if (claudeEngine?.shutdown) {
      await claudeEngine.shutdown()
    }
    if (opencodeProc?.pid) {
      await terminateProcessTree(opencodeProc.pid)
    }
    openCodeEngine?.disconnect()
    process.exit(0)
  }

  shutdownRef = shutdown

  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
  // On Windows: SIGINT fires for Ctrl+C only; SIGHUP is a no-op (never fires).
  // SIGTERM is delivered by Node/Bun when the extension calls process.kill(pid, "SIGTERM").
  process.on("SIGHUP", shutdown)

  // Idle timeout check — every 30s, if idle > 10min and no active sessions/pipelines, self-terminate.
  // Engine activity callbacks reset lastActivityAt on every SDK yield, so active sessions prevent shutdown.
  // Belt-and-suspenders: also check the engine directly for busy sessions.
  const hasActiveSessions = (): boolean => {
    const claudeEngine = registry.getEngineIfReady("claude-code")
    if (claudeEngine?.hasActiveSessions?.()) return true
    return false
  }
  const idleChecker = setInterval(() => {
    const idleMs = Date.now() - lastActivityAt
    if (idleMs >= IDLE_TIMEOUT_MS && !orchestratorRef.current?.hasActivePipeline() && !hasActiveSessions() && !ralphController.hasActiveLoops()) {
      serverLogger.info("atelier", "server", "idle_shutdown", { data: { idleMs } })
      clearInterval(idleChecker)
      // Write marker so extension knows this was intentional (not a crash)
      try { fs.writeFileSync(path.join(stateDir, "idle-shutdown"), "", { mode: 0o600 }) } catch {}
      shutdown()
    }
  }, 30_000)
  idleChecker.unref()

  // Claude Code backend — lazy factories (initialized on first anthropic session).
  // Registered here (after Bun.serve) so `actualPort` is available for the MCP signal tool.
  registry.registerEngineFactory("claude-code", async () => {
    const { ClaudeCodeEngine } = await import("./engine/claude-code-engine.js")
    let sdkQuery: unknown
    let sdkForkSession: unknown
    try {
      const sdkModule = await import("@anthropic-ai/claude-agent-sdk")
      sdkQuery = sdkModule.query
      sdkForkSession = sdkModule.forkSession
    } catch (err) {
      // Bun throws non-Error objects for unresolvable modules
      const msg = err instanceof Error ? err.message : String(err && typeof err === "object" && "message" in err ? (err as any).message : err)
      throw new Error(`Claude Agent SDK not available: ${msg}`)
    }
    const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects")
    const encodedWs = workspacePath.replace(/[^a-zA-Z0-9]/g, "-")
    const engine = new ClaudeCodeEngine({
      queryFactory: sdkQuery as any,
      forkSessionFactory: sdkForkSession as any,
      stateDir,
      port: actualPort,
      metadataStore,
      transcriptDir: path.join(claudeProjectsDir, encodedWs),
      logger,
    })
    engine.setActivityCallback((sessionId) => {
      touchActivity()
      orchestratorRef.current?.handleSessionActivity(sessionId)
    })
    engine.setBusyCallback((sessionId) =>
      orchestratorRef.current?.handleSessionBusy(sessionId))
    engine.setIdleCallback((sessionId) =>
      orchestratorRef.current?.handleSessionIdle(sessionId))
    engine.setRawEventCallback((event) =>
      eventMerger.forwardEvent(event))
    engine.setNormalizedEventCallback((event) =>
      orchestratorRef.current?.handleNormalizedEvent(event, "claude-code"))
    engine.setQuestionCallback((sessionId, requestId, questions) => {
      if (orchestratorRef.current?.isSessionOwnedByPipeline(sessionId)) {
        orchestratorRef.current.handleInteractionAsked(sessionId, requestId)
      }
    })
    engine.setPermissionCallback((sessionId, requestId) => {
      if (orchestratorRef.current?.isSessionOwnedByPipeline(sessionId)) {
        orchestratorRef.current.handleInteractionAsked(sessionId, requestId)
        orchestratorRef.current.handleAutoPermission(sessionId, requestId)
      }
    })
    engine.setSessionCreatedCallback((sessionId) => {
      const meta = metadataStore.get(sessionId)
      if (meta) {
        eventMerger.emit({
          type: "session.created",
          properties: {
            info: {
              id: sessionId,
              title: meta.title,
              slug: sessionId,
              projectID: "",
              directory: meta.workspacePath,
              version: "1",
              time: { created: meta.createdAt, updated: meta.lastActiveAt },
            }
          }
        })
      }
    })

    return engine
  })

  registry.registerProxyFactory("claude-code", async () => {
    const { ClaudeCodeProxy } = await import("./engine/claude-code-proxy.js")
    const engine = await registry.getEngine("claude-code")
    const claudeProjectsDir = path.join(os.homedir(), ".claude", "projects")
    const proxy = new ClaudeCodeProxy({
      engine: engine as import("./engine/claude-code-engine.js").ClaudeCodeEngine,
      metadataStore,
      claudeProjectsDir,
      workspacePath,
    })
    proxy.warmModels()
    return proxy
  })

  // Initialize OpenCode eagerly (non-blocking — server is already listening).
  // Pre-flight check: opencode is an optional backend. If it's not on PATH, skip
  // initialization entirely so the server can still run with only Claude Code
  // (or any other backend). On Bun, spawn() throws synchronously on ENOENT,
  // bypassing .catch(), so a synchronous availability probe is the reliable guard.
  if (isOpencodeAvailable()) {
    initOpenCode(actualPort!).catch((err) => {
      engineError = (err as Error).message
      rejectOpenCodeProxy!(err instanceof Error ? err : new Error(String(err)))
      serverLogger.error("atelier", "server", "opencode_init_failed", { error: String(err) })
    })
  } else {
    const msg = "OpenCode not installed — skipping OpenCode backend. Install from https://github.com/opencode-ai/opencode to enable."
    serverLogger.info("atelier", "server", "opencode_not_installed")
    rejectOpenCodeProxy!(new Error(msg))
    // Attach a no-op .catch so Bun doesn't treat this as unhandled.
    // Consumers that await the promise later still see the rejection.
    openCodeProxyReady.catch(() => {})
  }

  // Pre-warm claude-code backend (non-blocking — avoids cold-start on first anthropic message).
  registry.getEngine("claude-code").then(() =>
    registry.getProxy("claude-code")
  ).then(() => {
    serverLogger.info("atelier", "server", "claude_code_ready")
    // Once a backend is ready, start the merged-models refresher so the
    // /message hot path always reads from a warm cache (avoids 900ms helper
    // spawn that previously blocked every send after a 30s idle window).
    startMergedModelsRefresher(registry)
  }).catch((err) => {
    serverLogger.error("atelier", "server", "claude_code_init_failed", { error: String(err) })
  })

  // Pre-warm MCP instructions cache (non-blocking — spawns servers to extract instructions).
  import("./engine/mcp-instructions.js").then(({ resolveMcpInstructions }) =>
    resolveMcpInstructions(workspacePath)
  ).then((block) => {
    if (block) serverLogger.info("atelier", "server", "mcp_instructions_resolved", { data: { length: block.length } })
  }).catch(() => {
    // Non-critical — will retry on first sendMessage
  })

  // Watch parent process (extension host) — if it dies, self-terminate to avoid orphaned bun processes.
  // When VS Code crashes or is force-killed, deactivate() never runs, so SIGTERM is never sent.
  // We detect this by checking if the parent PID is still alive every 2 seconds.
  const parentPid = process.ppid
  if (parentPid && parentPid > 1) {
    const parentWatcher = setInterval(() => {
      try {
        process.kill(parentPid, 0) // signal 0 = liveness check
      } catch {
        serverLogger.info("atelier", "server", "parent_died", { data: { parentPid } })
        clearInterval(parentWatcher)
        shutdown()
      }
    }, 2000)
    parentWatcher.unref() // don't prevent exit
  }
}

function parseDetectorServerDefaults(): Partial<IdleDetectorStagePolicyOverride> | undefined {
  const raw = process.env.ATELIER_IDLE_DETECTOR_CONFIG
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      // console.warn is intentional here — the structured logger isn't available yet
      // at the point where this function is called during startup.
      console.warn("[Atelier] Ignoring ATELIER_IDLE_DETECTOR_CONFIG: expected JSON object")
      return undefined
    }
    return parsed as Partial<IdleDetectorStagePolicyOverride>
  } catch (error) {
    // console.warn is intentional — logger isn't available yet during startup
    console.warn("[Atelier] Failed to parse ATELIER_IDLE_DETECTOR_CONFIG", error)
    return undefined
  }
}

/** Returns a proxy where every method throws -- used before OpenCode is ready. */
function createPlaceholderProxy(): import("./engine/backend-proxy.js").BackendProxy {
  return new Proxy({} as import("./engine/backend-proxy.js").BackendProxy, {
    get: (_, prop) => () => { throw new Error("OpenCode not ready") },
  })
}

/** Returns a placeholder engine where every method throws -- used before any backend is ready. */
function createPlaceholderEngine(): import("@atelier/core/agent-engine").AgentEngine {
  return new Proxy({} as import("@atelier/core/agent-engine").AgentEngine, {
    get: (_, prop) => () => { throw new Error("No backend engine ready") },
  })
}

main().catch((err) => {
  console.error("[Atelier] Fatal:", err)
  process.exit(1)
})
