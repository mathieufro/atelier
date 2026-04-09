import { For, Match, Show, Switch, type JSX } from "solid-js"
import type { Part, TextPart, ReasoningPart, ToolPart, SubtaskPart, FilePart, RetryPart, AgentPart, CompactionPart } from "@atelier/core"
import { TextPartView } from "./parts/TextPart.jsx"
import { ReasoningPartView } from "./parts/ReasoningPart.jsx"
import { ToolPartView } from "./parts/ToolPart.jsx"
import { SubtaskPartView } from "./parts/SubtaskPart.jsx"
import { FilePartView } from "./parts/FilePart.jsx"
import { RetryPartView } from "./parts/RetryPart.jsx"
import { AgentPartView } from "./parts/AgentPart.jsx"
import { CompactionPartView } from "./parts/CompactionPart.jsx"

// Part types that are hidden from chat (metadata only, shown elsewhere)
const HIDDEN_PARTS = new Set(["step-start", "step-finish"])

/** Resolve the dot color class for a part */
function dotColor(part: Part, isLastActive: boolean): string {
  if (part.type === "tool") {
    const status = (part as ToolPart).state.status
    if (status === "completed") return "bg-vsc-success"
    if (status === "error") return "bg-vsc-error"
    // Pending or running → pulsing gray to show activity
    return "bg-vsc-description-fg animate-pulse"
  }
  if (part.type === "reasoning") {
    const r = part as ReasoningPart
    return r.time.end !== undefined ? "bg-vsc-description-fg" : "bg-vsc-description-fg animate-pulse"
  }
  if (part.type === "subtask") return "bg-vsc-link animate-pulse"
  // Text/default: pulse if this is the last active part (still streaming)
  if (isLastActive) return "bg-vsc-description-fg animate-pulse"
  return "bg-vsc-description-fg"
}

/**
 * Layout wrapper: status dot + content.
 * Uses .part-row / .part-dot / .part-content defined in index.css.
 * Dot alignment is centralized there — one place to tweak for all parts.
 */
function PartRow(props: { dot: string; dotClass?: string; dotStyle?: JSX.CSSProperties; children: JSX.Element }) {
  return (
    <div class="part-row">
      <span class={`part-dot ${props.dot}${props.dotClass ? ` ${props.dotClass}` : ""}`} style={props.dotStyle} />
      <div class="part-content">{props.children}</div>
    </div>
  )
}

export function AssistantMessageView(props: {
  parts: Part[]
  onFileClick?: (path: string, line?: number) => void
  isStreaming?: boolean
  isStalled?: boolean
  interrupted?: boolean
}) {
  // Find visible parts to determine which is last (for streaming pulse)
  const visibleParts = () => props.parts.filter((p) => {
    if (HIDDEN_PARTS.has(p.type)) return false
    // Hide empty text parts — they're created as placeholders for streaming deltas
    // but render as lone dots with no content when the message has no text blocks
    if (p.type === "text" && !(p as TextPart).text) return false
    return true
  })

  // Show placeholder when streaming but no visible parts yet
  const showPlaceholder = () => !!(props.isStreaming && visibleParts().length === 0)

  // Trailing status after the last tool part:
  // - "Generating..." when a completed/errored tool is followed by LLM producing next response
  // - "Working..." when a task (subagent) tool is still running (can take minutes)
  const trailingStatus = (): "generating" | "working" | null => {
    if (!props.isStreaming || props.interrupted) return null
    const parts = visibleParts()
    if (parts.length === 0) return null
    const last = parts[parts.length - 1]!
    if (last.type !== "tool") return null
    const tool = last as ToolPart
    const status = tool.state.status
    if (status === "completed" || status === "error") return "generating"
    if (status === "running" && tool.tool === "task") return "working"
    return null
  }

  return (
    <div class="mb-4 space-y-2">
      <Show when={showPlaceholder() && !props.interrupted}>
        <PartRow dot="bg-vsc-description-fg animate-pulse">
          <span class="text-sm text-vsc-description-fg italic">Generating<span class="dots" /></span>
        </PartRow>
      </Show>
      <For each={visibleParts()}>
        {(part, i) => {
          const isLastVisible = () => i() === visibleParts().length - 1
          const isLastActive = () => !!(props.isStreaming && isLastVisible())

          return (
            <Switch>
              <Match when={part.type === "text"}>
                <PartRow dot={dotColor(part, isLastActive())}>
                  <TextPartView part={part as TextPart} onFileClick={props.onFileClick} />
                </PartRow>
              </Match>
              <Match when={part.type === "reasoning"}>
                <PartRow dot={dotColor(part, isLastActive())}>
                  <ReasoningPartView part={part as ReasoningPart} stopped={props.interrupted} />
                </PartRow>
              </Match>
              <Match when={part.type === "tool"}>
                <PartRow dot={dotColor(part, isLastActive())}>
                  <ToolPartView part={part as ToolPart} onFileClick={props.onFileClick} />
                </PartRow>
              </Match>
              <Match when={part.type === "subtask"}>
                <PartRow dot={dotColor(part, isLastActive())}>
                  <SubtaskPartView part={part as SubtaskPart} />
                </PartRow>
              </Match>
              <Match when={part.type === "file"}>
                <PartRow dot={dotColor(part, isLastActive())}>
                  <FilePartView part={part as FilePart} />
                </PartRow>
              </Match>
              <Match when={part.type === "retry"}>
                <PartRow dot={dotColor(part, isLastActive())}>
                  <RetryPartView part={part as RetryPart} />
                </PartRow>
              </Match>
              <Match when={part.type === "agent"}>
                <PartRow dot={dotColor(part, isLastActive())} dotStyle={{ "margin-top": "4px" }}>
                  <AgentPartView part={part as AgentPart} />
                </PartRow>
              </Match>
              <Match when={part.type === "compaction"}>
                <PartRow dot={dotColor(part, isLastActive())}>
                  <CompactionPartView part={part as CompactionPart} />
                </PartRow>
              </Match>
            </Switch>
          )
        }}
      </For>
      <Show when={trailingStatus()}>
        <PartRow dot="bg-vsc-description-fg animate-pulse">
          <span class="text-sm text-vsc-description-fg italic">
            {trailingStatus() === "working" ? "Working" : "Generating"}<span class="dots" />
          </span>
        </PartRow>
      </Show>
      <Show when={props.isStalled && !props.interrupted}>
        <PartRow dot="bg-vsc-warning-fg animate-pulse">
          <span class="text-sm text-vsc-warning-fg italic">Reconnecting<span class="dots" /></span>
        </PartRow>
      </Show>
      <Show when={props.interrupted}>
        <PartRow dot="bg-vsc-description-fg">
          <span class="text-sm text-vsc-disabled-fg italic">interrupted</span>
        </PartRow>
      </Show>
    </div>
  )
}
