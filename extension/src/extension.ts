import * as vscode from "vscode"
import * as path from "node:path"
import * as fs from "node:fs"
import * as os from "node:os"
import * as crypto from "node:crypto"
import { AtelierServerManager } from "./atelier-server-manager.js"
import { createAtelierClient, type AtelierClient } from "./atelier-client.js"
import { createBridge } from "./bridge.js"
import { wireClientToWebview } from "./extension-wiring.js"
import { getWebviewContent } from "./webview-panel.js"
import { installOpencode } from "./install-opencode.js"
import { isStrobeInstalled, installStrobe } from "./install-strobe.js"
import { OutputChannelController } from "./output-channel-controller.js"
import { shouldForkOnSwitch, findBystanderPanels, shouldCleanupFork, findOrphanForks } from "./fork-utils.js"
import { LOG_LEVELS, type LogLevel } from "@atelier/core"
import type { WebviewMessage, HostMessage } from "@atelier/core"
import type { AtelierSettings } from "@atelier/core/settings"

let atelierClient: AtelierClient | null = null
let atelierManager: AtelierServerManager | null = null
let outputChannel: OutputChannelController | null = null
const panels = new Set<vscode.WebviewPanel>()
const panelWirings = new Map<vscode.WebviewPanel, () => void>()
const panelMessageHandlers = new Map<vscode.WebviewPanel, (msg: WebviewMessage) => void>()
const panelActiveSessionIds = new Map<vscode.WebviewPanel, string | null>()
const forkTracker = new Map<string, { hasUserMessages: boolean }>()
const sessionStatusCache = new Map<string, "busy" | "idle">()
let lastFocusedPanel: vscode.WebviewPanel | null = null

interface PanelPersistedState {
  activeSessionId?: string
  activePipelineId?: string
  fileContextEnabled?: boolean
}

function trimTitle(value: string | undefined, max: number): string {
  const text = (value ?? "").trim()
  if (!text) return "Untitled"
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
}

export function resolvePanelTitle(state: {
  activeSessionId: string | null
  activePipelineId: string | null
  activePipelineStageSessionId?: string | null
  sessionTitles: Map<string, string>
  pipelineTitles: Map<string, string>
}): string {
  // Pipeline slug title takes priority — stage session titles are internal
  // labels ("bugfix", "⚙ Compile brainstorm") that aren't useful for tab identification.
  if (state.activePipelineId) {
    const title = state.pipelineTitles.get(state.activePipelineId)
    if (title) return trimTitle(title, 30)
  }
  if (state.activePipelineStageSessionId) {
    const title = state.sessionTitles.get(state.activePipelineStageSessionId)
    if (title) return trimTitle(title, 30)
  }
  if (state.activeSessionId) {
    const title = state.sessionTitles.get(state.activeSessionId)
    if (title) return trimTitle(title, 30)
  }
  return "Atelier"
}

export type IconState = "idle" | "running" | "halted" | "done"

export function deriveIconStateFromEvent(
  currentState: IconState,
  event: { type: string; pipelineId?: string; sessionId?: string },
  activePipelineId: string | null,
  activePipelineStageSessionId?: string | null,
): IconState {
  if (!activePipelineId) return currentState
  // Pipeline-level events — must match active pipeline
  if (event.pipelineId === activePipelineId) {
    switch (event.type) {
      case "stage_started":
      case "stage_resumed":
        return "running"
      case "stage_interrupted":
      case "stuck_escalation":
        return "halted"
      case "pipeline_completed":
        return "idle"
    }
  }
  // Session-level events — detect agent idle within the active pipeline stage
  if (activePipelineStageSessionId && event.sessionId === activePipelineStageSessionId) {
    if (event.type === "session.idle") return "done"
    if (event.type === "session.busy") return "running"
  }
  return currentState
}

export function deriveIconStateFromPipeline(
  pipeline: { status: string; stages: Array<{ status: string; interrupted?: boolean }> },
): IconState {
  if (pipeline.status === "stuck") return "halted"
  if (pipeline.status !== "running") return "idle"
  const hasBlocked = pipeline.stages.some(s => s.interrupted || s.status === "stuck")
  return hasBlocked ? "halted" : "running"
}

export function resolveIconPath(
  state: IconState,
  extensionPath: string,
): { light: vscode.Uri; dark: vscode.Uri } {
  const res = (...parts: string[]) => vscode.Uri.file(path.join(extensionPath, "resources", ...parts))
  if (state === "running") {
    const uri = res("icon-running.svg")
    return { light: uri, dark: uri }
  }
  if (state === "halted") {
    const uri = res("icon-halted.svg")
    return { light: uri, dark: uri }
  }
  if (state === "done") {
    return { light: res("icon-done-light.svg"), dark: res("icon-done-dark.svg") }
  }
  return { light: res("icon-light.svg"), dark: res("icon-dark.svg") }
}

// Mutex for ensureClient -- prevents double-creation from concurrent openChat calls
let clientPromise: Promise<void> | null = null

// Exported for testing -- pure function, no module-level state dependency
export function resolvePanelFrom<T>(
  lastFocused: T | null,
  panelSet: Set<T>,
): T | null {
  if (lastFocused && panelSet.has(lastFocused)) return lastFocused
  for (const p of panelSet) return p
  return null
}

function isPathInWorkspace(
  fsPath: string,
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
): boolean {
  if (!workspaceFolders) return false
  const sep = path.sep
  return workspaceFolders.some(
    (f) => fsPath === f.uri.fsPath || fsPath.startsWith(f.uri.fsPath + sep),
  )
}

function getActiveFileInfo(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined): {
  path: string
  startLine?: number
  endLine?: number
} | null {
  const editor = vscode.window.activeTextEditor
  if (!editor) return null
  const resolved = editor.document.uri.fsPath
  if (!isPathInWorkspace(resolved, workspaceFolders)) return null
  const selection = editor.selection
  return {
    path: resolved,
    startLine: selection.isEmpty ? undefined : selection.start.line + 1,
    endLine: selection.isEmpty ? undefined : selection.end.line + 1,
  }
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | null = null
  return ((...args: any[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn(...args) }, ms)
  }) as unknown as T
}

async function openFileInEditor(filePath: string, line?: number): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders
  const resolved = (() => {
    if (path.isAbsolute(filePath)) return path.normalize(filePath)
    if (!workspaceFolders?.length) return path.resolve(filePath)

    for (const folder of workspaceFolders) {
      const candidate = path.resolve(folder.uri.fsPath, filePath)
      if (fs.existsSync(candidate)) return candidate
    }

    return path.resolve(workspaceFolders[0]!.uri.fsPath, filePath)
  })()

  const uri = vscode.Uri.file(resolved)
  try {
    const doc = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(doc)
    if (line) {
      const pos = new vscode.Position(line - 1, 0)
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos))
    }
  } catch {
    // Non-text files (images, PDFs, etc.) — let VS Code pick the right viewer
    await vscode.commands.executeCommand("vscode.open", uri)
  }
}

function resolvePanel(): vscode.WebviewPanel | null {
  return resolvePanelFrom(lastFocusedPanel, panels)
}

async function promptAndInstall(): Promise<boolean> {
  const choice = await vscode.window.showInformationMessage(
    "OpenCode binary not found. Install it now?",
    "Install",
    "Cancel",
  )
  if (choice !== "Install") return false

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing OpenCode", cancellable: true },
      async (progress, token) => {
        const ac = new AbortController()
        token.onCancellationRequested(() => ac.abort())
        await installOpencode(progress, ac.signal)
      },
    )
    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    vscode.window.showErrorMessage(`Atelier: ${msg}`)
    return false
  }
}

async function promptAndInstallStrobe(): Promise<void> {
  if (isStrobeInstalled()) return

  const action = await vscode.window.showWarningMessage(
    "Atelier: Strobe is not installed. Strobe provides debugging infrastructure for pipeline execution.",
    "Install Strobe",
    "Later",
  )
  if (action !== "Install Strobe") return

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Installing Strobe", cancellable: true },
      async (progress, token) => {
        const ac = new AbortController()
        token.onCancellationRequested(() => ac.abort())
        await installStrobe(progress, ac.signal)
      },
    )
    vscode.window.showInformationMessage("Strobe installed successfully.")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    vscode.window.showErrorMessage(`Strobe installation failed: ${msg}`)
  }
}

/** Register global event handlers (test_command, stuck_escalation, session.created, etc.) on a client. */
function registerGlobalEventHandlers(
  client: AtelierClient,
  navContext?: { context: vscode.ExtensionContext; workspacePath: string },
): void {
  client.onEvent((event) => {
    if (event.type === "test_command" && typeof event.command === "string") {
      const ALLOWED_TEST_COMMANDS = ["workbench.action.reloadWindow", "atelier.openPanel"]
      if (ALLOWED_TEST_COMMANDS.includes(event.command)) {
        vscode.commands.executeCommand(event.command)
      }
    }
    // Forward test webview messages — simulate as if the user clicked a session/pipeline tab
    if (event.type === "test_webview_message" && typeof event === "object" && "message" in event && event.message) {
      const panel = resolvePanel()
      if (panel) {
        const handler = panelMessageHandlers.get(panel)
        if (handler) handler(event.message as WebviewMessage)
      }
    }
    // MCP-driven navigation: switch to session/pipeline in the Atelier panel.
    // If the current panel already has an active session, open a new tab for the new session.
    if (event.type === "test_navigate_session") {
      const e = event as Record<string, unknown>
      const sessionId = e.sessionId as string | undefined
      const pipelineId = e.pipelineId as string | undefined

      if (sessionId) outputChannel?.log("debug", "navigate_session", sessionId)

      // Check if any panel already shows this session — just focus it
      for (const [p, sid] of panelActiveSessionIds) {
        if (sid === sessionId && panels.has(p)) {
          p.reveal(undefined, true)
          return
        }
      }

      const target = resolvePanel()
      const targetHasSession = target ? !!panelActiveSessionIds.get(target) : false

      const switchInPanel = (panel: vscode.WebviewPanel) => {
        panel.reveal(undefined, true)
        const handler = panelMessageHandlers.get(panel)
        if (handler && sessionId) handler({ type: "switchSession", sessionId } as WebviewMessage)
        if (handler && pipelineId) handler({ type: "loadPipeline", pipelineId } as WebviewMessage)
      }

      if (target && !targetHasSession) {
        // Panel exists but has no active session — switch in it
        switchInPanel(target)
      } else if (target && targetHasSession && navContext) {
        // Panel already has a session — open a new tab
        const newPanel = createPanel(navContext.context, navContext.workspacePath)
        switchInPanel(newPanel)
      } else if (target && targetHasSession) {
        // Fallback: no context available — switch in existing panel
        switchInPanel(target)
      } else {
        // No panel — create one via command, then switch after it appears
        vscode.commands.executeCommand("atelier.openChat")
        setTimeout(() => {
          const p = resolvePanel()
          if (p) switchInPanel(p)
        }, 300)
      }
    }
    // Maintain global session status cache for fork decisions
    // Normalized events carry sessionID inside properties (not top-level sessionId)
    if (event.type === "session.busy" || event.type === "session.idle") {
      const props = (event as Record<string, unknown>).properties as Record<string, unknown> | undefined
      const sid = (typeof props?.sessionID === "string" ? props.sessionID : undefined)
        ?? (typeof (event as Record<string, unknown>).sessionId === "string" ? (event as Record<string, unknown>).sessionId as string : undefined)
      if (sid) {
        sessionStatusCache.set(sid, event.type === "session.busy" ? "busy" : "idle")
      }
    }
    if (event.type === "stuck_escalation") {
      const e = event as Record<string, unknown>
      outputChannel?.log("debug", "stuck_notification", `pipelineId=${e.pipelineId}`)
      vscode.window.showInformationMessage(
        `Pipeline stuck at ${e.stage} — reviewer needs your input`,
        "View Details",
        "Retry with Fixer",
        "Abort Pipeline",
      ).then(choice => {
        if (choice === "View Details") {
          vscode.commands.executeCommand("atelier.openChat")
        } else if (choice === "Retry with Fixer") {
          client.retryStuck(String(e.pipelineId), String(e.stageId), "fixer").catch(() => {})
        } else if (choice === "Abort Pipeline") {
          client.abortPipeline(String(e.pipelineId)).catch(() => {})
        }
      })
    }
  })
}

async function sweepOrphanForks(client: AtelierClient): Promise<void> {
  try {
    const sessions = await client.listSessions()
    const sessionData = sessions.map((s: any) => ({
      id: s.id,
      forkedFrom: s.forkedFrom,
      createdAt: s.time?.created ?? 0,
      lastActiveAt: s.time?.updated ?? 0,
    }))
    const orphans = findOrphanForks(sessionData, 5000)
    for (const orphanId of orphans) {
      await client.deleteSession(orphanId).catch(() => {})
      outputChannel?.log("info", "sweep_orphan_fork", orphanId)
    }
  } catch {
    // Non-critical
  }
}

async function ensureClient(workspacePath: string, context?: vscode.ExtensionContext): Promise<void> {
  if (atelierClient) return
  if (clientPromise) return clientPromise

  clientPromise = (async () => {
    try {
      // Create output channel early so we can log the entire startup flow
      if (context && !outputChannel) {
        outputChannel = new OutputChannelController("") // URL set after server starts
      }
      outputChannel?.log("info", "startup", "initializing")

      const am = new AtelierServerManager()
      am.setLogger((level, action, detail) => outputChannel?.log(level as LogLevel, action, detail))

      // External server URL takes precedence — skip spawn entirely
      const settings = getAtelierSettings()
      if (settings.serverUrl) {
        outputChannel?.log("info", "server_external_connect", settings.serverUrl)
        await am.connectExternal(settings.serverUrl)
        outputChannel?.log("info", "server_external_connected", am.atelierUrl!)
      } else {
        const reconnected = await am.reconnect(workspacePath)
        if (reconnected) {
          outputChannel?.log("info", "server_reconnected", am.atelierUrl!)
        } else {
          outputChannel?.log("info", "server_starting", workspacePath)
          await startServer(am, workspacePath)
          outputChannel?.log("info", "server_started", am.atelierUrl!)
        }
      }
      atelierManager = am

      // Now that we have the URL, connect the log SSE stream
      if (outputChannel) {
        outputChannel.updateBaseUrl(am.atelierUrl!)
        const savedLevel = context?.workspaceState.get<LogLevel>("atelier.logLevel", "info") ?? "info"
        outputChannel.setLevel(savedLevel).catch(() => {})
      }

      outputChannel?.log("info", "client_connecting", am.atelierUrl!)
      const client = createAtelierClient(am.atelierUrl!, (level, action, detail) => outputChannel?.log(level as LogLevel, action, detail))
      atelierClient = client
      outputChannel?.log("debug", "client_init_complete")
      registerGlobalEventHandlers(client, context ? { context, workspacePath } : undefined)
      // Connect SSE in background — don't block panel creation on stream open
      client.connect().then(() => {
        outputChannel?.log("info", "client_connected", "SSE event stream open")
      }).catch(err => console.error("[atelier] Background SSE connect failed:", err))

      // Sweep orphan forks from previous sessions (fire-and-forget)
      sweepOrphanForks(client).catch(() => {})

      am.onStateChange((state) => {
        outputChannel?.log("info", "server_state_changed", state)
        if (state === "crashed") {
          const crashSettings = getAtelierSettings()
          am.restart(workspacePath, crashSettings.serverPort, crashSettings).then(() => {
            outputChannel?.log("info", "server_restarted", am.atelierUrl!)
            outputChannel?.updateBaseUrl(am.atelierUrl!)
            atelierClient?.disconnect()
            const newClient = createAtelierClient(am.atelierUrl!)
            registerGlobalEventHandlers(newClient, context ? { context, workspacePath } : undefined)
            newClient.connect()
            atelierClient = newClient
            // Rewire all panels to use the new client's SSE stream
            for (const rewire of panelWirings.values()) rewire()
            // Trigger full refresh in all panels so they reload sessions, pipelines, etc.
            for (const panel of panelWirings.keys()) {
              panel.webview.postMessage({ type: "event", event: { type: "full_refresh_required", seq: 0 } })
            }
            outputChannel?.log("debug", "panels_rewiring", `count=${panelWirings.size}`)
            outputChannel?.log("info", "panels_rewired", `count=${panelWirings.size}`)
          }).catch(err => {
            const msg = err instanceof Error ? err.message : String(err)
            outputChannel?.log("error", "server_restart_failed", msg)
            vscode.window.showErrorMessage(`Atelier: Server crashed and restart failed — ${msg}`)
          })
        }
        if (state === "stopped" && am.idleShutdown) {
          // Server self-terminated due to idle timeout — tear down client so
          // ensureClient() will restart on the next user action
          outputChannel?.log("info", "idle_shutdown_detected", "server will restart on next activity")
          atelierClient?.disconnect()
          atelierClient = null
          clientPromise = null
          atelierManager = null
        }
      })
    } finally {
      clientPromise = null
    }
  })()

  return clientPromise
}

/** Read Atelier settings from VS Code configuration. */
function getAtelierSettings(): AtelierSettings {
  const config = vscode.workspace.getConfiguration("atelier")
  const configuredPort = config.get<number | null>("serverPort", null)
  const configuredUrl = config.get<string | null>("serverUrl", null)
  return {
    serverPort: typeof configuredPort === "number" && Number.isInteger(configuredPort) && configuredPort > 0
      ? configuredPort
      : null,
    serverUrl: typeof configuredUrl === "string" && configuredUrl.trim()
      ? configuredUrl.trim()
      : null,
    gitEnabled: config.get<boolean>("gitIntegration", false),
  }
}

async function startServer(am: AtelierServerManager, workspacePath: string): Promise<void> {
  const settings = getAtelierSettings()

  try {
    await am.start({ cwd: workspacePath, settings })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("not found") && await promptAndInstall()) {
      await am.start({ cwd: workspacePath, settings })
      return
    }
    outputChannel?.log("error", "server_start_failed", msg)
    if (!msg.includes("not found")) {
      vscode.window.showErrorMessage("Atelier: Failed to start server — see Output panel for details")
    }
    throw err
  }
}

const LANG_TO_EXT: Record<string, string> = {
  typescript: ".ts", javascript: ".js", typescriptreact: ".tsx",
  javascriptreact: ".jsx", shellscript: ".sh", python: ".py",
  ruby: ".rb", go: ".go", rust: ".rs", java: ".java",
  csharp: ".cs", cpp: ".cpp", c: ".c", html: ".html",
  css: ".css", json: ".json", markdown: ".md", yaml: ".yaml",
  xml: ".xml", sql: ".sql", php: ".php", swift: ".swift",
  kotlin: ".kt", scala: ".scala", perl: ".pl", lua: ".lua",
}
function fileExtensionForLanguage(language: string | undefined): string {
  if (!language) return ".txt"
  return LANG_TO_EXT[language] ?? ".txt"
}

function createPanel(
  context: vscode.ExtensionContext,
  workspacePath: string,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "atelierChat",
    "Atelier",
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      enableCommandUris: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
      ],
    },
  )
  outputChannel?.log("debug", "panel_create", `column=${vscode.ViewColumn.One}`)
  wirePanel(panel, context, workspacePath)
  return panel
}

function wirePanel(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext,
  workspacePath: string,
  initialState?: PanelPersistedState,
): void {
  const nonce = crypto.randomBytes(16).toString("hex")
  const scriptUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "dist", "webview", "webview.js"),
  )
  const styleUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(context.extensionUri, "dist", "webview", "webview.css"),
  )
  panel.webview.html = getWebviewContent(
    nonce,
    scriptUri.toString(),
    styleUri.toString(),
    panel.webview.cspSource,
  )

  // Queue events until webview sends "ready"
  let webviewReady = false
  let activeSessionId: string | null = initialState?.activeSessionId ?? null
  let activePipelineId: string | null = initialState?.activePipelineId ?? null
  let activePipelineStageSessionId: string | null = null
  const sessionTitles = new Map<string, string>()
  const pipelineTitles = new Map<string, string>()
  const MAX_QUEUED_EVENTS = 500
  const eventQueue: HostMessage[] = []

  let currentIconState: IconState = "idle"
  panel.iconPath = resolveIconPath("idle", context.extensionPath)

  function applyIconState(state: IconState): void {
    if (state === currentIconState) return
    currentIconState = state
    panel.iconPath = resolveIconPath(state, context.extensionPath)
  }

  function applyPanelTitle(): void {
    panel.title = resolvePanelTitle({
      activeSessionId,
      activePipelineId,
      activePipelineStageSessionId,
      sessionTitles,
      pipelineTitles,
    })
  }

  function postToWebview(msg: HostMessage): void {
    if (webviewReady && panel) {
      panel.webview.postMessage(msg)
    } else {
      if (eventQueue.length >= MAX_QUEUED_EVENTS) {
        outputChannel?.log("debug", "event_queue_overflow", `type=${msg.type}`)
      } else {
        eventQueue.push(msg)
      }
    }
    if (msg.type === "sessions") {
      sessionTitles.clear()
      for (const session of msg.sessions) sessionTitles.set(session.id, session.title ?? "Untitled")
    }
    if (msg.type === "pipelines") {
      pipelineTitles.clear()
      for (const pipeline of msg.pipelines) pipelineTitles.set(pipeline.id, pipeline.title ?? pipeline.prompt ?? "Untitled")
    }
    if (msg.type === "pipeline") {
      pipelineTitles.set(msg.pipeline.id, msg.pipeline.title ?? msg.pipeline.prompt ?? "Untitled")
      // Sync active pipeline — the bridge sends this when a new pipeline is created
      // or loaded, so the extension tab title should reflect the active pipeline.
      activePipelineId = msg.pipeline.id
      activeSessionId = null
      activePipelineStageSessionId = null
      applyIconState(deriveIconStateFromPipeline(msg.pipeline))
    }
    let titleChanged = false
    if (msg.type === "activeSession") {
      activeSessionId = msg.sessionId
      panelActiveSessionIds.set(panel, msg.sessionId)
      activePipelineId = null
      activePipelineStageSessionId = null
      titleChanged = true
      applyIconState("idle")
    }
    if (msg.type === "event") {
      const pipelineIdSnapshot = activePipelineId
      const event = msg.event
      if (event?.type === "stage_started") {
        if (activePipelineId === event.pipelineId) {
          activePipelineStageSessionId = event.sessionId ?? null
          titleChanged = true
        }
      }
      if (event?.type === "pipeline_completed") {
        if (activePipelineId === event.pipelineId) {
          activePipelineId = null
          activePipelineStageSessionId = null
          titleChanged = true
        }
      }
      if (event?.type === "session.updated") {
        const props = event.properties as Record<string, unknown> | undefined
        const info = props?.info as Record<string, unknown> | undefined
        if (info?.id) {
          sessionTitles.set(info.id as string, (info.title as string) ?? "Untitled")
          titleChanged = true
        }
      }
      if (event?.type === "pipeline_title_updated" && event.pipelineId && event.title) {
        pipelineTitles.set(event.pipelineId as string, event.title as string)
        titleChanged = true
      }
      if (event?.type === "stage_started" || event?.type === "stage_interrupted"
          || event?.type === "stage_resumed" || event?.type === "stuck_escalation"
          || event?.type === "pipeline_completed"
          || ((event?.type === "session.idle" || event?.type === "session.busy") && activePipelineId)) {
        applyIconState(deriveIconStateFromEvent(
          currentIconState,
          event as { type: string; pipelineId?: string; sessionId?: string },
          pipelineIdSnapshot,
          activePipelineStageSessionId,
        ))
      }
      // Session-level busy/idle for regular (non-pipeline) chats
      if (!activePipelineId && activeSessionId && 'sessionId' in event && event.sessionId === activeSessionId) {
        if (event?.type === "session.busy") applyIconState("running")
        else if (event?.type === "session.idle") applyIconState("idle")
        else if (event?.type === "session.interrupted") applyIconState("halted")
      }
    }
    if (msg.type === "sessions" || msg.type === "pipelines" || msg.type === "pipeline") {
      titleChanged = true
    }
    if (titleChanged) applyPanelTitle()
    if (msg.type === "error" && msg.code !== "ABORTED") {
      vscode.window.showErrorMessage(`Atelier: ${msg.message}`)
    }
  }

  outputChannel?.log("info", "panel_created", `panel wired to ${atelierClient ? "client" : "NO CLIENT"}`)
  const bridge = createBridge(() => atelierClient!, postToWebview, outputChannel ?? undefined)
  let cleanupSSE = wireClientToWebview(atelierClient!, postToWebview)

  // Store rewire function so crash recovery can re-subscribe SSE on new client
  panelWirings.set(panel, () => {
    cleanupSSE()
    cleanupSSE = wireClientToWebview(atelierClient!, postToWebview)
  })

  panel.onDidChangeViewState(() => {
    if (panel.active) lastFocusedPanel = panel
  })

  /** Fork a session and navigate this panel to it. Returns forked ID, or null on failure. */
  async function forkAndNavigate(sessionId: string, title?: string): Promise<string | null> {
    const forked = await atelierClient!.forkSession(sessionId, title)
    forkTracker.set(forked.id, { hasUserMessages: false })
    const page = await atelierClient!.getMessages(forked.id, { limit: 80 })
    postToWebview({ type: "messages", ...page, sessionId: forked.id, direction: "replace" } as any)
    postToWebview({ type: "activeSession", sessionId: forked.id } as any)
    activeSessionId = forked.id
    panelActiveSessionIds.set(panel, forked.id)
    activePipelineId = null
    activePipelineStageSessionId = null
    applyPanelTitle()
    return forked.id
  }

  // Test-injectable message handler for E2E validation (switchSession, loadPipeline, createSession)
  const handleWebviewMessage = async (msg: WebviewMessage) => {
    // Restart server on demand after idle shutdown
    if (!atelierClient && msg.type === "sendMessage") {
      outputChannel?.log("info", "idle_restart", "restarting server for user message")
      await ensureClient(workspacePath, context)
      // Rewire all panels to use the new client's SSE stream
      for (const rewire of panelWirings.values()) rewire()
      for (const p of panelWirings.keys()) {
        p.webview.postMessage({ type: "event", event: { type: "full_refresh_required", seq: 0 } })
      }
    }
    if (msg.type === "switchSession") {
      // Auto-fork Trigger 1: if target session is busy in another panel, fork
      if (shouldForkOnSwitch(msg.sessionId, panel, panelActiveSessionIds, sessionStatusCache)) {
        try {
          await forkAndNavigate(msg.sessionId)
          return  // Don't fall through to bridge
        } catch (err) {
          outputChannel?.log("error", "auto_fork_switch_failed", String(err))
          // Fall through to normal switchSession
        }
      }
      activeSessionId = msg.sessionId
      panelActiveSessionIds.set(panel, msg.sessionId)
      activePipelineId = null
      activePipelineStageSessionId = null
      applyPanelTitle()
    }
    if (msg.type === "loadPipeline") {
      activePipelineId = msg.pipelineId
      activeSessionId = null
      activePipelineStageSessionId = null
      applyPanelTitle()
    }
    if (msg.type === "sendMessage" || msg.type === "invokeSkill") {
      const sessionId = activeSessionId
      if (sessionId) {
        // Mark fork as having user messages
        const tracking = forkTracker.get(sessionId)
        if (tracking) tracking.hasUserMessages = true

        // Auto-fork Trigger 2: fork bystander panels before sending
        const bystanders = findBystanderPanels(sessionId, panel, panelActiveSessionIds)
        for (const bystander of bystanders) {
          try {
            const forked = await atelierClient!.forkSession(sessionId)
            forkTracker.set(forked.id, { hasUserMessages: false })
            const page = await atelierClient!.getMessages(forked.id, { limit: 80 })
            bystander.webview.postMessage({ type: "messages", ...page, sessionId: forked.id, direction: "replace" })
            bystander.webview.postMessage({ type: "activeSession", sessionId: forked.id })
            panelActiveSessionIds.set(bystander, forked.id)
          } catch (err) {
            outputChannel?.log("error", "bystander_fork_failed", String(err))
          }
        }
      }
    }
    await bridge.handleMessage(msg)
  }
  panelMessageHandlers.set(panel, handleWebviewMessage)

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    const rawObj = raw as Record<string, unknown>
    if (!raw || typeof raw !== "object" || typeof rawObj.type !== "string") return
    const msg = raw as WebviewMessage

    outputChannel?.log("debug", "webview_message", `type=${msg.type}`)

    if (msg.type === "ready") {
      webviewReady = true
      // Flush queued events in small batches to avoid blocking the extension host
      const toFlush = eventQueue.splice(0)
      outputChannel?.log("debug", "webview_ready_flush", `queued=${toFlush.length}`)
      const BATCH_SIZE = 20
      for (let i = 0; i < toFlush.length; i += BATCH_SIZE) {
        const batch = toFlush.slice(i, i + BATCH_SIZE)
        for (const queued of batch) panel.webview.postMessage(queued)
        if (i + BATCH_SIZE < toFlush.length) {
          await new Promise(r => setTimeout(r, 0)) // yield to event loop
        }
      }
      await bridge.handleMessage(msg)
      applyPanelTitle()
    } else if (msg.type === "copyToClipboard") {
      await vscode.env.clipboard.writeText(msg.text)
    } else if (msg.type === "openFile") {
      await openFileInEditor(msg.path, msg.line)
    } else if (msg.type === "openContent") {
      const sessionDir = path.join(os.tmpdir(), "atelier", activeSessionId ?? "scratch")
      await fs.promises.mkdir(sessionDir, { recursive: true })
      const slug = (msg.title ?? "output").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)
      const ext = fileExtensionForLanguage(msg.language)
      const filePath = path.join(sessionDir, `${slug}${ext}`)
      await fs.promises.writeFile(filePath, msg.content, "utf-8")
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
      await vscode.window.showTextDocument(doc)
    } else if (msg.type === "requestFiles") {
      const safeQuery = (msg.query || "").replace(/[^a-zA-Z0-9._\-\/]/g, "")
      const pattern = safeQuery ? `**/*${safeQuery}*` : "**/*"
      const uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**", 50)
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      const sep = path.sep
      const files = uris
        .filter((uri) => workspaceRoot && (uri.fsPath === workspaceRoot || uri.fsPath.startsWith(workspaceRoot + sep)))
        .map((uri) => ({
          path: uri.fsPath,
          name: path.basename(uri.fsPath),
        }))
      postToWebview({ type: "fileResults", files })
    } else if (msg.type === "insertActiveFile") {
      const info = getActiveFileInfo(vscode.workspace.workspaceFolders)
      if (info) {
        postToWebview({ type: "activeFileInserted", ...info })
      }
    } else if (msg.type === "forkStageSession") {
      try {
        const forked = await atelierClient!.forkSession(msg.sessionId)
        forkTracker.set(forked.id, { hasUserMessages: false })
        // Open the forked session in a new tab instead of navigating the current panel
        const newPanel = createPanel(context, workspacePath)
        const handler = panelMessageHandlers.get(newPanel)
        if (handler) handler({ type: "switchSession", sessionId: forked.id } as WebviewMessage)
        newPanel.reveal(undefined, true)
      } catch (err) {
        outputChannel?.log("error", "fork_stage_session_failed", String(err))
      }
    } else {
      await handleWebviewMessage(msg)
    }
  }, undefined, context.subscriptions)

  // --- Active file context push ---
  // Track the last known context so it survives webview/panel focus.
  // When the user clicks the Atelier panel, activeTextEditor becomes undefined
  // and the active tab is the webview (no file URI). We replay the last context.
  type FileContextMsg =
    | { type: "activeFileContext"; path: string; relativePath: string; startLine?: number; endLine?: number }
    | { type: "activeFileContext"; path: null }
  let lastContext: FileContextMsg = { type: "activeFileContext", path: null }

  const sendContext = (msg: FileContextMsg) => {
    lastContext = msg
    postToWebview(msg)
  }

  const pushActiveFileContext = debounce(() => {
    // 1. Active text editor — best case, we get selection info
    const editor = vscode.window.activeTextEditor
    if (editor) {
      const resolved = editor.document.uri.fsPath
      if (isPathInWorkspace(resolved, vscode.workspace.workspaceFolders)) {
        const rel = vscode.workspace.asRelativePath(resolved)
        const selection = editor.selection
        sendContext({
          type: "activeFileContext",
          path: resolved,
          relativePath: rel,
          startLine: selection.isEmpty ? undefined : selection.start.line + 1,
          endLine: selection.isEmpty ? undefined : selection.end.line + 1,
        })
      } else {
        sendContext({ type: "activeFileContext", path: null })
      }
      return
    }

    // 2. No active text editor — check the active tab for non-text files (images, etc.)
    const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab
    const tabInput = activeTab?.input
    if (tabInput && typeof tabInput === "object" && "uri" in tabInput) {
      const uri = (tabInput as { uri: vscode.Uri }).uri
      if (uri.scheme === "file" && isPathInWorkspace(uri.fsPath, vscode.workspace.workspaceFolders)) {
        const rel = vscode.workspace.asRelativePath(uri.fsPath)
        sendContext({
          type: "activeFileContext",
          path: uri.fsPath,
          relativePath: rel,
        })
        return
      }
    }

    // 3. No file tab active (webview, terminal, etc.) — replay last known context
    postToWebview(lastContext)
  }, 150)

  const d1 = vscode.window.onDidChangeActiveTextEditor(() => {
    pushActiveFileContext()
  })
  const d2 = vscode.window.onDidChangeTextEditorSelection(pushActiveFileContext)
  // Track non-text tab changes (images, PDFs, etc.)
  const d3 = vscode.window.tabGroups.onDidChangeTabs(pushActiveFileContext)
  context.subscriptions.push(d1, d2, d3)

  // Seed initial state
  pushActiveFileContext()

  panel.onDidDispose(() => {
    outputChannel?.log("debug", "panel_disposed")

    // Abort the running pipeline owned by this panel before tearing down
    if (activePipelineId && atelierClient) {
      outputChannel?.log("info", "panel_disposed_abort_pipeline", activePipelineId)
      atelierClient.abortPipeline(activePipelineId).catch(() => {})
    }

    // Clean up empty forks
    const closingSessionId = panelActiveSessionIds.get(panel)
    if (closingSessionId && atelierClient && shouldCleanupFork(closingSessionId, panel, forkTracker, panelActiveSessionIds)) {
      outputChannel?.log("info", "cleanup_empty_fork", closingSessionId)
      atelierClient.deleteSession(closingSessionId).catch(() => {})
      forkTracker.delete(closingSessionId)
    }

    cleanupSSE()
    panels.delete(panel)
    panelWirings.delete(panel)
    panelMessageHandlers.delete(panel)
    panelActiveSessionIds.delete(panel)
    if (lastFocusedPanel === panel) lastFocusedPanel = null

    // Stop the server when the last panel is closed to avoid orphaned bun processes
    if (panels.size === 0) {
      outputChannel?.log("info", "last_panel_closed", "stopping server")
      teardownClientAndServer()
    }
  }, null, context.subscriptions)

  panels.add(panel)
  lastFocusedPanel = panel
}

async function ensureClientAndCreatePanel(
  context: vscode.ExtensionContext,
): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
  try {
    await ensureClient(workspacePath, context)
  } catch (err) {
    console.error("[Atelier] Failed to start backend:", err)
    return
  }
  createPanel(context, workspacePath)
}

export async function activate(context: vscode.ExtensionContext): Promise<{
  _test: {
    getClient: () => AtelierClient | null
    getPanel: () => vscode.WebviewPanel | null
    getPanels: () => Set<vscode.WebviewPanel>
    getAtelierManager: () => AtelierServerManager | null
  }
}> {
  // Register serializer FIRST -- VS Code may call it immediately on restart.
  // Restores the panel and re-selects the last active session/pipeline view.
  // This only restores the *view* — zombie pipelines are prevented by the
  // abort-on-dispose and idle-detector interrupt guards.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("atelierChat", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
        try {
          await ensureClient(workspacePath, context)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          vscode.window.showErrorMessage(`Atelier: Failed to restore panel — ${msg}`)
          panel.dispose()
          return
        }
        wirePanel(panel, context, workspacePath, state as PanelPersistedState | undefined)
      },
    }),
  )

  // Ensure the opencode binary is findable
  const opencodeBin = path.join(os.homedir(), ".opencode", "bin")
  if (!process.env.PATH?.includes(opencodeBin)) {
    process.env.PATH = `${opencodeBin}${path.delimiter}${process.env.PATH}`
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("atelier.openFile", async (filePath: string, line?: number) => {
      await openFileInEditor(filePath, line)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("atelier.insertActiveFile", () => {
      const target = resolvePanel()
      if (!target) return
      const info = getActiveFileInfo(vscode.workspace.workspaceFolders)
      if (info) {
        target.webview.postMessage({ type: "activeFileInserted", ...info })
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("atelier.setFavoriteModelVariant", async () => {
      const target = resolvePanel()
      if (!target) {
        vscode.window.showInformationMessage("Atelier: Open a chat panel first to favorite the current model/variant")
        return
      }
      target.webview.postMessage({ type: "favorites.command.upsertCurrent" })
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("atelier.openChat", async () => {
      const existing = resolvePanel()
      if (existing) {
        existing.reveal()
        return
      }
      await ensureClientAndCreatePanel(context)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("atelier.openChatInNewTab", async () => {
      await ensureClientAndCreatePanel(context)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("atelier.setLogLevel", async () => {
      const levels = LOG_LEVELS.map(l => ({
        label: l.charAt(0).toUpperCase() + l.slice(1),
        description: l === "info" ? "(default)" : undefined,
        level: l as LogLevel,
      }))
      const picked = await vscode.window.showQuickPick(levels, {
        placeHolder: "Select log verbosity level",
      })
      if (picked && outputChannel) {
        await outputChannel.setLevel(picked.level)
        context.workspaceState.update("atelier.logLevel", picked.level)
      }
    }),
  )

  // Sync settings to disk when the user changes VS Code configuration
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("atelier")) {
        const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
        atelierManager?.syncSettings(wsPath, getAtelierSettings())
      }
    }),
  )

  // Auto-start the server on activation so the Test MCP Server can connect
  // without requiring the panel to be opened first
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
  ensureClient(workspacePath, context).catch(err => console.error("[atelier] Background startup failed:", err))

  // Check for Strobe (required for debugging/TDD in pipelines)
  // Non-blocking: runs after all commands are registered
  promptAndInstallStrobe().catch(err => console.error("[atelier] Strobe check failed:", err))

  return {
    _test: {
      getClient: () => atelierClient,
      getPanel: () => resolvePanel(),
      getPanels: () => panels,
      getAtelierManager: () => atelierManager,
    },
  }
}

/** Disconnect the client and stop the server. Used on last-panel-close and deactivate. */
async function teardownClientAndServer(): Promise<void> {
  atelierClient?.disconnect()
  atelierClient = null
  clientPromise = null
  const manager = atelierManager
  atelierManager = null
  await manager?.stop()
}

export async function deactivate(): Promise<void> {
  for (const p of panels) p.dispose()
  panels.clear()
  lastFocusedPanel = null
  await teardownClientAndServer()
  outputChannel?.dispose()
  outputChannel = null
}
