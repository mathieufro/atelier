import { createSignal, createEffect, Show, For, Match, Switch } from "solid-js"
import { formatDuration } from "@atelier/core"
import type { ToolState, Part, TextPart, ReasoningPart, ToolPart as ToolPartType, SubtaskPart } from "@atelier/core"
import { useStores } from "../../../stores/context.jsx"
import { TextPartView } from "../TextPart.jsx"
import { ReasoningPartView } from "../ReasoningPart.jsx"
import { ToolPartView, ChevronIcon } from "../ToolPart.jsx"
import { SubtaskPartView } from "../SubtaskPart.jsx"

const HIDDEN_PARTS = new Set(["step-start", "step-finish", "agent"])

/** Resolve dot color for a child part (mirrors AssistantMessage.dotColor) */
function dotColor(part: Part, isLast: boolean, isRunning: boolean): string {
  if (part.type === "tool") {
    const status = (part as ToolPartType).state.status
    if (status === "completed") return "bg-vsc-success"
    if (status === "error") return "bg-vsc-error"
    return "bg-vsc-description-fg animate-pulse"
  }
  if (part.type === "reasoning") {
    const r = part as ReasoningPart
    return r.time.end !== undefined ? "bg-vsc-description-fg" : "bg-vsc-description-fg animate-pulse"
  }
  if (part.type === "subtask") return "bg-vsc-link animate-pulse"
  if (isLast && isRunning) return "bg-vsc-description-fg animate-pulse"
  return "bg-vsc-description-fg"
}

interface TaskToolProps {
  state: ToolState
  onFileClick?: (path: string, line?: number) => void
}

export function TaskToolView(props: TaskToolProps) {
  const { messageStore } = useStores()

  const isRunning = () => props.state.status === "running"
  const isError = () => props.state.status === "error"
  const [expanded, setExpanded] = createSignal(isRunning())

  // Auto-expand when task starts running
  createEffect(() => {
    if (isRunning()) setExpanded(true)
  })

  const metadata = (): Record<string, unknown> | undefined => {
    const s = props.state
    if (s.status === "running" || s.status === "completed" || s.status === "error") return s.metadata
    return undefined
  }
  const childSessionId = () => {
    const sid = metadata()?.sessionId
    return typeof sid === "string" ? sid : undefined
  }

  const agentName = () => {
    const val = props.state.input?.subagent_type
    return typeof val === "string" ? val : "task"
  }
  const description = () => {
    const s = props.state
    const title = (s.status === "running" || s.status === "completed") ? s.title : undefined
    if (typeof title === "string" && title) return title
    const desc = s.input?.description
    return typeof desc === "string" ? desc : ""
  }
  const duration = () => {
    const s = props.state
    if (s.status === "completed" || s.status === "error") return formatDuration(s.time.start, s.time.end)
    return ""
  }

  /** Extract visible assistant parts from child messages */
  const childParts = () => {
    const sessionId = childSessionId()
    if (!sessionId) return []
    const msgs = messageStore.messages(sessionId)
    const parts: Part[] = []
    for (const entry of msgs) {
      if (entry.message.role !== "assistant") continue
      for (const p of entry.parts) {
        if (HIDDEN_PARTS.has(p.type)) continue
        if (p.type === "text" && !(p as TextPart).text) continue
        parts.push(p)
      }
    }
    return parts
  }

  const showWorkingPlaceholder = () => isRunning() && childParts().length === 0

  const showTrailingWorking = () => {
    if (!isRunning()) return false
    const parts = childParts()
    if (parts.length === 0) return false
    const last = parts[parts.length - 1]!
    if (last.type !== "tool") return false
    const status = (last as ToolPartType).state.status
    return status === "completed" || status === "error"
  }

  return (
    <div>
      <button
        class="flex items-center gap-1.5 text-sm leading-5"
        onClick={() => setExpanded((e) => !e)}
      >
        <ChevronIcon expanded={expanded()} />
        <span class="text-vsc-link font-mono text-xs">@{agentName()}</span>
        <span class="text-vsc-disabled-fg text-xs truncate">{description()}</span>
        <Show when={isRunning() && !duration()}>
          <span class="text-vsc-disabled-fg text-xs italic"><span class="dots" /></span>
        </Show>
        <Show when={duration()}>
          <span class="text-vsc-disabled-fg text-xs">{duration()}</span>
        </Show>
        <Show when={isError()}>
          <span class="text-vsc-error text-xs">failed</span>
        </Show>
      </button>
      <Show when={expanded()}>
        <div class="ml-[4px] mt-1 border-l border-vsc-panel-border pl-3 space-y-1">
          <Show when={childParts().length > 0} fallback={
            <Show when={showWorkingPlaceholder()}>
              <div class="part-row">
                <span class="part-dot bg-vsc-description-fg animate-pulse" />
                <span class="text-xs text-vsc-disabled-fg italic">Working<span class="dots" /></span>
              </div>
            </Show>
          }>
            <For each={childParts()}>
              {(part, i) => {
                const isLast = () => i() === childParts().length - 1
                return (
                  <div class="part-row">
                    <span class={`part-dot ${dotColor(part, isLast(), isRunning())}`} />
                    <div class="part-content">
                      <Switch>
                        <Match when={part.type === "text"}>
                          <TextPartView part={part as TextPart} onFileClick={props.onFileClick} />
                        </Match>
                        <Match when={part.type === "reasoning"}>
                          <ReasoningPartView part={part as ReasoningPart} />
                        </Match>
                        <Match when={part.type === "tool"}>
                          <ToolPartView part={part as ToolPartType} onFileClick={props.onFileClick} />
                        </Match>
                        <Match when={part.type === "subtask"}>
                          <SubtaskPartView part={part as SubtaskPart} />
                        </Match>
                      </Switch>
                    </div>
                  </div>
                )
              }}
            </For>
          </Show>
          <Show when={showTrailingWorking()}>
            <div class="part-row">
              <span class="part-dot bg-vsc-description-fg animate-pulse" />
              <span class="text-xs text-vsc-disabled-fg italic">Working<span class="dots" /></span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  )
}
