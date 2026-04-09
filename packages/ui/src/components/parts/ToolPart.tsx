import { Show, Match, Switch } from "solid-js"
import { formatDuration } from "@atelier/core"
import type { ToolPart, ToolState, ToolStateRunning, ToolStateCompleted, ToolStateError, BashToolInput } from "@atelier/core"
import { workspacePath } from "../../stores/workspace.js"
import { usePostMessage } from "../../stores/post-message.js"
import { BashToolView } from "./tools/BashTool.jsx"
import { EditToolView } from "./tools/EditTool.jsx"
import { GenericToolView } from "./tools/GenericTool.jsx"
import { TodoToolView } from "./tools/TodoTool.jsx"
import { WebFetchToolView } from "./tools/WebFetchTool.jsx"
import { McpToolView } from "./tools/McpTool.jsx"
import { WriteToolView } from "./tools/WriteTool.jsx"
import { TaskToolView } from "./tools/TaskTool.jsx"

/** Shared helper: extract output from a completed tool state */
export function toolOutput(state: ToolState): string {
  if (state.status !== "completed") return ""
  const output = (state as ToolStateCompleted).output as unknown
  if (typeof output === "string") return output
  if (output == null) return ""
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}

/** Parse an MCP tool name (mcp_<server>_<toolname>) into its components */
export function parseMcpToolName(tool: string): { server: string; toolName: string } {
  const segments = tool.replace(/^mcp_/, "").split("_")
  const server = segments[0] ?? ""
  const toolName = segments.slice(1).join("_")
  return { server, toolName }
}

/** Shared error display for tool components */
export function ToolError(props: { state: ToolState }) {
  return (
    <Show when={props.state.status === "error" && (props.state as ToolStateError).error !== "Interrupted"}>
      <pre class="tool-error">{(props.state as ToolStateError).error}</pre>
    </Show>
  )
}

/** Returns true when the tool was interrupted (not a real error). */
function isInterruptedTool(state: ToolState): boolean {
  return state.status === "error" && (state as ToolStateError).error === "Interrupted"
}

/** Shared chevron icon for expand/collapse controls */
export function ChevronIcon(props: { expanded: boolean; class?: string }) {
  return (
    <svg
      class={props.class ?? "shrink-0 text-vsc-disabled-fg"}
      width="10"
      height="10"
      viewBox="0 0 10 10"
      style={`transform: rotate(${props.expanded ? "90deg" : "0deg"}); transition: transform 0.15s ease`}
    >
      <path d="M3 1.5L7 5L3 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}

/** Generate a VS Code command URI to open a file */
export function fileCommandUri(filePath: string, line?: number): string {
  const args = line != null ? [filePath, line] : [filePath]
  return `command:atelier.openFile?${encodeURIComponent(JSON.stringify(args))}`
}

const TOOL_LABELS: Record<string, string> = {
  edit: "Edit",
  patch: "Edit",
  apply_patch: "Edit",
  write: "Write",
  read: "Read",
  view: "Read",
  bash: "Bash",
  glob: "Glob",
  grep: "Grep",
  todowrite: "Todo",
  todoread: "Todo",
  webfetch: "WebFetch",
  askuserquestion: "Question",
}

function toolLabel(tool: string): string {
  if (tool.startsWith("mcp_")) {
    const { toolName, server } = parseMcpToolName(tool)
    return toolName || server || tool
  }
  return TOOL_LABELS[tool] ?? tool
}

/** Safely get parsed input — handles both object and raw JSON string */
function safeInput(state: ToolState): Record<string, unknown> {
  const raw = state.input
  if (raw && typeof raw === "object") return raw as Record<string, unknown>
  if (typeof raw === "string") {
    try { return JSON.parse(raw) } catch { return {} }
  }
  return {}
}

function extractFilePath(tool: string, state: ToolState): string {
  if (state.status === "pending") return ""
  if (tool === "apply_patch" && state.status === "completed") {
    const meta = (state as ToolStateCompleted).metadata
    const files = Array.isArray(meta?.files) ? meta.files : []
    if (files.length === 1 && typeof files[0]?.filePath === "string") return files[0].filePath
  }
  if (!FILE_TOOLS.has(tool)) return ""
  const input = safeInput(state)
  return (input.filePath as string) ?? (input.file_path as string) ?? (input.path as string) ?? ""
}

/** Extract the first changed line number from an edit/patch tool's diff metadata */
function extractEditLine(tool: string, state: ToolState): number | undefined {
  if (tool === "apply_patch" && state.status === "completed") {
    const meta = (state as ToolStateCompleted).metadata
    const files = Array.isArray(meta?.files) ? meta.files : []
    if (files.length !== 1 || typeof files[0]?.diff !== "string") return undefined
    const m = files[0].diff.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
    if (m) return parseInt(m[1], 10)
    return undefined
  }
  if (tool !== "edit" && tool !== "patch") return undefined
  if (state.status !== "completed") return undefined
  const meta = (state as ToolStateCompleted).metadata
  if (!meta) return undefined
  if (typeof meta.line === "number") return meta.line
  const diff = meta.diff as string | undefined
  if (diff) {
    const m = diff.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
    if (m) return parseInt(m[1]!, 10)
  }
  return undefined
}

/** Strip workspace prefix to show a relative path */
function displayPath(absPath: string): string {
  const ws = workspacePath()
  if (ws && absPath.startsWith(ws)) {
    const rel = absPath.slice(ws.length)
    return rel.startsWith("/") ? rel.slice(1) : rel
  }
  return absPath
}

/** For bash, show command; for glob/grep show pattern; otherwise use title */
function extractSubtitle(tool: string, state: ToolState): string {
  if (state.status === "pending") return "Preparing"
  if (tool === "bash") {
    const input = state.input as unknown as BashToolInput
    return input.description || input.command || ""
  }
  if (tool === "glob" || tool === "grep") {
    const input = safeInput(state)
    const pattern = (input.pattern as string) ?? (input.glob as string) ?? ""
    const path = (input.path as string)
    return path ? `${pattern} in ${path}` : pattern
  }
  if ("title" in state) {
    const title = (state as ToolStateRunning | ToolStateCompleted).title ?? ""
    // Skip title when it's just the tool name repeated (Claude Code sets title = tool name)
    if (title && title.toLowerCase() !== tool.toLowerCase()) return title
  }
  return ""
}

const FILE_TOOLS = new Set(["edit", "patch", "write", "read", "view"])
const TODO_TOOLS = new Set(["todowrite", "todoread"])
const READ_TOOLS = new Set(["read", "view"])
const EDIT_TOOLS = new Set(["edit", "patch", "apply_patch"])
const GLOB_GREP_TOOLS = new Set(["glob", "grep"])
/** Tools that show header-only on success (no card) */
const HEADER_ONLY_TOOLS = new Set([...READ_TOOLS, ...GLOB_GREP_TOOLS])
/** Tools that defer card display until completed (show animation in header during running) */
const CARD_DEFERRED_TOOLS = new Set(["write", ...EDIT_TOOLS, ...READ_TOOLS])

export function ToolPartView(props: { part: ToolPart; onFileClick?: (path: string, line?: number) => void }) {
  const post = usePostMessage()
  const state = () => props.part.state
  const duration = () => {
    const s = state()
    return (s.status === "completed" || s.status === "error") ? formatDuration(s.time.start, s.time.end) : ""
  }
  const filePath = () => extractFilePath(props.part.tool, state())
  const editLine = () => extractEditLine(props.part.tool, state())
  const subtitle = () => extractSubtitle(props.part.tool, state())
  const label = () => toolLabel(props.part.tool)
  const isGlobGrep = () => GLOB_GREP_TOOLS.has(props.part.tool)
  const globGrepOutput = () => toolOutput(state())

  const openGlobGrepOutput = () => {
    const output = globGrepOutput()
    if (!output) return
    post?.({ type: "openContent", content: output, title: `${label()} — ${subtitle()}` })
  }

  // Task tools render their own full UI with expand/collapse and child parts
  if (props.part.tool === "task") {
    return <TaskToolView state={state()} onFileClick={props.onFileClick} />
  }

  // Todo tools render inline without header or card
  if (TODO_TOOLS.has(props.part.tool)) {
    return (
      <Show when={state().status !== "pending"}>
        <ToolContent tool={props.part.tool} state={state()} onFileClick={props.onFileClick} />
      </Show>
    )
  }

  return (
    <div>
      {/* Header: tool label + file path or subtitle + duration + status */}
      <div class="flex items-baseline gap-2 leading-5">
        <span class="text-vsc-disabled-fg text-sm font-medium shrink-0">{label()}<Show when={state().status === "running" && !filePath() && !subtitle()}><span class="dots" /></Show></span>
        <Show when={filePath()}>
          <a
            class="font-mono text-xs text-vsc-editor-fg hover:underline truncate"
            href={fileCommandUri(filePath(), editLine())}
          >
            {displayPath(filePath())}
          </a>
          <Show when={state().status === "running"}><span class="dots" /></Show>
        </Show>
        <Show when={!filePath() && subtitle()}>
          <Show when={isGlobGrep() && globGrepOutput()}
            fallback={<span class="font-mono text-xs text-vsc-editor-fg truncate">{subtitle()}<Show when={state().status === "pending" || state().status === "running"}><span class="dots" /></Show></span>}
          >
            <button
              class="font-mono text-xs text-vsc-editor-fg truncate hover:underline text-left"
              onClick={openGlobGrepOutput}
            >
              {subtitle()}
            </button>
          </Show>
        </Show>
        <span class="ml-auto shrink-0 flex items-center gap-2">
          <Show when={duration()}><span class="text-vsc-disabled-fg text-xs">{duration()}</span></Show>
          <Show when={state().status === "error" && !isInterruptedTool(state())}><span class="text-vsc-error text-xs">failed</span></Show>
          <Show when={isInterruptedTool(state())}><span class="text-vsc-disabled-fg text-xs italic">interrupted</span></Show>
        </span>
      </div>
      {/* Content card — skip for header-only tools (reads, glob/grep) on success, and for write/edit while still running */}
      <Show when={state().status !== "pending" && !(HEADER_ONLY_TOOLS.has(props.part.tool) && state().status === "completed") && !(CARD_DEFERRED_TOOLS.has(props.part.tool) && state().status === "running")}>
        <div
          class="tool-card mt-2"
          classList={{ "cursor-pointer": !!(filePath() && EDIT_TOOLS.has(props.part.tool)) }}
          onClick={() => { if (filePath() && EDIT_TOOLS.has(props.part.tool)) props.onFileClick?.(filePath(), editLine()) }}
        >
          <ToolContent tool={props.part.tool} state={state()} onFileClick={props.onFileClick} />
        </div>
      </Show>
    </div>
  )
}

function ToolContent(props: { tool: string; state: ToolState; onFileClick?: (path: string, line?: number) => void }) {
  return (
    <Switch fallback={<GenericToolView tool={props.tool} state={props.state} />}>
      <Match when={props.tool === "bash"}><BashToolView state={props.state} /></Match>
      <Match when={props.tool === "edit" || props.tool === "patch" || props.tool === "apply_patch"}><EditToolView state={props.state} onFileClick={props.onFileClick} /></Match>
      <Match when={props.tool === "write"}><WriteToolView state={props.state} onFileClick={props.onFileClick} /></Match>
      <Match when={props.tool === "todowrite" || props.tool === "todoread"}><TodoToolView state={props.state} /></Match>
      <Match when={props.tool === "webfetch"}><WebFetchToolView state={props.state} /></Match>
      <Match when={props.tool?.startsWith("mcp_")}><McpToolView tool={props.tool} state={props.state} /></Match>
    </Switch>
  )
}
